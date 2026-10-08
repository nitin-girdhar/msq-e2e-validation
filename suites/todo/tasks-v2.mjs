// Tasks v2 (schema 1.67.0): GET /tasks/stats, GET /tasks/export, POST /tasks/bulk and the
// Stitch-redesigned todo-web pages /tasks, /tasks/lists, /tasks/<id>, /tasks/team.
//
// Tasks are licensed for tenant B (MSquare) - its three logins are the principals:
//   rep = msq_rep1 (own scope only), oa = msq_org_admin, ta = msq_tenant_admin.
// Tenant A (Fitclass) holds no tasks.* capabilities today, so the CROSS-TENANT actor is a
// Fitclass sales_representative to whom the suite grants tasks.* through journalled tenant
// overrides (capability.setOverride; restored in finally and by loadJournal() after a crash).
// A branch-isolation fixture (a task in another MSquare branch) is inserted by SQL.
//
//   A  stats: caller scope only, deltas after known inserts, invariants (open == grid total)
//   B  export: CSV shape, formula-injection escaping, rows == DB expectation, no foreign rows
//   C  bulk: mixed foreign/private/other-branch/other-tenant/random ids, no silent partial
//      success (results == DB), validation limits, assignee fences, status log + note
//   D  capability on/off (tasks.bulk / .edit / .export / .view.org / .assign)
//   E  two users change the same task at once (assignee + status) - optimistic lock + DB
//   F  identity spoofing (created_by / org_id in bodies)
//   G  Playwright pass over /tasks, /tasks/lists, /tasks/<id>, /tasks/team for rep, oa, ta and the
//      cross-tenant actor; every tab / filter dropdown / sort / view toggle / tile / bulk modal /
//      export / drawer, UI numbers compared with the API and DB
//
// Everything created carries E2E-tasks-<stamp> in its title/name and is hard-purged in finally.
//
//   node suites/todo/tasks-v2.mjs
import fs from 'node:fs';
import { APPS, GATEWAY, authFile, openState } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { purgeById } from '../../fixtures.mjs';
import { setOverride, restoreAll, loadJournal, waitForSessionCapability, tenantIdForOrg } from '../../capability.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { req, anon, reporter, grade, isOk, sleep, sweepPage } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep_ = reporter('todo', 'Tasks v2 (stats / export / bulk / redesigned pages)');
const { fail, log } = rep_;
const MARK = `E2E-tasks-${Date.now()}`;
const T = GATEWAY;
const need = ['msq_rep1', 'msq_org_admin', 'msq_tenant_admin', 'sales_representative'];
for (const k of need) if (!fs.existsSync(authFile(k))) { console.log(`${k} login required - aborting`); process.exit(0); }
loadJournal(); restoreAll();

const EM = { rep: 'employee.msq@e2e-fixture.test', oa: 'org-admin@msq.in', ta: 'admin@msq.in' };
const uid = (e) => scalar(`SELECT id FROM iam.users WHERE email=${lit(e)}`);
const ID = { rep: uid(EM.rep), oa: uid(EM.oa), ta: uid(EM.ta) };
const ORG = scalar(`SELECT org_id FROM iam.users WHERE id=${lit(ID.oa)}`);
const TB = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(ORG)}`);
const KSH = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(TB)} AND id<>${lit(ORG)} AND NOT is_deleted AND name LIKE '%Kinshasa%' LIMIT 1`);
const KSH_USER = !KSH ? null : scalar(`SELECT u.id FROM iam.users u JOIN iam.user_org_mapping m ON m.user_id=u.id AND m.is_active WHERE m.org_id=${lit(KSH)} AND u.is_active LIMIT 1`);
const TA_TENANT = tenantIdForOrg('Gurugram - Sector 69');
const FUSER = scalar(`SELECT id FROM iam.users WHERE email='singhneha6020@gmail.com'`);
const created = { tasks: [], lists: [] };

const A = {};
const open = async () => { A.rep = await actor('msq_rep1'); A.oa = await actor('msq_org_admin'); A.ta = await actor('msq_tenant_admin'); A.f = await actor('sales_representative'); };
const close = async () => { for (const k of Object.keys(A)) { await A[k].close().catch(() => {}); delete A[k]; } };

const mkTask = async (a, body) => {
  const r = await req(a, 'POST', `${T}/tasks`, { data: { priority_name: 'medium', status_name: 'todo', ...body } });
  const id = r.body?.data?.id;
  if (id) created.tasks.push(id);
  return { id, no: r.body?.data?.task_no, r };
};
const mkList = async (a, name, visibility, ownerId) => {
  const r = await req(a, 'POST', `${T}/task-lists`, { data: { name, visibility } });
  let id = r.body?.data?.id;
  if (!id) { // creator lacks lists.manage: insert as the owner
    id = scalar(`INSERT INTO task.task_lists (org_id,name,owner_id,visibility,created_by) VALUES (${lit(ORG)},${lit(name)},${lit(ownerId)},${lit(visibility)},${lit(ownerId)}) RETURNING id`);
  }
  if (id) created.lists.push(id);
  return id;
};
const dbTask = (id) => rows(`SELECT s.name, COALESCE(t.assignee_id::text,''), t.is_deleted::text, t.org_id::text, t.created_by::text FROM task.tasks t JOIN task.task_statuses s ON s.id=t.status_id WHERE t.id=${lit(id)}`, ['status', 'assignee', 'deleted', 'org', 'by'])[0] ?? null;
const stats = async (a, scope = 'own', extra = '') => (await req(a, 'GET', `${T}/tasks/stats?scope=${scope}${extra}`));
const num = (r, k) => Number(r.body?.data?.[k] ?? NaN);
const listTotal = async (a, scope, extra = '') => (await req(a, 'GET', `${T}/tasks?scope=${scope}&limit=1${extra}`)).body?.total;

// CSV (RFC 4180 with BOM + CRLF) -> array of rows
function parseCsv(text) {
  const t = text.replace(/^﻿/, ''); const out = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') out.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

async function main() {
  await open();
  // ── grant the cross-tenant actor tasks.* (journalled tenant overrides) ────
  const FCAPS = ['tasks', 'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.bulk', 'tasks.export', 'tasks.assign', 'tasks.lists', 'tasks.lists.view'];
  for (const k of FCAPS) { try { setOverride(TA_TENANT, 'sales_representative', k, true); } catch (e) { console.log(`  (override ${k}: ${String(e.message).slice(0, 60)})`); } }
  const fw = await waitForSessionCapability(A.f, 'tasks.bulk', true, { timeoutMs: 20000 });
  console.log(`cross-tenant actor tasks.bulk effective: ${fw.ok} (${fw.ms} ms)`);
  const caps = { rep: await sessionCaps(A.rep), oa: await sessionCaps(A.oa), ta: await sessionCaps(A.ta), f: await sessionCaps(A.f) };
  console.log(`caps: rep bulk=${caps.rep?.has('tasks.bulk')} export=${caps.rep?.has('tasks.export')} | oa bulk=${caps.oa?.has('tasks.bulk')} export=${caps.oa?.has('tasks.export')} view.org=${caps.oa?.has('tasks.view.org')}`);

  // ── baselines ─────────────────────────────────────────────────────────────
  const base = { rep: await stats(A.rep, 'own'), oa: await stats(A.oa, 'org'), ta: await stats(A.ta, 'org'), f: await stats(A.f, 'own') };
  for (const [k, r] of Object.entries(base)) if (!isOk(r.status)) fail('high', k, `GET /tasks/stats baseline failed for ${k}`, '200', `HTTP ${r.status}`, r.text.slice(0, 160), 'tasks.view holder must always get own-scope tiles.');

  // ── fixtures ──────────────────────────────────────────────────────────────
  const LR = await mkList(A.rep, `${MARK}-rep-private`, 'private', ID.rep);
  const LO = await mkList(A.oa, `${MARK}-oa-private`, 'private', ID.oa);
  const LORG = await mkList(A.oa, `${MARK}-oa-org`, 'org', ID.oa);
  const R1 = await mkTask(A.rep, { title: `${MARK} R1 rep-private`, list_id: LR, assignee_id: ID.rep });
  const R2 = await mkTask(A.rep, { title: `${MARK} R2 rep-private-unassigned`, list_id: LR });
  const R3 = await mkTask(A.rep, { title: `${MARK} R3 rep-standalone`, assignee_id: ID.rep, priority_name: 'urgent' });
  const O1 = await mkTask(A.oa, { title: `${MARK} O1 oa-private`, list_id: LO, assignee_id: ID.oa });
  const O2 = await mkTask(A.oa, { title: `${MARK} O2 oa-org`, list_id: LORG, assignee_id: ID.ta, priority_name: 'high' });
  const T1 = await mkTask(A.ta, { title: `${MARK} T1 ta-standalone`, assignee_id: ID.ta });
  const T2 = await mkTask(A.ta, { title: `${MARK} T2 ta-unassigned` });
  const T3 = await mkTask(A.ta, { title: `${MARK} T3 for-rep`, assignee_id: ID.rep, due_at: new Date(Date.now() - 36e5).toISOString() });
  const T4 = await mkTask(A.ta, { title: `${MARK} T4 due-soon`, assignee_id: ID.ta, due_at: new Date(Date.now() + 2 * 36e5).toISOString() });
  // other branch, same tenant (SQL: the suite has no login there)
  const KID = KSH ? scalar(`INSERT INTO task.tasks (org_id,title,created_by,status_id,priority_id)
    VALUES (${lit(KSH)}, ${lit(`${MARK} K1 other-branch`)}, ${lit(ID.oa)},
      (SELECT id FROM task.task_statuses WHERE name='todo' AND is_active LIMIT 1), (SELECT id FROM task.task_priorities WHERE name='medium' AND is_active LIMIT 1)) RETURNING id`) : null;
  if (KID) created.tasks.push(KID);
  // tenant A
  const F1 = await mkTask(A.f, { title: `${MARK} F1 fitclass`, assignee_id: FUSER });
  const F2 = await mkTask(A.f, { title: `${MARK} F2 fitclass`, priority_name: 'low' });
  const need2 = { R1, R2, R3, O1, O2, T1, T2, T3, T4, F1 };
  for (const [k, v] of Object.entries(need2)) if (!v.id) { fail('high', 'harness', `fixture ${k} not created`, '201', `HTTP ${v.r.status}`, v.r.text.slice(0, 200), 'Precondition: tasks.create for the actor.'); }
  console.log(`fixtures: tasks=${created.tasks.length} lists=${created.lists.length} other-branch=${!!KID}`);

  // ── A. stats ──────────────────────────────────────────────────────────────
  console.log('\n== A stats ==');
  const after = { rep: await stats(A.rep, 'own'), oa: await stats(A.oa, 'org'), ta: await stats(A.ta, 'org'), f: await stats(A.f, 'own') };
  const dOpen = (k) => num(after[k], 'open') - num(base[k], 'open');
  // expectations from the repository scope rules
  const exp = { rep: 4 /*R1 R2 R3 T3*/, oa: 6 /*R3 O1 O2 T1 T2 T3 T4 -> 7*/, ta: 6, f: 2 };
  exp.oa = 7; exp.ta = 6; // ta: R3 O2 T1 T2 T3 T4 (not O1/R1/R2)
  for (const k of ['rep', 'oa', 'ta', 'f']) {
    const ok = dOpen(k) === exp[k];
    log({ role: k, action: `stats open delta after known inserts (expect +${exp[k]})`, method: 'GET', endpoint: '/tasks/stats', status: after[k].status, verified: ok, expected: `+${exp[k]}` });
    if (!ok) {
      const leakish = dOpen(k) > exp[k];
      fail(leakish ? 'critical' : 'high', k, `Stats open count wrong: delta ${dOpen(k)} vs expected ${exp[k]}`, `+${exp[k]} (caller-visible rows only; private lists of others, other branches and other tenants excluded)`, `base=${num(base[k], 'open')} after=${num(after[k], 'open')}`, JSON.stringify(after[k].body?.data), leakish ? 'Tiles are counting rows the caller may not see: re-check scopeVisibilityClause / org fence.' : 'Tiles miss rows the grid shows.');
    }
    const d = after[k].body?.data ?? {};
    if (d.open !== d.todo + d.in_progress + d.blocked) fail('medium', k, 'Stats invariant broken: open != todo + in_progress + blocked', 'equal', JSON.stringify(d), '', 'getTaskStats FILTERs.');
  }
  // B's fixtures must not move tenant A's tiles and vice versa (checked by exact delta above); also explicit
  const gridTotals = { rep: await listTotal(A.rep, 'own'), oa: await listTotal(A.oa, 'org'), ta: await listTotal(A.ta, 'org') };
  for (const k of ['rep', 'oa', 'ta']) {
    const tile = num(after[k], 'open');
    log({ role: k, action: 'stats.open equals the default grid total', method: 'GET', endpoint: '/tasks vs /tasks/stats', status: 200, verified: tile === gridTotals[k], expected: 'equal' });
    if (tile !== gridTotals[k]) fail('medium', k, 'KPI tile disagrees with the grid it filters', 'stats.open == GET /tasks total (default filters)', `tile=${tile} grid=${gridTotals[k]}`, '', 'Stats and list must share runScoped + filterClause semantics.');
  }
  // status / sla arithmetic
  await req(A.rep, 'PATCH', `${T}/tasks/${R1.id}`, { data: { status_name: 'in_progress' } });
  await req(A.rep, 'PATCH', `${T}/tasks/${R2.id}`, { data: { status_name: 'blocked' } });
  await req(A.rep, 'PATCH', `${T}/tasks/${R3.id}`, { data: { status_name: 'done' } });
  const s2 = await stats(A.rep, 'own');
  const dd = (k) => num(s2, k) - num(after.rep, k);
  const okMove = dd('in_progress') === 1 && dd('blocked') === 1 && dd('completed') === 1 && dd('open') === -1 && dd('todo') === -3;
  log({ role: 'rep', action: 'stats follow status changes (in_progress +1, blocked +1, done +1, open -1)', method: 'GET', endpoint: '/tasks/stats', status: s2.status, verified: okMove, expected: 'exact arithmetic' });
  if (!okMove) fail('medium', 'rep', 'Stats do not follow status changes', 'in_progress+1 blocked+1 completed+1 open-1 todo-3', ['in_progress', 'blocked', 'completed', 'open', 'todo'].map((k) => `${k}${dd(k) >= 0 ? '+' : ''}${dd(k)}`).join(' '), '', 'status_name / status_is_terminal in vw_tasks_enriched.');
  const sOver = await stats(A.rep, 'own');
  if (num(sOver, 'overdue') < 1) fail('medium', 'rep', 'Overdue tile does not count an open task past its due date (T3)', 'overdue >= 1', JSON.stringify(sOver.body?.data), T3.id, 'sla_state in the view.');
  // scope + param guards
  for (const [who, a, path, want, label] of [
    ['rep', A.rep, '?scope=team', caps.rep?.has('tasks.view.team') ? 200 : 403, 'team scope'],
    ['rep', A.rep, '?scope=org', caps.rep?.has('tasks.view.org') ? 200 : 403, 'org scope'],
    ['rep', A.rep, '?scope=galaxy', 422, 'unknown scope'],
    ['rep', A.rep, `?scope=own&list_id=not-a-uuid`, 422, 'malformed list_id'],
    ['oa', A.oa, `?scope=org&list_id=${LR}`, 200, 'another user\'s private list id (must count 0)'],
    ['f', A.f, `?scope=own&list_id=${LORG}`, 200, 'a tenant-B list id (must count 0)'],
  ]) {
    const r = await req(a, 'GET', `${T}/tasks/stats${path}`);
    const ok = r.status === want && (!/list id/.test(label) || num(r, 'open') === 0);
    log({ role: who, action: `stats ${label}`, method: 'GET', endpoint: `/tasks/stats${path}`, status: r.status, verified: ok, expected: `${want}` });
    if (r.status >= 500) fail('high', who, `stats ${label} 5xx`, String(want), `HTTP ${r.status}`, r.text.slice(0, 160), 'validate() then typed 4xx.');
    else if (!ok) fail(/list id/.test(label) ? 'critical' : 'medium', who, `stats ${label}`, `${want}${/list id/.test(label) ? ' and open=0' : ''}`, `HTTP ${r.status} open=${num(r, 'open')}`, r.text.slice(0, 160), 'Scope/capability gate or list fence.');
  }
  const an = await anon(); const anonR = await req(an, 'GET', `${T}/tasks/stats`); await an.close();
  if (anonR.status !== 401) fail('high', 'anonymous', 'GET /tasks/stats without a session', '401', `HTTP ${anonR.status}`, '', 'withAuth');

  // ── B. export ─────────────────────────────────────────────────────────────
  console.log('\n== B export ==');
  const inj = [
    ['=1+1', 'eq'], ['+SUM(1,1)', 'plus'], ['-2+3', 'minus'], ['@SUM(1)', 'at'], ['=HYPERLINK("http://evil.example","x")', 'link'],
  ];
  const injIds = [];
  for (const [prefix, tag] of inj) {
    const t = await mkTask(A.oa, { title: `${prefix} ${MARK} inj-${tag}`, description: `${prefix}-desc`, tags: [`${prefix}tag`] });
    if (t.id) injIds.push(t.id);
  }
  const weird = await mkTask(A.oa, { title: `${MARK} weird, "quoted"\nnewline`, description: 'line1\r\nline2' });
  const expC = (a, extra = '') => req(a, 'GET', `${T}/tasks/export?${extra}`);
  const headerExp = 'Task,Title,Description,List,Status,Priority,SLA,Due,Assignee,Created by,Tags,Created,Completed';
  for (const [who, a, scope] of [['oa', A.oa, 'org'], ['ta', A.ta, 'org'], ['f', A.f, 'own']]) {
    const r = await expC(a, `scope=${scope}&include_completed=true&q=${encodeURIComponent(MARK)}`);
    const has = caps[who]?.has('tasks.export');
    grade(rep_, { role: who, scenario: `export CSV scope=${scope}`, has, status: r.status, effect: null, endpoint: '/tasks/export', evidence: r.text.slice(0, 120), fixOver: 'requireCapability(TASKS_EXPORT).' });
    if (!isOk(r.status)) continue;
    const ct = r.headers['content-type'] ?? '', cd = r.headers['content-disposition'] ?? '';
    if (!/text\/csv/.test(ct) || !/attachment/.test(cd)) fail('low', who, 'Export response headers', 'text/csv + attachment; filename', `${ct} | ${cd}`, '', 'controller headers.');
    if (r.headers['x-export-truncated'] !== 'false') fail('low', who, 'X-Export-Truncated header missing/true', 'false', String(r.headers['x-export-truncated']), '', 'gateway forwardResponseHeaders.');
    const grid = parseCsv(r.text);
    if (grid[0]?.join(',') !== headerExp) fail('medium', who, 'Export header row differs from the contract', headerExp, String(grid[0]?.join(',')), '', 'EXPORT_HEADERS.');
    const body = grid.slice(1);
    const titles = new Set(body.map((c) => c[1]));
    const expOrg = who === 'f' ? scalar(`SELECT org_id FROM iam.users WHERE id=${lit(FUSER)}`) : ORG;
    const mine = [...titles].filter((t) => t.includes(MARK) && !t.includes(String.fromCharCode(10))).map((t) => t.replace(/^'/, ''));
    const wrongOrg = [];
    for (const t of mine) for (const o of rows(`SELECT org_id::text FROM task.tasks WHERE title=${lit(t)}`, ['org'])) if (o.org !== expOrg) wrongOrg.push({ title: t.slice(0, 40), org: o.org });
    log({ role: who, action: 'export rows all belong to the caller\'s branch', method: 'GET', endpoint: '/tasks/export', status: r.status, verified: wrongOrg.length === 0, expected: '0 foreign rows', note: `${body.length} rows` });
    if (wrongOrg.length) fail('critical', who, `Export contains ${wrongOrg.length} rows from another branch/tenant`, 'only the caller\'s org', JSON.stringify(wrongOrg.slice(0, 3)), '', 'org fence in runScoped.');
    const mustNot = who === 'f' ? [R1, R3, O2, T1] : [R1, R2];
    const seenHidden = mustNot.filter((x) => x.id && [...titles].some((t) => t.includes(String((x.r.body?.data?.title ?? '')))));
    const hiddenTitles = who === 'f' ? [`${MARK} R1`, `${MARK} O2`, `${MARK} T1`] : [`${MARK} R1`, `${MARK} R2`, `${MARK} K1`];
    if (who === 'ta') hiddenTitles.push(`${MARK} O1`);
    const leaked = hiddenTitles.filter((h) => [...titles].some((t) => t.startsWith(h)));
    if (leaked.length) fail('critical', who, `Export leaks tasks the caller must not see: ${leaked.join(', ')}`, 'private lists of others / other branch / other tenant excluded', leaked.join(','), '', 'scopeVisibilityClause + org fence.');
    if (who !== 'f') {
      const visibleExpected = [`${MARK} R3`, `${MARK} O2`, `${MARK} T1`, `${MARK} T2`, `${MARK} T3`, `${MARK} T4`].concat(who === 'oa' ? [`${MARK} O1`] : []);
      const missing = visibleExpected.filter((v) => ![...titles].some((t) => t.startsWith(v)));
      if (missing.length) fail('high', who, `Export is missing visible tasks: ${missing.join(', ')}`, 'same rows as the grid', missing.join(','), '', 'listTasksForExport.');
      // formula injection: no cell of a MARK row may START with = + - @
      let injected = [];
      for (const row of body.filter((c) => (c[1] ?? '').includes(MARK))) row.forEach((cellv, i) => { if (/^[=+\-@]/.test(cellv)) injected.push(`${headerExp.split(',')[i]}=${cellv.slice(0, 30)}`); });
      log({ role: who, action: 'CSV formula-injection escaping (= + - @ in title, description, tags)', method: 'GET', endpoint: '/tasks/export', status: r.status, verified: injected.length === 0, expected: 'cells prefixed with an apostrophe' });
      if (injected.length) fail('high', who, 'CSV export is vulnerable to formula injection', 'cells starting with = + - @ are neutralised', injected.slice(0, 4).join(' | '), '', 'lib/csv.ts FORMULA_START prefix.');
      const unescapedOk = body.some((c) => (c[1] ?? '').startsWith("'=1+1"));
      if (!unescapedOk) fail('medium', who, 'Escaped formula title not found in the expected neutralised form', "'=1+1 ...", String([...titles].filter((t) => /1\+1/.test(t))[0]), '', 'cell() prefix.');
      const wr = body.find((c) => (c[1] ?? '').includes('weird'));
      if (!wr || !wr[1].includes('"quoted"') || !wr[1].includes('\n')) fail('medium', who, 'CSV quoting broke on commas / quotes / newlines', 'RFC 4180 round trip', JSON.stringify(wr?.[1]), '', 'cell() quoting.');
    }
  }
  // filters + guards on export
  const fx = [
    ['status=done', `scope=org&include_completed=true&status=done&q=${encodeURIComponent(MARK)}`, (g) => g.every((c) => c[4] === 'Done' || /done/i.test(c[4]))],
    ['priority=urgent', `scope=org&include_completed=true&priority=urgent&q=${encodeURIComponent(MARK)}`, (g) => g.every((c) => /urgent/i.test(c[5])) && g.some((c) => c[1].includes('R3'))],
    ['unassigned', `scope=org&unassigned=true&q=${encodeURIComponent(MARK)}`, (g) => g.every((c) => !c[8]) && g.some((c) => c[1].includes('T2'))],
    ['sort title asc', `scope=org&sort=title&dir=asc&include_completed=true&q=${encodeURIComponent(MARK)}`, (g) => { const t = g.map((c) => c[1].replace(/^'/, '')).filter((x) => !/weird/.test(x)); const db = rows(`SELECT title FROM task.tasks WHERE title LIKE ${lit(`%${MARK}%`)} AND title NOT LIKE '%weird%' AND org_id=${lit(ORG)} AND NOT is_deleted AND id IN (SELECT id FROM task.tasks) ORDER BY lower(title), id`, ['t']).map((r) => r.t).filter((x) => !x.includes(String.fromCharCode(10))); const norm = (v) => v.map((x) => x.toLowerCase()); const visible = norm(db).filter((x) => norm(t).includes(x)); return JSON.stringify(norm(t).filter((x) => visible.includes(x))) === JSON.stringify(visible); }],
  ];
  for (const [n, qs, check] of fx) {
    const r = await expC(A.oa, qs);
    const g = isOk(r.status) ? parseCsv(r.text).slice(1) : [];
    const ok = isOk(r.status) && g.length > 0 && check(g);
    log({ role: 'oa', action: `export filter ${n}`, method: 'GET', endpoint: `/tasks/export?${n}`, status: r.status, verified: ok, expected: 'rows obey the filter' });
    if (!ok) fail('medium', 'oa', `Export filter "${n}" not honoured`, 'filtered rows', `HTTP ${r.status}, ${g.length} rows`, r.text.slice(0, 160), 'filterClause / orderClause.');
  }
  for (const [n, qs, want] of [['unknown sort key', 'sort=password', 422], ['malformed list_id', 'list_id=zzz', 422], ['scope=galaxy', 'scope=galaxy', 422], ['SQL in q', `q=${encodeURIComponent("'; DROP TABLE task.tasks;--")}`, 200], ['wildcard q', 'q=%25', 200]]) {
    const r = await expC(A.oa, `scope=org&${qs}`);
    log({ role: 'oa', action: `export ${n}`, method: 'GET', endpoint: '/tasks/export', status: r.status, verified: r.status === want, expected: String(want) });
    if (r.status >= 500 || r.status !== want) fail(r.status >= 500 ? 'high' : 'low', 'oa', `Export with ${n}`, String(want), `HTTP ${r.status}`, r.text.slice(0, 160), 'validate() whitelist.');
  }
  if (Number(scalar(`SELECT COUNT(*) FROM task.tasks`)) < 1) fail('critical', 'oa', 'tasks table emptied by an injection probe', '>0', '0', '', '');
  const rr = await expC(A.rep, 'scope=own');
  grade(rep_, { role: 'rep', scenario: 'export CSV (default rep)', has: caps.rep?.has('tasks.export'), status: rr.status, endpoint: '/tasks/export', evidence: rr.text.slice(0, 100) });

  // ── C. bulk ───────────────────────────────────────────────────────────────
  console.log('\n== C bulk ==');
  const RANDOM = '99999999-9999-4999-8999-999999999999';
  const bulk = (a, body) => req(a, 'POST', `${T}/tasks/bulk`, { data: body });
  const before = Object.fromEntries([R1, R2, O1, O2, T1, T2, F1, F2].map((x) => [x.id, dbTask(x.id)]));
  const b1 = await bulk(A.oa, { ids: [O1.id, O2.id, R3.id, R1.id, R2.id, F1.id, RANDOM, ...(KID ? [KID] : [])], status_name: 'blocked', note: `${MARK} bulk note` });
  const res1 = Object.fromEntries((b1.body?.data?.results ?? []).map((r) => [r.id, r]));
  const must = { ok: [O1.id, O2.id, R3.id], bad: [R1.id, R2.id, F1.id, RANDOM, ...(KID ? [KID] : [])] };
  log({ role: 'oa', action: 'bulk status on a mixed id list (own, org, standalone, private-of-others, foreign tenant, random, other branch)', method: 'POST', endpoint: '/tasks/bulk', status: b1.status, verified: must.ok.every((i) => res1[i]?.ok) && must.bad.every((i) => res1[i] && !res1[i].ok), expected: 'only visible+editable ids change; the rest are reported' });
  if (b1.status !== 200) fail('high', 'oa', 'Bulk status on a mixed list failed outright', '200 with per-id results', `HTTP ${b1.status}`, b1.text.slice(0, 200), 'bulkUpdateTasks.');
  else {
    for (const i of must.ok) if (!res1[i]?.ok) fail('high', 'oa', 'Bulk skipped a task the caller may edit', 'ok', JSON.stringify(res1[i]), i, 'canViewTask/canEditTask vs per-task PATCH.');
    for (const i of must.bad) if (res1[i]?.ok) fail('critical', 'oa', 'BULK CHANGED A TASK THE CALLER MAY NOT TOUCH', 'skipped', JSON.stringify(res1[i]), i, 'Per-id authorisation in bulkUpdateTasks.');
    // reported == DB
    for (const [i, r] of Object.entries(res1)) {
      const d = dbTask(i); const changed = d && before[i] && d.status !== before[i].status;
      if (!r.ok && changed) fail('critical', 'oa', 'Bulk reported a failure but the row changed', 'unchanged', `${before[i].status}->${d.status}`, i, 'Per-task transaction.');
      if (r.ok && d && d.status !== 'blocked') fail('high', 'oa', 'Bulk reported success but the DB did not change (silent no-op)', 'status=blocked', d.status, i, 'repo.updateTask.');
    }
    const unchangedForeign = [R1, R2, F1].every((x) => dbTask(x.id)?.status === before[x.id]?.status);
    if (!unchangedForeign) fail('critical', 'oa', 'Foreign/private task status changed by bulk', 'unchanged', 'changed', '', '');
    const m1 = res1[R1.id]?.error, m2 = res1[RANDOM]?.error, m3 = res1[F1.id]?.error;
    if (new Set([m1, m2, m3]).size > 1) fail('medium', 'oa', 'Bulk error text distinguishes private / random / foreign ids (id oracle)', 'one identical message', JSON.stringify([m1, m2, m3]), '', 'Always "Task not found or you are not allowed to change it".');
    if (b1.body.data.updated + b1.body.data.failed !== b1.body.data.results.length) fail('medium', 'oa', 'Bulk summary counts do not add up', 'updated+failed == results', JSON.stringify(b1.body.data).slice(0, 160), '', '');
    const logged = Number(scalar(`SELECT COUNT(*) FROM task.task_status_log WHERE task_id IN (${lit(O1.id)},${lit(O2.id)},${lit(R3.id)}) AND note=${lit(`${MARK} bulk note`)}`));
    log({ role: 'oa', action: 'bulk note recorded in each task\'s status history', method: 'GET', endpoint: 'task.task_status_log', status: 200, verified: logged === 3, expected: '3 rows' });
    if (logged !== 3) fail('medium', 'oa', 'Bulk status note not written to the history of every changed task', '3 log rows', String(logged), '', 'updateTask note handling.');
  }
  // duplicates dedupe; validation limits
  const dup = await bulk(A.oa, { ids: [T2.id, T2.id, T2.id], status_name: 'in_progress' });
  if (dup.body?.data?.results?.length !== 1) fail('low', 'oa', 'Duplicate ids not de-duplicated in bulk', '1 result', String(dup.body?.data?.results?.length), '', '');
  for (const [n, body, want] of [
    ['empty ids', { ids: [], status_name: 'done' }, 422], ['101 ids', { ids: Array.from({ length: 101 }, () => RANDOM), status_name: 'done' }, 422],
    ['malformed id', { ids: ['nope'], status_name: 'done' }, 422], ['no fields to change', { ids: [T2.id] }, 422],
    ['unknown status', { ids: [T2.id], status_name: 'exploded' }, 422], ['ids not an array', { ids: T2.id, status_name: 'done' }, 422],
  ]) {
    const r = await bulk(A.oa, body);
    log({ role: 'oa', action: `bulk rejects ${n}`, method: 'POST', endpoint: '/tasks/bulk', status: r.status, verified: r.status === want, expected: String(want) });
    if (r.status !== want) fail(r.status >= 500 ? 'high' : 'medium', 'oa', `bulk ${n}`, String(want), `HTTP ${r.status}`, r.text.slice(0, 160), 'bulkUpdateTasksSchema.');
  }
  // 100 ids, mostly random: bounded time, no 5xx
  const t0 = Date.now();
  const big = await bulk(A.oa, { ids: [T2.id, ...Array.from({ length: 99 }, (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`)], status_name: 'todo' });
  log({ role: 'oa', action: 'bulk of 100 ids', method: 'POST', endpoint: '/tasks/bulk', status: big.status, verified: big.status === 200 && big.body?.data?.failed === 99, expected: '200, 99 skipped', note: `${Date.now() - t0} ms` });
  if (big.status !== 200 || big.body?.data?.failed !== 99) fail('medium', 'oa', 'Bulk of 100 ids misbehaves', '200 with 99 skipped', `HTTP ${big.status} ${JSON.stringify(big.body?.data?.failed)}`, '', '');
  // assignee fences
  for (const [n, assignee] of [['a tenant-A user', FUSER], ['a user of another MSquare branch', KSH_USER], ['a random user id', RANDOM]].filter(([, v]) => v)) {
    const r = await bulk(A.oa, { ids: [T2.id], assignee_id: assignee });
    const ok = r.status === 200 && r.body?.data?.updated === 0 && (dbTask(T2.id)?.assignee ?? '') === '';
    log({ role: 'oa', action: `bulk reassign to ${n}`, method: 'POST', endpoint: '/tasks/bulk', status: r.status, verified: ok, expected: 'skipped; assignee unchanged' });
    if (!ok) fail('critical', 'oa', `Bulk assigned a task to ${n}`, 'refused ("Assignee is not an active member of this org")', `HTTP ${r.status} updated=${r.body?.data?.updated} assignee=${dbTask(T2.id)?.assignee}`, r.text.slice(0, 200), 'assertAssigneeActive per id.');
  }
  const un = await bulk(A.oa, { ids: [T1.id], assignee_id: null });
  if (!(un.body?.data?.updated === 1 && dbTask(T1.id)?.assignee === '')) fail('medium', 'oa', 'Bulk unassign (assignee_id null) did not apply', 'assignee cleared', JSON.stringify(un.body?.data), '', '');
  await req(A.oa, 'PATCH', `${T}/tasks/${T1.id}`, { data: { assignee_id: ID.ta } });
  // body-supplied identity ignored
  const sp = await bulk(A.oa, { ids: [R1.id], status_name: 'done', user_id: ID.rep, org_id: KSH ?? ORG, created_by: ID.rep, tenant_id: TA_TENANT });
  if (dbTask(R1.id)?.status === 'done') fail('critical', 'oa', 'Bulk honoured client-supplied identity fields to reach a private task', 'unchanged', 'done', '', 'Identity only from the session.');
  // rep (no bulk) and F (own tenant)
  const rb = await bulk(A.rep, { ids: [R1.id], status_name: 'todo' });
  grade(rep_, { role: 'rep', scenario: 'bulk (default rep)', has: caps.rep?.has('tasks.bulk') && caps.rep?.has('tasks.edit'), status: rb.status, effect: null, method: 'POST', endpoint: '/tasks/bulk', evidence: rb.text.slice(0, 120), sevOver: 'high' });
  const fb = await bulk(A.f, { ids: [F1.id, O2.id, T1.id, R3.id, ...(KID ? [KID] : [])], status_name: 'in_progress' });
  const fres = Object.fromEntries((fb.body?.data?.results ?? []).map((r) => [r.id, r]));
  const fOk = isOk(fb.status) && fres[F1.id]?.ok && [O2, T1, R3].every((x) => fres[x.id] && !fres[x.id].ok) && dbTask(O2.id)?.status !== 'in_progress';
  log({ role: 'f', action: 'cross-tenant bulk: own task + tenant-B task ids', method: 'POST', endpoint: '/tasks/bulk', status: fb.status, verified: fOk, expected: 'own changes, tenant B ids skipped' });
  if (isOk(fb.status) && [O2, T1, R3].some((x) => fres[x.id]?.ok)) fail('critical', 'f', 'TENANT A USER CHANGED TENANT B TASKS VIA BULK', 'skipped', JSON.stringify(fres), '', 'org fence in getTaskRow.');
  else if (!fOk) fail('medium', 'f', 'Cross-tenant actor bulk behaved unexpectedly', 'own ok, foreign skipped', `HTTP ${fb.status} ${fb.text.slice(0, 160)}`, '', '');
  const bf = await bulk(A.oa, { ids: [F1.id, F2.id], status_name: 'done' });
  if (bf.body?.data?.updated) fail('critical', 'oa', 'Tenant B admin changed tenant A tasks via bulk', 'skipped', JSON.stringify(bf.body.data), '', 'org fence.');
  for (const x of [F1, F2]) if (dbTask(x.id)?.status === 'done') fail('critical', 'oa', 'Tenant A task marked done by tenant B', 'unchanged', 'done', x.id, '');
  // single-task cross-tenant reads
  for (const [who, a, id] of [['f', A.f, O2.id], ['f', A.f, T1.id], ['oa', A.oa, F1.id], ['oa', A.oa, R1.id]]) {
    for (const [p, m] of [['', 'GET'], ['/comments', 'GET'], ['/status-history', 'GET']]) {
      const r = await req(a, m, `${T}/tasks/${id}${p}`);
      if (isOk(r.status)) fail('critical', who, `${who} can read ${m} /tasks/<other tenant or private id>${p}`, '404', `HTTP ${r.status}`, id, 'loadVisible / org fence.');
    }
    const w = await req(a, 'PATCH', `${T}/tasks/${id}`, { data: { title: `${MARK} HIJACK` } });
    if (isOk(w.status) || (scalar(`SELECT title FROM task.tasks WHERE id=${lit(id)}`) ?? '').includes('HIJACK')) fail('critical', who, 'PATCH of another tenant\'s / private task succeeded', '404/403', `HTTP ${w.status}`, id, 'loadVisible.');
  }

  // ── D. capability on / off ────────────────────────────────────────────────
  console.log('\n== D capabilities ==');
  const flip = async (who, a, role, cap, granted) => {
    setOverride(TB, role, cap, granted);
    const w = await waitForSessionCapability(a, cap, granted, { timeoutMs: 20000 });
    if (!w.ok) console.log(`  (cap ${cap}=${granted} not effective for ${who} after ${w.ms} ms)`);
    return w;
  };
  // d1: rep gets bulk (+ edit already): own tasks only
  await flip('rep', A.rep, 'sales_representative', 'tasks.bulk', true);
  if (caps.rep && !caps.rep.has('tasks.edit')) await flip('rep', A.rep, 'sales_representative', 'tasks.edit', true);
  const d1 = await bulk(A.rep, { ids: [R1.id, R2.id, O1.id, T1.id, O2.id], status_name: 'todo' });
  const d1r = Object.fromEntries((d1.body?.data?.results ?? []).map((r) => [r.id, r]));
  const d1ok = isOk(d1.status) && d1r[R1.id]?.ok && d1r[R2.id]?.ok && !d1r[O1.id]?.ok && !d1r[T1.id]?.ok && !d1r[O2.id]?.ok;
  log({ role: 'rep', action: 'tasks.bulk granted: rep bulk touches own tasks only', method: 'POST', endpoint: '/tasks/bulk', status: d1.status, verified: d1ok, expected: 'own ok; others skipped' });
  if (!d1ok) fail(d1r[O1.id]?.ok || d1r[T1.id]?.ok ? 'critical' : 'medium', 'rep', 'Rep with tasks.bulk: wrong per-task authorisation', 'own tasks changed, colleagues\' skipped', `HTTP ${d1.status} ${JSON.stringify(d1.body?.data?.results)?.slice(0, 260)}`, '', 'canEditTask per id.');
  const dAssign = await bulk(A.rep, { ids: [R1.id], assignee_id: ID.ta });
  const repAssign = caps.rep?.has('tasks.assign');
  grade(rep_, { role: 'rep', scenario: 'bulk reassign to a colleague without tasks.assign', has: !!repAssign, status: dAssign.status, effect: null, method: 'POST', endpoint: '/tasks/bulk', evidence: dAssign.text.slice(0, 120) });
  // d2: edit revoked, bulk granted -> 403
  await flip('rep', A.rep, 'sales_representative', 'tasks.edit', false);
  const d2 = await bulk(A.rep, { ids: [R1.id], status_name: 'done' });
  log({ role: 'rep', action: 'tasks.bulk without tasks.edit', method: 'POST', endpoint: '/tasks/bulk', status: d2.status, verified: d2.status === 403 && dbTask(R1.id)?.status !== 'done', expected: '403' });
  if (isOk(d2.status) || dbTask(R1.id)?.status === 'done') fail('high', 'rep', 'tasks.bulk alone lets a user change tasks they cannot PATCH', '403 (needs tasks.edit too)', `HTTP ${d2.status}`, '', 'router requires both capabilities.');
  const patchNoEdit = await req(A.rep, 'PATCH', `${T}/tasks/${R1.id}`, { data: { status_name: 'done' } });
  if (isOk(patchNoEdit.status)) fail('high', 'rep', 'PATCH succeeded without tasks.edit', '403', `HTTP ${patchNoEdit.status}`, '', '');
  await flip('rep', A.rep, 'sales_representative', 'tasks.edit', true);
  // d3: export granted to rep: own rows only
  await flip('rep', A.rep, 'sales_representative', 'tasks.export', true);
  const d3 = await expC(A.rep, `scope=own&include_completed=true&q=${encodeURIComponent(MARK)}`);
  const d3t = isOk(d3.status) ? parseCsv(d3.text).slice(1).map((c) => c[1]) : [];
  const d3ok = isOk(d3.status) && d3t.some((t) => t.includes('R1')) && !d3t.some((t) => /O1|T1 |K1|F1/.test(t));
  log({ role: 'rep', action: 'tasks.export granted: rep export has only own rows', method: 'GET', endpoint: '/tasks/export', status: d3.status, verified: d3ok, expected: 'own rows only' });
  if (!d3ok) fail(d3t.some((t) => /O1|K1|F1/.test(t)) ? 'critical' : 'medium', 'rep', 'Rep export wrong after grant', 'R1.. only', `HTTP ${d3.status} ${d3t.join(' | ').slice(0, 200)}`, '', 'runScoped own.');
  await flip('rep', A.rep, 'sales_representative', 'tasks.export', false);
  const d3b = await expC(A.rep, 'scope=own');
  if (isOk(d3b.status)) fail('high', 'rep', 'Export still works after tasks.export was revoked', '403', `HTTP ${d3b.status}`, '', 'Capability cache / requireCapability.');
  await flip('rep', A.rep, 'sales_representative', 'tasks.bulk', false);
  // d4: org admin: bulk off / on, export off, view.org off, assign off
  await flip('oa', A.oa, 'org_admin', 'tasks.bulk', false);
  const d4 = await bulk(A.oa, { ids: [T2.id], status_name: 'todo' });
  log({ role: 'oa', action: 'tasks.bulk revoked from org_admin', method: 'POST', endpoint: '/tasks/bulk', status: d4.status, verified: d4.status === 403, expected: '403' });
  if (d4.status !== 403) fail('high', 'oa', 'Bulk works after tasks.bulk was revoked', '403', `HTTP ${d4.status}`, '', '');
  await flip('oa', A.oa, 'org_admin', 'tasks.bulk', true);
  await flip('oa', A.oa, 'org_admin', 'tasks.assign', false);
  const d5 = await bulk(A.oa, { ids: [T2.id], assignee_id: ID.ta });
  const d5self = await bulk(A.oa, { ids: [T2.id], assignee_id: ID.oa });
  log({ role: 'oa', action: 'no tasks.assign: reassign to others 403, to self allowed', method: 'POST', endpoint: '/tasks/bulk', status: d5.status, verified: d5.status === 403 && isOk(d5self.status), expected: '403 / 200' });
  if (isOk(d5.status)) fail('high', 'oa', 'Bulk reassigns to a colleague without tasks.assign', '403', `HTTP ${d5.status}`, '', 'canAssignTasks check in bulkUpdateTasks.');
  await flip('oa', A.oa, 'org_admin', 'tasks.assign', true);
  await flip('oa', A.oa, 'org_admin', 'tasks.view.org', false);
  const d6 = await Promise.all([stats(A.oa, 'org'), expC(A.oa, 'scope=org'), req(A.oa, 'GET', `${T}/tasks?scope=org`), stats(A.oa, 'own')]);
  log({ role: 'oa', action: 'tasks.view.org revoked: org scope refused everywhere, own scope fine', method: 'GET', endpoint: '/tasks*', status: d6.map((r) => r.status).join('/'), verified: [d6[0], d6[1], d6[2]].every((r) => r.status === 403) && isOk(d6[3].status), expected: '403 x3, 200' });
  if (![d6[0], d6[1], d6[2]].every((r) => r.status === 403)) fail('high', 'oa', 'Org scope still reachable after tasks.view.org revoked (stats/export/list disagree)', '403 on all three', d6.map((r) => r.status).join('/'), '', 'assertScopeAllowed shared by list/stats/export.');
  await flip('oa', A.oa, 'org_admin', 'tasks.view.org', true);
  await flip('ta', A.ta, 'tenant_admin', 'tasks.export', false);
  const d7 = await expC(A.ta, 'scope=org');
  if (isOk(d7.status)) fail('high', 'ta', 'Export works after tasks.export was revoked from tenant_admin', '403', `HTTP ${d7.status}`, '', '');
  await flip('ta', A.ta, 'tenant_admin', 'tasks.export', true);
  log({ role: 'ta', action: 'capability overrides toggled and restored', method: 'PUT', endpoint: 'iam.role_capabilities', status: 200, verified: true, expected: 'restored' });

  // ── E. two users, one task ────────────────────────────────────────────────
  console.log('\n== E concurrent edits ==');
  for (let round = 1; round <= 3; round++) {
    const cur = await req(A.oa, 'GET', `${T}/tasks/${T2.id}`);
    const t0v = new Date(cur.body?.data?.updated_at).toISOString();
    const [x, y] = await Promise.all([
      req(A.oa, 'PATCH', `${T}/tasks/${T2.id}`, { data: { assignee_id: ID.ta, status_name: 'in_progress', expected_updated_at: t0v } }),
      req(A.ta, 'PATCH', `${T}/tasks/${T2.id}`, { data: { assignee_id: ID.oa, status_name: 'blocked', expected_updated_at: t0v } }),
    ]);
    const d = dbTask(T2.id);
    const wins = [x, y].filter((r) => isOk(r.status)).length;
    const pairOk = (d.assignee === ID.ta && d.status === 'in_progress') || (d.assignee === ID.oa && d.status === 'blocked');
    const winnerMatches = (isOk(x.status) && d.assignee === ID.ta) || (isOk(y.status) && d.assignee === ID.oa);
    log({ role: 'oa+ta', action: `round ${round}: simultaneous assignee+status edit with the same expected_updated_at`, method: 'PATCH', endpoint: '/tasks/:id', status: `${x.status}/${y.status}`, verified: wins === 1 && pairOk && winnerMatches, expected: 'one 200, one 409, DB == winner' });
    if (wins !== 1) fail(wins === 2 ? 'high' : 'medium', 'oa+ta', `Optimistic locking: ${wins} of 2 stale-token writers succeeded`, 'exactly one 200 and one 409', `${x.status}/${y.status}`, JSON.stringify([x.body, y.body]).slice(0, 220), 'updateTask must guard on expected_updated_at atomically.');
    if (!pairOk) fail('high', 'oa+ta', 'Concurrent edits produced a MIXED record (assignee from one writer, status from the other)', 'one writer\'s values entirely', `assignee=${d.assignee} status=${d.status}`, T2.id, 'Update must be one statement guarded by the token.');
    const conflict = [x, y].find((r) => r.status === 409);
    if (conflict && !/changed|reload|conflict|stale|updated/i.test(JSON.stringify(conflict.body))) fail('low', 'oa+ta', '409 body has no actionable message', 'message telling the user to reload', JSON.stringify(conflict.body).slice(0, 120), '', '');
  }
  // last-writer-wins without a token: still never mixed
  const [lx, ly] = await Promise.all([
    req(A.oa, 'PATCH', `${T}/tasks/${T4.id}`, { data: { assignee_id: ID.oa, status_name: 'done' } }),
    req(A.ta, 'PATCH', `${T}/tasks/${T4.id}`, { data: { assignee_id: ID.ta, status_name: 'blocked' } }),
  ]);
  const dl = dbTask(T4.id);
  const mixed = !((dl.assignee === ID.oa && dl.status === 'done') || (dl.assignee === ID.ta && dl.status === 'blocked'));
  log({ role: 'oa+ta', action: 'token-less simultaneous edits end consistent', method: 'PATCH', endpoint: '/tasks/:id', status: `${lx.status}/${ly.status}`, verified: !mixed, expected: 'one writer\'s pair' });
  if (mixed) fail('medium', 'oa+ta', 'Token-less concurrent PATCHes interleaved into a mixed record', 'pair from one writer', `assignee=${dl.assignee} status=${dl.status}`, T4.id, 'Single UPDATE statement.');
  const histN = Number(scalar(`SELECT COUNT(*) FROM task.task_status_log WHERE task_id=${lit(T4.id)}`));
  if (histN < 1) fail('low', 'oa+ta', 'Status history has no entry after concurrent status changes', '>=1', String(histN), T4.id, '');
  // bulk vs single race
  const [bx, by] = await Promise.all([
    bulk(A.oa, { ids: [T3.id], status_name: 'done' }),
    req(A.ta, 'PATCH', `${T}/tasks/${T3.id}`, { data: { status_name: 'blocked' } }),
  ]);
  const ds = dbTask(T3.id)?.status;
  log({ role: 'oa+ta', action: 'bulk and single edit on the same task', method: 'POST', endpoint: '/tasks/bulk + PATCH', status: `${bx.status}/${by.status}`, verified: ['done', 'blocked'].includes(ds), expected: 'consistent end state' });
  if (bx.status >= 500 || by.status >= 500) fail('high', 'oa+ta', 'bulk/PATCH race 5xx', '2xx/409', `${bx.status}/${by.status}`, '', '');

  // ── F. identity spoofing on create/update ─────────────────────────────────
  console.log('\n== F spoofing ==');
  const sp2 = await req(A.rep, 'POST', `${T}/tasks`, { data: { title: `${MARK} spoof`, priority_name: 'low', status_name: 'todo', created_by: ID.oa, org_id: KSH ?? ORG, tenant_id: TA_TENANT, user_id: ID.ta } });
  const spId = sp2.body?.data?.id; if (spId) created.tasks.push(spId);
  const spRow = spId ? dbTask(spId) : null;
  log({ role: 'rep', action: 'create with client-supplied created_by/org_id', method: 'POST', endpoint: '/tasks', status: sp2.status, verified: !spRow || (spRow.by === ID.rep && spRow.org === ORG), expected: 'identity from the session' });
  if (spRow && (spRow.by !== ID.rep || spRow.org !== ORG)) fail('critical', 'rep', 'Task created under another user / branch from client-supplied fields', 'created_by = caller, org = session org', JSON.stringify(spRow), spId, 'Never read identity from the body.');
  const sp3 = await req(A.rep, 'PATCH', `${T}/tasks/${R1.id}`, { data: { created_by: ID.oa, org_id: KSH ?? ORG, title: `${MARK} R1 rep-private` } });
  if (dbTask(R1.id)?.by !== ID.rep || dbTask(R1.id)?.org !== ORG) fail('critical', 'rep', 'PATCH changed created_by/org_id', 'ignored', JSON.stringify(dbTask(R1.id)), '', 'updateTaskSchema whitelist.');
  void sp3;
  const sp4 = await req(A.f, 'POST', `${T}/tasks`, { data: { title: `${MARK} cross list`, list_id: LORG, priority_name: 'low', status_name: 'todo' } });
  if (sp4.body?.data?.id) { created.tasks.push(sp4.body.data.id); fail('critical', 'f', 'Tenant A user created a task inside a tenant-B list', '400 (list not accessible)', 'created', sp4.body.data.id, 'assertListUsable org fence.'); }
  const sp5 = await req(A.f, 'POST', `${T}/tasks`, { data: { title: `${MARK} cross assignee`, assignee_id: ID.ta, priority_name: 'low', status_name: 'todo' } });
  if (sp5.body?.data?.id) { created.tasks.push(sp5.body.data.id); fail('critical', 'f', 'Tenant A user assigned a task to a tenant-B user', '400', 'created', sp5.body.data.id, 'assertAssigneeActive.'); }

  await close();
  await uiPass();
}

// ── G. UI ────────────────────────────────────────────────────────────────────
async function uiPass() {
  console.log('\n== G UI ==');
  const base = APPS['todo-web'];
  const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.locator('[role="status"]:has-text("Loading")').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500); };
  const rowTitles = async (page) => (await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => (tr.querySelectorAll('td')[2]?.innerText || tr.innerText).split('\n')[0].trim()))).filter(Boolean);
  const search = async (page, text) => { const s = page.getByLabel('Search tasks'); await s.fill(text); await page.waitForTimeout(900); await settle(page); };
  const tileCount = async (page, label) => { const t = await page.locator('button[aria-pressed]', { hasText: label }).first().innerText().catch(() => ''); const m = t.replace(label, '').match(/\d+/); return m ? Number(m[0]) : null; };
  const who = [
    { key: 'msq_rep1', k: 'rep', org: false }, { key: 'msq_org_admin', k: 'oa', org: true }, { key: 'msq_tenant_admin', k: 'ta', org: true }, { key: 'sales_representative', k: 'f', org: false },
  ];
  const TID = (k) => created.tasks.find(() => true);
  for (const w of who) {
    const { browser, ctx, page, log: plog } = await openState(w.key);
    const api = { request: ctx.request };
    try {
      const caps = new Set((await req(api, 'GET', `${GATEWAY}/auth/me`)).body?.data?.user?.capabilities ?? []);
      const L = (action, verified, extra = {}) => log({ role: w.key, area: 'todo-web', action, method: 'UI', endpoint: extra.endpoint ?? '/tasks', status: extra.status ?? null, verified, outcome: extra.outcome ?? 'visible', expected: extra.expected });
      await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const onPage = new URL(page.url()).pathname.replace(/\/$/, '').endsWith('/tasks');
      const canView = caps.has('tasks.view');
      L('open My Tasks', onPage === canView, { expected: canView ? 'renders' : 'redirected/denied' });
      if (canView && !onPage) { fail('high', w.key, 'My Tasks not reachable for a tasks.view holder', '/tasks renders', page.url(), '', 'page guard.', 'todo-web /tasks'); continue; }
      if (!canView) { if (onPage && (await page.locator('tbody tr').count())) fail('high', w.key, 'My Tasks rendered rows for a user without tasks.view', 'denied', 'rows shown', '', '', 'todo-web /tasks'); continue; }
      await search(page, MARK);
      // visibility: UI rows == DB expectation
      const titles = await rowTitles(page);
      const mine = (s) => titles.filter((t) => t.includes(s)).length > 0;
      const expectVisible = w.k === 'rep' ? ['R1', 'R2', 'T3'] : w.k === 'f' ? ['F1', 'F2'] : ['R3'];
      const expectHidden = w.k === 'rep' ? ['O1', 'O2', 'T1', 'F1'] : w.k === 'f' ? ['R1', 'O2', 'T1', 'K1'] : ['R1', 'R2', 'F1', 'K1'];
      const missing = expectVisible.filter((s) => !titles.some((t) => t.includes(` ${s} `) || t.includes(`${s} `)));
      const leaked = expectHidden.filter((s) => titles.some((t) => t.includes(` ${s} `)));
      L('My Tasks grid shows exactly the caller\'s own tasks (search by marker)', !leaked.length, { expected: 'own only' });
      if (leaked.length) fail('critical', w.key, `My Tasks (own scope) shows tasks that are not the caller's: ${leaked.join(', ')}`, 'own (created/assigned) only', titles.join(' | ').slice(0, 240), '', 'scope=own RLS + filters.', 'todo-web /tasks');
      void mine; void missing;

      // tiles
      const stApi = (await req(api, 'GET', `${GATEWAY}/tasks/stats?scope=own`)).body?.data;
      const tileTotal = await tileCount(page, 'Total assigned');
      L('"Total assigned" tile equals /tasks/stats open', tileTotal === stApi?.open, { expected: String(stApi?.open) });
      if (tileTotal !== stApi?.open) fail('medium', w.key, 'KPI tile disagrees with the stats API', `open=${stApi?.open}`, `tile=${tileTotal}`, '', 'TaskStatsCards / useTaskBoard.', 'todo-web /tasks');
      for (const tile of ['In progress', 'Blocked', 'SLA critical', 'Total assigned']) {
        const b = page.locator('button[aria-pressed]', { hasText: tile }).first();
        if (!(await b.count())) continue;
        await b.click(); await page.waitForTimeout(700); await settle(page);
        const pressed = await b.getAttribute('aria-pressed');
        const ts = await rowTitles(page);
        const wantStatus = { 'In progress': 'in_progress', Blocked: 'blocked' }[tile];
        let okTile = true;
        if (wantStatus) { const dbN = rows(`SELECT t.id FROM task.tasks t JOIN task.task_statuses s ON s.id=t.status_id WHERE s.name=${lit(wantStatus)} AND t.title LIKE ${lit(`${MARK}%`)} AND NOT t.is_deleted AND (t.created_by=${lit(ID_OF(w.k))} OR t.assignee_id=${lit(ID_OF(w.k))}) AND t.org_id=(SELECT org_id FROM iam.users WHERE id=${lit(ID_OF(w.k))})`, ['id']).length; okTile = ts.length === dbN; }
        L(`tile "${tile}" filters the grid (aria-pressed=${pressed})`, okTile, { expected: 'rows == DB' });
        if (!okTile) fail('medium', w.key, `Tile "${tile}" filter shows ${ts.length} rows, DB has a different count`, 'grid == DB for the same filter', `UI ${ts.length}`, ts.join(' | ').slice(0, 200), 'status filter on the grid.', 'todo-web /tasks');
        await b.click().catch(() => {}); await page.waitForTimeout(300);
      }
      // filter dropdowns via the generic sweep + explicit checks
      for (const [label, val] of [['Filter by status', 'done'], ['Filter by priority', 'urgent']]) {
        const sel = page.getByLabel(label); if (!(await sel.count())) continue;
        await sel.selectOption(val); await page.waitForTimeout(600); await settle(page);
        const ts = await rowTitles(page);
        const col = label.includes('status') ? 's.name' : 'p.name';
        const dbN = rows(`SELECT t.id FROM task.tasks t JOIN task.task_statuses s ON s.id=t.status_id JOIN task.task_priorities p ON p.id=t.priority_id WHERE ${col}=${lit(val)} AND t.title LIKE ${lit(`${MARK}%`)} AND NOT t.is_deleted AND (t.created_by=${lit(ID_OF(w.k))} OR t.assignee_id=${lit(ID_OF(w.k))}) AND t.org_id=(SELECT org_id FROM iam.users WHERE id=${lit(ID_OF(w.k))}) ${val === 'done' ? '' : "AND s.name NOT IN ('done','cancelled')"}`, ['id']).length;
        if (val === 'done') await page.getByLabel('Show completed', { exact: false }).check().catch(() => {});
        await page.waitForTimeout(500); await settle(page);
        const ts2 = await rowTitles(page);
        L(`filter ${label}=${val}`, ts2.length === dbN, { expected: `${dbN} rows` });
        if (ts2.length !== dbN) fail('medium', w.key, `${label}=${val}: grid shows ${ts2.length}, DB has ${dbN}`, 'equal', ts2.join(' | ').slice(0, 160), '', 'filter wiring.', 'todo-web /tasks');
        await page.getByRole('button', { name: 'Clear filters' }).click().catch(() => {}); await search(page, MARK);
        void ts;
      }
      // sorting
      for (const col of ['Title', 'Priority', 'Status']) {
        const h = page.locator('th button', { hasText: col }).first();
        if (!(await h.count())) continue;
        await h.click(); await page.waitForTimeout(500); await settle(page);
        const thL = page.locator(`th:has(button:has-text("${col}"))`).first();
        const s1 = await thL.getAttribute('aria-sort', { timeout: 3000 }).catch(() => null);
        await h.click(); await page.waitForTimeout(500); await settle(page);
        const s2 = await thL.getAttribute('aria-sort', { timeout: 3000 }).catch(() => null);
        L(`sort by ${col} toggles aria-sort (${s1} -> ${s2})`, s1 !== null && s1 !== s2 && s1 !== 'none', {});
        if (s1 !== null && (s1 === s2 || s1 === 'none')) fail('low', w.key, `Sort header ${col} does not toggle`, 'ascending/descending', `${s1}/${s2}`, '', 'TaskTable sort.', 'todo-web /tasks');
      }
      // title sort order vs DB
      const th = page.locator('th button', { hasText: 'Title' }).first();
      if (await th.count()) { await th.click(); await settle(page); const tt = (await rowTitles(page)).map((x) => x.toLowerCase()); const srt = [...tt].sort(); if (tt.length > 1 && JSON.stringify(tt) !== JSON.stringify(srt) && JSON.stringify(tt) !== JSON.stringify([...srt].reverse())) fail('medium', w.key, 'Title sort order is neither ascending nor descending', 'sorted', tt.join(' | ').slice(0, 160), '', 'orderClause lower(title).', 'todo-web /tasks'); }
      // view toggle + board move (writer only)
      const board = page.getByRole('button', { name: 'Board', exact: true });
      if (await board.count()) {
        await board.click(); await settle(page);
        const cols = await page.locator('section[aria-label*="tasks"]').count();
        L(`Board view renders ${cols} status columns`, cols >= 4, {});
        if (cols < 4) fail('medium', w.key, 'Board view shows fewer than 4 status columns', '>=4', String(cols), '', 'TaskBoard.', 'todo-web /tasks');
        if (caps.has('tasks.edit')) {
          const mv = page.locator('select[aria-label^="Move"]', { has: page.locator('option') }).first();
          if (await mv.count()) {
            const lab = await mv.getAttribute('aria-label'); const title = lab.replace(/^Move /, '').replace(/ to another status$/, '');
            const idRow = rows(`SELECT t.id::text, s.name FROM task.tasks t JOIN task.task_statuses s ON s.id=t.status_id WHERE t.title=${lit(title)} LIMIT 1`, ['id', 's'])[0];
            if (idRow) {
              const target = idRow.s === 'blocked' ? 'todo' : 'blocked';
              const wr = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/tasks\//.test(r.url()), { timeout: 10000 }).catch(() => null);
              await mv.selectOption(target); const resp = await wr; await page.waitForTimeout(700);
              const nowS = dbTask(idRow.id)?.status;
              L(`board: move "${title.slice(0, 30)}" to ${target}`, nowS === target, { status: resp?.status() ?? null, expected: target });
              if (nowS !== target) fail('high', w.key, 'Board move did not persist', `status=${target}`, `HTTP ${resp?.status()} db=${nowS}`, idRow.id, 'TaskBoard move -> PATCH.', 'todo-web /tasks');
            }
          }
        }
        await page.getByRole('button', { name: 'List', exact: true }).click().catch(() => {}); await settle(page);
      }
      // quick add / new task modal
      if (caps.has('tasks.create')) {
        const qa = `${MARK} UI quick ${w.k}`;
        await page.getByLabel('New task title').fill(qa);
        const wr = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/tasks(\?|$)/.test(r.url()), { timeout: 10000 }).catch(() => null);
        await page.getByLabel('New task title').press('Enter'); const resp = await wr; await page.waitForTimeout(800);
        const qid = scalar(`SELECT id FROM task.tasks WHERE title=${lit(qa)} LIMIT 1`); if (qid) created.tasks.push(qid);
        L('quick-add a task (Enter)', !!qid, { status: resp?.status() ?? null, expected: 'row in task.tasks' });
        if (!qid) fail('high', w.key, 'Quick-add returned without creating a task', 'row persisted', `HTTP ${resp?.status()}`, '', 'TaskQuickAdd.', 'todo-web /tasks');
        await page.getByRole('button', { name: '+ New task' }).click();
        const dlg = page.locator('[role="dialog"]').filter({ has: page.locator('#new-task-title') }).first();
        const ttl = `${MARK} UI modal ${w.k}`;
        await dlg.locator('#new-task-title').fill(ttl); await dlg.locator('#new-task-desc').fill('=cmd|desc');
        await dlg.locator('#new-task-priority').selectOption('high').catch(() => {});
        const opts = await dlg.locator('#new-task-list option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean)); if (opts.length) await dlg.locator('#new-task-list').selectOption(opts[0]);
        const wr2 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/tasks(\?|$)/.test(r.url()), { timeout: 10000 }).catch(() => null);
        await dlg.getByRole('button', { name: /^create/i }).last().click(); const r2 = await wr2; await page.waitForTimeout(900);
        const mid = scalar(`SELECT id FROM task.tasks WHERE title=${lit(ttl)} LIMIT 1`); if (mid) created.tasks.push(mid);
        L('New task modal -> Create', !!mid, { status: r2?.status() ?? null });
        if (!mid) fail('high', w.key, 'New-task modal Create did not persist', 'row', `HTTP ${r2?.status()}`, '', 'TaskCreateModal.', 'todo-web /tasks');
        await page.getByRole('button', { name: '+ New task' }).click(); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      }
      // bulk bar
      const boxes = page.getByLabel(/^Select (?!all)/);
      const canBulk = caps.has('tasks.bulk');
      const nBoxes = await boxes.count();
      L(`bulk checkboxes ${canBulk ? 'visible' : 'hidden'} (${nBoxes})`, canBulk ? nBoxes > 0 || (await rowTitles(page)).length === 0 : nBoxes === 0, { expected: canBulk ? 'visible' : 'hidden' });
      if (!canBulk && nBoxes > 0) fail('medium', w.key, 'Bulk selection controls shown to a user without tasks.bulk', 'hidden', `${nBoxes} checkboxes`, '', 'canBulkUpdateTasks gate.', 'todo-web /tasks');
      if (canBulk && nBoxes > 0) {
        await page.getByLabel('Select all tasks on this page').check(); await page.waitForTimeout(300);
        const bar = page.getByRole('region', { name: 'Bulk actions' });
        const txt = await bar.innerText().catch(() => '');
        L('select-all shows the "N selected" bar', /selected/.test(txt), {});
        const targetsBefore = rows(`SELECT id::text FROM task.tasks WHERE title LIKE ${lit(`${MARK}%`)} AND NOT is_deleted`, ['id']).length; void targetsBefore;
        await bar.getByRole('button', { name: 'Change status' }).click();
        const dlg = page.locator('[role="dialog"]').last();
        await dlg.locator('#bulk-status').selectOption('in_progress'); await dlg.locator('#bulk-note').fill(`${MARK} ui-bulk`);
        const wr = page.waitForResponse((r) => r.request().method() === 'POST' && /\/tasks\/bulk/.test(r.url()), { timeout: 15000 }).catch(() => null);
        await dlg.getByRole('button', { name: 'Apply' }).click(); const resp = await wr; await page.waitForTimeout(800);
        const resTxt = await dlg.innerText().catch(() => '');
        const body = await resp?.json().catch(() => null);
        const updated = body?.data?.updated ?? -1; const results = body?.data?.results ?? [];
        const dbOk = results.every((r) => (dbTask(r.id)?.status === 'in_progress') === r.ok || !r.ok);
        L(`bulk Change status via UI (${resTxt.replace(/\s+/g, ' ').slice(0, 50)})`, resp?.status() === 200 && dbOk && new RegExp(`${updated} updated`).test(resTxt), { status: resp?.status() ?? null });
        if (resp?.status() !== 200 || !dbOk) fail('high', w.key, 'UI bulk status: response/DB mismatch', '200 and DB == results', `HTTP ${resp?.status()}`, JSON.stringify(results).slice(0, 200), 'TaskBulkBar / bulk API.', 'todo-web /tasks');
        for (const r of results) { if (!r.ok) { const own = dbTask(r.id); if (own && own.status === 'in_progress' && !/E2E/.test('')) { /* a skipped row must be unchanged: compared in API suite */ } } }
        await dlg.getByRole('button', { name: /^close$/i }).click().catch(() => page.keyboard.press('Escape'));
        await page.waitForTimeout(600);
        // reassign dialog opens (UserPicker), cancel
        if (await page.getByLabel('Select all tasks on this page').count()) { await page.getByLabel('Select all tasks on this page').check(); const re = page.getByRole('button', { name: 'Bulk reassign' }); if (await re.count()) { await re.click(); await page.waitForTimeout(400); L('Bulk reassign dialog opens', await page.locator('[role="dialog"]').count() > 0, {}); await page.getByRole('button', { name: 'Cancel' }).click().catch(() => {}); } await page.getByRole('button', { name: 'Clear', exact: true }).click().catch(() => {}); }
      }
      // export button
      const exp = page.getByRole('button', { name: /export csv/i });
      const hasExp = caps.has('tasks.export');
      L(`Export CSV button ${hasExp ? 'visible' : 'hidden'}`, (await exp.count() > 0) === hasExp, { expected: hasExp ? 'visible' : 'hidden' });
      if ((await exp.count() > 0) !== hasExp) fail(hasExp ? 'medium' : 'medium', w.key, `Export CSV button ${hasExp ? 'missing for' : 'shown to'} a ${hasExp ? 'holder' : 'non-holder'} of tasks.export`, hasExp ? 'visible' : 'hidden', String(await exp.count()), '', 'canExportTasks gate.', 'todo-web /tasks');
      if (hasExp && (await exp.count())) {
        const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await exp.click(); const d = await dl;
        if (d) {
          const path = await d.path(); const csv = fs.readFileSync(path, 'utf8'); const g = parseCsv(csv);
          const badCell = g.slice(1).some((c) => c.some((v) => /^[=+\-@]/.test(v)));
          L(`UI export downloaded ${d.suggestedFilename()} (${g.length - 1} rows)`, !badCell, {});
          if (badCell) fail('high', w.key, 'UI CSV export contains an un-neutralised formula cell', 'apostrophe-prefixed', 'cell starts with = + - @', d.suggestedFilename(), 'lib/csv.ts.', 'todo-web /tasks');
          if (/F1 fitclass/.test(csv) && w.k !== 'f') fail('critical', w.key, 'Export contains a tenant-A task', 'none', 'F1 present', '', 'org fence.', 'todo-web /tasks');
        } else fail('medium', w.key, 'Export CSV click produced no download', 'file download', 'none', '', 'exportCsv in TaskHubShell.', 'todo-web /tasks');
      }
      // detail drawer: edit + comment + history
      await page.getByRole('button', { name: 'Clear filters' }).click().catch(() => {}); await search(page, `${MARK} `);
      const firstTitle = page.locator('tbody tr td button').first();
      if (await firstTitle.count()) {
        await firstTitle.click(); await page.waitForTimeout(800);
        const drawer = page.getByRole('dialog', { name: 'Task detail' });
        const open = await drawer.count() > 0;
        L('task drawer opens', open, {});
        if (open) {
          const ttl = (await drawer.locator('#task-title').inputValue().catch(() => '')) || '';
          const tid = rows(`SELECT id::text FROM task.tasks WHERE title=${lit(ttl)} LIMIT 1`, ['id'])[0]?.id;
          const editable = caps.has('tasks.edit') && tid && (dbTask(tid)?.by === ID_OF(w.k) || dbTask(tid)?.assignee === ID_OF(w.k) || caps.has('tasks.edit.any'));
          if (editable) {
            await drawer.locator('#task-priority').selectOption('low');
            await drawer.locator('#task-status').selectOption('in_progress');
            const wr = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/tasks\//.test(r.url()), { timeout: 10000 }).catch(() => null);
            await drawer.getByRole('button', { name: 'Save changes' }).click(); const resp = await wr; await page.waitForTimeout(700);
            const pr = scalar(`SELECT p.name FROM task.tasks t JOIN task.task_priorities p ON p.id=t.priority_id WHERE t.id=${lit(tid)}`);
            L('drawer: change priority+status, Save changes', pr === 'low' && dbTask(tid)?.status === 'in_progress', { status: resp?.status() ?? null });
            if (!(pr === 'low' && dbTask(tid)?.status === 'in_progress')) fail('high', w.key, 'Drawer Save changes did not persist', 'priority=low status=in_progress', `HTTP ${resp?.status()} p=${pr}`, tid, 'TaskDetailPanel.save.', 'todo-web /tasks');
          }
          if (caps.has('tasks.comment') && tid) {
            const cm = `${MARK} ui-comment ${w.k}`;
            const inp = drawer.getByLabel('Add a comment'); if (await inp.count()) { await inp.fill(cm); await inp.press('Enter'); await page.waitForTimeout(900); const n = Number(scalar(`SELECT COUNT(*) FROM task.task_comments WHERE task_id=${lit(tid)} AND body=${lit(cm)}`)); L('drawer: add a comment', n === 1, {}); if (n !== 1) fail('medium', w.key, 'Drawer comment not persisted', '1 row', String(n), tid, '', 'todo-web /tasks'); }
            await drawer.getByRole('tab', { name: /Audit history/ }).click().catch(() => {});
          }
          await page.keyboard.press('Escape'); await drawer.getByRole('button', { name: 'Close' }).click().catch(() => {});
        }
      }
      // generic breadth sweep
      await page.goto(`${base}/tasks`, { waitUntil: 'domcontentloaded' }); await settle(page);
      await sweepPage(page, { rep: rep_, role: w.key, label: 'todo-web /tasks', log: plog });
      // /tasks/lists
      await page.goto(`${base}/tasks/lists`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const listsOk = new URL(page.url()).pathname.endsWith('/tasks/lists');
      const wantLists = caps.has('tasks.lists.view');
      L('open Lists & Scopes', listsOk === wantLists, { endpoint: '/tasks/lists', expected: wantLists ? 'renders' : 'redirect' });
      if (listsOk !== wantLists) fail('medium', w.key, `/tasks/lists ${listsOk ? 'shown to a user without' : 'denied to a holder of'} tasks.lists.view`, wantLists ? 'renders' : 'redirect', page.url(), '', 'page guard.', 'todo-web /tasks/lists');
      if (listsOk) {
        const lb = await page.locator('h2[title]').evaluateAll((h) => h.map((x) => x.getAttribute('title')));
        const leakL = lb.filter((n) => n.startsWith(MARK)).filter((n) => (w.k !== 'rep' && n.includes('rep-private')) || (w.k === 'rep' && n.includes('oa-private')) || (w.k === 'f' && /rep-private|oa-/.test(n)));
        L(`lists shown: ${lb.filter((n) => n.startsWith(MARK)).length} fixtures`, !leakL.length, { endpoint: '/tasks/lists' });
        if (leakL.length) fail('critical', w.key, `Lists page shows others' private/foreign lists: ${leakL.join(', ')}`, 'only lists the caller may see', leakL.join(','), '', 'listTaskLists visibility.', 'todo-web /tasks/lists');
        if (caps.has('tasks.lists.manage')) {
          const nm = `${MARK} ui-list ${w.k}`;
          await page.getByRole('button', { name: '+ New list' }).click();
          await page.locator('#list-name').fill(nm);
          const wr = page.waitForResponse((r) => r.request().method() === 'POST' && /task-lists/.test(r.url()), { timeout: 10000 }).catch(() => null);
          await page.locator('[role="dialog"]').getByRole('button', { name: /^(create|save)/i }).last().click(); const resp = await wr; await page.waitForTimeout(800);
          const lid = scalar(`SELECT id FROM task.task_lists WHERE name=${lit(nm)} LIMIT 1`); if (lid) created.lists.push(lid);
          L('create a list through the UI', !!lid, { endpoint: '/tasks/lists', status: resp?.status() ?? null });
          if (!lid) fail('high', w.key, 'New list did not persist', 'row in task.task_lists', `HTTP ${resp?.status()}`, '', 'TaskListFormModal.', 'todo-web /tasks/lists');
          else {
            const card = page.locator('article, li, div', { has: page.locator(`h2[title="${nm}"]`) }).last();
            await card.getByRole('button', { name: 'Edit' }).first().click().catch(() => {});
            await page.locator('#list-name').fill(`${nm} renamed`).catch(() => {});
            const wr2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /task-lists/.test(r.url()), { timeout: 10000 }).catch(() => null);
            await page.locator('[role="dialog"]').getByRole('button', { name: /^(save|update)/i }).last().click().catch(() => {}); await wr2; await page.waitForTimeout(700);
            const renamed = scalar(`SELECT name FROM task.task_lists WHERE id=${lit(lid)}`) === `${nm} renamed`;
            L('rename a list through the UI', renamed, { endpoint: '/tasks/lists' });
            if (!renamed) fail('medium', w.key, 'List rename did not persist', 'new name', scalar(`SELECT name FROM task.task_lists WHERE id=${lit(lid)}`), lid, '', 'todo-web /tasks/lists');
          }
        } else if (await page.getByRole('button', { name: '+ New list' }).count()) fail('medium', w.key, 'New list button shown without tasks.lists.manage', 'hidden', 'visible', '', '', 'todo-web /tasks/lists');
        await sweepPage(page, { rep: rep_, role: w.key, label: 'todo-web /tasks/lists', log: plog });
      }
      // /tasks/team
      await page.goto(`${base}/tasks/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const teamOk = new URL(page.url()).pathname.endsWith('/tasks/team');
      const wantTeam = caps.has('tasks.view.team');
      L('open Team tasks', teamOk === wantTeam, { endpoint: '/tasks/team', expected: wantTeam ? 'renders' : 'redirect to /tasks' });
      if (teamOk !== wantTeam) fail('high', w.key, `/tasks/team ${teamOk ? 'rendered for a user without' : 'denied to a holder of'} tasks.view.team`, wantTeam ? 'renders' : 'redirect', page.url(), '', 'page guard.', 'todo-web /tasks/team');
      if (teamOk) {
        await search(page, MARK);
        const tt = await rowTitles(page);
        const hidden = w.k === 'oa' ? ['R1', 'R2', 'F1', 'K1'] : ['O1', 'R1', 'R2', 'F1', 'K1'];
        const bad = hidden.filter((s) => tt.some((t) => t.includes(` ${s} `)));
        L(`Team grid hides private/foreign/other-branch tasks (${tt.length} rows)`, !bad.length, { endpoint: '/tasks/team' });
        if (bad.length) fail('critical', w.key, `Team grid shows tasks the caller must not see: ${bad.join(', ')}`, 'hidden', tt.join(' | ').slice(0, 200), '', 'scopeVisibilityClause(team).', 'todo-web /tasks/team');
        const stt = (await req(api, 'GET', `${GATEWAY}/tasks/stats?scope=team`)).body?.data;
        const tileU = await tileCount(page, 'Unassigned'); const tileP = await tileCount(page, 'In progress');
        L('Team tiles equal /tasks/stats?scope=team', tileU === stt?.unassigned && tileP === stt?.in_progress, { endpoint: '/tasks/team' });
        if (tileU !== stt?.unassigned || tileP !== stt?.in_progress) fail('medium', w.key, 'Team tiles disagree with the stats API', `unassigned=${stt?.unassigned} in_progress=${stt?.in_progress}`, `unassigned=${tileU} in_progress=${tileP}`, '', 'TaskStatsCards team.', 'todo-web /tasks/team');
        await sweepPage(page, { rep: rep_, role: w.key, label: 'todo-web /tasks/team', log: plog });
      }
      // /tasks/<id>: visible own, foreign + private + other tenant -> not found
      const ownId = rows(`SELECT id::text FROM task.tasks WHERE title LIKE ${lit(`${MARK}%`)} AND created_by=${lit(ID_OF(w.k) ?? '00000000-0000-0000-0000-000000000000')} AND NOT is_deleted LIMIT 1`, ['id'])[0]?.id;
      if (ownId) {
        await page.goto(`${base}/tasks/${ownId}`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const b = await page.locator('body').innerText();
        L('own task page /tasks/<id> renders', /Task|TASK-/.test(b) && !/not found/i.test(b), { endpoint: '/tasks/<id>' });
        if (/not found|do not have access/i.test(b)) fail('high', w.key, 'Own task page says not found', 'renders', b.slice(0, 100), ownId, 'TaskDetailShell load.', 'todo-web /tasks/<id>');
        else await sweepPage(page, { rep: rep_, role: w.key, label: 'todo-web /tasks/<id>', log: plog, maxButtons: 10 });
      }
      const foreignIds = w.k === 'f' ? rows(`SELECT id::text FROM task.tasks WHERE title LIKE ${lit(`${MARK} T1%`)} OR title LIKE ${lit(`${MARK} O2%`)}`, ['id']) : rows(`SELECT id::text FROM task.tasks WHERE title LIKE ${lit(`${MARK} F1%`)} OR (title LIKE ${lit(`${MARK} R1 %`)} AND ${lit(w.k)} <> 'rep') OR (title LIKE ${lit(`${MARK} O1%`)} AND ${lit(w.k)} <> 'oa')`, ['id']);
      for (const { id } of foreignIds) {
        await page.goto(`${base}/tasks/${id}`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const b = await page.locator('body').innerText();
        const leaked = /MARK|E2E-tasks-\d+ [A-Z]\d/.test(b) && !/not found|do not have access/i.test(b);
        L(`foreign/private task page ${id.slice(0, 8)} is not shown`, !leaked, { endpoint: '/tasks/<id>' });
        if (leaked) fail('critical', w.key, 'Task detail page renders another tenant\'s / user\'s private task', 'not found', b.slice(0, 140), id, 'loadVisible; shell must show not-found.', 'todo-web /tasks/<id>');
      }
      await page.goto(`${base}/tasks/not-a-uuid`, { waitUntil: 'domcontentloaded' }); await settle(page);
      if (!/not found|404/i.test(await page.locator('body').innerText())) fail('low', w.key, 'Malformed task id does not 404', '404 page', page.url(), '', '', 'todo-web /tasks/<id>');
    } catch (e) {
      console.log(e.stack); fail('high', w.key, 'UI pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error', 'todo-web');
    } finally { await browser.close(); }
  }

  // two browsers, one task: stale save conflict
  console.log('  two-browser conflict');
  const TC = created.tasks.map((i) => i).find(() => false);
  const shared = rows(`SELECT id::text FROM task.tasks WHERE title LIKE ${lit(`${MARK} T2%`)} LIMIT 1`, ['id'])[0]?.id;
  if (shared) {
    const a = await openState('msq_org_admin'), b = await openState('msq_tenant_admin');
    try {
      for (const x of [a, b]) { await x.page.goto(`${base}/tasks/${shared}`, { waitUntil: 'domcontentloaded' }); await settle(x.page); }
      const save = async (x, status) => { await x.page.locator('#task-status').selectOption(status).catch(() => {}); const wr = x.page.waitForResponse((r) => r.request().method() === 'PATCH', { timeout: 10000 }).catch(() => null); await x.page.getByRole('button', { name: 'Save changes' }).click().catch(() => {}); return wr; };
      const ra = await save(a, 'in_progress'); await a.page.waitForTimeout(500);
      const rb = await save(b, 'blocked'); await b.page.waitForTimeout(800);
      const stale = await b.page.locator('[role="alert"]').innerText().catch(() => '');
      const finalS = dbTask(shared)?.status;
      log({ role: 'oa+ta', area: 'todo-web /tasks/<id>', action: 'two browsers edit one task; the second (stale) save is refused', method: 'UI', endpoint: '/tasks/<id>', status: `${ra?.status()}/${rb?.status()}`, verified: ra?.status() === 200 && rb?.status() === 409 && finalS === 'in_progress', outcome: 'allowed', expected: '200 then 409, DB=first writer' });
      if (rb?.status() !== 409) fail('high', 'oa+ta', 'A stale browser silently overwrote a colleague\'s change', '409 with "Reload the latest version"', `first=${ra?.status()} second=${rb?.status()} db=${finalS}`, shared, 'UI must send expected_updated_at (it does) and the API must enforce it.', 'todo-web /tasks/<id>');
      else if (!/reload|changed|latest/i.test(stale)) fail('low', 'oa+ta', 'Stale-save conflict gives no "Reload the latest version" prompt', 'alert with reload link', stale.slice(0, 100), shared, 'TaskDetailPanel stale state.', 'todo-web /tasks/<id>');
    } finally { await a.browser.close(); await b.browser.close(); }
  }
  void TC;
}
const ID_OF = (k) => ({ rep: ID.rep, oa: ID.oa, ta: ID.ta, f: FUSER })[k];

try { await main(); } catch (e) {
  console.log(e.stack);
  fail('high', 'harness', 'tasks-v2 suite aborted', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'see log');
} finally {
  await close().catch(() => {});
  const n = restoreAll();
  for (const id of created.tasks) { try { purgeById('task.tasks', id); } catch {} }
  try { for (const id of rows(`SELECT id FROM task.tasks WHERE title LIKE ${lit(`%${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.tasks', id); } catch {}
  for (const id of created.lists) { try { purgeById('task.task_lists', id); } catch {} }
  try { for (const id of rows(`SELECT id FROM task.task_lists WHERE name LIKE ${lit(`${MARK}%`)}`, ['id']).map((r) => r.id)) purgeById('task.task_lists', id); } catch {}
  console.log(`\nrestored ${n} capability overrides; purged fixtures; findings=${rep_.state.findings} actions=${rep_.state.actions}`);
}
