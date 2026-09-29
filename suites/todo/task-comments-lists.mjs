// Tasks: comments, status history and task-list ownership — endpoints no suite
// referenced before this pass (GET/POST /tasks/:id/comments, GET
// /tasks/:id/status-history, GET/PATCH/DELETE /task-lists/:id, GET /tasks/mine).
//
// tasks.service guards comments/history with loadVisible() and lists with
// assertCanView()/loadForWrite(). This proves those guards hold across people
// who share a branch but not the record, and across tenants:
//
//   * rep1 creates a PRIVATE list and a private, unassigned task in it;
//   * rep2 (same branch, same role) must not read/comment/see history of the
//     task, nor read/rename/delete the list;
//   * a tenant-B user must not either (critical if it can);
//   * rep1's own status changes are recorded in the history, in order.
//
// Everything is throwaway (title/name E2E-task-<stamp>) and purged at the end.
//
//   node suites/todo/task-comments-lists.mjs
import { APPS, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch, apiDelete } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, purgeById } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'todo';
const fail = finder(TOOL, 'Task comments, history & lists');
const T = `${APPS['todo-web']}/api`;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
for (const k of ['sales_representative', 'rep2']) if (!fs.existsSync(authFile(k))) { console.log(`${k} login required — aborting`); process.exit(0); }

const MARK = `E2E-task-${Date.now()}`;
const rep1 = await actor('sales_representative');
const rep2 = await actor('rep2');
const bKey = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)))?.stateKey;
const b = bKey ? await actor(bKey) : null;

try {
  const list = await apiPost(rep1, `${T}/task-lists`, { name: `${MARK}-list`, visibility: 'private' });
  const listId = list.body?.data?.id ?? scalar(`SELECT id FROM task.task_lists WHERE name=${lit(`${MARK}-list`)} LIMIT 1`);
  const task = await apiPost(rep1, `${T}/tasks`, { title: `${MARK}-task`, list_id: listId ?? null, assignee_id: null });
  const taskId = task.body?.data?.id ?? scalar(`SELECT id FROM task.tasks WHERE title=${lit(`${MARK}-task`)} LIMIT 1`);
  console.log(`setup list http=${list.status} task http=${task.status}`);
  if (!taskId) {
    fail('high', 'sales_representative', 'Create a private task', '201', `list=${list.status} task=${task.status}`, JSON.stringify(task.body).slice(0, 200), 'A rep must be able to create their own task (tasks.create). A 500 here: check the task_svc RLS policies and platform.write for the role.');
    throw new Error('stop');
  }

  // ── Owner path: comment + status history ──────────────────────────────────
  const c = await apiPost(rep1, `${T}/tasks/${taskId}/comments`, { body: 'e2e owner comment' });
  const cl = await apiGet(rep1, `${T}/tasks/${taskId}/comments`);
  console.log(`owner comment http=${c.status} list http=${cl.status}`);
  if (!isOk(c.status) || !isOk(cl.status)) fail('medium', 'sales_representative', 'Owner cannot comment on / read comments of their own task', '2xx', `add=${c.status} list=${cl.status}`, JSON.stringify(c.body).slice(0, 200), 'loadVisible must pass for the creator.');
  for (const s of ['in_progress', 'done']) await apiPatch(rep1, `${T}/tasks/${taskId}`, { status_name: s });
  const h = await apiGet(rep1, `${T}/tasks/${taskId}/status-history`);
  const hist = Array.isArray(h.body?.data) ? h.body.data : [];
  const names = JSON.stringify(hist);
  console.log(`status-history http=${h.status} entries=${hist.length}`);
  if (!isOk(h.status)) fail('medium', 'sales_representative', 'Task status history does not load', '2xx', `HTTP ${h.status}`, JSON.stringify(h.body).slice(0, 200), 'Check listStatusHistory against task.task_status_log.');
  else if (hist.length < 2 || !/in_progress/.test(names) || !/done/.test(names)) fail('medium', 'sales_representative', 'Status changes are not recorded in the task history', 'At least todo→in_progress and in_progress→done entries', `${hist.length} entries: ${names.slice(0, 200)}`, taskId, 'The status-change trigger on task.tasks must write task.task_status_log for every transition (and the API must return it).');

  const mine = await apiGet(rep1, `${T}/tasks/mine`);
  if (mine.status >= 500) fail('high', 'sales_representative', 'GET /tasks/mine 5xxs', '2xx', `HTTP ${mine.status}`, JSON.stringify(mine.body).slice(0, 200), 'Check listMine filters (queryBool coercion) and RLS.');

  // ── Outsiders: rep2 (same branch) and tenant B ────────────────────────────
  for (const [who, a, sev] of [['rep2 (same branch)', rep2, 'high'], [`${bKey} (tenant B)`, b, 'critical']].filter(([, x]) => x)) {
    const probes = {
      'read task': await apiGet(a, `${T}/tasks/${taskId}`),
      'read comments': await apiGet(a, `${T}/tasks/${taskId}/comments`),
      'add comment': await apiPost(a, `${T}/tasks/${taskId}/comments`, { body: `e2e intrusion by ${who}` }),
      'read status history': await apiGet(a, `${T}/tasks/${taskId}/status-history`),
      ...(listId ? {
        'read private list': await apiGet(a, `${T}/task-lists/${listId}`),
        'rename private list': await apiPatch(a, `${T}/task-lists/${listId}`, { name: `${MARK}-list-hijacked` }),
      } : {}),
    };
    const leaked = Object.entries(probes).filter(([, r]) => isOk(r.status)).map(([k]) => k);
    const crashed = Object.entries(probes).filter(([, r]) => r.status >= 500).map(([k, r]) => `${k}:${r.status}`);
    console.log(`${who.padEnd(28)} ${Object.entries(probes).map(([k, r]) => `${k}=${r.status}`).join(' ')}`);
    if (leaked.length) fail(sev, who, `${who} can ${leaked.join(', ')} on someone else's PRIVATE task/list`, '403/404 — private items are visible to their creator/assignee only', leaked.join(', '), `task=${taskId} list=${listId}`, 'Route every per-task read/write through loadVisible()/assertCanView(); for tenant B this also means the query is not running under the caller\'s RLS context.');
    if (crashed.length) fail('medium', who, `Private task probes 5xx for ${who}`, '403/404', crashed.join(', '), `task=${taskId}`, 'Throw NotFound/Forbidden from the visibility guard instead of letting the cast/RLS error surface.');
    const renamed = listId && scalar(`SELECT name FROM task.task_lists WHERE id=${lit(listId)}`) === `${MARK}-list-hijacked`;
    if (renamed) fail(sev, who, `${who} RENAMED a private task list they do not own`, 'Row unchanged', 'task.task_lists.name changed', listId, 'loadForWrite must require ownership (or a manage scope over the owner).');
  }
  if (listId) {
    const del = await apiDelete(rep2, `${T}/task-lists/${listId}`);
    const gone = scalar(`SELECT is_deleted::text FROM task.task_lists WHERE id=${lit(listId)}`) === 'true';
    console.log(`rep2 delete rep1's private list http=${del.status} deleted=${gone}`);
    if (gone) fail('high', 'rep2 (same branch)', 'A rep deleted a colleague\'s private task list', '403/404 and the list survives', `HTTP ${del.status}, is_deleted=true`, listId, 'deleteTaskList → loadForWrite must reject non-owners.');
  }
} catch (e) {
  if (e.message !== 'stop') throw e;
} finally {
  for (const a of [rep1, rep2, b]) if (a) await a.close();
  for (const id of rows(`SELECT id FROM task.tasks WHERE title LIKE ${lit(`${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.tasks', id);
  for (const id of rows(`SELECT id FROM task.task_lists WHERE name LIKE ${lit(`${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.task_lists', id);
  console.log('\npurged throwaway task + list.');
}
