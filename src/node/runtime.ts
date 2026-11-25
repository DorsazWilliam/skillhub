import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Env } from '../env';
import { SqlD1, type Engine } from './sql';
import { engineFromUrl, migrate } from './engines';
import { SqlKV } from './kv';
import { DiskBucket, S3Bucket } from './blob';
import { AzureBlobBucket } from './azure';

/**
 * Builds the app's bindings (DB, BUCKET, OAUTH_KV, ASSETS, RATE_LIMITER, LAUNCH_BROWSER) from environment variables,
 * so the unchanged Worker code runs on Node. See docs/SELF_HOSTING.md for every variable.
 */

export type Vars = Record<string, string | undefined>;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** The static SPA, like Workers static assets with single-page-application fallback. */
export function assetsFetcher(dir: string): { fetch: (req: Request) => Promise<Response> } {
  const root = resolve(dir);
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      let path: string;
      try {
        path = resolve(root, '.' + decodeURIComponent(url.pathname));
      } catch {
        return new Response('Bad path', { status: 400 });
      }
      if (path !== root && !path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
      try {
        const s = await stat(path);
        if (s.isDirectory()) path = resolve(path, 'index.html');
        const body = await readFile(path);
        const immutable = url.pathname.startsWith('/assets/');
        return new Response(body, {
          headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
        });
      } catch {
        // Unknown paths are app routes: serve the SPA.
        if (extname(url.pathname)) return new Response('Not found', { status: 404 });
        return new Response(await readFile(resolve(root, 'index.html')), { headers: { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' } });
      }
    },
  };
}

/** Per-process limiter with the same contract as the Workers rate limiting binding (fixed window). */
export function memoryRateLimiter(limit: number, periodS: number): { limit: (o: { key: string }) => Promise<{ success: boolean }> } {
  const hits = new Map<string, { n: number; reset: number }>();
  return {
    async limit({ key }) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || h.reset <= now) {
        if (hits.size > 50_000) hits.clear();
        h = { n: 0, reset: now + periodS * 1000 };
        hits.set(key, h);
      }
      h.n++;
      return { success: h.n <= limit };
    },
  };
}

function storage(v: Vars): DiskBucket | S3Bucket | AzureBlobBucket {
  const kind = (v['STORAGE'] ?? 'disk').toLowerCase();
  if (kind === 'azure') {
    if (!v['AZURE_STORAGE_ACCOUNT']) throw new Error('STORAGE=azure needs AZURE_STORAGE_ACCOUNT');
    return new AzureBlobBucket({
      account: v['AZURE_STORAGE_ACCOUNT'],
      container: v['AZURE_STORAGE_CONTAINER'] ?? 'skillhub',
      endpoint: v['AZURE_STORAGE_ENDPOINT'],
      key: v['AZURE_STORAGE_KEY'],
      clientId: v['AZURE_CLIENT_ID'],
    });
  }
  if (kind === 's3') {
    const need = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !v[k]);
    if (need.length) throw new Error('STORAGE=s3 needs ' + need.join(', '));
    return new S3Bucket({
      endpoint: v['S3_ENDPOINT']!,
      bucket: v['S3_BUCKET']!,
      region: v['S3_REGION'] ?? 'auto',
      accessKeyId: v['S3_ACCESS_KEY_ID']!,
      secretAccessKey: v['S3_SECRET_ACCESS_KEY']!,
      pathStyle: (v['S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
    });
  }
  if (kind !== 'disk') throw new Error('STORAGE must be disk or s3 or azure');
  return new DiskBucket(v['STORAGE_DIR'] ?? './data/files');
}

/** A Chromium to drive over the DevTools protocol: BROWSER_URL (http://host:9222) or BROWSER_WS_URL (ws://...). */
function browser(v: Vars): Env['LAUNCH_BROWSER'] {
  const http = v['BROWSER_URL'];
  const ws = v['BROWSER_WS_URL'];
  if (!http && !ws) return undefined;
  return async () => {
    const p = await import('puppeteer-core');
    return p.default.connect(ws ? { browserWSEndpoint: ws } : { browserURL: http });
  };
}

/** SMTP_URL (smtp://user:pass@host:587 or smtps://...) for sign-in links and invitations. */
function mailer(v: Vars): Env['SEND_MAIL'] {
  const url = v['SMTP_URL'];
  if (!url) return undefined;
  let transport: { sendMail: (m: Record<string, string>) => Promise<unknown> } | null = null;
  return async (m) => {
    if (!transport) {
      const nm = await import('nodemailer');
      transport = nm.default.createTransport(url) as unknown as typeof transport;
    }
    await transport!.sendMail(m);
  };
}

export interface Runtime {
  env: Env;
  engine: Engine;
  close: () => Promise<void>;
}

/** The app's bindings from variables. Applies pending migrations unless `migrations` is null. */
export async function createRuntime(v: Vars, opts: { migrations: string | null; assets: string | null }): Promise<Runtime> {
  for (const k of ['BASE_URL', 'SESSION_SECRET']) if (!v[k]) throw new Error(`${k} is required`);
  const engine = await engineFromUrl(v['DATABASE_URL'] ?? 'sqlite:./data/skillhub.db');
  if (opts.migrations) await migrate(engine, opts.migrations);
  const db = new SqlD1(engine);
  const bucket = storage(v);
  if (bucket instanceof S3Bucket && v['S3_CREATE_BUCKET'] === 'true') await bucket.ensureBucket();
  if (bucket instanceof AzureBlobBucket && v['AZURE_CREATE_CONTAINER'] === 'true') await bucket.ensureContainer();
  const vars: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) vars[k] = val;
  const env = {
    ...vars,
    BASE_URL: v['BASE_URL']!.replace(/\/+$/, ''),
    ENTRA_TENANT_ID: v['ENTRA_TENANT_ID'] ?? '',
    ENTRA_CLIENT_ID: v['ENTRA_CLIENT_ID'] ?? '',
    ENTRA_CLIENT_SECRET: v['ENTRA_CLIENT_SECRET'] ?? '',
    SESSION_SECRET: v['SESSION_SECRET']!,
    MCP_MAX_SCOPES: v['MCP_MAX_SCOPES'] ?? 'read,write,publish,manage',
    CATALOG_IN_TOOL_DESC: v['CATALOG_IN_TOOL_DESC'] ?? 'true',
    DB: db as unknown as D1Database,
    BUCKET: bucket as unknown as R2Bucket,
    OAUTH_KV: new SqlKV(db) as unknown as KVNamespace,
    ...(opts.assets ? { ASSETS: assetsFetcher(opts.assets) as unknown as Fetcher } : {}),
    RATE_LIMITER: memoryRateLimiter(Number(v['RATE_LIMIT'] ?? 300), 60) as unknown as RateLimit,
    LAUNCH_BROWSER: browser(v),
    SEND_MAIL: mailer(v),
  } as unknown as Env;
  return { env, engine, close: () => engine.close() };
}

/** An ExecutionContext for one request: background work is awaited lazily and errors are logged. */
export function executionContext(): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      p.catch((e: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'background task failed', err: String(e) })));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
