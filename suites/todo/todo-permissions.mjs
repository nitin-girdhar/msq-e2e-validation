// Permission boundary probes:
//  1. read_only: can it create/edit a task via the Tasks UI at all?
//  2. sales_representative: can it reassign its own created task (should be
//     allowed - creator can always edit); can it see/edit other users' tasks
//     it doesn't own (should not, and UI scope=own should just not show them).
import { openAs, visit, record, APPS } from '../../lib.mjs';

const BASE = APPS['todo-web'];

async function testReadOnlyCreate() {
  const ROLE = 'read_only';
  const { browser, page, log } = await openAs(ROLE);
  const TITLE = `E2E-readonly-${Date.now()}`;
  try {
    await visit(page, `${BASE}/tasks`);
    const quickAdd = page.locator('input[placeholder*="Quick-add"]');
    const quickAddVisible = await quickAdd.isVisible().catch(() => false);
    console.log('[read_only] quick-add input visible:', quickAddVisible);

    if (!quickAddVisible) {
      console.log('[read_only] no quick-add control present; treating as correctly restricted (nothing to test further)');
      return;
    }

    await quickAdd.fill(TITLE);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
      quickAdd.press('Enter'),
    ]);
    await page.waitForTimeout(800);
    console.log('[read_only] create task POST status:', resp?.status());

    const created = await page.locator('button', { hasText: TITLE }).first().isVisible().catch(() => false);
    record('todo', {
      severity: 'medium',
      role: ROLE,
      page: '/tasks',
      scenario: 'read_only creates a task via quick-add',
      expected:
        'A CRM-facing "read_only" role either cannot see task creation controls, or the server enforces read-only access at the Tasks-service layer.',
      actual: created
        ? `Task was created successfully (POST ${resp?.status()}) and appears in the list — read_only has full write access to their own Tasks.`
        : `Task creation did not visibly succeed (POST ${resp?.status()}).`,
      evidence: `Tasks-service authorizes purely by task.member_roles rank (independent of the CRM "read_only" role name) — see tasks-service/src/api/v1/tasks/tasks.service.ts createTask() (no rank floor) and middleware/auth.middleware.ts (only rejects rank < 0). If read_only is provisioned with task_member rank in task.member_roles, they get full create/edit on their own tasks regardless of their CRM/org role name. create POST status=${resp?.status()}, badRequests=${JSON.stringify(log.badRequests)}`,
    });
  } finally {
    await browser.close();
  }
}

async function testRepReassignOwnTask() {
  const ROLE = 'sales_representative';
  const { browser, page, log } = await openAs(ROLE);
  const TITLE = `E2E-rep-${Date.now()}`;
  try {
    await visit(page, `${BASE}/tasks`);
    const quickAdd = page.locator('input[placeholder*="Quick-add"]');
    await quickAdd.fill(TITLE);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
      quickAdd.press('Enter'),
    ]);
    await page.waitForTimeout(800);

    const row = page.locator('button', { hasText: TITLE }).first();
    const created = await row.isVisible().catch(() => false);
    if (!created) {
      console.log('[sales_representative] could not create own task to test reassignment; skipping');
      return;
    }
    await row.click();
    const drawer = page.locator('[role="dialog"][aria-label="Task detail"]');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });

    const assigneeBtn = drawer.locator('label:has-text("Assignee")').locator('xpath=following-sibling::*[1]//button');
    await assigneeBtn.click();
    const listbox = drawer.locator('ul[role="listbox"]');
    await listbox.waitFor({ state: 'visible', timeout: 3000 });
    const options = listbox.locator('li[role="option"]');
    const optionTexts = await options.allTextContents();
    console.log('[sales_representative] assignable users visible in picker:', optionTexts.length, optionTexts.slice(0, 8));

    if (optionTexts.length === 0) {
      record('todo', {
        severity: 'medium',
        role: ROLE,
        page: '/tasks',
        scenario: 'sales_representative reassigns own task',
        expected: 'Assignee picker shows at least some org users to reassign to',
        actual: 'Assignee picker listbox had zero options for a sales_representative',
        evidence: 'Opened assignee picker on a self-created task',
      });
      return;
    }
    let idx = optionTexts.findIndex((t) => !/unassigned/i.test(t));
    if (idx < 0) idx = 0;
    await options.nth(idx).click();

    const [saveResp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
      drawer.locator('button', { hasText: 'Save changes' }).click(),
    ]);
    console.log('[sales_representative] reassign own task PATCH status:', saveResp?.status());
    if (saveResp && saveResp.status() >= 400) {
      record('todo', {
        severity: 'high',
        role: ROLE,
        page: '/tasks',
        scenario: 'sales_representative reassigns a task they created',
        expected: 'Creator should always be able to reassign their own task (per canEditTask: row.created_by === me)',
        actual: `PATCH returned ${saveResp.status()}`,
        evidence: `badRequests=${JSON.stringify(log.badRequests)}`,
      });
    } else {
      console.log('[sales_representative] reassigning own created task succeeded as expected');
    }
  } finally {
    await browser.close();
  }
}

await testReadOnlyCreate();
await testRepReassignOwnTask();
console.log('done');
