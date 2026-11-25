import { main } from './server';

/** Docker image entry (dist/server.mjs): migrations and the web app from directories next to it. */
main({ migrations: process.env['MIGRATIONS_DIR'] ?? './migrations', assets: process.env['ASSETS_DIR'] ?? './web/dist' }).catch((e: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', msg: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
