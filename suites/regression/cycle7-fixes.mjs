// Regression pass for the cycle-7 open items fixed in schema 1.78.0 (2026-10-09).
//   N1  payroll publish/lock/unlock with a malformed month is a 400, never a 500
//   N2  removing an own emergency contact works (204) and a repeat is a 404, never a 500
//   R3  tenant_admin / super_admin can create (and rename) a department
//   N3  GET /analytics/dashboard/campaigns is branch-scoped without lms.analytics.org.view
//   N5  PUT /tenants/:id/modules is refused by the gateway for a non-super-admin, before body validation
//   N7  failed password-reset attempts no longer spend the login budget (429 on login)
// Every row it creates is removed in finally.
//
//   node suites/regression/cycle7-fixes.mjs
import { GATEWAY } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, q, scalar, lit } from '../../db.mjs';
import { req, anon, reporter, isOk, sleep } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('regression', 'Cycle-7 fixes (1.78.0)');
const { fail, log } = rep;
const MARK = `E2Ec7${String(Date.now()).slice(-6)}`;
const open = (k) => actor(k).catch(() => null);
const cleanup = [];

try {
  // ── N1 payroll malformed month ─────────────────────────────────────────────
  for (const key of ['org_admin', 'hr_admin', 'tenant_admin', 'msq_org_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      const caps = await sessionCaps(a);
      if (!caps?.has('hr.reports.payroll.manage')) continue;
      for (const act of ['publish', 'lock', 'unlock']) for (const m of ['2020-13', 'abc', '2020-3-1', '2020-00']) {
        const r = await req(a, 'POST', `${GATEWAY}/hr/payroll/admin/${m}/${act}`);
        const ok = r.status === 400 || r.status === 422;
        log({ role: key, action: `payroll ${act} month=${m}`, method: 'POST', endpoint: `/hr/payroll/admin/:month/${act}`, status: r.status, verified: ok, expected: '400/422' });
        if (!ok) fail('high', key, `payroll ${act} with malformed month ${m}`, '400', `HTTP ${r.status}`, r.text.slice(0, 160), 'validate({ params }) + monthStart BadRequestError.');
      }
    } finally { await a.close(); }
  }

  // ── N2 emergency contact create + delete ──────────────────────────────────
  for (const key of ['msq_rep1', 'org_admin', 'tenant_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      const c = await req(a, 'POST', `${GATEWAY}/hr/profile/me/contacts`, { data: { name: `${MARK} Contact`, relation: 'Friend', phone: '9000000001', is_primary: false } });
      const id = c.body?.data?.id;
      if (!isOk(c.status) || !id) { log({ role: key, action: 'add emergency contact', method: 'POST', endpoint: '/hr/profile/me/contacts', status: c.status, verified: false, expected: '201' }); continue; }
      cleanup.push(`DELETE FROM hr.emergency_contacts WHERE id=${lit(id)}`);
      const d = await req(a, 'DELETE', `${GATEWAY}/hr/profile/me/contacts/${id}`);
      const gone = scalar(`SELECT count(*) FROM hr.emergency_contacts WHERE id=${lit(id)} AND is_deleted`) === '1';
      log({ role: key, action: 'remove own emergency contact', method: 'DELETE', endpoint: '/hr/profile/me/contacts/:id', status: d.status, verified: isOk(d.status) && gone, expected: '204 and soft-deleted' });
      if (!isOk(d.status) || !gone) fail('high', key, 'Removing an own emergency contact failed', '204 and is_deleted', `HTTP ${d.status} deleted=${gone}`, d.text.slice(0, 160), 'removeOwnContact must soft-delete in a service tx.');
      const d2 = await req(a, 'DELETE', `${GATEWAY}/hr/profile/me/contacts/${id}`);
      if (d2.status !== 404) fail('medium', key, 'Removing an already-removed contact', '404', `HTTP ${d2.status}`, d2.text.slice(0, 120), '');
    } finally { await a.close(); }
  }

  // ── R3 departments ────────────────────────────────────────────────────────
  for (const key of ['tenant_admin', 'super_admin', 'msq_tenant_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      const caps = await sessionCaps(a);
      if (!caps?.has('hr.employees.taxonomy.manage')) { log({ role: key, action: 'create department skipped (no hr.employees.taxonomy.manage)', method: 'POST', endpoint: '/hr/employees/departments', status: null, outcome: 'visible', expected: 'n/a' }); continue; }
      const r = await req(a, 'POST', `${GATEWAY}/hr/employees/departments`, { data: { name: `${MARK} Dept ${key}` } });
      const id = r.body?.data?.id;
      if (id) cleanup.push(`DELETE FROM iam.departments WHERE id=${lit(id)}`);
      log({ role: key, action: 'create department', method: 'POST', endpoint: '/hr/employees/departments', status: r.status, verified: isOk(r.status), expected: '201' });
      if (!isOk(r.status)) fail('high', key, 'Department create failed', '201', `HTTP ${r.status}`, r.text.slice(0, 160), 'tenant_admin needs INSERT/UPDATE on iam.departments and a FOR ALL policy (1.78.0).');
      else if (id) {
        const p = await req(a, 'PATCH', `${GATEWAY}/hr/employees/departments/${id}`, { data: { name: `${MARK} Renamed ${key}` } });
        if (!isOk(p.status)) fail('high', key, 'Department rename failed', '2xx', `HTTP ${p.status}`, p.text.slice(0, 160), 'UPDATE grant + policy WITH CHECK.');
      }
    } finally { await a.close(); }
  }

  // ── N3 campaign summary scope ─────────────────────────────────────────────
  for (const key of ['org_admin', 'org_manager', 'tenant_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      const caps = await sessionCaps(a);
      const r = await req(a, 'GET', `${GATEWAY}/analytics/dashboard/campaigns`);
      if (!isOk(r.status)) { log({ role: key, action: 'campaign summary', method: 'GET', endpoint: '/analytics/dashboard/campaigns', status: r.status, verified: true, expected: 'refused or served', outcome: 'visible' }); continue; }
      const orgs = new Set((r.body?.data ?? []).map((x) => x.org_id));
      const wide = caps?.has('lms.analytics.org.view');
      const ok = wide || orgs.size <= 1;
      log({ role: key, action: `campaign summary branches=${orgs.size} org.view=${!!wide}`, method: 'GET', endpoint: '/analytics/dashboard/campaigns', status: r.status, verified: ok, expected: wide ? 'tenant-wide allowed' : 'own branch only' });
      if (!ok) fail('high', key, `Campaign summary returns ${orgs.size} branches without lms.analytics.org.view`, '<= 1 branch', `${orgs.size} branches`, '', 'analytics.repository getTenantCampaignSummary tenantWide predicate.');
    } finally { await a.close(); }
  }

  // ── N5 tenant modules ─────────────────────────────────────────────────────
  const fitclass = scalar(`SELECT id FROM entity.tenants WHERE name='Fitclass' AND NOT is_deleted LIMIT 1`);
  for (const key of ['tenant_admin', 'org_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      for (const [label, body] of [['invalid body', { nonsense: 1 }], ['valid-looking body', { modules: [] }]]) {
        const r = await req(a, 'PUT', `${GATEWAY}/tenants/${fitclass}/modules`, { data: body });
        log({ role: key, action: `PUT tenant modules (${label})`, method: 'PUT', endpoint: '/tenants/:id/modules', status: r.status, verified: r.status === 403, expected: '403 at the gateway' });
        if (r.status !== 403) fail('low', key, `PUT /tenants/:id/modules (${label}) got past the gateway guard`, '403', `HTTP ${r.status}`, r.text.slice(0, 120), 'withSuperAdmin on the PUT route.');
      }
    } finally { await a.close(); }
  }

  // ── N7 reset does not spend the login budget ──────────────────────────────
  {
    const an = await anon();
    try {
      for (let i = 0; i < 8; i++) await req(an, 'POST', `${GATEWAY}/auth/reset-password`, { data: { token: `bad${i}`, password: 'Xx12345678!' } });
      const l = await req(an, 'POST', `${GATEWAY}/auth/login`, { data: { email: 'nobody@example.invalid', password: 'x' } });
      log({ role: 'anonymous', action: 'login after 8 failed reset attempts', method: 'POST', endpoint: '/auth/login', status: l.status, verified: l.status !== 429, expected: 'not 429' });
      if (l.status === 429) fail('low', 'anonymous', 'Failed resets still exhaust the login rate limit', 'login not 429', 'HTTP 429', '', 'resetPasswordRateLimit is its own bucket.');
    } finally { await an.close(); }
    await sleep(62_000); // let the 60 s windows lapse so later suites are not rate limited
  }
} finally {
  for (const s of cleanup) { try { q(s); } catch { /* best effort */ } }
}
