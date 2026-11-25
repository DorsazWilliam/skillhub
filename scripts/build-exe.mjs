// Builds SkillHub as one executable for this platform (Node single executable application):
// dist/skillhub.exe on Windows, dist/skillhub on Linux and macOS. The web app and migrations are embedded.
// Usage: npm run build:exe        (Linux binary from any OS: see Dockerfile.exe)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [join(root, 'scripts/build-web.mjs')], { stdio: 'inherit', cwd: root });

await build({
  entryPoints: [join(root, 'src/node/sea.ts')],
  outfile: join(dist, 'sea.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  alias: { 'cloudflare:workers': join(root, 'src/node/workers-shim.ts') },
  external: ['pg-native', '@electric-sql/pglite', '@cloudflare/puppeteer', 'bufferutil', 'utf-8-validate', 'chromium-bidi/*'],
  logLevel: 'warning',
});

// Assets: every file of web/dist and migrations, plus a manifest with a content version.
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(root, p).split(sep).join('/'));
  }
};
walk(join(root, 'web/dist'));
walk(join(root, 'migrations'));
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(join(root, f)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = { version: `${pkg.version}-${hash.digest('hex').slice(0, 12)}`, files };
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest));

const assets = { 'manifest.json': join(dist, 'manifest.json') };
for (const f of files) assets[f] = join(root, f);
writeFileSync(
  join(dist, 'sea-config.json'),
  JSON.stringify({ main: join(dist, 'sea.cjs'), output: join(dist, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', join(dist, 'sea-config.json')], { stdio: 'inherit' });

const exe = join(dist, process.platform === 'win32' ? 'skillhub.exe' : 'skillhub');
copyFileSync(process.execPath, exe);
if (process.platform !== 'win32') chmodSync(exe, 0o755);
const postject = join(root, 'node_modules/postject/dist/cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', join(dist, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
console.log(`${relative(root, exe)} ready (${manifest.files.length} embedded files, version ${manifest.version})`);
