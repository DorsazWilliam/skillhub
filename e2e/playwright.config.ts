import { defineConfig } from '@playwright/test';
import { chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 8790);
const READY = Number(process.env.E2E_READY_PORT ?? 8791);

/** Use Playwright's own Chromium when installed, else the newest one already on disk, else the system Chrome. */
function browser(): { executablePath?: string; channel?: string } {
  if (process.env.PW_EXECUTABLE) return { executablePath: process.env.PW_EXECUTABLE };
  try {
    if (existsSync(chromium.executablePath())) return {};
  } catch {
    /* not installed */
  }
  const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(root)) {
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs)
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(root, d, exe);
        if (existsSync(p)) return { executablePath: p };
      }
  }
  return { channel: 'chrome' };
}

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    launchOptions: browser(),
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'e2e', testMatch: /smoke\.spec\.ts/ },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: 'node scripts/e2e-stack.mjs',
    cwd: '..',
    url: `http://localhost:${READY}/ready`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
