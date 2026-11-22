import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke suite against the real local stack (wrangler dev + local D1/R2/KV) loaded with the demo seed.
 * Tests run in order and share the seeded state, the way a person would use the app.
 */

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, as: 'owner' | 'publisher' | 'viewer'): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator(`[data-dev="${as}"]`).click();
  await expect(page.locator('.top .brand, .m-tabs').first()).toBeVisible();
}

async function details(page: Page, tab: string): Promise<void> {
  if (!(await page.locator('.drawer .dtabs').isVisible())) await page.locator('.top [aria-label="Details"]').click();
  await page.locator(`.dtabs [aria-label="${tab}"]`).click();
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto('/n/' + path);
  await expect(page.locator('.crumbs .cur')).toBeVisible();
}

test('signs in as each role', async ({ page }) => {
  await signIn(page, 'owner');
  await expect(page.locator('.rail [aria-label="People"]')).toBeVisible();
  await signIn(page, 'publisher');
  await expect(page.locator('.rail [aria-label="People"]')).toHaveCount(0);
  await open(page, 'skills/code-review');
  await expect(page.locator('.acts [aria-label="Edit"]')).toBeVisible();
  await signIn(page, 'viewer');
  await open(page, 'skills/code-review');
  await expect(page.locator('.md h1')).toHaveText('Code review');
  await expect(page.locator('.acts [aria-label="Edit"]')).toHaveCount(0);
});

test('browses the four areas', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/');
  await expect(page.locator('.tile')).toHaveCount(4);
  for (const [name, item] of [
    ['rules', 'security'],
    ['skills', 'engineering'],
    ['documentation', 'handbook'],
    ['prototypes', 'checkout-flow'],
  ]) {
    await page.goto('/');
    await page.locator('.tile', { hasText: name }).click();
    await expect(page.locator('.fhead h1')).toHaveText(name);
    await expect(page.locator('.items .item', { hasText: item }).first()).toBeVisible();
  }
  await expect(page.locator('.meter')).toHaveCount(0);
  await page.goto('/');
  await page.locator('.tile', { hasText: 'rules' }).click();
  await expect(page.locator('.meter .mnum')).toContainText('/ 8 KB');
});

test('opens a skill and its files', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'skills/deploy-service');
  await expect(page.locator('.skhead code').first()).toHaveText('deploy-service');
  // Top level only: SKILL.md, sub-skills, then one tab per folder.
  await expect(page.locator('.stabs .stab')).toHaveText([/SKILL\.md/, /Sub-skills\s*2/, /scripts\s*1/, /templates\s*1/]);
  await expect(page.locator('.stabs .sback')).toHaveCount(0);
  await page.locator('.stabs .stab', { hasText: 'scripts' }).click();
  await page.locator('.flist .frow', { hasText: 'smoke-test.sh' }).click();
  await expect(page.locator('.code .code-h')).toContainText('smoke-test.sh');
  await expect(page.locator('.code pre')).toContainText('smoke test passed');
  await expect(page.locator('.stabs .stab.on')).toContainText('scripts');
  await page.locator('.stabs .stab', { hasText: 'templates' }).click();
  await page.locator('.flist .frow', { hasText: 'release-notes' }).click();
  await expect(page.locator('.md h1')).toHaveText('Release notes');
  // A sub-skill has a back control to its parent.
  await page.locator('.stabs .stab', { hasText: 'Sub-skills' }).click();
  await page.locator('.flist .frow', { hasText: 'rollback' }).click();
  await page.locator('.stabs .sback').click();
  await expect(page.locator('.skhead code').first()).toHaveText('deploy-service');
});

test('edits a draft with autosave, commits and publishes', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'documentation/handbook/onboarding');
  await page.locator('.acts [aria-label="Edit"]').click();
  await expect(page.locator('#ed-body .ProseMirror')).toBeVisible();
  await page.locator('.fmt [aria-label="Markdown"]').click();
  const cm = page.locator('#ed-raw .cm-content');
  await cm.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nBring a laptop charger on day one.\n');
  await expect(page.locator('#save-ic')).toHaveAttribute('aria-label', 'Saving');
  await expect(page.locator('#save-ic')).toHaveAttribute('aria-label', 'Saved to draft', { timeout: 15_000 });
  const draft = await page.evaluate(async () => (await fetch('/api/v1/docs/documentation%2Fhandbook%2Fonboarding/draft')).json());
  expect(draft.draft.content).toContain('Bring a laptop charger on day one.');
  await page.locator('.acts .btn.primary', { hasText: 'Commit' }).click();
  await page.locator('#commit-msg').fill('Add laptop charger tip');
  await page.locator('.modal label', { hasText: 'Publish now' }).click();
  await page.locator('.modal .btn.primary', { hasText: 'Commit' }).click();
  await expect(page.locator('.toast', { hasText: 'Published v2' })).toBeVisible();
  await expect(page.locator('.md')).toContainText('Bring a laptop charger on day one.');
  await expect(page.locator('.acts .vtext')).toContainText('Published v2');
});

test('publishes a whole skill with publish_skill', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'skills/deploy-service');
  await page.locator('.skhead .btn.primary').click();
  await expect(page.locator('.modal .pf')).not.toHaveCount(0);
  await page.locator('.modal .btn.primary', { hasText: /^Publish \d+ files?$/ }).click();
  await expect(page.locator('.toast', { hasText: 'Published deploy-service' })).toBeVisible();
  await expect(page.locator('.skhead .btn.primary')).toHaveCount(0);
});

test('shows history and rolls back', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'documentation/handbook/onboarding');
  await details(page, 'History');
  await expect(page.locator('.drawer .hrow')).toHaveCount(2);
  await page.locator('.drawer .hrow', { hasText: 'v1' }).hover();
  await page.locator('.drawer [aria-label="Roll back to v1"]').click();
  await expect(page.locator('.modal h2')).toContainText('Publish');
  await page.locator('.modal .btn.primary', { hasText: 'Roll back to v1' }).click();
  await expect(page.locator('.toast', { hasText: 'Rolled back to v1' })).toBeVisible();
  await expect(page.locator('.acts .vtext')).toContainText('Published v1');
});

test('shows links and backlinks', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'documentation/engineering/architecture');
  await details(page, 'Links');
  await expect(page.locator('.drawer svg.lg')).toBeVisible();
  await expect(page.locator('.drawer .sec', { hasText: 'Links to' })).toBeVisible();
  await expect(page.locator('.drawer .lrow', { hasText: 'environments' }).first()).toBeVisible();
  await expect(page.locator('.drawer .sec', { hasText: 'Linked from' })).toBeVisible();
  await expect(page.locator('.drawer .lrow', { hasText: 'onboarding' }).first()).toBeVisible();
  // A chip in the body navigates to its target.
  await page.locator('.md a.wl', { hasText: 'environments' }).first().click();
  await expect(page.locator('.md h1')).toHaveText('Environments');
});

test('renders the graph and opens a node', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/graph');
  await expect(page.locator('#gc')).toBeVisible();
  const size = await page.locator('#gc').evaluate((c: HTMLCanvasElement) => c.width * c.height);
  expect(size).toBeGreaterThan(10000);
  await page.locator('#gq').fill('architecture');
  await page.locator('#gq').press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Architecture');
});

test('searches', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/');
  await page.locator('#q').fill('rollback');
  await expect(page.locator('.sres .sr').first()).toBeVisible();
  await page.locator('.sres .sr', { hasText: 'rollback' }).first().click();
  await expect(page.locator('.crumbs .cur')).toBeVisible();
  expect(page.url()).toContain('/n/');
});

test('shows warnings and dismisses and restores them', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'skills/discovery-call');
  const btn = page.locator('.acts .lint-btn');
  await expect(btn).toHaveText('2');
  await btn.click();
  await expect(page.locator('.menu .lint-i')).toHaveCount(2);
  await page.locator('.menu .lint-i [aria-label="Dismiss"]').first().click();
  await expect(btn).toHaveText('1');
  // The menu stays open while warnings remain, with the restore control below them.
  await page.locator('.menu .mi[data-tip="Restore dismissed"]').click();
  await expect(btn).toHaveText('2');
});

test('opens a prototype: live preview, viewports, files', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/');
  await expect(page.locator('.tile')).toHaveCount(4);
  await page.goto('/n/prototypes/checkout-flow');
  await expect(page.locator('.stabs .stab')).toHaveText([/Preview/, /index\.html/, /app\.js/, /notes/, /styles\.css/]);
  const frame = page.frameLocator('iframe.pv-frame');
  await expect(frame.locator('[data-panel="1"] h1')).toHaveText('Your cart');
  // The prototype's own script runs: Continue moves to the next step.
  await frame.locator('#next').click();
  await expect(frame.locator('[data-panel="2"] h1')).toHaveText('Shipping');
  await page.locator('.pv-bar [aria-label="Phone"]').click();
  await expect(page.locator('.pv-stage.phone iframe')).toBeVisible();
  await page.locator('.stabs .stab', { hasText: 'app.js' }).click();
  await expect(page.locator('.code .code-h')).toContainText('app.js');
  await expect(page.locator('.stabs .stab.on')).toContainText('app.js');
});

test('shares a folder', async ({ page }) => {
  await signIn(page, 'owner');
  await open(page, 'documentation/handbook');
  await page.locator('.acts [aria-label="Share"]').click();
  await page.locator('#share-q').fill('Tom');
  await page.locator('.sugg .mi', { hasText: 'Tom Becker' }).click();
  await page.locator('.modal .addrow .btn.primary', { hasText: 'Add' }).click();
  await expect(page.locator('.toast', { hasText: 'Shared with Tom Becker' })).toBeVisible();
  await expect(page.locator('.modal .prow', { hasText: 'Tom Becker' })).toBeVisible();
});

test('a viewer cannot see drafts or unpublished documents', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.goto('/n/documentation/data/dbt-conventions');
  await expect(page.locator('.empty', { hasText: 'Not found or no access' })).toBeVisible();
  await open(page, 'skills/sql-review');
  await expect(page.locator('.banner')).toHaveCount(0);
  await expect(page.locator('.vtext')).toHaveCount(0);
  const r = await page.evaluate(async () => (await fetch('/api/v1/docs/skills%2Fsql-review/draft')).status);
  expect([403, 404]).toContain(r);
  await page.goto('/n/documentation/data');
  await expect(page.locator('.items .item', { hasText: 'warehouse' })).toBeVisible();
  await expect(page.locator('.items .item', { hasText: 'dbt-conventions' })).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('tab bar, push navigation and a sheet', async ({ page }) => {
    await signIn(page, 'owner');
    await page.goto('/');
    await expect(page.locator('.m-tabs button')).toHaveCount(4);
    await expect(page.locator('.m-large')).toHaveText('Library');
    await page.locator('.m-row', { hasText: 'skills' }).click();
    await expect(page.locator('.m-large')).toHaveText('skills');
    await page.locator('.m-row', { hasText: 'engineering' }).click();
    await page.locator('.m-row', { hasText: 'code-review' }).click();
    await expect(page.locator('.m-large')).toHaveText('Code review');
    await page.locator('.m-nav [aria-label="Details"]').click();
    await expect(page.locator('.modal.m-drawer')).toBeVisible();
    await page.locator('.modal-scrim').click();
    await expect(page.locator('.modal.m-drawer')).toHaveCount(0);
    await page.locator('.m-nav [data-back]').click();
    await expect(page.locator('.m-large')).toHaveText('engineering');
    await page.locator('.m-tabs [aria-label="Search"]').click();
    await page.locator('#mq').fill('canary');
    await expect(page.locator('.m-res .m-row').first()).toBeVisible();
    await page.locator('.m-tabs [aria-label="Account"]').click();
    await expect(page.locator('.m-large')).toHaveText('Account');
  });
});
