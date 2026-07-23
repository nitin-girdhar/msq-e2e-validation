// Filters (status/priority/show-completed), due-date persistence, and
// complete -> reopen flow, as org_admin.
import { openAs, visit, record, APPS } from '../../lib.mjs';

const BASE = APPS['todo-web'];
const ROLE = 'org_admin';
const TITLE = `E2E-filtertest-${Date.now()}`;

const { browser, page, log } = await openAs(ROLE);

try {
  await visit(page, `${BASE}/tasks`);

  // Create a task to manipulate.
  const quickAdd = page.locator('input[placeholder*="Quick-add"]');
  await quickAdd.fill(TITLE);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
    quickAdd.press('Enter'),
  ]);
  await page.waitForTimeout(700);

  const row = page.locator('button', { hasText: TITLE }).first();
  if (!(await row.isVisible().catch(() => false))) {
    console.log('setup failed: could not create test task; aborting filter test');
    await browser.close();
    process.exit(0);
  }

  // ---- Set a due date via the detail drawer ----
  await row.click();
  const drawer = page.locator('[role="dialog"][aria-label="Task detail"]');
  await drawer.waitFor({ state: 'visible', timeout: 5000 });

  const dueInput = drawer.locator('input[type="date"]');
  const targetDate = '2026-08-15';
  await dueInput.fill(targetDate);

  const [saveResp] = await Promise.all([
    page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
    drawer.locator('button', { hasText: 'Save changes' }).click(),
  ]);
  console.log('due date save status:', saveResp?.status());
  await page.waitForTimeout(500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);

  const rowAfterDue = page.locator('button', { hasText: TITLE }).first();
  await rowAfterDue.click();
  await drawer.waitFor({ state: 'visible', timeout: 5000 });
  const dueAfter = await dueInput.inputValue().catch(() => null);
  console.log('due date after reload:', dueAfter);
  if (dueAfter !== targetDate) {
    record('todo', {
      severity: 'high',
      role: ROLE,
      page: '/tasks',
      scenario: 'Due-date persistence',
      expected: `Due date = ${targetDate} after save + reload`,
      actual: `Due date field shows "${dueAfter}"`,
      evidence: `save PATCH status=${saveResp?.status()}`,
    });
  }

  // ---- Mark complete (status = done) and verify default-list hides it ----
  const statusSelect = drawer.locator('select').filter({ has: page.locator('option', { hasText: 'Blocked' }) });
  await statusSelect.selectOption('done');
  await Promise.all([
    page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
    drawer.locator('button', { hasText: 'Save changes' }).click(),
  ]);
  await page.waitForTimeout(700);

  // Default list (include_completed unchecked) should now hide it.
  const stillVisibleDefault = await page.locator('button', { hasText: TITLE }).first().isVisible().catch(() => false);
  console.log('visible in default (incomplete-only) list after marking done:', stillVisibleDefault);
  if (stillVisibleDefault) {
    record('todo', {
      severity: 'medium',
      role: ROLE,
      page: '/tasks',
      scenario: 'Mark task done / default filter hides completed',
      expected: 'A "done" task disappears from the default list (Show completed unchecked)',
      actual: 'Task remained visible in the default (incomplete-only) list after being marked done',
      evidence: 'Set status to done, saved, task still matched by title in the default My Tasks list',
    });
  }

  // Now toggle "Show completed" and verify it reappears (reopen path).
  const showCompleted = page.locator('label', { hasText: 'Show completed' }).locator('input[type="checkbox"]');
  await showCompleted.check();
  await page.waitForTimeout(700);
  const visibleWithShowCompleted = await page.locator('button', { hasText: TITLE }).first().isVisible().catch(() => false);
  console.log('visible with Show completed checked:', visibleWithShowCompleted);
  if (!visibleWithShowCompleted) {
    record('todo', {
      severity: 'medium',
      role: ROLE,
      page: '/tasks',
      scenario: '"Show completed" filter reveals done tasks',
      expected: 'Checking "Show completed" reveals the done task',
      actual: 'Task still not visible after checking "Show completed"',
      evidence: `badRequests=${JSON.stringify(log.badRequests)}`,
    });
  } else {
    // Reopen it: set status back to todo.
    await page.locator('button', { hasText: TITLE }).first().click();
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    await statusSelect.selectOption('todo');
    const [reopenResp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
      drawer.locator('button', { hasText: 'Save changes' }).click(),
    ]);
    console.log('reopen (status back to todo) save status:', reopenResp?.status());
  }

  // ---- Status filter chip check ----
  await page.locator('button[aria-label="Close"]').click().catch(() => {});
  await showCompleted.uncheck().catch(() => {});
  const statusFilter = page.locator('select[aria-label="Filter by status"]');
  await statusFilter.selectOption('blocked');
  await page.waitForTimeout(600);
  const noneMatchBlocked = await page.locator('button', { hasText: TITLE }).first().isVisible().catch(() => false);
  console.log('task (status=todo) visible when filtering by "Blocked"?', noneMatchBlocked, '(expected false)');
  if (noneMatchBlocked) {
    record('todo', {
      severity: 'medium',
      role: ROLE,
      page: '/tasks',
      scenario: 'Status filter chip correctness',
      expected: 'Filtering by "Blocked" should not show a task whose status is "todo"',
      actual: 'Task remained visible while status filter was set to Blocked',
      evidence: 'Selected "Blocked" in the status filter chip; test task status was reopened to "todo" moments earlier',
    });
  }
  await statusFilter.selectOption('');
} catch (e) {
  console.error('SCRIPT ERROR', e);
} finally {
  await browser.close();
}
