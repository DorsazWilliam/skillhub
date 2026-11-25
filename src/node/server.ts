import { serve } from '@hono/node-server';
import worker from '../worker';
import { createRuntime, executionContext } from './runtime';

/**
 * SkillHub on Node: the same Worker, with bindings from environment variables (docs/SELF_HOSTING.md).
 * Listens on PORT, applies migrations at start, and runs the twice-daily cleanup itself.
 */

const v = process.env;
const migrations = v['MIGRATIONS_DIR'] ?? './migrations';
const assets = v['ASSETS_DIR'] ?? './web/dist';
// The database or the bucket may still be starting (Compose, Kubernetes): retry for up to 3 minutes before giving up.
async function start(): Promise<Awaited<ReturnType<typeof createRuntime>>> {
  for (let i = 1; ; i++) {
    try {
      return await createRuntime(v, { migrations: v['SKIP_MIGRATIONS'] === 'true' ? null : migrations, assets });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= 36 || /is required|must start with|must be disk or s3|needs /.test(msg)) throw e;
      console.error(JSON.stringify({ level: 'warn', msg: 'waiting for the database and storage', attempt: i, err: msg.slice(0, 200) }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
const rt = await start();
const base = new URL(rt.env.BASE_URL);

// Behind a proxy the request arrives as http://pod-ip:port; the app and the OAuth provider build URLs from the
// request, so it is rewritten onto BASE_URL (the public origin).
const server = serve({
  port: Number(v['PORT'] ?? 8080),
  hostname: v['HOST'] ?? '0.0.0.0',
  fetch: async (req: Request) => {
    const u = new URL(req.url);
    if (u.pathname === '/livez') return new Response('ok');
    const url = base.origin + u.pathname + u.search;
    const headers = new Headers(req.headers);
    headers.set('host', base.host);
    const fwd = headers.get('x-forwarded-for');
    if (fwd && !headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', fwd.split(',')[0]!.trim());
    const init: RequestInit & { duplex?: string } = { method: req.method, headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body;
      init.duplex = 'half';
    }
    return worker.fetch(new Request(url, init), rt.env, executionContext());
  },
});

// Cron "17 3,15 * * *" (UTC), as on Cloudflare. With several replicas on Postgres, an advisory lock lets one run it.
function nextRun(now = Date.now()): number {
  const H = 3600_000;
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (const t of [day + 3 * H + 17 * 60_000, day + 15 * H + 17 * 60_000, day + 27 * H + 17 * 60_000]) if (t > now) return t - now;
  return 12 * H;
}
async function tick(): Promise<void> {
  try {
    const pg = rt.engine.dialect === 'postgres';
    if (pg && !(await rt.engine.query('SELECT pg_try_advisory_lock(?) AS ok', [17315]).then((r) => r.rows[0]?.['ok']))) return;
    try {
      await worker.scheduled({ cron: '17 3,15 * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, rt.env, executionContext());
    } finally {
      if (pg) await rt.engine.query('SELECT pg_advisory_unlock(?)', [17315]);
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'scheduled cleanup failed', err: String(e) }));
  }
}
const schedule = (): void => {
  setTimeout(() => void tick().finally(schedule), nextRun()).unref();
};
schedule();

console.log(JSON.stringify({ level: 'info', msg: 'SkillHub listening', port: Number(v['PORT'] ?? 8080), base: rt.env.BASE_URL, db: rt.engine.dialect }));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    void rt.close().finally(() => process.exit(0));
  });
}
