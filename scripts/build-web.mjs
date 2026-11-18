// Builds web assets into web/dist. Until the React SPA lands this copies web/public.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const dist = new URL('../web/dist/', import.meta.url);
if (existsSync(new URL('../web/vite.config.ts', import.meta.url))) {
  const { execSync } = await import('node:child_process');
  execSync('npx vite build --config web/vite.config.ts', { stdio: 'inherit' });
} else {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(new URL('../web/public/', import.meta.url), dist, { recursive: true });
}
console.log('web/dist ready');
