// CONCURRENCY: two users edit the SAME task's title at the same time. This
// checks whether a simultaneous edit silently loses one user's change with no
// conflict signal. Non-destructive: we create a throwaway task, race two title
// edits, verify the DB, then soft-delete our task.
//
// PATCH /api/tasks/:id supports optimistic concurrency via `expected_updated_at`
// (OPTIONAL by design — a caller that omits it still gets last-writer-wins), so
// both editors read the task first and send the version they opened.
//
//   node suites/concurrency/todo-task-double-edit.mjs
import { APPS, record } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch, simultaneously } from '../../conc.mjs';
import { dbReachable, one, scalar, lit } from '../../db.mjs';

const TOOL = 'concurrency';
const TODO = APPS['todo-web'];
const EDITORS = ['org_admin', 'org_sr_manager']; // e1 edits as admin, e2 edits as assignee

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const [e1, e2] = await Promise.all(EDITORS.map((r) => actor(r)));

// Assign the task to the second editor so BOTH have edit access (admin can edit
// any task in-org; the assignee can edit their own) — otherwise the second
// editor gets a 404/403 and there is no real concurrent-write to observe.
const assigneeId = scalar(`SELECT id FROM iam.users WHERE email='srmanager@fitclass.ggn.in' LIMIT 1`);

// 1. Create a throwaway task as the first editor, assigned to the second.
const stamp = Date.now();
const created = await apiPost(e1, `${TODO}/api/tasks`, {
  title: `E2E-conc-${stamp}`, description: 'concurrency probe', priority_name: 'low', status_name: 'todo',
  assignee_id: assigneeId,
});
console.log(`Create task -> ${created.status}`);
if (created.status >= 300) {
  console.log('Could not create a task — aborting:', JSON.stringify(created.body).slice(0, 200));
  await e1.close(); await e2.close(); process.exit(0);
}
const taskId = created.body?.data?.id || created.body?.id
  || scalar(`SELECT id FROM task.tasks WHERE title=${lit(`E2E-conc-${stamp}`)} ORDER BY created_at DESC LIMIT 1`);
if (!taskId) { console.log('No task id resolved — aborting'); await e1.close(); await e2.close(); process.exit(0); }
console.log(`Task ${taskId}`);

// 2. Both editors open the task, then race two title edits against the version
// they each saw — the same `expected_updated_at` token TaskDetailDrawer sends.
const o1 = await apiGet(e1, `${TODO}/api/tasks/${taskId}`);
const o2 = await apiGet(e2, `${TODO}/api/tasks/${taskId}`);
const v1 = o1.body?.data?.updated_at, v2 = o2.body?.data?.updated_at;
if (!v1 || !v2) {
  console.log('Could not read updated_at for both editors — aborting');
  await e1.close(); await e2.close(); process.exit(0);
}
const exp1 = new Date(v1).toISOString(), exp2 = new Date(v2).toISOString();
console.log(`Both editors opened version ${exp1} (identical: ${exp1 === exp2})`);

const titleA = `E2E-A-${stamp}`, titleB = `E2E-B-${stamp}`;
const [r1, r2] = await simultaneously([
  () => apiPatch(e1, `${TODO}/api/tasks/${taskId}`, { title: titleA, expected_updated_at: exp1 }),
  () => apiPatch(e2, `${TODO}/api/tasks/${taskId}`, { title: titleB, expected_updated_at: exp2 }),
]);
console.log(`${EDITORS[0]} PATCH -> ${r1.status}; ${EDITORS[1]} PATCH -> ${r2.status}`);

// 3. Verify.
await new Promise((r) => setTimeout(r, 500));
const finalTitle = scalar(`SELECT title FROM task.tasks WHERE id=${lit(taskId)}`);
console.log(`DB final title="${finalTitle}"`);

const bothAccepted = r1.status < 300 && r2.status < 300;
const conflictSignalled = [r1.status, r2.status].includes(409);
if (bothAccepted && !conflictSignalled) {
  record(TOOL, {
    severity: 'medium', role: EDITORS.join(' + '), page: 'Task edit (PATCH /api/tasks/:id)',
    scenario: 'Two users edit the same task field simultaneously',
    expected: 'The second concurrent write is rejected/merged with a conflict signal, or the loser is warned their change was overwritten',
    actual: `Both writes returned 2xx with no conflict; final DB title="${finalTitle}". One edit was silently lost (last-writer-wins, no version guard).`,
    evidence: JSON.stringify({ taskId, titleA, titleB, statusA: r1.status, statusB: r2.status, finalTitle }),
    proposedSolution: 'Add optimistic concurrency to PATCH /api/tasks/:id (updated_at / version guarded UPDATE returning 409 on mismatch) and reflect a "task changed" reload prompt in the task editor.',
  });
  console.log('RECORDED: silent lost update on tasks.');
} else {
  console.log(`No lost-update defect: bothAccepted=${bothAccepted} conflictSignalled=${conflictSignalled}`);
}

// 4. Cleanup — soft-delete our throwaway task directly (no destructive UI action).
one(`UPDATE task.tasks SET is_deleted=TRUE, is_active=FALSE, deleted_at=NOW() WHERE id=${lit(taskId)} RETURNING id`);
await e1.close(); await e2.close();
console.log('done (task soft-deleted).');
