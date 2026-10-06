// HR taxonomy (departments / designations), holiday calendars + holidays, and leave-policy PATCH:
// the admin writes that no suite asserted beyond "create a department" / "create a holiday".
//
//   PATCH /hr/employees/departments/:id          hr.employees.taxonomy.manage
//   GET|POST /hr/employees/designations          hr.employees.view | hr.employees.taxonomy.manage
//   PATCH /hr/employees/designations/:id         hr.employees.taxonomy.manage
//   GET|POST /hr/holiday-calendars               hr.leave.view | hr.leave.admin.holidays.manage
//   PATCH /hr/holiday-calendars/:id              hr.leave.admin.holidays.manage
//   PATCH /hr/holidays/:id  (+ POST with a foreign calendar_id)   hr.leave.admin.holidays.manage
//   PATCH /hr/leave/policies/:id                 hr.leave.admin.policies.manage
//
// Every expectation is read from the login's own /auth/me (live capabilities), never from a role name.
// Proven here, against Postgres: writes land in the CALLER's tenant / branch exactly (a smuggled
// org_id / tenant_id in the body moves nothing); another TENANT's id (and another BRANCH's id) is 404
// and the row is byte-identical afterwards; list responses carry only the caller's branch + tenant-wide
// rows; bad input (non-uuid id, empty / oversize / wrong-typed fields, out-of-range numbers, an int
// that overflows INT, an impossible calendar date, a foreign calendar_id) is a 4xx never a 5xx; the
// unique indexes surface as 409 not 500; anonymous is 401.
//
// SAFETY: throwaway rows are marked E2E-people-<stamp> and hard-purged in finally (journalled, so a
// killed run is replayed by restorePending('people-')); the one real leave policy edited is
// snapshotted and restored.
//
//   node suites/hr/hr-taxonomy-holidays.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import { simultaneously } from '../../conc.mjs';
import {
  HR, MARK, uuid, suite, open, who, holds, guarded, snapshotRow, journalPurge, q, scalar, rows, lit,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR taxonomy / holidays / policy PATCH');
const cleanups = [];
const TAX = 'hr.employees.taxonomy.manage', EMPV = 'hr.employees.view';
const HOL = 'hr.leave.admin.holidays.manage', LVIEW = 'hr.leave.view', POL = 'hr.leave.admin.policies.manage';

const deptRow = (id) => rows(`SELECT tenant_id::text, COALESCE(org_id::text,''), name, label, is_active::text, is_deleted::text, COALESCE(created_by::text,'') FROM iam.departments WHERE id=${lit(id)}`,
  ['tenant', 'org', 'name', 'label', 'active', 'del', 'by'])[0];
const desigRow = (id) => rows(`SELECT org_id::text, name, is_active::text, is_deleted::text, COALESCE(created_by::text,'') FROM hr.designations WHERE id=${lit(id)}`,
  ['org', 'name', 'active', 'del', 'by'])[0];
const calRow = (id) => rows(`SELECT org_id::text, name, year::text, is_active::text, is_deleted::text FROM hr.holiday_calendars WHERE id=${lit(id)}`,
  ['org', 'name', 'year', 'active', 'del'])[0];
const holRow = (id) => rows(`SELECT org_id::text, calendar_id::text, holiday_date::text, name, is_optional::text, is_active::text, is_deleted::text FROM hr.holidays WHERE id=${lit(id)}`,
  ['org', 'cal', 'date', 'name', 'opt', 'active', 'del'])[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tenantOfOrg = (org) => scalar(`SELECT tenant_id::text FROM entity.organizations WHERE id=${lit(org)}`);

await guarded(async () => {
  cleanups.push(journalPurge('people-taxo-purge', 'E2E taxonomy / holidays', [
    `DELETE FROM hr.holidays WHERE name LIKE '${MARK}%'`,
    `DELETE FROM hr.holiday_calendars WHERE name LIKE '${MARK}%'`,
    `DELETE FROM hr.designations WHERE name LIKE '${MARK}%'`,
    `DELETE FROM iam.departments WHERE name LIKE '${MARK}%'`,
  ]));
  cleanups.push(() => {
    q(`DELETE FROM hr.holidays WHERE name LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM hr.holiday_calendars WHERE name LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM hr.designations WHERE name LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM iam.departments WHERE name LIKE ${lit(`${MARK}%`)}`);
  });

  const keys = ['msq_org_admin', 'msq_tenant_admin', 'msq_rep1', 'hr_admin', 'org_admin', 'org_manager', 'sales_representative', 'read_only'];
  const A = {}, W = {};
  for (const k of keys) { const a = await open(k); if (a) { const w = await who(a); if (w) { w.tenant_id = w.tenant_id || tenantOfOrg(w.org_id); A[k] = a; W[k] = w; } } }
  const ADM = A.msq_org_admin, EMP = A.msq_rep1;
  if (!ADM) { console.log('tenant B org admin missing (run auth-setup)'); return; }
  const adm = W.msq_org_admin;
  console.log('actors: ' + Object.keys(A).map((k) => `${k}[${W[k].org_id.slice(0, 8)}/${W[k].tenant_id?.slice(0, 8)}]`).join(' '));

  // The writers: any login that really holds the capability (live), per tenant. Used to seed fixtures.
  const writer = (cap, tenantNot = null) => Object.keys(A).find((k) => holds(W[k], cap) && (tenantNot == null || W[k].tenant_id !== tenantNot));
  const admTenant = adm.tenant_id ?? tenantOfOrg(adm.org_id);
  const foreignKey = (cap) => writer(cap, admTenant); // a tenant-A login that holds `cap`

  // ═══ 0. anonymous ══════════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['PATCH', `/employees/departments/${uuid()}`], ['GET', '/employees/designations'], ['POST', '/employees/designations'],
    ['PATCH', `/employees/designations/${uuid()}`], ['GET', '/holiday-calendars'], ['POST', '/holiday-calendars'],
    ['PATCH', `/holiday-calendars/${uuid()}`], ['PATCH', `/holidays/${uuid()}`], ['PATCH', `/leave/policies/${uuid()}`]]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'GET' ? undefined : '{}' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p} without a session`, '401', `HTTP ${r.status}`);
  }

  // ═══ 1. departments / designations — authz by LIVE capability ════════════════
  console.log('\n— 1. taxonomy authz (graded by each login\'s own capabilities) —');
  const made = { dept: {}, desig: {} };
  for (const k of Object.keys(A)) {
    const w = W[k];
    const canManage = holds(w, TAX), canView = holds(w, EMPV);
    const lst = await t.api(A[k], 'GET', '/employees/designations', { expect: canView ? 'ok' : 'denied', label: `${k} lists designations (hr.employees.view=${canView})` });
    if (canView && lst.status === 200) {
      const ids = (lst.body?.data ?? []).map((d) => d.id).filter(Boolean);
      if (ids.length) {
        const bad = rows(`SELECT id::text, org_id::text FROM hr.designations WHERE id IN (${ids.map(lit).join(',')}) AND org_id <> ${lit(w.org_id)}`, ['id', 'org']);
        t.check(bad.length === 0, 'critical', k, 'designation list holds only the caller\'s branch', '0 foreign rows', `${bad.length} foreign: ${JSON.stringify(bad).slice(0, 200)}`, '', 'listDesignations must filter org_id = ctx.org_id under RLS.');
      }
    }
    const dl = await t.api(A[k], 'GET', '/employees/departments', { expect: canView ? 'ok' : 'denied', label: `${k} lists departments` });
    if (canView && dl.status === 200) {
      const ids = (dl.body?.data ?? []).map((d) => d.id).filter(Boolean);
      if (ids.length) {
        const bad = rows(`SELECT id::text, COALESCE(org_id::text,'-'), tenant_id::text FROM iam.departments WHERE id IN (${ids.map(lit).join(',')}) AND (tenant_id <> ${lit(w.tenant_id ?? tenantOfOrg(w.org_id))} OR (org_id IS NOT NULL AND org_id <> ${lit(w.org_id)}))`, ['id', 'org', 'tenant']);
        t.check(bad.length === 0, 'critical', k, 'department list = own branch + tenant-wide rows only', '0 foreign rows', `${bad.length}: ${JSON.stringify(bad).slice(0, 200)}`, '', 'listDepartments must keep the (org_id = ctx OR NULL) + tenant fence.');
      }
    }
    // writes
    const dn = `${MARK}-dept-${k}`, gn = `${MARK}-desig-${k}`;
    const dr = await t.api(A[k], 'POST', '/employees/departments', { body: { name: dn }, expect: canManage ? [201] : 'forbidden', label: `${k} creates a department (taxonomy.manage=${canManage})` });
    const gr = await t.api(A[k], 'POST', '/employees/designations', { body: { name: gn }, expect: canManage ? [201] : 'forbidden', label: `${k} creates a designation` });
    const did = rows(`SELECT id::text FROM iam.departments WHERE name=${lit(dn)}`, ['id'])[0]?.id;
    const gid = rows(`SELECT id::text FROM hr.designations WHERE name=${lit(gn)}`, ['id'])[0]?.id;
    if (canManage) {
      const d = did && deptRow(did), g = gid && desigRow(gid);
      t.check(!!d && d.org === w.org_id && d.tenant === (w.tenant_id ?? tenantOfOrg(w.org_id)) && d.by === w.id, 'high', k, 'department lands in the caller\'s branch + tenant, created_by = caller', 'org/tenant/by = caller', JSON.stringify(d));
      t.check(!!g && g.org === w.org_id && g.by === w.id, 'high', k, 'designation lands in the caller\'s branch, created_by = caller', 'org/by = caller', JSON.stringify(g));
      if (did) made.dept[k] = did; if (gid) made.desig[k] = gid;
    } else {
      t.check(!did && !gid, 'critical', k, 'a refused create wrote nothing', 'no rows', `dept=${did} desig=${gid}`);
    }
  }

  // ═══ 2. PATCH happy path + mass-assignment + validation (tenant B admin) ═══════
  console.log('\n— 2. department / designation PATCH —');
  const dKey = 'msq_org_admin';
  let myDept = made.dept[dKey], myDesig = made.desig[dKey];
  if (!myDept && holds(adm, TAX)) { await t.api(ADM, 'POST', '/employees/departments', { body: { name: `${MARK}-dept-main` }, expect: [201] }); myDept = scalar(`SELECT id::text FROM iam.departments WHERE name=${lit(`${MARK}-dept-main`)}`); }
  if (myDept && myDesig) {
    const before = deptRow(myDept);
    await t.api(ADM, 'PATCH', `/employees/departments/${myDept}`, { body: { name: `${MARK}-dept-renamed` }, expect: 'ok', label: 'rename own department' });
    const after = deptRow(myDept);
    t.check(after.name === `${MARK}-dept-renamed` && after.org === before.org && after.tenant === before.tenant, 'high', dKey, 'rename persisted; org/tenant untouched', 'renamed, same org/tenant', JSON.stringify(after));
    // product note: `label` is what pickers show; a rename that leaves label stale is a UX gap, recorded as info only
    if (after.label !== after.name) t.find('low', dKey, 'department rename leaves iam.departments.label stale', 'label follows name (or the API exposes label)', `name=${after.name} label=${after.label}`, myDept, 'updateDepartment should also set label when name changes, or lists should show the name consistently.');
    // smuggled ownership fields must be ignored (zod strips) — never move the row to another branch / tenant
    const foreignOrg = scalar(`SELECT id::text FROM entity.organizations WHERE tenant_id <> ${lit(admTenant)} LIMIT 1`);
    const sm = await t.api(ADM, 'PATCH', `/employees/departments/${myDept}`, { body: { is_active: true, org_id: foreignOrg, tenant_id: tenantOfOrg(foreignOrg), is_deleted: true, created_by: uuid() }, expect: [200, 204, 400, 422], label: 'PATCH a department with smuggled org_id / tenant_id / is_deleted' });
    void sm;
    const after2 = deptRow(myDept);
    t.check(after2.org === before.org && after2.tenant === before.tenant && after2.del === 'false' && after2.by === before.by, 'critical', dKey, 'smuggled org_id/tenant_id/is_deleted/created_by were ignored', 'row unchanged', JSON.stringify(after2), '', 'Never spread the body into the UPDATE; whitelist name/is_active.');
    await t.api(ADM, 'PATCH', `/employees/departments/${myDept}`, { body: { is_active: false }, expect: 'ok', label: 'deactivate own department' });
    t.check(deptRow(myDept).active === 'false', 'high', dKey, 'deactivation persisted', 'is_active=false', deptRow(myDept).active);
    const dl = await t.api(ADM, 'GET', '/employees/departments', { expect: 'ok', label: 'list after deactivation' });
    t.check((dl.body?.data ?? []).some((d) => d.id === myDept), 'low', dKey, 'a deactivated department is still listed (flagged isActive=false) so HR can re-enable it', 'listed with isActive=false', 'not listed');

    await t.api(ADM, 'PATCH', `/employees/designations/${myDesig}`, { body: { name: `${MARK}-desig-renamed`, is_active: false }, expect: 'ok', label: 'rename + deactivate own designation' });
    const g2 = desigRow(myDesig);
    t.check(g2.name === `${MARK}-desig-renamed` && g2.active === 'false', 'high', dKey, 'designation PATCH persisted', 'renamed + inactive', JSON.stringify(g2));
    await t.api(ADM, 'PATCH', `/employees/designations/${myDesig}`, { body: { org_id: uuid(), is_deleted: true }, expect: [200, 204, 400, 404, 422], label: 'PATCH a designation with smuggled org_id / is_deleted' });
    const g3 = desigRow(myDesig);
    t.check(g3.org === adm.org_id && g3.del === 'false', 'critical', dKey, 'smuggled designation fields were ignored', 'org same, not deleted', JSON.stringify(g3));

    // validation — every one a 4xx, never a 5xx (api() flags a 5xx itself)
    const bads = [
      ['non-uuid id', `/employees/departments/not-a-uuid`, { name: 'x' }],
      ['uuid-like injection id', `/employees/departments/${encodeURIComponent("' OR 1=1 --")}`, { name: 'x' }],
      ['empty name', `/employees/departments/${myDept}`, { name: '' }],
      ['201-char name', `/employees/departments/${myDept}`, { name: 'n'.repeat(201) }],
      ['numeric name', `/employees/departments/${myDept}`, { name: 12345 }],
      ['is_active as string', `/employees/departments/${myDept}`, { is_active: 'yes' }],
      ['empty body', `/employees/departments/${myDept}`, {}],
      ['null body fields', `/employees/departments/${myDept}`, { name: null }],
      ['unknown id', `/employees/departments/${uuid()}`, { name: 'x' }],
    ];
    for (const [lbl, p, body] of bads) await t.api(ADM, 'PATCH', p, { body, expect: 'notok', label: `department PATCH: ${lbl}` });
    for (const [lbl, p, body] of [['non-uuid id', '/employees/designations/zzz', { name: 'x' }], ['empty name', `/employees/designations/${myDesig}`, { name: '' }], ['201-char name', `/employees/designations/${myDesig}`, { name: 'n'.repeat(201) }], ['unknown id', `/employees/designations/${uuid()}`, { name: 'x' }], ['empty body', `/employees/designations/${myDesig}`, {}]]) {
      await t.api(ADM, 'PATCH', p, { body, expect: 'notok', label: `designation PATCH: ${lbl}` });
    }
    for (const [lbl, p, body] of [['empty name', '/employees/departments', { name: '' }], ['missing name', '/employees/departments', {}], ['201-char name', '/employees/designations', { name: 'n'.repeat(201) }], ['array name', '/employees/designations', { name: ['a'] }], ['whitespace-only name', '/employees/designations', { name: '   ' }]]) {
      const r = await t.api(ADM, 'POST', p, { body, expect: [201, 400, 422], label: `taxonomy POST: ${lbl}` });
      if (r.status === 201 && /whitespace/.test(lbl)) t.find('low', dKey, 'a whitespace-only designation name is accepted', '400 (trimmed name must be non-empty)', 'HTTP 201', JSON.stringify(r.body).slice(0, 150), 'Trim in createDesignationSchema (z.string().trim().min(1)).');
    }
    // unique index -> 409 not 500
    await t.api(ADM, 'POST', '/employees/designations', { body: { name: `${MARK}-desig-renamed` }, expect: [409, 400, 422], label: 'duplicate designation name in one branch' });
    await t.api(ADM, 'POST', '/employees/departments', { body: { name: `${MARK}-dept-renamed` }, expect: [409, 400, 422], label: 'duplicate department name in one branch' });
    // two simultaneous identical creates: exactly one row, the loser is 409 (never two rows, never 5xx)
    const racer = `${MARK}-desig-race`;
    const res = await simultaneously([0, 1, 2].map(() => () => t.api(ADM, 'POST', '/employees/designations', { body: { name: racer }, expect: [201, 409], label: 'simultaneous identical designation create' })));
    t.check(Number(scalar(`SELECT count(*) FROM hr.designations WHERE name=${lit(racer)} AND NOT is_deleted`)) === 1 && res.filter((r) => r.status === 201).length === 1, 'high', dKey, 'three simultaneous identical creates -> exactly one row / one 201', '1 row, one 201', `${scalar(`SELECT count(*) FROM hr.designations WHERE name=${lit(racer)}`)} rows; statuses ${res.map((r) => r.status)}`);
  } else console.log('  (no taxonomy fixtures for tenant B — manage capability not held; PATCH happy path skipped)');

  // ═══ 3. cross-tenant / cross-branch IDOR on taxonomy PATCH ═════════════════════
  console.log('\n— 3. taxonomy IDOR —');
  const fa = foreignKey(TAX); // a tenant-A login that holds taxonomy.manage
  if (fa && myDept) {
    const fdept = made.dept[fa], fdesig = made.desig[fa];
    if (fdept) {
      const b = deptRow(fdept);
      await t.api(ADM, 'PATCH', `/employees/departments/${fdept}`, { body: { name: `${MARK}-hijack`, is_active: false }, expect: 'denied', label: 'tenant B admin renames tenant A\'s department' });
      t.check(same(deptRow(fdept), b), 'critical', 'msq_org_admin', 'foreign department byte-identical after a rejected PATCH', 'unchanged', JSON.stringify(deptRow(fdept)));
      await t.api(A[fa], 'PATCH', `/employees/departments/${myDept}`, { body: { name: `${MARK}-hijack` }, expect: 'denied', label: `tenant A ${fa} renames tenant B's department` });
      t.check(deptRow(myDept).name !== `${MARK}-hijack`, 'critical', fa, 'tenant B department untouched by a tenant A admin', 'not renamed', deptRow(myDept).name);
    }
    if (fdesig) {
      const b = desigRow(fdesig);
      await t.api(ADM, 'PATCH', `/employees/designations/${fdesig}`, { body: { name: `${MARK}-hijack`, is_active: false }, expect: 'denied', label: 'tenant B admin renames tenant A\'s designation' });
      t.check(same(desigRow(fdesig), b), 'critical', 'msq_org_admin', 'foreign designation byte-identical after a rejected PATCH', 'unchanged', JSON.stringify(desigRow(fdesig)));
    }
  } else console.log('  (no tenant-A login holds taxonomy.manage — cross-tenant PATCH skipped)');
  // same tenant, other BRANCH: a department is branch-owned (org_id) — a sibling branch's admin must not edit it
  const pairs = Object.keys(A).flatMap((k) => Object.keys(A).filter((o) => o !== k && made.dept[k] && made.dept[o] && W[o].tenant_id === W[k].tenant_id && W[o].org_id !== W[k].org_id).map((o) => [k, o]));
  const [sib, other] = pairs[0] ?? [];
  if (sib) {
    const b = deptRow(made.dept[other]);
    await t.api(A[sib], 'PATCH', `/employees/departments/${made.dept[other]}`, { body: { name: `${MARK}-sibling-hijack` }, expect: 'denied', label: `${sib} edits sibling branch's department (${other})` });
    t.check(same(deptRow(made.dept[other]), b), 'high', sib, 'a sibling branch\'s department is unchanged', 'unchanged', JSON.stringify(deptRow(made.dept[other])));
  }
  if (EMP && !holds(W.msq_rep1, TAX) && myDept) {
    const b = deptRow(myDept);
    await t.api(EMP, 'PATCH', `/employees/departments/${myDept}`, { body: { name: `${MARK}-emp-hijack` }, expect: 'forbidden', label: 'employee without taxonomy.manage renames a department' });
    t.check(same(deptRow(myDept), b), 'critical', 'msq_rep1', 'department unchanged after a refused employee PATCH', 'unchanged', JSON.stringify(deptRow(myDept)));
  }

  // ═══ 4. holiday calendars + holidays ═══════════════════════════════════════════
  console.log('\n— 4. holiday calendars / holidays —');
  const YEAR = 2031; // far from any real calendar so the unique (org, name, year) cannot collide with seed data
  const calKeys = {};
  for (const k of Object.keys(A)) {
    const w = W[k], canView = holds(w, LVIEW), canManage = holds(w, HOL);
    const cl = await t.api(A[k], 'GET', '/holiday-calendars', { expect: canView ? 'ok' : 'denied', label: `${k} lists holiday calendars (hr.leave.view=${canView})` });
    if (canView && cl.status === 200) {
      const ids = (cl.body?.data ?? []).map((c) => c.id).filter(Boolean);
      if (ids.length) {
        const bad = rows(`SELECT id::text FROM hr.holiday_calendars WHERE id IN (${ids.map(lit).join(',')}) AND org_id <> ${lit(w.org_id)}`, ['id']);
        t.check(bad.length === 0, 'critical', k, 'holiday-calendar list holds only the caller\'s branch', '0 foreign rows', `${bad.length} foreign`, '', 'listCalendars must filter by org under RLS.');
      }
    }
    const nm = `${MARK}-cal-${k}`;
    await t.api(A[k], 'POST', '/holiday-calendars', { body: { name: nm, year: YEAR }, expect: canManage ? [201] : 'forbidden', label: `${k} creates a holiday calendar (holidays.manage=${canManage})` });
    const cid = scalar(`SELECT id::text FROM hr.holiday_calendars WHERE name=${lit(nm)}`);
    if (canManage) {
      const c = cid && calRow(cid);
      t.check(!!c && c.org === w.org_id && c.year === String(YEAR), 'high', k, 'calendar lands in the caller\'s branch with the posted year', 'org=caller', JSON.stringify(c));
      if (cid) calKeys[k] = cid;
    } else t.check(!cid, 'critical', k, 'a refused calendar create wrote nothing', 'no row', String(cid));
  }
  const myCal = calKeys.msq_org_admin;
  if (myCal) {
    const before = calRow(myCal);
    await t.api(ADM, 'PATCH', `/holiday-calendars/${myCal}`, { body: { name: `${MARK}-cal-renamed`, year: YEAR + 1 }, expect: 'ok', label: 'rename own calendar + change year' });
    const aft = calRow(myCal);
    t.check(aft.name === `${MARK}-cal-renamed` && aft.year === String(YEAR + 1) && aft.org === before.org, 'high', 'msq_org_admin', 'calendar PATCH persisted, org untouched', 'renamed', JSON.stringify(aft));
    await t.api(ADM, 'PATCH', `/holiday-calendars/${myCal}`, { body: { org_id: uuid(), is_deleted: true }, expect: [200, 204, 400, 404, 422], label: 'PATCH a calendar with smuggled org_id / is_deleted' });
    t.check(calRow(myCal).org === adm.org_id && calRow(myCal).del === 'false', 'critical', 'msq_org_admin', 'smuggled calendar fields ignored', 'unchanged', JSON.stringify(calRow(myCal)));
    for (const [lbl, p, body] of [
      ['non-uuid id', '/holiday-calendars/xyz', { name: 'x' }], ['unknown id', `/holiday-calendars/${uuid()}`, { name: 'x' }],
      ['empty name', `/holiday-calendars/${myCal}`, { name: '' }], ['year as text', `/holiday-calendars/${myCal}`, { year: 'twenty' }],
      ['year float', `/holiday-calendars/${myCal}`, { year: 2031.5 }], ['year beyond INT', `/holiday-calendars/${myCal}`, { year: 99999999999 }],
      ['is_active string', `/holiday-calendars/${myCal}`, { is_active: 'no' }],
    ]) await t.api(ADM, 'PATCH', p, { body, expect: 'notok', label: `calendar PATCH: ${lbl}` });
    for (const [lbl, body] of [['missing year', { name: `${MARK}-cal-x` }], ['year beyond INT', { name: `${MARK}-cal-x`, year: 99999999999 }], ['empty name', { name: '', year: YEAR }], ['year object', { name: `${MARK}-cal-x`, year: {} }]]) {
      await t.api(ADM, 'POST', '/holiday-calendars', { body, expect: [400, 422], label: `calendar POST: ${lbl}` });
    }
    await t.api(ADM, 'POST', '/holiday-calendars', { body: { name: `${MARK}-cal-renamed`, year: YEAR + 1 }, expect: [409, 400, 422], label: 'duplicate calendar (org, name, year)' });

    // holidays under it
    const mkHol = await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: myCal, holiday_date: `${YEAR + 1}-03-14`, name: `${MARK}-hol-a`, is_optional: false }, expect: [201], label: 'create a holiday in own calendar' });
    const hid = scalar(`SELECT id::text FROM hr.holidays WHERE name=${lit(`${MARK}-hol-a`)}`);
    void mkHol;
    if (hid) {
      const h0 = holRow(hid);
      t.check(h0.org === adm.org_id && h0.cal === myCal, 'high', 'msq_org_admin', 'holiday stamped with the caller\'s org + the calendar', 'org=caller', JSON.stringify(h0));
      await t.api(ADM, 'PATCH', `/holidays/${hid}`, { body: { name: `${MARK}-hol-b`, is_optional: true, holiday_date: `${YEAR + 1}-03-15` }, expect: 'ok', label: 'edit own holiday' });
      const h1 = holRow(hid);
      t.check(h1.name === `${MARK}-hol-b` && h1.opt === 'true' && h1.date === `${YEAR + 1}-03-15` && h1.cal === myCal && h1.org === h0.org, 'high', 'msq_org_admin', 'holiday PATCH persisted; calendar + org untouched', 'edited', JSON.stringify(h1));
      await t.api(ADM, 'PATCH', `/holidays/${hid}`, { body: { calendar_id: uuid(), org_id: uuid(), is_deleted: true }, expect: [200, 204, 400, 404, 422], label: 'PATCH a holiday with smuggled calendar_id / org_id / is_deleted' });
      const h2 = holRow(hid);
      t.check(h2.cal === myCal && h2.org === h0.org && h2.del === 'false', 'critical', 'msq_org_admin', 'smuggled holiday fields ignored', 'unchanged', JSON.stringify(h2));
      for (const [lbl, p, body] of [['impossible date 2031-02-30', `/holidays/${hid}`, { holiday_date: '2031-02-30' }], ['date wrong shape', `/holidays/${hid}`, { holiday_date: '15/03/2031' }],
        ['non-uuid id', '/holidays/nope', { name: 'x' }], ['empty name', `/holidays/${hid}`, { name: '' }], ['is_optional string', `/holidays/${hid}`, { is_optional: 'true' }], ['unknown id', `/holidays/${uuid()}`, { name: 'x' }]]) {
        await t.api(ADM, 'PATCH', p, { body, expect: 'notok', label: `holiday PATCH: ${lbl}` });
      }
      await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: myCal, holiday_date: `${YEAR + 1}-03-15`, name: `${MARK}-hol-dup` }, expect: [409, 400, 422], label: 'second holiday on the same calendar date' });
      await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: myCal, holiday_date: '2031-13-01', name: `${MARK}-hol-baddate` }, expect: [400, 422], label: 'holiday POST: month 13' });
      await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: 'nope', holiday_date: `${YEAR + 1}-04-01`, name: `${MARK}-hol-badcal` }, expect: [400, 422], label: 'holiday POST: non-uuid calendar_id' });
      await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: uuid(), holiday_date: `${YEAR + 1}-04-01`, name: `${MARK}-hol-nocal` }, expect: 'notok', label: 'holiday POST: unknown calendar_id' });
      t.check(Number(scalar(`SELECT count(*) FROM hr.holidays WHERE name IN (${lit(`${MARK}-hol-dup`)}, ${lit(`${MARK}-hol-baddate`)}, ${lit(`${MARK}-hol-badcal`)}, ${lit(`${MARK}-hol-nocal`)})`)) === 0, 'high', 'msq_org_admin', 'refused holiday creates wrote nothing', '0 rows', 'rows exist');

      // cross-tenant
      const fh = foreignKey(HOL);
      if (fh && calKeys[fh]) {
        const fcal = calKeys[fh], bc = calRow(fcal);
        await t.api(ADM, 'PATCH', `/holiday-calendars/${fcal}`, { body: { name: `${MARK}-hijack`, is_active: false }, expect: 'denied', label: 'tenant B admin edits tenant A\'s calendar' });
        t.check(same(calRow(fcal), bc), 'critical', 'msq_org_admin', 'foreign calendar byte-identical after a rejected PATCH', 'unchanged', JSON.stringify(calRow(fcal)));
        await t.api(ADM, 'POST', '/holidays', { body: { calendar_id: fcal, holiday_date: `${YEAR}-06-01`, name: `${MARK}-hol-foreign` }, expect: 'notok', label: 'tenant B admin adds a holiday to tenant A\'s calendar' });
        t.check(Number(scalar(`SELECT count(*) FROM hr.holidays WHERE calendar_id=${lit(fcal)} AND name LIKE ${lit(`${MARK}%`)}`)) === 0, 'critical', 'msq_org_admin', 'no holiday was written into a foreign tenant\'s calendar', '0 rows', 'row written', '', 'createHoliday must verify calendar_id belongs to ctx.org_id.');
        await t.api(A[fh], 'PATCH', `/holidays/${hid}`, { body: { name: `${MARK}-hijack` }, expect: 'denied', label: `tenant A ${fh} edits tenant B's holiday` });
        t.check(holRow(hid).name === `${MARK}-hol-b`, 'critical', fh, 'tenant B holiday untouched by a tenant A admin', 'unchanged', holRow(hid).name);
        await t.api(A[fh], 'PATCH', `/holiday-calendars/${myCal}`, { body: { name: `${MARK}-hijack` }, expect: 'denied', label: `tenant A ${fh} edits tenant B's calendar` });
        t.check(calRow(myCal).name === `${MARK}-cal-renamed`, 'critical', fh, 'tenant B calendar untouched', 'unchanged', calRow(myCal).name);
      } else console.log('  (no tenant-A login holds holidays.manage — cross-tenant holiday cases skipped)');
      if (EMP && !holds(W.msq_rep1, HOL)) {
        await t.api(EMP, 'PATCH', `/holidays/${hid}`, { body: { name: `${MARK}-emp` }, expect: 'forbidden', label: 'employee without holidays.manage edits a holiday' });
        await t.api(EMP, 'PATCH', `/holiday-calendars/${myCal}`, { body: { name: `${MARK}-emp` }, expect: 'forbidden', label: 'employee without holidays.manage edits a calendar' });
        t.check(holRow(hid).name === `${MARK}-hol-b` && calRow(myCal).name === `${MARK}-cal-renamed`, 'critical', 'msq_rep1', 'holiday + calendar unchanged after refused employee edits', 'unchanged', `${holRow(hid).name} / ${calRow(myCal).name}`);
      }
    }
  } else console.log('  (tenant B admin cannot manage holidays — calendar/holiday cases skipped)');

  // ═══ 5. leave-policy PATCH ═════════════════════════════════════════════════════
  console.log('\n— 5. leave policy PATCH —');
  const polOf = (org) => scalar(`SELECT id::text FROM hr.leave_policies WHERE org_id=${lit(org)} AND NOT is_deleted ORDER BY created_at LIMIT 1`);
  const polRow = (id) => rows(`SELECT COALESCE(org_id::text,''), tenant_id::text, sla_hours::text, approval_levels::text, encashable::text, COALESCE(max_encash_days::text,''), min_notice_days::text, is_deleted::text FROM hr.leave_policies WHERE id=${lit(id)}`,
    ['org', 'tenant', 'sla', 'levels', 'enc', 'maxenc', 'notice', 'del'])[0];
  const myPol = polOf(adm.org_id);
  if (myPol && holds(adm, POL)) {
    cleanups.push(snapshotRow('people-taxo-policy', 'hr.leave_policies', 'id', myPol));
    const b = polRow(myPol);
    await t.api(ADM, 'PATCH', `/leave/policies/${myPol}`, { body: { sla_hours: 72, min_notice_days: 3 }, expect: 'ok', label: 'edit own leave policy (sla_hours, min_notice_days)' });
    const a1 = polRow(myPol);
    t.check(a1.sla === '72' && a1.notice === '3' && a1.org === b.org && a1.tenant === b.tenant, 'high', 'msq_org_admin', 'policy PATCH persisted; org/tenant untouched', 'sla 72, notice 3', JSON.stringify(a1));
    await t.api(ADM, 'PATCH', `/leave/policies/${myPol}`, { body: { org_id: uuid(), tenant_id: uuid(), is_deleted: true, leave_type_id: uuid() }, expect: [200, 204, 400, 404, 422], label: 'PATCH a policy with smuggled org_id / tenant_id / is_deleted / leave_type_id' });
    const a2 = polRow(myPol);
    t.check(a2.org === b.org && a2.tenant === b.tenant && a2.del === 'false', 'critical', 'msq_org_admin', 'smuggled policy ownership fields ignored', 'unchanged', JSON.stringify(a2));
    const before = polRow(myPol);
    for (const [lbl, body] of [
      ['sla_hours 0', { sla_hours: 0 }], ['sla_hours 721', { sla_hours: 721 }], ['sla_hours 1.5', { sla_hours: 1.5 }], ['sla_hours beyond SMALLINT (40000)', { sla_hours: 40000 }],
      ['max_encash_days 366', { max_encash_days: 366 }], ['max_encash_days 0', { max_encash_days: 0 }], ['approval_levels 0', { approval_levels: 0 }],
      ['approval_levels beyond SMALLINT', { approval_levels: 70000 }], ['min_notice_days -1', { min_notice_days: -1 }], ['min_notice_days beyond SMALLINT', { min_notice_days: 70000 }],
      ['accrual_amount -1', { accrual_amount: -1 }], ['accrual_amount beyond NUMERIC(5,2) (1000)', { accrual_amount: 1000 }], ['max_balance beyond NUMERIC(5,2)', { max_balance: 99999 }],
      ['accrual_frequency not in enum', { accrual_frequency: 'weekly' }], ['carry_forward string', { carry_forward: 'yes' }],
      ['max_consecutive_days beyond SMALLINT', { max_consecutive_days: 70000 }], ['requires_document_after_days beyond SMALLINT', { requires_document_after_days: 70000 }],
    ]) await t.api(ADM, 'PATCH', `/leave/policies/${myPol}`, { body, expect: 'notok', label: `policy PATCH: ${lbl}` });
    t.check(same(polRow(myPol), before), 'high', 'msq_org_admin', 'no rejected policy PATCH changed the row', 'unchanged', JSON.stringify(polRow(myPol)));
    await t.api(ADM, 'PATCH', '/leave/policies/not-a-uuid', { body: { sla_hours: 10 }, expect: 'notok', label: 'policy PATCH: non-uuid id' });
    await t.api(ADM, 'PATCH', `/leave/policies/${uuid()}`, { body: { sla_hours: 10 }, expect: 'notok', label: 'policy PATCH: unknown id' });
    // cross-tenant
    const fp = foreignKey(POL);
    const fpol = fp && polOf(W[fp].org_id);
    if (fpol) {
      cleanups.push(snapshotRow('people-taxo-policy-foreign', 'hr.leave_policies', 'id', fpol));
      const fb = polRow(fpol);
      await t.api(ADM, 'PATCH', `/leave/policies/${fpol}`, { body: { sla_hours: 1, approval_levels: 9 }, expect: 'denied', label: 'tenant B admin edits tenant A\'s leave policy' });
      t.check(same(polRow(fpol), fb), 'critical', 'msq_org_admin', 'foreign leave policy byte-identical after a rejected PATCH', 'unchanged', JSON.stringify(polRow(fpol)));
      await t.api(A[fp], 'PATCH', `/leave/policies/${myPol}`, { body: { sla_hours: 1 }, expect: 'denied', label: `tenant A ${fp} edits tenant B's leave policy` });
      t.check(polRow(myPol).sla === before.sla, 'critical', fp, 'tenant B policy untouched by a tenant A admin', before.sla, polRow(myPol).sla);
    }
    if (EMP && !holds(W.msq_rep1, POL)) {
      await t.api(EMP, 'PATCH', `/leave/policies/${myPol}`, { body: { sla_hours: 2 }, expect: 'forbidden', label: 'employee without policies.manage edits a policy' });
      t.check(polRow(myPol).sla === before.sla, 'critical', 'msq_rep1', 'policy unchanged after a refused employee PATCH', before.sla, polRow(myPol).sla);
    }
  } else console.log('  (tenant B has no leave policy / admin lacks policies.manage — policy PATCH skipped)');

  // ═══ 6. /hr/leave/ping — the module-gate liveness probe ════════════════════════
  console.log('\n— 6. leave module gate —');
  for (const k of Object.keys(A)) {
    const r = await t.api(A[k], 'GET', '/leave/ping', { expect: [200, 403, 404], label: `${k} /leave/ping` });
    if (r.status === 200) t.check(r.body?.data?.pong === true && JSON.stringify(r.body).length < 120, 'low', k, 'ping returns only { pong: true }', '{pong:true}', JSON.stringify(r.body).slice(0, 120));
  }
}, cleanups);

t.summary();
process.exit(0);
