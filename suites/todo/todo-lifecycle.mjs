// Core task lifecycle test as org_admin: create -> assign -> status -> priority
// -> comment -> save -> reload -> verify persistence. Also probes empty-title
// validation and a very long comment.
import { openAs, visit, record, APPS } from '../../lib.mjs';

const BASE = APPS['todo-web'];
const ROLE = 'org_admin';
const TITLE = `E2E-lifecycle-${Date.now()}`;

const { browser, page, log } = await openAs(ROLE);

try {
  await visit(page, `${BASE}/tasks`);

  // ---- CREATE via quick-add ----
  const quickAdd = page.locator('input[placeholder*="Quick-add"]');
  await quickAdd.fill(TITLE);
  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
    quickAdd.press('Enter'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);

  console.log('create response status:', createResp?.status());

  const row = page.locator('button', { hasText: TITLE }).first();
  const created = await row.isVisible().catch(() => false);
  if (!created) {
    record('todo', {
      severity: 'critical',
      role: ROLE,
      page: '/tasks',
      scenario: 'Create task via quick-add',
      expected: `Task "${TITLE}" appears in list after quick-add + Enter`,
      actual: `Task did not appear in list. create POST status=${createResp?.status()}`,
      evidence: `consoleErrors=${JSON.stringify(log.consoleErrors)} badRequests=${JSON.stringify(log.badRequests)}`,
    });
  } else {
    console.log('CREATE ok:', TITLE);
  }

  // ---- Open detail drawer ----
  await row.click();
  const drawer = page.locator('[role="dialog"][aria-label="Task detail"]');
  await drawer.waitFor({ state: 'visible', timeout: 5000 });

  // ---- ASSIGN via UserPicker (custom button + listbox, NOT a native <select>) ----
  const assigneeBtn = drawer.locator('label:has-text("Assignee")').locator('xpath=following-sibling::*[1]//button');
  await assigneeBtn.click();
  const listbox = drawer.locator('ul[role="listbox"]');
  await listbox.waitFor({ state: 'visible', timeout: 3000 });
  const optionEls = listbox.locator('li[role="option"]');
  const optionCount = await optionEls.count();
  let assignedLabel = '';
  if (optionCount === 0) {
    record('todo', {
      severity: 'high',
      role: ROLE,
      page: '/tasks',
      scenario: 'Assignee dropdown population',
      expected: 'Assignee picker lists assignable org users',
      actual: 'Assignee listbox opened with zero <li role="option"> entries',
      evidence: `badRequests=${JSON.stringify(log.badRequests)}`,
    });
  } else {
    // pick a real user (skip "Unassigned" if present as option 0)
    const texts = await optionEls.allTextContents();
    let idx = texts.findIndex((t) => !/unassigned/i.test(t));
    if (idx < 0) idx = 0;
    assignedLabel = texts[idx];
    await optionEls.nth(idx).click();
  }
  await page.waitForTimeout(200);

  // ---- STATUS + PRIORITY dropdowns ----
  const statusSelect = drawer.locator('select').filter({ has: page.locator('option', { hasText: 'Blocked' }) });
  const prioritySelect = drawer.locator('select').filter({ has: page.locator('option', { hasText: 'Urgent' }) });
  await statusSelect.selectOption('blocked');
  await prioritySelect.selectOption('urgent');

  // ---- COMMENT ----
  const commentMarker = `E2E-comment-${Date.now()}-`;
  const commentBody = commentMarker + 'x'.repeat(2000); // long comment edge case (~2012 chars, under 5000 schema limit)
  const commentInput = drawer.locator('input[placeholder="Add a comment…"]');
  await commentInput.fill(commentBody);
  const postBtn = drawer.locator('button', { hasText: 'Post' });
  const [commentResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/comments') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
    postBtn.click(),
  ]);
  await page.waitForTimeout(800);
  console.log('comment POST status:', commentResp?.status());

  const commentPosted = await drawer.locator('li', { hasText: commentMarker }).first().isVisible().catch(() => false);
  if (!commentPosted) {
    record('todo', {
      severity: 'high',
      role: ROLE,
      page: '/tasks',
      scenario: 'Add very long comment (~2000 chars)',
      expected: 'Comment posts (2xx) and appears in comment list',
      actual: `Comment did not appear after posting. POST status=${commentResp?.status()}`,
      evidence: `badRequests=${JSON.stringify(log.badRequests)} consoleErrors=${JSON.stringify(log.consoleErrors)}`,
    });
  } else {
    console.log('COMMENT ok (long comment posted)');
  }

  // ---- SAVE ----
  log.badRequests.length = 0;
  const saveBtn = drawer.locator('button', { hasText: 'Save changes' });
  const [saveResp] = await Promise.all([
    page.waitForResponse((r) => /\/api\/tasks\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH', { timeout: 8000 }).catch(() => null),
    saveBtn.click(),
  ]);
  await page.waitForTimeout(500);
  console.log('save PATCH status:', saveResp?.status());

  const drawerStillOpen = await drawer.isVisible().catch(() => false);
  console.log('after save: drawerStillOpen=', drawerStillOpen, 'badRequests=', log.badRequests);

  // ---- RELOAD and verify persistence ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  const rowAfter = page.locator('button', { hasText: TITLE }).first();
  const stillListed = await rowAfter.isVisible().catch(() => false);
  if (!stillListed) {
    record('todo', {
      severity: 'critical',
      role: ROLE,
      page: '/tasks',
      scenario: 'Reload persistence check (task still listed)',
      expected: `Task "${TITLE}" still visible in "My Tasks" after reload`,
      actual: 'Task not found in list after reload',
      evidence: 'reproduced: reloaded page and searched by title text',
    });
  } else {
    await rowAfter.click();
    await drawer.waitFor({ state: 'visible', timeout: 5000 });

    const statusAfter = await statusSelect.inputValue().catch(() => null);
    const priorityAfter = await prioritySelect.inputValue().catch(() => null);
    const commentsAfter = await drawer.locator('li', { hasText: commentMarker }).count();
    const assigneeBtnAfter = drawer.locator('label:has-text("Assignee")').locator('xpath=following-sibling::*[1]//button');
    const assigneeLabelAfter = (await assigneeBtnAfter.textContent().catch(() => '')) || '';

    console.log('PERSISTENCE CHECK', { statusAfter, priorityAfter, commentsAfter, assigneeLabelAfter: assigneeLabelAfter.trim(), assignedLabel: assignedLabel.trim() });

    if (statusAfter !== 'blocked') {
      record('todo', {
        severity: 'critical',
        role: ROLE,
        page: '/tasks',
        scenario: 'Status change persistence',
        expected: 'Status = "blocked" after save + reload',
        actual: `Status field shows "${statusAfter}"`,
        evidence: 'Re-opened task detail drawer after full page reload and read <select> value directly',
      });
    }
    if (priorityAfter !== 'urgent') {
      record('todo', {
        severity: 'critical',
        role: ROLE,
        page: '/tasks',
        scenario: 'Priority change persistence',
        expected: 'Priority = "urgent" after save + reload',
        actual: `Priority field shows "${priorityAfter}"`,
        evidence: 'Re-opened task detail drawer after full page reload and read <select> value directly',
      });
    }
    if (commentsAfter === 0) {
      record('todo', {
        severity: 'high',
        role: ROLE,
        page: '/tasks',
        scenario: 'Comment persistence',
        expected: 'Long comment still present after reload',
        actual: 'No matching comment found after reload',
        evidence: `commentResp status=${commentResp?.status()}; re-opened task detail drawer after full page reload`,
      });
    }
    if (assignedLabel && !assigneeLabelAfter.includes(assignedLabel.trim().split('\n')[0].slice(0, 10))) {
      record('todo', {
        severity: 'high',
        role: ROLE,
        page: '/tasks',
        scenario: 'Assignee change persistence',
        expected: `Assignee remains set to "${assignedLabel.trim()}" after reload`,
        actual: `Assignee button shows "${assigneeLabelAfter.trim()}"`,
        evidence: 'Re-opened task detail drawer after full page reload',
      });
    }
  }

  // ---- Empty-title validation edge case ----
  await drawer.locator('button[aria-label="Close"]').click().catch(() => {});
  await page.waitForTimeout(300);
  await rowAfter.click().catch(() => {});
  await drawer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.locator('label:has-text("Title")').locator('xpath=following-sibling::input[1]').fill('');
  const saveBtnAfterEmpty = drawer.locator('button', { hasText: 'Save changes' });
  const disabledWhenEmpty = await saveBtnAfterEmpty.isDisabled().catch(() => null);
  console.log('Save button disabled when title empty?', disabledWhenEmpty);
  if (disabledWhenEmpty === false) {
    record('todo', {
      severity: 'medium',
      role: ROLE,
      page: '/tasks',
      scenario: 'Empty title validation',
      expected: 'Save button disabled (or server rejects) when title is blank',
      actual: 'Save button remained enabled with empty title',
      evidence: 'Cleared title input, checked disabled attribute on Save changes button',
    });
  }
} catch (e) {
  console.error('SCRIPT ERROR', e);
} finally {
  await browser.close();
}
