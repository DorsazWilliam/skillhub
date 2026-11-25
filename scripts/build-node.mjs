// Bundles the Node server (src/node/server.ts), with its database drivers and Puppeteer, into one file:
// dist/server.mjs. Usage: node scripts/build-node.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [root + 'src/node/start.ts'],
  outfile: root + 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  alias: { 'cloudflare:workers': root + 'src/node/workers-shim.ts' },
  // Everything is bundled except optional native and test-only packages: the image needs no node_modules.
  external: ['pg-native', '@electric-sql/pglite', '@cloudflare/puppeteer', 'bufferutil', 'utf-8-validate', 'chromium-bidi/*'],
  // Some bundled CommonJS code calls require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('dist/server.mjs ready');
