import { openAs, visit, APPS } from '../../lib.mjs';
const BASE = APPS['todo-web'];
const { browser, page } = await openAs('org_admin');
await visit(page, `${BASE}/tasks`);
const TITLE = `E2E-duecheck-${Date.now()}`;
const quickAdd = page.locator('input[placeholder*="Quick-add"]');
await quickAdd.fill(TITLE);
await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
  quickAdd.press('Enter'),
]);
await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(1500);
const row = page.locator('button', { hasText: TITLE }).first();
await row.waitFor({ state: 'visible', timeout: 10000 });
await row.click();
const drawer = page.locator('[role="dialog"][aria-label="Task detail"]');
await drawer.waitFor({ state: 'visible', timeout: 5000 });
const dueInput = drawer.locator('input[type="date"]');
await dueInput.fill('2026-08-15');
await Promise.all([
  page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
  drawer.locator('button', { hasText: 'Save changes' }).click(),
]);
await page.waitForTimeout(600);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(600);
await page.locator('button', { hasText: TITLE }).first().click();
await drawer.waitFor({ state: 'visible', timeout: 5000 });
const dueAfter = await dueInput.inputValue();
console.log('set 2026-08-15, read back after reload:', dueAfter);
await browser.close();
