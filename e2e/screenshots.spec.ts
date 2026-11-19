import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** README screenshots from the seeded demo (npm run screenshots). Light theme; one dark graph. Kept under ~600 KB. */

const OUT = join(process.cwd(), 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });
const MAX = 600 * 1024;

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('[data-dev="owner"]').click();
  await expect(page.locator('.top .brand, .m-tabs').first()).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
}

/** PNG when small enough, otherwise re-encoded in the browser as a palette-friendly smaller PNG at 1x, then WebP. */
async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  const file = join(OUT, name);
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(file, png);
  if (statSync(file).size <= MAX) return;
  // Too large: re-encode through a canvas as lossy WebP at high quality, keeping the .png name out of the README.
  const b64 = png.toString('base64');
  const webp = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.9).split(',')[1]!;
  }, b64);
  writeFileSync(file.replace(/\.png$/, '.webp'), Buffer.from(webp, 'base64'));
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });

  test('desktop screenshots', async ({ page }) => {
    await signIn(page);
    await page.goto('/n/skills/deploy-service');
    await expect(page.locator('.skhead')).toBeVisible();
    await page.goto('/');
    await expect(page.locator('.tile')).toHaveCount(3);
    await shot(page, 'desktop-home.png');

    await page.goto('/n/skills/incident-response');
    await expect(page.locator('.md figure img')).toBeVisible();
    await expect(page.locator('.drawer svg.lg')).toBeVisible();
    await shot(page, 'desktop-skill.png');

    await page.goto('/graph');
    await expect(page.locator('#gc')).toBeVisible();
    await page.waitForTimeout(2500);
    await shot(page, 'desktop-graph.png');

    await page.goto('/n/skills/sql-review');
    await page.locator('.dtabs [aria-label="History"]').click();
    await expect(page.locator('.drawer .hrow').first()).toBeVisible();
    await page.locator('.drawer .hrow', { hasText: 'v3' }).hover();
    await page.locator('.drawer [aria-label="Compare with v2"]').click();
    await expect(page.locator('.modal .diff')).toBeVisible();
    await shot(page, 'desktop-history-diff.png');
    await page.keyboard.press('Escape');

    await page.goto('/n/skills/engineering');
    await page.locator('.acts [aria-label="Share"]').click();
    await expect(page.locator('.modal .prow').first()).toBeVisible();
    await shot(page, 'desktop-share.png');
  });

  test('desktop dark graph', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page);
    await page.goto('/graph');
    await expect(page.locator('#gc')).toBeVisible();
    await page.waitForTimeout(2500);
    await shot(page, 'desktop-graph-dark.png');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });

  test('mobile screenshots', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await expect(page.locator('.m-large')).toHaveText('Library');
    await shot(page, 'mobile-home.png');
    await page.goto('/n/skills/incident-response');
    await expect(page.locator('.m-large')).toHaveText('Incident response');
    await shot(page, 'mobile-skill.png');
    await page.goto('/graph');
    await expect(page.locator('#gc')).toBeVisible();
    await page.waitForTimeout(2500);
    await shot(page, 'mobile-graph.png');
  });
});
