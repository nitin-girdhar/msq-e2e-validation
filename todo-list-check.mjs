import { openAs, visit, record, APPS } from './lib.mjs';
const BASE = APPS['todo-web'];
const { browser, page, log } = await openAs('org_admin');
await visit(page, `${BASE}/tasks`);

const LIST_NAME = `E2E-list-${Date.now()}`;
await page.locator('button[aria-label="Create list"]').click();
await page.locator('input[placeholder*="Q3 onboarding"]').fill(LIST_NAME);
const [createListResp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/task-lists') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
  page.locator('button', { hasText: 'Create list' }).click(),
]);
console.log('create list status:', createListResp?.status());
await page.waitForTimeout(800);

const listBtn = page.locator('nav button', { hasText: LIST_NAME });
const listVisible = await listBtn.isVisible().catch(() => false);
console.log('new list visible in sidebar:', listVisible);
if (!listVisible) {
  record('todo', {
    severity: 'medium',
    role: 'org_admin',
    page: '/tasks',
    scenario: 'Create task list',
    expected: 'New list appears in "My lists" sidebar after creation',
    actual: `List not visible in sidebar. create POST status=${createListResp?.status()}`,
    evidence: `badRequests=${JSON.stringify(log.badRequests)}`,
  });
}

await browser.close();
