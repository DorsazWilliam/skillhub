import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from './server';

/**
 * Single-executable entry (scripts/build-exe.mjs): the web app and the migrations are embedded as SEA assets and
 * unpacked once to a versioned folder in the temp directory. Defaults suit one machine: SQLite and files next to the
 * executable's working directory (./data), port 8080.
 */

interface SeaApi {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAssetKeys?(): string[];
}

async function unpack(): Promise<{ migrations: string; assets: string }> {
  const sea = (await import('node:sea')) as unknown as SeaApi;
  const manifest = JSON.parse(new TextDecoder().decode(sea.getAsset('manifest.json'))) as { version: string; files: string[] };
  const root = join(tmpdir(), 'skillhub-' + manifest.version);
  if (!existsSync(join(root, '.done'))) {
    for (const f of manifest.files) {
      const out = join(root, f);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, new Uint8Array(sea.getAsset(f)));
    }
    writeFileSync(join(root, '.done'), '');
  }
  return { migrations: join(root, 'migrations'), assets: join(root, 'web', 'dist') };
}

const env = process.env;
env['DATABASE_URL'] ??= 'sqlite:./data/skillhub.db';
env['STORAGE'] ??= 'disk';
env['STORAGE_DIR'] ??= './data/files';

unpack()
  .then((dirs) => main(dirs))
  .catch((e: unknown) => {
    console.error(JSON.stringify({ level: 'fatal', msg: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
