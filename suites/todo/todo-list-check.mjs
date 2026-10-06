import { openAs, visit, record, APPS } from '../../lib.mjs';
const BASE = APPS['todo-web'];
const { browser, page, log } = await openAs('org_admin');
// Lists are managed on Lists & Scopes (the old "My lists" sidebar was removed in the
// 1.67.0 redesign), so create the list there.
await visit(page, `${BASE}/tasks/lists`);

const LIST_NAME = `E2E-list-${Date.now()}`;
await page.getByRole('button', { name: '+ New list' }).click();
await page.locator('input[placeholder*="Q3 onboarding"]').fill(LIST_NAME);
const [createListResp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/task-lists') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
  page.getByRole('dialog').getByRole('button', { name: 'Create list' }).click(),
]);
console.log('create list status:', createListResp?.status());
await page.waitForTimeout(800);

const listCard = page.getByRole('heading', { name: LIST_NAME });
const listVisible = await listCard.isVisible().catch(() => false);
console.log('new list visible on Lists & Scopes:', listVisible);
if (!listVisible) {
  record('todo', {
    severity: 'medium',
    role: 'org_admin',
    page: '/tasks/lists',
    scenario: 'Create task list',
    expected: 'New list appears on the Lists & Scopes page after creation',
    actual: `List not visible on the page. create POST status=${createListResp?.status()}`,
    evidence: `badRequests=${JSON.stringify(log.badRequests)}`,
  });
}

await browser.close();
