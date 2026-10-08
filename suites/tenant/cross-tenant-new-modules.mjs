// Cross-tenant isolation for everything added in schema 1.57 - 1.70.
//
// cross-tenant-isolation.mjs attacks leads / tasks / leave requests and
// cross-tenant-hr-config.mjs attacks holidays / policies / shifts. Neither knew
// the tables the Stitch redesign + HR parity work added: payslips, employee
// documents, comp-off, encashment, shift swaps, profile-change requests,
// announcements, assets, statutory details, roster, campaign-type rules, tenant
// branding, bulk lead / task actions. This logs in as tenant B (MSquare
// Professionals) and attacks tenant A (FitClass) on those surfaces, four ways:
//
//   1. LEAK SCAN   — every UUID in every response body is compared with the set of
//                    ids tenant A owns (users, branches, and one row per new table,
//                    read straight from Postgres). One hit is proven leakage, whatever
//                    the envelope looks like. Lists are also called with smuggled
//                    ?org_id= / ?tenant_id= / ?user_id= pointing at tenant A.
//   2. IDOR READ   — GET tenant A's payslip / document file / leave request /
//                    leave attachment / employee statutory / profile-360 / dossier.
//   3. IDOR WRITE  — approve / reject / cancel / review / delete / assign / publish /
//                    bulk-update tenant A's rows BY ID. Each target row is snapshotted in
//                    the DB before and after: a rejected write that still mutated is
//                    `critical` and the row is restored from the snapshot.
//   4. CONTROL     — the same tenant-B admin must still read its OWN lists (2xx). An
//                    API that denied everything would otherwise look perfectly isolated.
//
// Never sends anything to /meta/* — those routes drive the real Meta Graph API and
// the anonymous/non-super-admin denial of them is already graded by the API sweep.
//
//   node suites/tenant/cross-tenant-new-modules.mjs
import { GATEWAY, authFile, CROSS_TENANT, primaryTenant, otherTenant } from '../../lib.mjs';
import { actor, readResp } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { tenantIdForOrg } from '../../capability.mjs';
import { finder, leakOf, isOk } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'tenant';
const fail = finder(TOOL, 'Cross-tenant — modules added in schema 1.57-1.70');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const A = primaryTenant();
const B = otherTenant();
if (!A || !B) { console.log('Need two tenants configured in roles.json — aborting'); process.exit(0); }
const tA = tenantIdForOrg(A.org);
const tB = tenantIdForOrg(B.org);
if (!tA || !tB || tA === tB) { console.log('Tenant ids unresolved or identical — aborting'); process.exit(0); }
console.log(`tenant A = ${A.name} (${tA})   tenant B = ${B.name} (${tB})\n`);

const safe = (fn, dflt = null) => { try { return fn(); } catch { return dflt; } };
const firstOf = (table, where = 'TRUE', pk = 'id') => safe(() => scalar(
  `SELECT t.${pk} FROM ${table} t JOIN entity.organizations o ON o.id=t.org_id
    WHERE o.tenant_id=${lit(tA)}::uuid AND ${where} ORDER BY 1 LIMIT 1`));

// ── 1. The set of ids tenant A owns ──────────────────────────────────────────
const ORG_TABLES = ['hr.payslips', 'hr.payslip_lines', 'hr.pay_periods', 'hr.employee_documents', 'hr.leave_requests', 'hr.comp_off_claims',
  'hr.leave_encashment_requests', 'hr.shift_swap_requests', 'hr.profile_change_requests', 'hr.announcements', 'hr.assets', 'hr.asset_assignments',
  'hr.emergency_contacts', 'hr.employee_notes', 'hr.shift_requirements', 'hr.roster_publications', 'hr.attendance_regularizations',
  'hr.attendance_events', 'hr.shift_assignments', 'task.tasks', 'lms.marketing_leads', 'lms.lead_follow_ups'];
const A_IDS = new Set();
for (const t of ORG_TABLES) {
  const r = safe(() => q(`SELECT t.id::text FROM ${t} t JOIN entity.organizations o ON o.id=t.org_id WHERE o.tenant_id=${lit(tA)}::uuid LIMIT 20000`), []);
  for (const [id] of r) if (id) A_IDS.add(id.toLowerCase());
}
for (const [id] of safe(() => q(`SELECT u.id::text FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE o.tenant_id=${lit(tA)}::uuid`), [])) A_IDS.add(id.toLowerCase());
for (const [id] of safe(() => q(`SELECT id::text FROM entity.organizations WHERE tenant_id=${lit(tA)}::uuid`), [])) A_IDS.add(id.toLowerCase());
for (const [id] of safe(() => q(`SELECT id::text FROM marketing.campaign_type_rules WHERE tenant_id=${lit(tA)}::uuid`), [])) A_IDS.add(id.toLowerCase());
// Ids that exist in BOTH tenants by design (shared catalog rows, the tenant id of the caller) must not count.
for (const [id] of safe(() => q(`SELECT u.id::text FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE o.tenant_id=${lit(tB)}::uuid`), [])) A_IDS.delete(id.toLowerCase());
console.log(`tenant-A id fingerprint: ${A_IDS.size} ids`);
const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const leakedIds = (body) => {
  const txt = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return [...new Set((txt.match(UUID_RX) || []).map((x) => x.toLowerCase()).filter((x) => A_IDS.has(x)))];
};

// ── 2. Tenant-A targets (one real row per surface) ───────────────────────────
const aUser = safe(() => scalar(`SELECT u.id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE o.tenant_id=${lit(tA)}::uuid AND u.is_active AND NOT u.is_deleted AND u.email NOT LIKE '%@e2e.local' AND COALESCE(u.platform_role,'')<>'super_admin' ORDER BY u.created_at LIMIT 1`));
const aOrg = safe(() => scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tA)}::uuid AND is_active AND NOT is_deleted ORDER BY created_at LIMIT 1`));
const T = {
  payslip: firstOf('hr.payslips', 'NOT t.is_deleted'),
  payslipMonth: safe(() => scalar(`SELECT to_char(p.period,'YYYY-MM') FROM hr.payslips p JOIN entity.organizations o ON o.id=p.org_id WHERE o.tenant_id=${lit(tA)}::uuid LIMIT 1`)),
  document: firstOf('hr.employee_documents', 'NOT t.is_deleted'),
  leave: firstOf('hr.leave_requests'),
  leaveAttachment: firstOf('hr.leave_requests', 't.attachment_key IS NOT NULL'),
  compOff: firstOf('hr.comp_off_claims'),
  encashment: firstOf('hr.leave_encashment_requests'),
  swap: firstOf('hr.shift_swap_requests'),
  changeReq: firstOf('hr.profile_change_requests'),
  announcement: firstOf('hr.announcements'),
  asset: firstOf('hr.assets'),
  lead: firstOf('lms.marketing_leads', 'NOT t.is_deleted AND t.is_active'),
  task: firstOf('task.tasks', 'NOT t.is_deleted'),
  rule: safe(() => scalar(`SELECT id FROM marketing.campaign_type_rules WHERE tenant_id=${lit(tA)}::uuid AND NOT is_deleted ORDER BY rule_order LIMIT 1`)),
};
console.log('tenant-A targets: ' + Object.entries(T).map(([k, v]) => `${k}=${v ? 'yes' : '-'}`).join(' ') + '\n');

// ── 3. Snapshots + restore ───────────────────────────────────────────────────
// snap = a SQL expression returning ONE text value that changes iff the data changes.
const rowSnap = (table, id, pk = 'id') => `COALESCE((SELECT row_to_json(t)::text FROM ${table} t WHERE t.${pk}=${lit(id)}), 'ABSENT')`;
const countSnap = (table, where) => `(SELECT COUNT(*)::text || ':' || COALESCE(MAX(t.ctid::text),'') FROM ${table} t WHERE ${where})`;
const SEP = '@@@';
const readSnap = (expr) => safe(() => scalar('SELECT ' + expr), 'SNAP-ERROR');
function restoreRow(table, pk, id, json) {
  json = String(json ?? '').split(SEP)[0];
  if (!json || json === 'ABSENT' || json === 'SNAP-ERROR') return false;
  try {
    const cols = rows(`SELECT column_name FROM information_schema.columns WHERE table_schema||'.'||table_name=${lit(table)} AND is_generated='NEVER' AND column_name<>${lit(pk)}`, ['c']).map((r) => `"${r.c}"`);
    if (!cols.length) return false;
    q(`UPDATE ${table} t SET (${cols.join(',')}) = (SELECT ${cols.join(',')} FROM jsonb_populate_record(NULL::${table}, ${lit(json)}::jsonb)) WHERE t.${pk}=${lit(id)}`);
    return true;
  } catch { return false; }
}

// ── 4. Attack catalogue ──────────────────────────────────────────────────────
const smuggle = `org_id=${aOrg}&tenant_id=${tA}&user_id=${aUser}`;
const READS = [
  ['GET payslip by id', `/hr/payroll/payslips/${T.payslip}`, !!T.payslip],
  ['GET document file by id', `/hr/documents/${T.document}/file`, !!T.document],
  ['GET leave request by id', `/hr/leave/requests/${T.leave}`, !!T.leave],
  ['GET leave attachment by id', `/hr/leave/requests/${T.leaveAttachment}/attachment`, !!T.leaveAttachment],
  ['GET employee statutory', `/hr/employees/${aUser}/statutory`, !!aUser],
  ['GET employee profile-360', `/hr/employees/${aUser}/profile-360`, !!aUser],
  ['GET employee attendance', `/hr/employees/${aUser}/attendance`, !!aUser],
  ['GET employee audit', `/hr/employees/${aUser}/audit`, !!aUser],
  ['GET employee documents', `/hr/documents/employee/${aUser}`, !!aUser],
  ['GET employee dossier', `/hr/documents/employee/${aUser}/dossier`, !!aUser],
  ['GET leave balances of user', `/hr/leave/balances/${aUser}`, !!aUser],
  ['GET comp-off queue (smuggled org)', `/hr/leave/comp-off/queue?${smuggle}`, true],
  ['GET lead assignment history', `/leads/${T.lead}/assignment-history`, !!T.lead],
  ['GET lead assignments', `/leads/${T.lead}/assignments`, !!T.lead],
  ['GET SA tenant branding', `/sa/tenants/${tA}/branding`, true],
  ['GET campaign-type rules (smuggled tenant)', `/campaign-types/rules?${smuggle}`, true],
  ['GET assignment weights (smuggled tenant)', `/users/assignment-weights?${smuggle}`, true],
  ['GET task export (smuggled org)', `/tasks/export?${smuggle}`, true],
];
const LISTS = [
  '/hr/announcements', '/hr/announcements/admin', '/hr/assets', '/hr/assets/mine', '/hr/leave/comp-off', '/hr/leave/comp-off/queue',
  '/hr/leave/encashments', '/hr/leave/encashments/queue', '/hr/attendance/swaps', '/hr/attendance/swaps/queue',
  '/hr/profile/change-requests', '/hr/profile/me', '/hr/payroll/payslips', '/hr/payroll/admin/overview', '/hr/payroll/admin/readiness',
  '/hr/documents/mine', '/hr/documents/admin/pending', '/hr/documents/settings', '/hr/leave/requests', '/hr/leave/requests/team',
  '/hr/attendance/roster', '/hr/attendance/planner/week', '/hr/employees', '/hr/employees/org-chart', '/hr/me/activity', '/hr/attendance/me/shift',
  '/tenant/branding', '/me/branding', '/campaign-types/rules', '/users/assignment-weights', '/tasks/export', '/assignments',
];
// [label, method, path, body, snapshot SQL, restore {table, pk, id} | null]
const WRITES = [];
const add = (label, method, path, body, snapSql, restore) => WRITES.push({ label, method, path, body, snapSql, restore });
if (T.compOff) for (const act of ['approve', 'reject', 'cancel']) add(`${act} comp-off claim`, 'POST', `/hr/leave/comp-off/${T.compOff}/${act}`, { comment: 'e2e cross-tenant' }, rowSnap('hr.comp_off_claims', T.compOff), { table: 'hr.comp_off_claims', pk: 'id', id: T.compOff });
if (T.encashment) for (const act of ['approve', 'reject', 'cancel']) add(`${act} encashment`, 'POST', `/hr/leave/encashments/${T.encashment}/${act}`, { comment: 'e2e cross-tenant' }, rowSnap('hr.leave_encashment_requests', T.encashment), { table: 'hr.leave_encashment_requests', pk: 'id', id: T.encashment });
if (T.swap) {
  add('peer-respond swap', 'POST', `/hr/attendance/swaps/${T.swap}/respond`, { accept: true }, rowSnap('hr.shift_swap_requests', T.swap), { table: 'hr.shift_swap_requests', pk: 'id', id: T.swap });
  for (const act of ['cancel', 'approve', 'reject']) add(`${act} swap`, 'POST', `/hr/attendance/swaps/${T.swap}/${act}`, { comment: 'e2e cross-tenant' }, rowSnap('hr.shift_swap_requests', T.swap), { table: 'hr.shift_swap_requests', pk: 'id', id: T.swap });
}
if (T.changeReq) for (const act of ['approve', 'reject']) add(`${act} profile change request`, 'POST', `/hr/profile/change-requests/${T.changeReq}/${act}`, { comment: 'e2e cross-tenant' }, rowSnap('hr.profile_change_requests', T.changeReq), { table: 'hr.profile_change_requests', pk: 'id', id: T.changeReq });
if (T.announcement) for (const act of ['read', 'publish', 'retire']) add(`${act} announcement`, 'POST', `/hr/announcements/${T.announcement}/${act}`, {}, `${rowSnap('hr.announcements', T.announcement)} || '@@@' || (SELECT COUNT(*) FROM hr.announcement_reads WHERE announcement_id=${lit(T.announcement)})`, { table: 'hr.announcements', pk: 'id', id: T.announcement });
if (T.asset) {
  add('assign asset', 'POST', `/hr/assets/${T.asset}/assign`, { user_id: aUser, assigned_on: '2026-01-01' }, `${rowSnap('hr.assets', T.asset)} || '@@@' || (SELECT COUNT(*) FROM hr.asset_assignments WHERE asset_id=${lit(T.asset)})`, { table: 'hr.assets', pk: 'id', id: T.asset });
  add('return asset', 'POST', `/hr/assets/${T.asset}/return`, {}, `${rowSnap('hr.assets', T.asset)} || '@@@' || (SELECT COUNT(*) FROM hr.asset_assignments WHERE asset_id=${lit(T.asset)} AND returned_on IS NULL)`, { table: 'hr.assets', pk: 'id', id: T.asset });
}
if (T.document) {
  add('review document', 'POST', `/hr/documents/${T.document}/review`, { status: 'verified', note: 'e2e cross-tenant' }, rowSnap('hr.employee_documents', T.document), { table: 'hr.employee_documents', pk: 'id', id: T.document });
  add('delete document', 'DELETE', `/hr/documents/${T.document}`, undefined, rowSnap('hr.employee_documents', T.document), { table: 'hr.employee_documents', pk: 'id', id: T.document });
}
if (T.leave) {
  for (const act of ['approve', 'reject', 'cancel']) add(`${act} leave request`, 'POST', `/hr/leave/requests/${T.leave}/${act}`, { comment: 'e2e cross-tenant' }, rowSnap('hr.leave_requests', T.leave), { table: 'hr.leave_requests', pk: 'id', id: T.leave });
  add('request more info on leave', 'POST', `/hr/leave/requests/${T.leave}/request-info`, { note: 'e2e cross-tenant' }, rowSnap('hr.leave_requests', T.leave), { table: 'hr.leave_requests', pk: 'id', id: T.leave });
  add('edit leave request', 'PATCH', `/hr/leave/requests/${T.leave}`, { reason: 'e2e cross-tenant' }, rowSnap('hr.leave_requests', T.leave), { table: 'hr.leave_requests', pk: 'id', id: T.leave });
}
if (aUser) {
  add('write employee statutory', 'PUT', `/hr/employees/${aUser}/statutory`, { pan: 'ABCDE1234F' }, rowSnap('hr.employee_statutory', aUser, 'user_id'), { table: 'hr.employee_statutory', pk: 'user_id', id: aUser });
  add('edit employee profile fields', 'PATCH', `/hr/employees/${aUser}`, { work_mode: 'remote', notice_period_days: 1 }, rowSnap('hr.employee_profiles', aUser, 'user_id'), { table: 'hr.employee_profiles', pk: 'user_id', id: aUser });
  add('add HR note on employee', 'POST', `/hr/employees/${aUser}/notes`, { kind: 'note', body: 'e2e cross-tenant' }, countSnap('hr.employee_notes', `t.user_id=${lit(aUser)}`), null);
  add('manual punch for employee', 'POST', '/hr/attendance/admin/manual-punch', { user_id: aUser, punch_type: 'in', occurred_at: new Date().toISOString(), reason: 'e2e cross-tenant' }, countSnap('hr.attendance_events', `t.user_id=${lit(aUser)}`), null);
  add('leave balance adjustment for employee', 'POST', '/hr/leave/adjustments', { user_id: aUser, amount: 1, note: 'e2e cross-tenant' }, countSnap('hr.leave_ledger', `t.user_id=${lit(aUser)}`), null);
}
if (T.lead) add('bulk reschedule tenant-A lead', 'POST', '/leads/bulk', { action: 'reschedule', lead_ids: [T.lead], scheduled_at: new Date(Date.now() + 86400000).toISOString() }, `${rowSnap('lms.marketing_leads', T.lead)} || '@@@' || (SELECT COUNT(*) FROM lms.lead_follow_ups WHERE lead_id=${lit(T.lead)})`, { table: 'lms.marketing_leads', pk: 'id', id: T.lead });
if (T.task) add('bulk change tenant-A task status', 'POST', '/tasks/bulk', { ids: [T.task], status_name: 'blocked', note: 'e2e cross-tenant' }, rowSnap('task.tasks', T.task), { table: 'task.tasks', pk: 'id', id: T.task });
if (T.rule) {
  add('edit tenant-A campaign-type rule', 'PATCH', `/campaign-types/rules/${T.rule}`, { pattern: 'e2e-cross-tenant' }, rowSnap('marketing.campaign_type_rules', T.rule), { table: 'marketing.campaign_type_rules', pk: 'id', id: T.rule });
  add('delete tenant-A campaign-type rule', 'DELETE', `/campaign-types/rules/${T.rule}`, undefined, rowSnap('marketing.campaign_type_rules', T.rule), { table: 'marketing.campaign_type_rules', pk: 'id', id: T.rule });
  add('reorder with tenant-A rule ids', 'PUT', '/campaign-types/rules/order', { ids: [T.rule] }, `(SELECT COALESCE(string_agg(id::text||':'||rule_order, ',' ORDER BY id),'') FROM marketing.campaign_type_rules WHERE tenant_id=${lit(tA)}::uuid)`, null);
}
add('SA branding write on tenant A', 'PUT', `/sa/tenants/${tA}/branding`, { theme_locked: true }, `COALESCE((SELECT row_to_json(b)::text FROM entity.tenant_branding b WHERE b.tenant_id=${lit(tA)}::uuid),'ABSENT')`, { table: 'entity.tenant_branding', pk: 'tenant_id', id: tA });
add('SA rotate tenant-A login key', 'POST', `/sa/tenants/${tA}/branding/rotate-key`, {}, `COALESCE((SELECT row_to_json(b)::text FROM entity.tenant_branding b WHERE b.tenant_id=${lit(tA)}::uuid),'ABSENT')`, { table: 'entity.tenant_branding', pk: 'tenant_id', id: tA });

// ── 5. Run as every tenant-B login ───────────────────────────────────────────
const attackers = CROSS_TENANT.filter((c) => fs.existsSync(authFile(c.stateKey)));
if (!attackers.length) { console.log('No tenant-B auth state — run auth-setup first. Aborting.'); process.exit(0); }
const report = { reads: 0, lists: 0, writes: 0, inconclusive: [], skipped: [] };
const call = async (a, method, path, data) => {
  const resp = await a.request.fetch(`${GATEWAY}${path}`, { method, data, failOnStatusCode: false, timeout: 45000 }).catch((e) => ({ err: e }));
  if (resp.err) return { status: -1, body: String(resp.err.message).slice(0, 200) };
  return readResp(resp);
};

for (const cta of attackers) {
  const who = `${cta.stateKey} (${cta.role} @ ${B.name})`;
  console.log(`=== ${who} ===`);
  const a = await actor(cta.stateKey);
  try {
    // 5a. IDOR reads
    for (const [label, path, ok] of READS) {
      if (!ok || /\/undefined|\/null|=null|=undefined/.test(path)) { report.skipped.push(`${label} (no tenant-A row)`); continue; }
      const res = await call(a, 'GET', path);
      report.reads++;
      const ids = leakedIds(res.body);
      const d = res.body?.data;
      const nonEmpty = Array.isArray(d) ? d.length > 0 : d && typeof d === 'object' ? Object.keys(d).length > 0 : false;
      console.log(`  read  ${label.padEnd(44)} http=${res.status}${ids.length ? `  LEAK x${ids.length}` : ''}`);
      if (ids.length) fail('critical', who, `${label} returns tenant-A data to a tenant-B login`, '403/404, or a body with no tenant-A id', `HTTP ${res.status}; ${ids.length} tenant-A id(s) in the body: ${ids.slice(0, 4).join(', ')}`, `GET ${path}`, 'Resolve the object inside withRoleTx so RLS applies (never serviceDrizzle for a by-id read), and compare the row\'s tenant to the session tenant before returning; strip smuggled org_id/tenant_id/user_id query params — scope comes from the verified session only.');
      else if (isOk(res.status) && nonEmpty && /\/(payroll|documents|statutory|profile-360|attachment|branding)/.test(path) && !/smuggle|org_id=/.test(path)) fail('high', who, `${label} answers 2xx with data for another tenant's id`, '404 (same as a non-existent id)', `HTTP ${res.status}, non-empty data`, `GET ${path} -> ${JSON.stringify(res.body).slice(0, 200)}`, 'Even without a recognised tenant-A id in the body, a 2xx with data for a foreign id means the lookup is not tenant-scoped.');
      else if (res.status >= 500 || res.status === -1) fail('medium', who, `${label} 5xx for a foreign id`, '403/404', `HTTP ${res.status}`, `GET ${path} -> ${JSON.stringify(res.body).slice(0, 200)}`, 'Map the not-found/forbidden outcome to an AppError instead of letting the repository throw.');
      const leak = res.status >= 400 ? leakOf(res.body) : null;
      if (leak) fail('medium', who, `${label} leaks backend internals in the error`, 'Generic error message', `…${leak}…`, `GET ${path}`, 'Route through the service error handler.');
    }

    // 5b. List scoping + smuggled scope params
    let ownRows = 0, own2xx = 0;
    for (const base of LISTS) {
      for (const qs of ['', (base.includes('?') ? '&' : '?') + smuggle]) {
        const path = base + qs;
        const res = await call(a, 'GET', path);
        report.lists++;
        const ids = leakedIds(res.body);
        if (!qs && isOk(res.status)) { own2xx++; const d = res.body?.data; ownRows += Array.isArray(d) ? d.length : d && typeof d === 'object' ? 1 : 0; }
        if (ids.length) {
          console.log(`  list  ${path.slice(0, 70).padEnd(70)} LEAK x${ids.length}`);
          fail('critical', who, `GET ${base}${qs ? ' (smuggled ids)' : ''} returns tenant-A rows to a tenant-B login`, 'Every row belongs to the caller\'s tenant; client-supplied org/tenant/user ids are ignored',
            `${ids.length} tenant-A id(s): ${ids.slice(0, 4).join(', ')}`, `GET ${path} -> HTTP ${res.status}`,
            'The query is not under withRoleTx/RLS, or it honours a client org_id. Derive org/tenant from parseAuthContext only and let the policy filter.');
        } else if (res.status >= 500) {
          fail('medium', who, `GET ${base}${qs ? ' (smuggled ids)' : ''} 5xx`, '2xx or a 4xx that says why', `HTTP ${res.status}`, `GET ${path} -> ${JSON.stringify(res.body).slice(0, 200)}`, 'Read the owning service log; typical roots are a missing RLS policy for the service login or an unparameterised array.');
        }
      }
    }
    console.log(`  lists swept=${LISTS.length * 2}  own-scope 2xx=${own2xx}/${LISTS.length}`);
    // Control: a tenant-B admin must be able to use the surface at all, else "no leak" proves nothing.
    if (/admin/.test(cta.role) && own2xx < Math.ceil(LISTS.length / 3)) {
      fail('medium', who, 'Control probe: tenant-B admin reads almost none of its own lists', 'Most list routes answer 2xx for a tenant admin of tenant B', `${own2xx}/${LISTS.length} answered 2xx`, 'A blanket-deny API (or a suite that never logged in) would look like perfect isolation', 'Check the tenant-B session (auth-refresh) and tenant B\'s module licences — the isolation result for this actor is inconclusive.');
    }

    // 5c. IDOR writes with before/after snapshots
    for (const w of WRITES) {
      const before = readSnap(w.snapSql);
      const res = await call(a, w.method, w.path, w.body);
      const after = readSnap(w.snapSql);
      report.writes++;
      const changed = before !== after;
      const status = res.status;
      const sent = JSON.stringify([w.path, w.body ?? null]); /* an id the caller itself sent is not a disclosure */ const ids = leakedIds(res.body).filter((i) => !sent.includes(i));
      console.log(`  write ${w.label.padEnd(44)} http=${status} ${changed ? 'ROW CHANGED' : 'unchanged'}${ids.length ? ' LEAK' : ''}`);
      if (changed) {
        const restored = w.restore ? restoreRow(w.restore.table, w.restore.pk, w.restore.id, before) : false;
        fail('critical', who, `${w.label}: a tenant-B login modified tenant A's data`, 'Rejected AND the row left byte-identical', `HTTP ${status}; snapshot differs (${restored ? 'row restored from snapshot' : 'NOT restored — repair by hand'})`, `${w.method} ${w.path}`,
          'The write ran outside the caller\'s RLS scope (service transaction / serviceDrizzle, or an UPDATE keyed on id alone). Use withRoleTx and add the org/tenant predicate; the by-id statement must match zero rows for a foreign id.');
      } else if (isOk(status)) {
        fail('medium', who, `${w.label}: answers 2xx for another tenant's id`, '404 (indistinguishable from a missing id)', `HTTP ${status}, row unchanged`, `${w.method} ${w.path} -> ${JSON.stringify(res.body).slice(0, 160)}`, 'No data changed, but the route confirms the id exists or silently no-ops: resolve the parent first and 404 when it is not visible.');
      } else if (status >= 500 || status === -1) {
        fail('medium', who, `${w.label}: 5xx for a foreign id`, '403/404', `HTTP ${status}`, `${w.method} ${w.path} -> ${JSON.stringify(res.body).slice(0, 200)}`, 'Map the foreign/not-found outcome to an AppError.');
      } else if (status === 400 || status === 422) {
        report.inconclusive.push(`${who}: ${w.label} -> ${status} (validation ran before authorization; guessed body may need updating)`);
      }
      if (ids.length) fail('critical', who, `${w.label}: response carries tenant-A ids`, 'No tenant-A identifiers in any response to tenant B', `${ids.length} id(s): ${ids.slice(0, 3).join(', ')}`, `${w.method} ${w.path}`, 'Do not echo the foreign row in the error body.');
    }
  } finally { await a.close(); }
}

console.log(`\nreads=${report.reads} list calls=${report.lists} writes=${report.writes} · skipped=${report.skipped.length} · inconclusive (4xx validation)=${report.inconclusive.length}`);
if (report.skipped.length) console.log('skipped: ' + [...new Set(report.skipped)].join('; '));
if (report.inconclusive.length) {
  console.log('inconclusive: ' + report.inconclusive.slice(0, 8).join('; '));
  fail('info', 'tenant-B actors', `${report.inconclusive.length} cross-tenant write(s) were rejected by validation before authorization`, 'Bodies valid enough to reach the authorization check', report.inconclusive.slice(0, 6).join(' | '), 'harness bodies in suites/tenant/cross-tenant-new-modules.mjs', 'Update the guessed request bodies to the current zod schemas so the attack reaches the by-id lookup; a 4xx from validation proves nothing about isolation.');
}
