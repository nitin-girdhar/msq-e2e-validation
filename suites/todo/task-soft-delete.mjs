// Tasks: DELETE /tasks/:id and DELETE /task-lists/:id (schema 1.68.0 soft delete) - the one write
// path tasks-v2.mjs and task-comments-lists.mjs do not exercise.
//
// Why it needs its own suite: task.tasks / task.task_lists RLS hides deleted rows
// (USING ... NOT is_deleted), so an app_user UPDATE ... SET is_deleted = TRUE is always refused
// (a bare 500 in the first Stitch build). The fix runs the soft delete in withServiceTx - which
// BYPASSES RLS and withRoleTx's read-only defence - so the authorisation is entirely in the service
// layer (creator or tasks.edit.any / administer; ctx.readOnly refusal; org_id fence in the UPDATE).
// A bug there degrades to a cross-user / cross-branch / cross-tenant delete with no RLS backstop.
//
// Principals (Tasks is licensed for MSquare, not Fitclass - same as tasks-v2.mjs):
//   rep = msq_rep1 (creator of its own tasks, no admin), oa = msq_org_admin, ta = msq_tenant_admin,
//   f   = Fitclass sales_representative, granted tasks.* through JOURNALLED tenant overrides
//         (capability.setOverride; restored in finally and by loadJournal() after a crash).
//
//   D1  owner delete: graded by LIVE tasks.delete; DB is_deleted/is_active/deleted_by/deleted_at,
//       the row is still there (soft), a second DELETE is 404 (never 5xx)
//   D2  a deleted task is gone EVERYWHERE: GET/PATCH/comments/status-history -> 404 and nothing
//       written, absent from list + export, stats.open drops by exactly one, bulk skips it
//   D3  non-creator non-admin (even the ASSIGNEE) cannot delete; row untouched
//   D4  foreign targets: other tenant, other branch, random uuid, malformed id, body-supplied
//       identity - all refused, rows byte-identical (checked by DB, not by status)
//   D5  org admin deleting a colleague's task: response and DB must agree (observed, not graded)
//   D6  capability off/on (tasks.delete, tasks.lists.delete) takes effect on the next call
//   D7  races: two simultaneous DELETEs (one winner, no 5xx), DELETE vs PATCH
//   L1  lists: non-owner cannot delete an org list; owner can; tasks are DETACHED (list_id NULL),
//       not deleted; deleted list is invisible (GET 404, not in list, PATCH 404, not usable for
//       new tasks); cross-tenant list deletes refused
//   U1  UI: /tasks/<id> "Archive / delete" gated by tasks.delete, confirm flow persists, deleted
//       task page and /tasks/lists card are gone
//
// Skipped on purpose: a role WITHOUT platform.write (read-only defence in softDeleteTask) - no
// such login exists in roles.json (see custom-roles-missing-platform-write); the check is listed
// in the run report as not covered.
//
// Everything created carries E2E-tdel-<stamp> and is hard-purged (root_service) in finally.
//
//   node suites/todo/task-soft-delete.mjs
import fs from 'node:fs';
import { APPS, GATEWAY, authFile, openState } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { purgeById } from '../../fixtures.mjs';
import { setOverride, restoreAll, loadJournal, waitForSessionCapability, tenantIdForOrg } from '../../capability.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { req, reporter, grade, isOk, sleep } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep_ = reporter('todo', 'Task & list soft delete');
const { fail, log } = rep_;
const MARK = `E2E-tdel-${Date.now()}`;
const T = GATEWAY;
for (const k of ['msq_rep1', 'msq_org_admin', 'msq_tenant_admin']) if (!fs.existsSync(authFile(k))) { console.log(`${k} login required - aborting`); process.exit(0); }
const HAVE_F = fs.existsSync(authFile('sales_representative'));
loadJournal(); restoreAll();

const EM = { rep: 'hr@msquareprofessionals.in', oa: 'org-admin@msquareprofessionals.in', ta: 'admin@msquareprofessionals.in' };
const uid = (e) => scalar(`SELECT id FROM iam.users WHERE email=${lit(e)}`);
const ID = { rep: uid(EM.rep), oa: uid(EM.oa), ta: uid(EM.ta) };
const ORG = scalar(`SELECT org_id FROM iam.users WHERE id=${lit(ID.oa)}`);
const TB = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(ORG)}`);
const KSH = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(TB)} AND id<>${lit(ORG)} AND NOT is_deleted AND name LIKE '%KSH%' LIMIT 1`);
const TA_TENANT = tenantIdForOrg('Gurugram - Sector 69');
const FUSER = scalar(`SELECT id FROM iam.users WHERE email='singhneha6020@gmail.com'`);
const FORG = scalar(`SELECT org_id FROM iam.users WHERE id=${lit(FUSER)}`);
const RANDOM = '99999999-9999-4999-8999-999999999999';
const created = { tasks: [], lists: [] };
const A = {};

const open = async () => { A.rep = await actor('msq_rep1'); A.oa = await actor('msq_org_admin'); A.ta = await actor('msq_tenant_admin'); if (HAVE_F) A.f = await actor('sales_representative'); };
const close = async () => { for (const k of Object.keys(A)) { await A[k].close().catch(() => {}); delete A[k]; } };

const mkTask = async (a, body) => {
  const r = await req(a, 'POST', `${T}/tasks`, { data: { priority_name: 'medium', status_name: 'todo', ...body } });
  const id = r.body?.data?.id;
  if (id) created.tasks.push(id);
  return { id, r };
};
const mkListSql = (orgId, name, visibility, ownerId) => {
  const id = scalar(`INSERT INTO task.task_lists (org_id,name,owner_id,visibility,created_by) VALUES (${lit(orgId)},${lit(name)},${lit(ownerId)},${lit(visibility)},${lit(ownerId)}) RETURNING id`);
  if (id) created.lists.push(id);
  return id;
};
const mkList = async (a, name, visibility, ownerId) => {
  const r = await req(a, 'POST', `${T}/task-lists`, { data: { name, visibility } });
  let id = r.body?.data?.id;
  if (id) created.lists.push(id); else id = mkListSql(ORG, name, visibility, ownerId);
  return id;
};
// Raw soft-delete state straight from Postgres (superuser reads bypass RLS).
const dbT = (id) => rows(`SELECT is_deleted::text, is_active::text, COALESCE(deleted_by::text,''), (deleted_at IS NOT NULL)::text, COALESCE(list_id::text,''), title
  FROM task.tasks WHERE id=${lit(id)}`, ['del', 'active', 'by', 'at', 'list', 'title'])[0] ?? null;
const dbL = (id) => rows(`SELECT is_deleted::text, COALESCE(deleted_by::text,''), name FROM task.task_lists WHERE id=${lit(id)}`, ['del', 'by', 'name'])[0] ?? null;
const intactT = (id) => { const r = dbT(id); return !!r && r.del === 'false'; };
const intactL = (id) => { const r = dbL(id); return !!r && r.del === 'false'; };
const stats = async (a, scope = 'own') => (await req(a, 'GET', `${T}/tasks/stats?scope=${scope}`)).body?.data ?? {};
const del = (a, id, data) => req(a, 'DELETE', `${T}/tasks/${id}`, data ? { data } : {});
const delL = (a, id) => req(a, 'DELETE', `${T}/task-lists/${id}`);

async function main() {
  await open();
  // ── the cross-tenant actor needs tasks.* to be a meaningful attacker ───────
  if (HAVE_F) {
    for (const k of ['tasks', 'tasks.view', 'tasks.view.own', 'tasks.create', 'tasks.edit', 'tasks.edit.own', 'tasks.delete', 'tasks.comment', 'tasks.history.view', 'tasks.lists', 'tasks.lists.view', 'tasks.lists.manage', 'tasks.lists.delete']) {
      try { setOverride(TA_TENANT, 'sales_representative', k, true); } catch (e) { console.log(`  (override ${k}: ${String(e.message).slice(0, 60)})`); }
    }
    const fw = await waitForSessionCapability(A.f, 'tasks.delete', true, { timeoutMs: 20000 });
    console.log(`cross-tenant actor tasks.delete effective: ${fw.ok} (${fw.ms} ms)`);
  }
  const caps = { rep: await sessionCaps(A.rep), oa: await sessionCaps(A.oa), ta: await sessionCaps(A.ta), f: A.f ? await sessionCaps(A.f) : null };
  console.log(`caps: rep delete=${caps.rep?.has('tasks.delete')} | oa delete=${caps.oa?.has('tasks.delete')} lists.delete=${caps.oa?.has('tasks.lists.delete')} | ta delete=${caps.ta?.has('tasks.delete')}`);
  const repCanDelete = !!caps.rep?.has('tasks.delete');
  const oaCanDelete = !!caps.oa?.has('tasks.delete');

  // ── fixtures ──────────────────────────────────────────────────────────────
  const R1 = await mkTask(A.rep, { title: `${MARK} R1 rep-own`, assignee_id: ID.rep });
  const R2 = await mkTask(A.rep, { title: `${MARK} R2 rep-own-race` });
  const R3 = await mkTask(A.rep, { title: `${MARK} R3 rep-own-cap` });
  const R4 = await mkTask(A.rep, { title: `${MARK} R4 rep-own-admin-delete` });
  const R5 = await mkTask(A.rep, { title: `${MARK} R5 rep-own-vs-patch` });
  const O1 = await mkTask(A.oa, { title: `${MARK} O1 oa-assigned-to-rep`, assignee_id: ID.rep });   // rep is assignee, not creator
  const O2 = await mkTask(A.oa, { title: `${MARK} O2 oa-own` });
  const O3 = await mkTask(A.oa, { title: `${MARK} O3 oa-own-ui` });
  const T1 = await mkTask(A.ta, { title: `${MARK} T1 ta-own` });
  const KID = KSH ? scalar(`INSERT INTO task.tasks (org_id,title,created_by,status_id,priority_id)
    VALUES (${lit(KSH)}, ${lit(`${MARK} K1 other-branch`)}, ${lit(ID.oa)},
      (SELECT id FROM task.task_statuses WHERE name='todo' AND is_active LIMIT 1), (SELECT id FROM task.task_priorities WHERE name='medium' AND is_active LIMIT 1)) RETURNING id`) : null;
  if (KID) created.tasks.push(KID);
  const F1 = A.f ? await mkTask(A.f, { title: `${MARK} F1 fitclass`, assignee_id: FUSER }) : { id: null, r: { status: 0, text: '' } };
  for (const [k, v] of Object.entries({ R1, R2, R3, R4, R5, O1, O2, O3, T1 })) if (!v.id) fail('high', 'harness', `fixture ${k} not created`, '201', `HTTP ${v.r.status}`, v.r.text.slice(0, 200), 'Precondition: tasks.create for the actor.');
  if (!R1.id || !O1.id) { console.log('fixtures missing - aborting'); return; }
  const before = { O1: dbT(O1.id), O2: dbT(O2.id), T1: dbT(T1.id), K1: KID ? dbT(KID) : null, F1: F1.id ? dbT(F1.id) : null };

  // a comment on R1 so "comment after delete" has history to compare
  await req(A.rep, 'POST', `${T}/tasks/${R1.id}/comments`, { data: { body: `${MARK} before-delete` } });
  const commentsBefore = () => Number(scalar(`SELECT COUNT(*) FROM task.task_comments WHERE task_id=${lit(R1.id)}`));
  const nC0 = commentsBefore();
  const sBefore = await stats(A.rep, 'own');

  // ── D1 owner delete ───────────────────────────────────────────────────────
  console.log('\n== D1 owner delete ==');
  const d1 = await del(A.rep, R1.id);
  const r1 = dbT(R1.id);
  const d1gone = !!r1 && r1.del === 'true';
  grade(rep_, { role: 'rep', scenario: 'DELETE own task', has: repCanDelete, status: d1.status, effect: d1gone, method: 'DELETE', endpoint: '/tasks/:id', evidence: d1.text.slice(0, 160), fixOver: 'requireCapability(TASKS_DELETE) on DELETE /tasks/:id.' });
  if (isOk(d1.status) && d1gone) {
    log({ role: 'rep', action: 'soft-delete columns written (is_active=false, deleted_by=caller, deleted_at set, row kept)', method: 'GET', endpoint: 'task.tasks', status: 200, verified: r1.active === 'false' && r1.by === ID.rep && r1.at === 'true', expected: 'soft delete, actor recorded' });
    if (r1.by !== ID.rep) fail('high', 'rep', 'deleted_by is not the acting user', ID.rep, r1.by || '(null)', R1.id, 'softDeleteTask must write ctx.user_id from the verified session.');
    if (r1.at !== 'true' || r1.active !== 'false') fail('medium', 'rep', 'Soft delete did not stamp deleted_at / is_active=false', 'deleted_at set, is_active false', JSON.stringify(r1), R1.id, 'softDeleteTask UPDATE.');
  } else if (!isOk(d1.status) && d1gone) {
    fail('critical', 'rep', 'DELETE reported a failure but the task was soft-deleted', 'status and DB agree', `HTTP ${d1.status}, is_deleted=true`, d1.text.slice(0, 160), 'Service-tx UPDATE must be inside the request outcome.');
  }
  if (!d1gone && repCanDelete) { fail('high', 'rep', 'Owner could not delete their own task although tasks.delete is held', 'is_deleted=true', `HTTP ${d1.status}`, d1.text.slice(0, 160), 'withServiceTx soft delete (a 500 here is the RLS WITH CHECK regression).'); }
  const hard = Number(scalar(`SELECT COUNT(*) FROM task.tasks WHERE id=${lit(R1.id)}`)) === 1;
  if (d1gone && !hard) fail('high', 'rep', 'DELETE hard-deleted the task (audit rows lose their parent)', 'soft delete only', 'row gone', R1.id, 'Keep the UPDATE is_deleted path.');

  if (d1gone) {
    // ── D2 deleted task is gone everywhere ───────────────────────────────────
    console.log('\n== D2 invisibility after delete ==');
    const probes = {
      'GET /tasks/:id': await req(A.rep, 'GET', `${T}/tasks/${R1.id}`),
      'PATCH /tasks/:id': await req(A.rep, 'PATCH', `${T}/tasks/${R1.id}`, { data: { title: `${MARK} RESURRECTED` } }),
      'GET comments': await req(A.rep, 'GET', `${T}/tasks/${R1.id}/comments`),
      'POST comment': await req(A.rep, 'POST', `${T}/tasks/${R1.id}/comments`, { data: { body: `${MARK} after-delete` } }),
      'GET status-history': await req(A.rep, 'GET', `${T}/tasks/${R1.id}/status-history`),
      'DELETE again': await del(A.rep, R1.id),
    };
    for (const [n, r] of Object.entries(probes)) {
      log({ role: 'rep', action: `${n} on a deleted task`, method: n.split(' ')[0] === 'GET' || n.startsWith('GET') ? 'GET' : n.startsWith('PATCH') ? 'PATCH' : n.startsWith('POST') ? 'POST' : 'DELETE', endpoint: '/tasks/:id', status: r.status, verified: r.status === 404 || r.status === 403, expected: '404' });
      if (r.status >= 500) fail('high', 'rep', `${n} on a deleted task 5xx`, '404', `HTTP ${r.status}`, r.text.slice(0, 160), 'Guard on NOT is_deleted before touching the row.');
      else if (isOk(r.status)) fail('high', 'rep', `${n} still works on a SOFT-DELETED task`, '404', `HTTP ${r.status}`, r.text.slice(0, 200), 'Every per-task path must filter NOT is_deleted.');
    }
    if (commentsBefore() !== nC0) fail('high', 'rep', 'A comment was written to a deleted task', 'no new task_comments rows', `${commentsBefore() - nC0} new`, R1.id, 'addComment -> loadVisible must 404.');
    if (dbT(R1.id)?.title?.includes('RESURRECTED')) fail('critical', 'rep', 'PATCH changed a deleted task', 'unchanged', 'title rewritten', R1.id, 'updateTask guard.');
    const titlesIn = (b) => JSON.stringify(b ?? '');
    const lst = await req(A.rep, 'GET', `${T}/tasks?scope=own&limit=200&include_completed=true&q=${encodeURIComponent(MARK)}`);
    log({ role: 'rep', action: 'deleted task absent from the grid', method: 'GET', endpoint: '/tasks', status: lst.status, verified: isOk(lst.status) && !titlesIn(lst.body).includes('R1 rep-own'), expected: 'absent' });
    if (isOk(lst.status) && titlesIn(lst.body).includes('R1 rep-own')) fail('high', 'rep', 'Deleted task still listed in GET /tasks', 'absent', 'present', R1.id, 'vw_tasks_enriched / list query must filter NOT is_deleted.');
    const mine = await req(A.rep, 'GET', `${T}/tasks/mine?limit=200`);
    if (isOk(mine.status) && titlesIn(mine.body).includes('R1 rep-own')) fail('high', 'rep', 'Deleted task still listed in GET /tasks/mine', 'absent', 'present', R1.id, 'listMine must filter NOT is_deleted.');
    const sAfter = await stats(A.rep, 'own');
    const dOpen = Number(sAfter.open) - Number(sBefore.open);
    // R1 was open before the delete; R2..R5 were created before sBefore, so the only change is -1.
    log({ role: 'rep', action: 'stats.open drops by exactly one', method: 'GET', endpoint: '/tasks/stats', status: 200, verified: dOpen === -1, expected: '-1', note: `delta ${dOpen}` });
    if (dOpen !== -1) fail('medium', 'rep', 'KPI tiles do not reflect a deleted task', 'open -1', `open delta ${dOpen}`, JSON.stringify(sAfter), 'getTaskStats must filter NOT is_deleted.');
    if (caps.rep?.has('tasks.export')) {
      const ex = await req(A.rep, 'GET', `${T}/tasks/export?scope=own&include_completed=true&q=${encodeURIComponent(MARK)}`);
      if (isOk(ex.status) && ex.text.includes('R1 rep-own')) fail('high', 'rep', 'Deleted task present in the CSV export', 'absent', 'present', R1.id, 'listTasksForExport must filter NOT is_deleted.');
    }
    if (caps.rep?.has('tasks.bulk') && caps.rep?.has('tasks.edit')) {
      const bk = await req(A.rep, 'POST', `${T}/tasks/bulk`, { data: { ids: [R1.id], status_name: 'done' } });
      const res = bk.body?.data?.results?.[0];
      log({ role: 'rep', action: 'bulk skips a deleted id', method: 'POST', endpoint: '/tasks/bulk', status: bk.status, verified: !!res && !res.ok && dbT(R1.id)?.del === 'true', expected: 'ok=false' });
      if (res?.ok) fail('high', 'rep', 'Bulk updated a deleted task', 'skipped', JSON.stringify(res), R1.id, 'bulkUpdateTasks -> getTaskRow NOT is_deleted.');
    }
  }

  // ── D3 non-creator, non-admin cannot delete ───────────────────────────────
  console.log('\n== D3 non-creator ==');
  for (const [lbl, id] of [['assignee-but-not-creator (O1)', O1.id], ['colleague private/own (O2)', O2.id], ['tenant admin task (T1)', T1.id]]) {
    const r = await del(A.rep, id);
    const ok = !isOk(r.status) && intactT(id);
    log({ role: 'rep', action: `DELETE ${lbl}`, method: 'DELETE', endpoint: '/tasks/:id', status: r.status, verified: ok, expected: '403/404, row intact' });
    if (r.status >= 500) fail('high', 'rep', `DELETE ${lbl} 5xx`, '403', `HTTP ${r.status}`, r.text.slice(0, 160), 'Typed ForbiddenError, not a throw.');
    else if (isOk(r.status) || !intactT(id)) fail('critical', 'rep', `A rep deleted a task they did not create (${lbl})`, '403 "Only the creator or an org admin can delete this task"; row untouched', `HTTP ${r.status}, is_deleted=${dbT(id)?.del}`, id, 'deleteTask creator/administer check - the soft delete bypasses RLS so this is the only guard.');
    if (!isOk(r.status) && r.status !== 403 && r.status !== 404) fail('low', 'rep', `DELETE ${lbl} status`, '403 or 404', `HTTP ${r.status}`, r.text.slice(0, 120), '');
  }

  // ── D4 foreign targets ────────────────────────────────────────────────────
  console.log('\n== D4 foreign targets ==');
  const foreign = [
    ['oa -> other-branch task (same tenant)', A.oa, KID, 'K1'],
    ['oa -> tenant A task', A.oa, F1.id, 'F1'],
    ['ta -> tenant A task', A.ta, F1.id, 'F1'],
    ['f  -> tenant B task (O2)', A.f, O2.id, 'O2'],
    ['f  -> tenant B task (T1)', A.f, T1.id, 'T1'],
    ['f  -> tenant B task with spoofed body identity', A.f, O2.id, 'O2s'],
  ].filter(([, a, id]) => a && id);
  for (const [lbl, a, id, tag] of foreign) {
    const spoof = tag === 'O2s' ? { org_id: ORG, tenant_id: TB, created_by: ID.oa, user_id: ID.oa } : null;
    const r = await del(a, id, spoof);
    const key = tag.replace('s', '');
    const same = JSON.stringify(dbT(id)) === JSON.stringify(before[key] ?? dbT(id));
    log({ role: lbl.split(' ')[0], action: `DELETE ${lbl}`, method: 'DELETE', endpoint: '/tasks/:id', status: r.status, verified: !isOk(r.status) && intactT(id) && same, expected: '404 (org fence), row identical' });
    if (isOk(r.status) || !intactT(id)) fail('critical', lbl.split(' ')[0], `Cross-branch / cross-tenant DELETE succeeded: ${lbl}`, '404 and the row untouched', `HTTP ${r.status}, is_deleted=${dbT(id)?.del}`, id, 'softDeleteTask/getTaskRow must pin org_id to the session org (no RLS in withServiceTx).');
    else if (r.status >= 500) fail('high', lbl.split(' ')[0], `Cross-tenant DELETE 5xx: ${lbl}`, '404', `HTTP ${r.status}`, r.text.slice(0, 160), 'Typed 404.');
    else if (/E2E-tdel|fitclass|msquare/i.test(r.text) && !/not found|forbidden/i.test(r.text)) fail('medium', lbl.split(' ')[0], `Refusal body of ${lbl} carries record data`, 'generic message', r.text.slice(0, 160), id, 'Do not echo the row.');
  }
  for (const [n, id, want] of [['random uuid', RANDOM, 404], ['malformed id', 'not-a-uuid', 422], ['sql-ish id', encodeURIComponent("1' OR '1'='1"), 422]]) {
    const r = await del(A.oa, id);
    log({ role: 'oa', action: `DELETE ${n}`, method: 'DELETE', endpoint: '/tasks/:id', status: r.status, verified: r.status === want, expected: String(want) });
    if (r.status >= 500) fail('high', 'oa', `DELETE ${n} 5xx`, String(want), `HTTP ${r.status}`, r.text.slice(0, 160), 'validate(idParamSchema) before the handler.');
    else if (r.status !== want) fail('low', 'oa', `DELETE ${n} status`, String(want), `HTTP ${r.status}`, r.text.slice(0, 120), '');
  }

  // ── D5 admin deleting a colleague's task ──────────────────────────────────
  console.log('\n== D5 org admin deletes a colleague\'s task ==');
  const d5 = await del(A.oa, R4.id);
  const d5gone = dbT(R4.id)?.del === 'true';
  grade(rep_, { role: 'oa', scenario: 'org admin DELETE a rep\'s task (administer path)', has: oaCanDelete ? null : false, status: d5.status, effect: d5gone, method: 'DELETE', endpoint: '/tasks/:id', evidence: d5.text.slice(0, 140) });
  if (isOk(d5.status) !== d5gone) fail('critical', 'oa', 'Response and database disagree on the admin delete', 'status and is_deleted agree', `HTTP ${d5.status}, is_deleted=${d5gone}`, R4.id, 'softDeleteTask runs in its own service tx.');
  if (d5gone && dbT(R4.id)?.by !== ID.oa) fail('high', 'oa', 'deleted_by is not the admin who deleted it', ID.oa, dbT(R4.id)?.by, R4.id, 'ctx.user_id.');
  const d5b = await del(A.ta, T1.id);
  log({ role: 'ta', action: 'tenant admin deletes own task', method: 'DELETE', endpoint: '/tasks/:id', status: d5b.status, verified: isOk(d5b.status) === (dbT(T1.id)?.del === 'true'), expected: 'status == DB' });

  // ── D6 capability off / on ────────────────────────────────────────────────
  console.log('\n== D6 capabilities ==');
  const flip = async (a, role, cap, granted) => {
    setOverride(TB, role, cap, granted);
    const w = await waitForSessionCapability(a, cap, granted, { timeoutMs: 20000 });
    if (!w.ok) console.log(`  (cap ${cap}=${granted} not effective after ${w.ms} ms)`);
    return w;
  };
  if (R3.id) {
    await flip(A.rep, 'sales_representative', 'tasks.delete', false);
    const r = await del(A.rep, R3.id);
    log({ role: 'rep', action: 'DELETE own task after tasks.delete was revoked', method: 'DELETE', endpoint: '/tasks/:id', status: r.status, verified: r.status === 403 && intactT(R3.id), expected: '403, row intact' });
    if (isOk(r.status) || !intactT(R3.id)) fail('high', 'rep', 'Delete still works after tasks.delete was revoked', '403', `HTTP ${r.status}`, R3.id, 'requireCapability(TASKS_DELETE) / capability cache.');
    else if (r.status !== 403) fail('low', 'rep', 'Revoked-capability delete status', '403', `HTTP ${r.status}`, r.text.slice(0, 120), '');
    await flip(A.rep, 'sales_representative', 'tasks.delete', true);
    const r2 = await del(A.rep, R3.id);
    log({ role: 'rep', action: 'DELETE own task after tasks.delete was re-granted', method: 'DELETE', endpoint: '/tasks/:id', status: r2.status, verified: isOk(r2.status) && dbT(R3.id)?.del === 'true', expected: '2xx, deleted' });
    if (!(isOk(r2.status) && dbT(R3.id)?.del === 'true')) fail('medium', 'rep', 'Delete does not work after the capability was granted back', '2xx', `HTTP ${r2.status}`, r2.text.slice(0, 160), 'Capability cache invalidation.');
    // tasks.delete without tasks.view/edit does not matter; restore to the tenant default (override removed)
    restoreAll();
    if (HAVE_F) for (const k of ['tasks', 'tasks.view', 'tasks.view.own', 'tasks.create', 'tasks.edit', 'tasks.edit.own', 'tasks.delete', 'tasks.comment', 'tasks.history.view', 'tasks.lists', 'tasks.lists.view', 'tasks.lists.manage', 'tasks.lists.delete']) { try { setOverride(TA_TENANT, 'sales_representative', k, true); } catch {} }
  }

  // ── D7 races ──────────────────────────────────────────────────────────────
  console.log('\n== D7 races ==');
  if (R2.id && repCanDelete) {
    const [x, y] = await Promise.all([del(A.rep, R2.id), del(A.rep, R2.id)]);
    const wins = [x, y].filter((r) => isOk(r.status)).length;
    log({ role: 'rep', action: 'two simultaneous DELETEs of one task', method: 'DELETE', endpoint: '/tasks/:id', status: `${x.status}/${y.status}`, verified: wins >= 1 && dbT(R2.id)?.del === 'true' && x.status < 500 && y.status < 500, expected: 'deleted, no 5xx (one 2xx, one 404)' });
    if (x.status >= 500 || y.status >= 500) fail('high', 'rep', 'Concurrent DELETE of one task 5xx', '2xx + 404', `${x.status}/${y.status}`, JSON.stringify([x.body, y.body]).slice(0, 200), 'softDeleteTask throws NotFound on 0 rows; make sure the controller maps it.');
    if (wins === 0) fail('high', 'rep', 'Neither of two simultaneous DELETEs succeeded', 'one 2xx', `${x.status}/${y.status}`, '', '');
    if (dbT(R2.id)?.del !== 'true') fail('high', 'rep', 'Task not deleted after concurrent DELETEs', 'is_deleted=true', String(dbT(R2.id)?.del), R2.id, '');
  }
  if (R5.id && repCanDelete) {
    const [dx, px] = await Promise.all([del(A.rep, R5.id), req(A.rep, 'PATCH', `${T}/tasks/${R5.id}`, { data: { status_name: 'in_progress' } })]);
    const end = dbT(R5.id);
    log({ role: 'rep', action: 'DELETE racing a PATCH of the same task', method: 'DELETE', endpoint: '/tasks/:id', status: `${dx.status}/${px.status}`, verified: dx.status < 500 && px.status < 500 && !!end, expected: 'no 5xx; row exists' });
    if (dx.status >= 500 || px.status >= 500) fail('high', 'rep', 'DELETE/PATCH race 5xx', '2xx/404/409', `${dx.status}/${px.status}`, '', 'updateTask locks FOR UPDATE; softDeleteTask is a separate tx - surface a 404/409, never a 500.');
    if (isOk(dx.status) && end?.del !== 'true') fail('critical', 'rep', 'DELETE returned 2xx but a racing PATCH left the task alive', 'is_deleted=true', 'is_deleted=false', R5.id, 'softDeleteTask UPDATE must win or the PATCH must be refused.');
  }

  // ── L1 lists ──────────────────────────────────────────────────────────────
  console.log('\n== L1 task lists ==');
  const oaCanDelList = !!caps.oa?.has('tasks.lists.delete');
  const LO = await mkList(A.oa, `${MARK}-org-list`, 'org', ID.oa);
  const LPRIV = await mkList(A.oa, `${MARK}-oa-private`, 'private', ID.oa);
  const LF = A.f ? mkListSql(FORG, `${MARK}-fitclass-list`, 'org', FUSER) : null;
  if (!LO) { fail('high', 'harness', 'org list fixture not created', 'list id', 'none', '', 'Precondition: tasks.lists.manage for org admin.'); }
  else {
    const L1 = await mkTask(A.oa, { title: `${MARK} L1 in-list-oa`, list_id: LO, assignee_id: ID.oa });
    const L2 = await mkTask(A.oa, { title: `${MARK} L2 in-list-rep`, list_id: LO, assignee_id: ID.rep });
    // non-owner non-admin
    const rd = await delL(A.rep, LO);
    log({ role: 'rep', action: 'DELETE an org list owned by someone else', method: 'DELETE', endpoint: '/task-lists/:id', status: rd.status, verified: !isOk(rd.status) && intactL(LO), expected: '403/404, list intact' });
    if (rd.status >= 500) fail('high', 'rep', 'DELETE colleague list 5xx', '403', `HTTP ${rd.status}`, rd.text.slice(0, 160), '');
    else if (isOk(rd.status) || !intactL(LO)) fail('critical', 'rep', 'A rep deleted a list they do not own', '403 and list intact', `HTTP ${rd.status}, is_deleted=${dbL(LO)?.del}`, LO, 'loadForWrite owner/administer check - soft delete bypasses RLS.');
    if (LPRIV) {
      const rp = await delL(A.rep, LPRIV);
      if (isOk(rp.status) || !intactL(LPRIV)) fail('critical', 'rep', 'A rep deleted another user\'s PRIVATE list', '403/404 and list intact', `HTTP ${rp.status}`, LPRIV, 'loadForWrite / getTaskListRow.');
    }
    // cross-tenant
    if (A.f) {
      const fd = await delL(A.f, LO);
      log({ role: 'f', action: 'tenant A user DELETEs a tenant B list', method: 'DELETE', endpoint: '/task-lists/:id', status: fd.status, verified: !isOk(fd.status) && intactL(LO), expected: '404, list intact' });
      if (isOk(fd.status) || !intactL(LO)) fail('critical', 'f', 'Tenant A user deleted a tenant B task list', '404 and list intact', `HTTP ${fd.status}`, LO, 'org_id fence in softDeleteTaskList/getTaskListRow.');
      if (LF) {
        const od = await delL(A.oa, LF);
        log({ role: 'oa', action: 'tenant B admin DELETEs a tenant A list', method: 'DELETE', endpoint: '/task-lists/:id', status: od.status, verified: !isOk(od.status) && intactL(LF), expected: '404, list intact' });
        if (isOk(od.status) || !intactL(LF)) fail('critical', 'oa', 'Tenant B admin deleted a tenant A task list', '404 and list intact', `HTTP ${od.status}`, LF, 'org_id fence.');
      }
    }
    // capability off
    await flip(A.oa, 'org_admin', 'tasks.lists.delete', false);
    const nc = await delL(A.oa, LO);
    log({ role: 'oa', action: 'DELETE own list after tasks.lists.delete was revoked', method: 'DELETE', endpoint: '/task-lists/:id', status: nc.status, verified: nc.status === 403 && intactL(LO), expected: '403, list intact' });
    if (isOk(nc.status) || !intactL(LO)) fail('high', 'oa', 'List delete works after tasks.lists.delete was revoked', '403', `HTTP ${nc.status}`, LO, 'requireCapability(TASKS_LISTS_DELETE).');
    await flip(A.oa, 'org_admin', 'tasks.lists.delete', true);
    // owner delete
    const od = await delL(A.oa, LO);
    const lrow = dbL(LO);
    const gone = lrow?.del === 'true';
    grade(rep_, { role: 'oa', scenario: 'DELETE own org list', has: oaCanDelList, status: od.status, effect: gone, method: 'DELETE', endpoint: '/task-lists/:id', evidence: od.text.slice(0, 140) });
    if (gone) {
      if (lrow.by !== ID.oa) fail('high', 'oa', 'Deleted list records the wrong deleted_by', ID.oa, lrow.by || '(null)', LO, 'ctx.user_id.');
      const t1 = dbT(L1.id), t2 = dbT(L2.id);
      const detached = !!t1 && !!t2 && t1.list === '' && t2.list === '' && t1.del === 'false' && t2.del === 'false';
      log({ role: 'oa', action: 'tasks of a deleted list are detached, not deleted', method: 'GET', endpoint: 'task.tasks', status: 200, verified: detached, expected: 'list_id NULL, is_deleted false' });
      if (!detached) fail('high', 'oa', 'Deleting a list lost or kept its tasks wrongly', 'tasks survive with list_id NULL', JSON.stringify({ L1: t1, L2: t2 }), LO, 'softDeleteTaskList must detach (the FK SET NULL does not fire for a soft delete).');
      const still = await req(A.rep, 'GET', `${T}/tasks/${L2.id}`);
      if (!isOk(still.status)) fail('medium', 'rep', 'Assignee can no longer open a task after its list was deleted', '200', `HTTP ${still.status}`, L2.id, 'Visibility must not depend on the (deleted) list.');
      const probes = {
        'GET list': await req(A.oa, 'GET', `${T}/task-lists/${LO}`),
        'PATCH list': await req(A.oa, 'PATCH', `${T}/task-lists/${LO}`, { data: { name: `${MARK}-zombie` } }),
        'DELETE list again': await delL(A.oa, LO),
      };
      for (const [n, r] of Object.entries(probes)) {
        if (r.status >= 500) fail('high', 'oa', `${n} on a deleted list 5xx`, '404', `HTTP ${r.status}`, r.text.slice(0, 160), '');
        else if (isOk(r.status)) fail('high', 'oa', `${n} still works on a soft-deleted list`, '404', `HTTP ${r.status}`, LO, 'NOT is_deleted in getTaskListRow.');
      }
      if (dbL(LO)?.name?.includes('zombie')) fail('critical', 'oa', 'PATCH renamed a deleted list', 'unchanged', 'renamed', LO, '');
      const all = await req(A.oa, 'GET', `${T}/task-lists`);
      if (isOk(all.status) && JSON.stringify(all.body).includes(LO)) fail('high', 'oa', 'Deleted list still returned by GET /task-lists', 'absent', 'present', LO, 'listTaskLists must filter NOT is_deleted.');
      const nt = await req(A.oa, 'POST', `${T}/tasks`, { data: { title: `${MARK} into-deleted-list`, list_id: LO, priority_name: 'low', status_name: 'todo' } });
      if (nt.body?.data?.id) { created.tasks.push(nt.body.data.id); fail('high', 'oa', 'A task can be created inside a deleted list', '400 (list not usable)', 'created', nt.body.data.id, 'assertListUsable must reject is_deleted lists.'); }
      else if (nt.status >= 500) fail('high', 'oa', 'Create task in a deleted list 5xx', '4xx', `HTTP ${nt.status}`, nt.text.slice(0, 160), 'assertListUsable -> typed BadRequest.');
      const st = await req(A.oa, 'GET', `${T}/tasks/stats?scope=org&list_id=${LO}`);
      if (st.status >= 500) fail('medium', 'oa', 'stats for a deleted list id 5xx', '200 open=0 or 4xx', `HTTP ${st.status}`, st.text.slice(0, 160), '');
      // oa (admin) deleting rep-owned private list: observed
      const LR = await mkList(A.rep, `${MARK}-rep-private`, 'private', ID.rep);
      if (LR) {
        const ad = await delL(A.oa, LR);
        log({ role: 'oa', action: 'org admin deletes a rep\'s PRIVATE list (administer path)', method: 'DELETE', endpoint: '/task-lists/:id', status: ad.status, verified: isOk(ad.status) === (dbL(LR)?.del === 'true'), expected: 'status == DB (policy: observed)' });
        if (isOk(ad.status) !== (dbL(LR)?.del === 'true')) fail('critical', 'oa', 'List delete response and DB disagree', 'agree', `HTTP ${ad.status}, is_deleted=${dbL(LR)?.del}`, LR, '');
      }
    }
  }

  await close();
  await uiPass(O3.id);
}

// ── U1 UI ────────────────────────────────────────────────────────────────────
async function uiPass(oaTaskId) {
  console.log('\n== U1 UI ==');
  const base = APPS['todo-web'];
  const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(600); };
  for (const [key, who, id] of [['msq_rep1', 'rep', null], ['msq_org_admin', 'oa', oaTaskId]]) {
    const { browser, ctx, page } = await openState(key);
    try {
      const caps = new Set((await req({ request: ctx.request }, 'GET', `${GATEWAY}/auth/me`)).body?.data?.user?.capabilities ?? []);
      const canDel = caps.has('tasks.delete');
      // rep opens a task it created (a fresh one so the other pass's rows are not disturbed)
      let target = id;
      if (!target) {
        const api = { request: ctx.request };
        const r = await req(api, 'POST', `${T}/tasks`, { data: { title: `${MARK} U1 rep-ui`, priority_name: 'low', status_name: 'todo' } });
        target = r.body?.data?.id; if (target) created.tasks.push(target);
      }
      if (!target) { console.log(`  (${key}: no task to open)`); continue; }
      await page.goto(`${base}/tasks/${target}`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const btn = page.getByRole('button', { name: /archive \/ delete/i });
      const visible = (await btn.count()) > 0;
      log({ role: key, area: 'todo-web /tasks/<id>', action: 'Archive / delete button gated by tasks.delete', method: 'UI', endpoint: '/tasks/<id>', status: null, outcome: visible ? 'visible' : 'hidden', verified: visible === canDel, expected: canDel ? 'visible' : 'hidden' });
      if (visible !== canDel) fail('medium', key, `Archive / delete button ${visible ? 'shown without' : 'missing for a holder of'} tasks.delete`, canDel ? 'visible' : 'hidden', String(visible), page.url(), 'canDeleteTasks(actor) must read tasks.delete.', 'todo-web /tasks/<id>');
      if (visible && canDel) {
        await btn.first().click();
        const cancel = page.getByRole('button', { name: /^keep$/i });
        log({ role: key, area: 'todo-web /tasks/<id>', action: 'confirm step appears and Keep cancels', method: 'UI', endpoint: '/tasks/<id>', status: null, outcome: 'visible', verified: (await cancel.count()) > 0, expected: 'Archive this task? Yes/Keep' });
        await cancel.first().click().catch(() => {});
        if (dbT(target)?.del !== 'false') fail('critical', key, 'Pressing Keep deleted the task', 'unchanged', 'deleted', target, 'TaskDetailPanel confirm flow.', 'todo-web /tasks/<id>');
        await btn.first().click();
        const wr = page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/tasks\//.test(r.url()), { timeout: 10000 }).catch(() => null);
        await page.getByRole('button', { name: /yes, archive/i }).first().click();
        const resp = await wr; await page.waitForTimeout(900);
        const gone = dbT(target)?.del === 'true';
        log({ role: key, area: 'todo-web /tasks/<id>', action: 'Yes, archive soft-deletes the task', method: 'UI', endpoint: 'DELETE /api/tasks/:id', status: resp?.status() ?? null, verified: gone, expected: 'is_deleted=true' });
        if (!gone) fail('high', key, 'UI archive did not persist', 'is_deleted=true', `HTTP ${resp?.status()}`, target, 'TaskDetailPanel.remove -> tasksApi.remove.', 'todo-web /tasks/<id>');
        else {
          await page.goto(`${base}/tasks/${target}`, { waitUntil: 'domcontentloaded' }); await settle(page);
          const body = await page.locator('body').innerText().catch(() => '');
          const shown = body.includes(MARK) && !/not found|404|do not have access/i.test(body);
          log({ role: key, area: 'todo-web /tasks/<id>', action: 'deleted task page is not found', method: 'UI', endpoint: '/tasks/<id>', status: null, outcome: 'visible', verified: !shown, expected: 'not found' });
          if (shown) fail('high', key, 'Deleted task page still renders the task', 'not found', body.slice(0, 120), target, 'TaskDetailShell load must 404 a soft-deleted task.', 'todo-web /tasks/<id>');
          await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' }); await settle(page);
          const s = page.getByLabel('Search tasks');
          if (await s.count()) { await s.fill(MARK); await page.waitForTimeout(900); await settle(page); const grid = await page.locator('tbody').innerText().catch(() => ''); if (grid.includes('U1 ') || grid.includes('O3 oa-own-ui')) fail('high', key, 'Deleted task still listed in the My Tasks grid', 'absent', 'present', target, 'grid query NOT is_deleted.', 'todo-web /tasks'); }
        }
      }
    } catch (e) {
      console.log(e.stack); fail('high', key, 'UI pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error', 'todo-web');
    } finally { await browser.close(); }
  }
  await sleep(100);
}

try { await main(); } catch (e) {
  console.log(e.stack);
  fail('high', 'harness', 'task-soft-delete suite aborted', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'see log');
} finally {
  await close().catch(() => {});
  const n = restoreAll();
  for (const id of created.tasks) { try { purgeById('task.tasks', id); } catch {} }
  try { for (const id of rows(`SELECT id FROM task.tasks WHERE title LIKE ${lit(`%${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.tasks', id); } catch {}
  for (const id of created.lists) { try { purgeById('task.task_lists', id); } catch {} }
  try { for (const id of rows(`SELECT id FROM task.task_lists WHERE name LIKE ${lit(`${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.task_lists', id); } catch {}
  console.log(`\nrestored ${n} capability overrides; purged fixtures; findings=${rep_.state.findings} actions=${rep_.state.actions}`);
}
