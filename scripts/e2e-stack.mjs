#!/usr/bin/env node
// Starts the real local stack for the Playwright suite: builds the SPA, applies migrations to a fresh local state
// directory, runs `wrangler dev` with the dev-only sign-in, loads the demo seed, then answers 200 on
// http://localhost:<E2E_READY_PORT>/ready so Playwright knows it can start. LOCAL ONLY (never --remote).
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.E2E_PORT ?? 8790);
const READY = Number(process.env.E2E_READY_PORT ?? 8791);
const BASE = `http://localhost:${PORT}`;
const STATE = `.wrangler/e2e-${Date.now()}`;
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

let ready = false;
const server = createServer((req, res) => {
  res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
  res.end(ready ? 'ready' : 'starting');
}).listen(READY);

run('node scripts/build-web.mjs');
run(`npx wrangler d1 migrations apply DB --local --persist-to ${STATE}`);

const vars = { BASE_URL: BASE, DEV_LOGIN: 'true', SESSION_SECRET: randomBytes(32).toString('hex'), ENTRA_CLIENT_SECRET: 'unused-in-e2e', AUTH_PROVIDERS: 'microsoft,email', EMAIL_TRANSPORT: 'log' };
// Extra or overridden variables, e.g. E2E_VARS='{"AUTH_PROVIDERS":"microsoft,google"}' (the demo video).
Object.assign(vars, JSON.parse(process.env.E2E_VARS ?? '{}'));
const args = ['wrangler', 'dev', '--infer-origin-from-routes=false', '--port', String(PORT), '--persist-to', STATE, '--show-interactive-dev-session=false'];
for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
// On Windows the shell joins the arguments: quote the ones with spaces.
const quoted = process.platform === 'win32' ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
const dev = spawn('npx', quoted, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });

const stop = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: 'ignore' });
    else dev.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
dev.on('exit', (code) => {
  console.error(`wrangler dev exited (${code})`);
  server.close();
  process.exit(code ?? 1);
});

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for ' + url);
}

await waitFor(`${BASE}/healthz`, 120_000);
// Warm the asset server so the first navigation is not a cold 404.
await fetch(`${BASE}/`, { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } }).catch(() => null);
run(`node scripts/seed-demo.mjs --base ${BASE} --persist-to ${STATE}`);
ready = true;
console.log(`e2e stack ready at ${BASE} (state ${STATE})`);
