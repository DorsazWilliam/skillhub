// Renders scripts/seed-assets/severity-matrix.png (the prototype's canvas drawing) with Playwright.
// Run once: node scripts/seed-assets/severity-matrix.mjs. The PNG is committed; the seed only uploads it.
import { chromium } from '@playwright/test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function localChrome() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: localChrome() });
const page = await browser.newPage();
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const W = 720, H = 200;
  c.width = W * 2; c.height = H * 2;
  const x = c.getContext('2d');
  x.scale(2, 2);
  const rr = (a, b, w, h, r) => { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); };
  const cols = [['SEV1', 'Outage or data loss', '15 min', '#dc2626'], ['SEV2', 'Major feature degraded', '30 min', '#d97706'], ['SEV3', 'Minor, workaround', '2 h', '#2563eb']];
  cols.forEach((k, i) => {
    const X = 12 + i * 236, Y = 12, w = 224, h = 176;
    x.fillStyle = k[3]; x.globalAlpha = 0.12; rr(X, Y, w, h, 14); x.fill(); x.globalAlpha = 1;
    x.fillStyle = k[3]; rr(X + 16, Y + 16, 64, 26, 8); x.fill();
    x.fillStyle = '#fff'; x.font = '600 13px system-ui, sans-serif'; x.fillText(k[0], X + 28, Y + 34);
    x.fillStyle = k[3]; x.font = '600 15px system-ui, sans-serif'; x.fillText(k[1], X + 16, Y + 82);
    x.font = '500 13px system-ui, sans-serif'; x.globalAlpha = 0.85; x.fillText('Update every', X + 16, Y + 128);
    x.font = '700 26px system-ui, sans-serif'; x.globalAlpha = 1; x.fillText(k[2], X + 16, Y + 158);
  });
  return c.toDataURL('image/png');
});
await browser.close();
writeFileSync(new URL('./severity-matrix.png', import.meta.url), Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('wrote scripts/seed-assets/severity-matrix.png');
