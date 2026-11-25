import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The same test suite on the Node runtime (src/node), against SQLite or Postgres (PGlite, Postgres in WASM):
 *   npm run test:node     (SQLite)
 *   npm run test:pg       (Postgres)
 */
const shim = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      'cloudflare:workers': shim('./test/node/workers.ts'),
      'cloudflare:test': shim('./test/node/test.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { TEST_DATABASE: mode === 'pg' ? 'pglite' : (process.env['TEST_DATABASE'] ?? 'sqlite') },
    // The OAuth provider imports cloudflare:workers: process it so the alias applies.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
}));
