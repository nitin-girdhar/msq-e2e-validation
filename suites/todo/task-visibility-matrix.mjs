// Task lists, sub-task hierarchy, and the cross-user visibility matrix.
//
// Three things the existing todo suites never covered:
//   1. task LIST create/edit (TASKS_LISTS_MANAGE) per role;
//   2. sub-task hierarchy — parent_task_id exists in the schema but nothing
//      ever created a child task or checked it is scoped with its parent;
//   3. WHO CAN SEE WHAT — one owner creates a private task and a task assigned
//      to someone else, then every other role is asked, via the API, whether it
//      can read/edit them. Read-across and edit-across are reported separately
//      because "can see" and "can change" are different failures.
//
// Every probe is a single authenticated API call per role (no shared-session
// concurrency), and each created row is soft-deleted at the end.
//
//   node suites/todo/task-visibility-matrix.mjs
import { ROLES, record, APPS, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';
import fs from 'node:fs';

const TOOL = 'todo';
const TODO = APPS['todo-web'];
const OWNER = 'org_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const created = [];
const owner = await actor(OWNER);

// ── 1. Task list CRUD as the owner ─────────────────────────────────────────
const listRes = await apiPost(owner, `${TODO}/api/task-lists`, { name: `E2E-list-${stamp}` });
console.log(`create task-list -> ${listRes.status}`);
const listId = listRes.body?.data?.id || listRes.body?.id
  || scalar(`SELECT id FROM task.task_lists WHERE name=${lit(`E2E-list-${stamp}`)} ORDER BY created_at DESC LIMIT 1`);
if (listId) created.push(['task.task_lists', listId]);
if (listRes.status >= 300) {
  record(TOOL, {
    severity: 'medium', role: OWNER, tool: TOOL, page: 'Task lists (POST /api/task-lists)',
    scenario: 'Org admin creates a task list',
    expected: 'A task list is created (201)',
    actual: `Create returned ${listRes.status}: ${JSON.stringify(listRes.body).slice(0, 200)}`,
    evidence: JSON.stringify(listRes.body).slice(0, 300),
    proposedSolution: 'Verify TASKS_LISTS_MANAGE is granted to org-admin rank and that the create handler accepts this payload shape.',
  });
}

// ── 2. Parent task + sub-task hierarchy ────────────────────────────────────
const parent = await apiPost(owner, `${TODO}/api/tasks`, {
  title: `E2E-parent-${stamp}`, priority_name: 'low', status_name: 'todo', ...(listId ? { list_id: listId } : {}),
});
const parentId = parent.body?.data?.id || parent.body?.id
  || scalar(`SELECT id FROM task.tasks WHERE title=${lit(`E2E-parent-${stamp}`)} ORDER BY created_at DESC LIMIT 1`);
if (parentId) created.push(['task.tasks', parentId]);
console.log(`create parent task -> ${parent.status} (${parentId})`);

let childId = null;
if (parentId) {
  const child = await apiPost(owner, `${TODO}/api/tasks`, {
    title: `E2E-child-${stamp}`, priority_name: 'low', status_name: 'todo', parent_task_id: parentId,
  });
  childId = child.body?.data?.id || child.body?.id
    || scalar(`SELECT id FROM task.tasks WHERE title=${lit(`E2E-child-${stamp}`)} ORDER BY created_at DESC LIMIT 1`);
  if (childId) created.push(['task.tasks', childId]);
  console.log(`create sub-task -> ${child.status} (${childId})`);

  const linked = childId ? scalar(`SELECT parent_task_id FROM task.tasks WHERE id=${lit(childId)}`) : null;
  if (child.status >= 300 || (childId && linked !== parentId)) {
    record(TOOL, {
      severity: 'medium', role: OWNER, tool: TOOL, page: 'Sub-tasks (POST /api/tasks with parent_task_id)',
      scenario: 'Create a sub-task under an existing parent task',
      expected: 'The child task is created and task.tasks.parent_task_id points at the parent',
      actual: child.status >= 300
        ? `Create returned ${child.status}: ${JSON.stringify(child.body).slice(0, 160)}`
        : `Child created but parent_task_id="${linked}" (expected "${parentId}") — the hierarchy link was dropped.`,
      evidence: JSON.stringify({ parentId, childId, linked, status: child.status }).slice(0, 300),
      proposedSolution: 'Persist parent_task_id in the create handler and expose the parent/child relation in the task API and UI, or reject the field explicitly if hierarchy is not supported yet.',
    });
  }
}

// ── 3. Visibility matrix: can each role READ / EDIT the owner's tasks? ─────
const matrix = [];
for (const role of ROLES) {
  if (role === OWNER || !fs.existsSync(authFile(role))) continue;
  let a;
  try { a = await actor(role); } catch { continue; }
  try {
    const read = parentId ? await apiGet(a, `${TODO}/api/tasks/${parentId}`) : { status: 0 };
    const edit = parentId
      ? await apiPatch(a, `${TODO}/api/tasks/${parentId}`, { title: `E2E-intrusion-${role}-${stamp}` })
      : { status: 0 };
    // Did the intrusion actually change the row?
    const titleNow = parentId ? scalar(`SELECT title FROM task.tasks WHERE id=${lit(parentId)}`) : '';
    const mutated = String(titleNow).includes(`E2E-intrusion-${role}`);
    matrix.push({ role, read: read.status, edit: edit.status, mutated });
    console.log(`  ${role.padEnd(24)} read=${read.status} edit=${edit.status} mutated=${mutated}`);

    if (mutated) {
      // Someone who is not the owner/assignee actually changed the task.
      record(TOOL, {
        severity: 'high', role, tool: TOOL, page: 'Task edit (PATCH /api/tasks/:id)',
        scenario: `${role} edits a task created by ${OWNER} and not assigned to them`,
        expected: 'Only the owner, the assignee, or a suitably ranked manager/admin may modify the task; others get 403/404',
        actual: `PATCH returned ${edit.status} and the title was actually changed in task.tasks — an unrelated role mutated another user's task.`,
        evidence: JSON.stringify({ taskId: parentId, role, editStatus: edit.status, titleNow }).slice(0, 300),
        proposedSolution: 'Enforce ownership/assignment (or explicit manager scope) in tasks.service.ts update() before applying the patch, not only in the list query.',
      });
      // restore so later roles are tested against a clean title
      q(`UPDATE task.tasks SET title=${lit(`E2E-parent-${stamp}`)} WHERE id=${lit(parentId)}`);
    }
  } finally {
    await a.close();
  }
}

// ── cleanup ────────────────────────────────────────────────────────────────
for (const [table, id] of created) {
  q(`UPDATE ${table} SET is_deleted=TRUE, is_active=FALSE WHERE id=${lit(id)}`);
}
await owner.close();

const readable = matrix.filter((m) => m.read < 300).map((m) => m.role);
const editable = matrix.filter((m) => m.mutated).map((m) => m.role);
console.log(`\nVisibility summary for a task owned by ${OWNER}:`);
console.log(`  can READ  (${readable.length}): ${readable.join(', ') || '-'}`);
console.log(`  can EDIT  (${editable.length}): ${editable.join(', ') || 'none (correct)'}`);
console.log(`cleaned up ${created.length} rows.`);
