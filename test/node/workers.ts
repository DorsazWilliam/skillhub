/**
 * `cloudflare:workers` for the Node test run (vitest.node.config.ts): the same tests, with the app on Node bindings.
 * Each test file gets a fresh database (TEST_DATABASE: sqlite or pglite) and a fresh file store.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../../src/worker';
import { createRuntime, executionContext } from '../../src/node/runtime';

export class WorkerEntrypoint {}

const kind = process.env['TEST_DATABASE'] ?? 'sqlite';
const rt = await createRuntime(
  {
    BASE_URL: 'https://skills.test',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_ALLOWED_TENANTS: '',
    ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    OWNER_EMAILS: 'owner@acme.test',
    ALLOW_GUESTS: 'false',
    ENTRA_CLIENT_SECRET: 'test-secret',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    MCP_MAX_SCOPES: 'read,write,publish,manage',
    CATALOG_IN_TOOL_DESC: 'true',
    AUTH_PROVIDERS: 'microsoft,email',
    EMAIL_TRANSPORT: 'memory',
    DATABASE_URL: kind === 'pglite' ? 'pglite:' : 'sqlite::memory:',
    STORAGE: 'disk',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'skillhub-test-')),
  },
  { migrations: 'migrations', assets: null },
);

// No rate limiting in tests, as on the Workers test pool.
export const env = { ...rt.env, RATE_LIMITER: undefined } as typeof rt.env & Record<string, unknown>;

export const exports = {
  default: {
    fetch: (req: Request) => worker.fetch(req as Parameters<typeof worker.fetch>[0], env, executionContext()),
  },
};
