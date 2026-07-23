import { openAs, visit, APPS } from '../../lib.mjs';
const BASE = APPS['todo-web'];

for (const role of ['read_only', 'sales_representative', 'senior_sales_executive', 'org_manager', 'org_sr_manager', 'org_admin']) {
  const { browser, page } = await openAs(role);
  await visit(page, `${BASE}/tasks`);
  await page.waitForTimeout(400);
  const TITLE = `E2E-pickercheck-${role}`;
  const quickAdd = page.locator('input[placeholder*="Quick-add"]');
  await quickAdd.fill(TITLE);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
    quickAdd.press('Enter'),
  ]);
  await page.waitForTimeout(600);
  const row = page.locator('button', { hasText: TITLE }).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click();
    const drawer = page.locator('[role="dialog"][aria-label="Task detail"]');
    await drawer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const assigneeBtn = drawer.locator('label:has-text("Assignee")').locator('xpath=following-sibling::*[1]//button');
    await assigneeBtn.click().catch(() => {});
    const listbox = drawer.locator('ul[role="listbox"]');
    await listbox.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    const options = await listbox.locator('li[role="option"]').allTextContents().catch(() => []);
    console.log(role, '-> assignable options:', options.length, options.map((o) => o.replace(/\s+/g, ' ').trim()));
  } else {
    console.log(role, '-> could not create task to test picker');
  }
  await browser.close();
}
