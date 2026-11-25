import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
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
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
