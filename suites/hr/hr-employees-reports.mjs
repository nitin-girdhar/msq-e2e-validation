// HR employees, attendance reports, balances & face reviews — none of which any
// suite touched before this pass.
//
//   * /hr/employees*            hr.employees.view / .manage / .taxonomy.manage
//                               (graded per role from its own /auth/me), plus
//                               profile IDOR: getEmployee is gated on RANK only
//                               (MIN_RANK_TO_VIEW_OTHERS) + RLS — probe a rep
//                               reading a peer and tenant B reading tenant A.
//   * /hr/attendance/reports/*  NEW (fa46a09 "HR reporting for attendance"):
//                               gated on hr.attendance.admin.reports.view;
//                               json/csv/xlsx must each come back with the right
//                               content type; a bad month is a 4xx; every row
//                               belongs to the caller's tenant (critical if not).
//   * /hr/leave/balances/:userId, /hr/leave/ledger?userId=  assertCanViewUser —
//                               a rep must not read a colleague's balance/ledger.
//   * /hr/attendance/face-reviews  gated on regularization approve.
//   * /hr/me, /hr/modules       every HR user, never 5xx.
//
// Department/designation creates are throwaway (E2E-hr-<stamp>) and removed.
//
//   node suites/hr/hr-employees-reports.mjs
import { roleMeta, ROLES, APPS, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, leakOf } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'hr';
const fail = finder(TOOL, 'HR employees / reports / balances');
const HR = `${APPS['hr-web']}/api/hr`;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const MARK = `E2E-hr-${Date.now()}`;
const idOf = (role) => scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta(role)?.email ?? '')}`);
const tenantOfUser = (id) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.id=${lit(id)}`);
const repId = idOf('sales_representative');
const adminId = idOf('org_admin');
const tenantA = tenantOfUser(adminId);
const month = new Date().toISOString().slice(0, 7);

// ── 1. Capability matrices ───────────────────────────────────────────────────
for (const [action, endpoint, cap, act] of [
  ['list employees', 'GET /hr/employees', 'hr.employees.view', (a) => apiGet(a, `${HR}/employees`)],
  ['attendance monthly summary report', 'GET /hr/attendance/reports/summary', 'hr.attendance.admin.reports.view', (a) => apiGet(a, `${HR}/attendance/reports/summary?month=${month}`)],
  ['list face-review queue', 'GET /hr/attendance/face-reviews', 'hr.attendance.regularization.approve', (a) => apiGet(a, `${HR}/attendance/face-reviews`)],
]) {
  console.log(`\n— ${action} (${cap}) —`);
  await runRoleMatrix({ tool: TOOL, action, endpoint, capability: cap, act, area: 'HR' });
}
console.log('\n— create a department (hr.employees.taxonomy.manage) —');
await runRoleMatrix({
  tool: TOOL, action: 'create an HR department', endpoint: 'POST /hr/employees/departments', area: 'HR', tab: 'Employees',
  capability: 'hr.employees.taxonomy.manage', severityOver: 'high',
  act: (a, role) => apiPost(a, `${HR}/employees/departments`, { name: `${MARK}-dept-${role}` }),
  verify: (role) => !!scalar(`SELECT id FROM iam.departments WHERE name=${lit(`${MARK}-dept-${role}`)}`),
});

const actors = {};
const get = (k) => (actors[k] ??= fs.existsSync(authFile(k)) ? actor(k) : Promise.resolve(null));
try {
  // ── 2. Employee profile IDOR ───────────────────────────────────────────────
  const rep = await get('sales_representative');
  if (rep && adminId) {
    const peer = await apiGet(rep, `${HR}/employees/${adminId}`);
    const self = await apiGet(rep, `${HR}/employees/${repId}`);
    console.log(`2. rep reads own profile=${self.status} org_admin's profile=${peer.status} (expect 403)`);
    if (isOk(peer.status)) fail('high', 'sales_representative', 'A rep reads another employee\'s HR profile', '403 Insufficient rank to view another employee profile', `HTTP ${peer.status}`, JSON.stringify(peer.body).slice(0, 200), 'getEmployee: keep the MIN_RANK_TO_VIEW_OTHERS check and add a capability/scope check (reporting line or hr.employees.view.org).');
    if (self.status >= 500) fail('high', 'sales_representative', 'Reading your own HR profile 5xxs', '2xx or 404 if no profile', `HTTP ${self.status}`, JSON.stringify(self.body).slice(0, 200), 'Check getEmployeeByUserId under the app_user RLS policy for hr_svc.');
  }
  const bKey = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)))?.stateKey;
  if (bKey && adminId) {
    const b = await get(bKey);
    for (const [p, lbl] of [[`/employees/${adminId}`, 'employee profile'], [`/leave/balances/${adminId}`, 'leave balances'], [`/leave/ledger?userId=${adminId}`, 'leave ledger']]) {
      const r = await apiGet(b, `${HR}${p}`);
      const hasData = isOk(r.status) && JSON.stringify(r.body?.data ?? []) !== '[]' && JSON.stringify(r.body?.data ?? {}) !== '{}';
      console.log(`2b. tenant B reads tenant-A ${lbl} http=${r.status}${hasData ? ' WITH DATA' : ''}`);
      if (hasData) fail('critical', bKey, `Tenant B reads a tenant-A user's ${lbl}`, '403/404 and no data', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 250), 'Run the read inside withRoleTx so the hr.* RLS tenant policy applies, and assert the target user is in ctx.tenant_id.');
    }
  }

  // ── 3. Balance / ledger IDOR inside the tenant ─────────────────────────────
  if (rep && adminId) {
    for (const [p, lbl] of [[`/leave/balances/${adminId}`, 'leave balances'], [`/leave/ledger?userId=${adminId}`, 'leave ledger']]) {
      const r = await apiGet(rep, `${HR}${p}`);
      console.log(`3. rep reads org_admin's ${lbl} http=${r.status} (expect 403)`);
      if (isOk(r.status)) fail('high', 'sales_representative', `A rep reads a colleague's ${lbl}`, '403 — assertCanViewUser (self, reporting line or HR admin)', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Call assertCanViewUser(ctx, targetUserId) on every per-user leave read.');
      else if (r.status >= 500) fail('medium', 'sales_representative', `Reading a colleague's ${lbl} 5xxs`, '403', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Throw ForbiddenError from assertCanViewUser.');
    }
  }

  // ── 4. Reports: formats, bad input, tenant scoping ─────────────────────────
  let reporter = null, reporterRole = null;
  for (const role of ['org_admin', 'hr_admin', 'tenant_admin']) {
    const a = await get(role);
    if (!a) continue;
    const r = await apiGet(a, `${HR}/attendance/reports/summary?month=${month}&format=json`);
    if (isOk(r.status)) { reporter = a; reporterRole = role; break; }
  }
  if (reporter) {
    const js = await apiGet(reporter, `${HR}/attendance/reports/summary?month=${month}&format=json`);
    const list = Array.isArray(js.body?.data) ? js.body.data : [];
    const uids = [...new Set(list.map((r) => r.user_id ?? r.userId).filter(Boolean))];
    const foreign = uids.filter((u) => tenantOfUser(u) !== tenantA);
    console.log(`4. ${reporterRole} summary json rows=${list.length} users=${uids.length} foreignTenant=${foreign.length}`);
    if (foreign.length) fail('critical', reporterRole, 'Attendance report includes employees of ANOTHER tenant', `Only tenant ${tenantA}`, `${foreign.length} foreign user(s)`, JSON.stringify(foreign.slice(0, 3)), 'monthlySummary must run under the caller\'s tenant tx (RLS on hr.attendance_days) — never withServiceTx for a report.');
    for (const [p, fmt, rx] of [
      ['summary', 'csv', /text\/csv/], ['summary', 'xlsx', /spreadsheetml|octet-stream/], ['detail', 'csv', /text\/csv/], ['detail', 'xlsx', /spreadsheetml|octet-stream/],
    ]) {
      const resp = await reporter.request.get(`${HR}/attendance/reports/${p}?month=${month}&format=${fmt}`, { failOnStatusCode: false });
      const ct = resp.headers()['content-type'] || ''; const len = (await resp.body().catch(() => Buffer.alloc(0))).length;
      console.log(`   ${p}.${fmt} http=${resp.status()} type=${ct.split(';')[0]} bytes=${len}`);
      if (resp.status() >= 500) fail('high', reporterRole, `Attendance ${p} report (${fmt}) 5xxs`, '200 with a file', `HTTP ${resp.status()}`, (await resp.text().catch(() => '')).slice(0, 200), 'Check the export builder for this month\'s data (null punches / split-shift sessions are the usual trigger).');
      else if (resp.status() === 200 && (!rx.test(ct) || len === 0)) fail('medium', reporterRole, `Attendance ${p} report (${fmt}) is not a usable file`, `Content-Type ${rx} and a non-empty body`, `type=${ct} bytes=${len}`, '', 'Set the right Content-Type/Content-Disposition and never send an empty workbook.');
    }
    for (const bad of ['2026-13', 'garbage', '1999-01; DROP TABLE x']) {
      const r = await apiGet(reporter, `${HR}/attendance/reports/summary?month=${encodeURIComponent(bad)}`);
      if (r.status >= 500 || isOk(r.status)) fail(r.status >= 500 ? 'medium' : 'low', reporterRole, `Attendance report accepts month="${bad}"`, '400/422 — monthString validation', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Validate month as YYYY-MM with 01..12 in reportsSummaryQuerySchema.');
      const leak = leakOf(r.body); if (leak) fail('medium', reporterRole, 'Attendance report leaks internals on bad input', 'Generic validation error', leak, bad, 'Return the Zod issue message only.');
    }
  } else console.log('4. no login could open attendance reports — format/scope checks skipped');

  // ── 5. Everyone's own HR context must load ─────────────────────────────────
  for (const role of ROLES) {
    const a = await get(role);
    if (!a) continue;
    for (const p of ['/me', '/modules', '/attendance/today-state', '/leave/balances']) {
      const r = await apiGet(a, `${HR}${p}`);
      if (r.status >= 500) fail('high', role, `GET /hr${p} 5xxs for ${role}`, '2xx (or 403 if HR is not licensed)', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Every employee opens HR on login; check the role\'s capability matrix (platform.write / hr.*) and the hr_svc RLS policies.');
    }
  }
} finally {
  for (const p of Object.values(actors)) { const a = await p; if (a) await a.close(); }
  for (const t of ['iam.departments', 'hr.designations']) {
    try { rows(`DELETE FROM ${t} WHERE name LIKE ${lit(`${MARK}-%`)} RETURNING id`, ['id']); } catch { /* referenced / soft only */ }
  }
  console.log('\ncleaned up throwaway departments/designations.');
}
