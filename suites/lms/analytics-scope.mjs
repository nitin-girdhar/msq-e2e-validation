// LMS analytics & reports — scope of every row, per role.
//
// The API-surface sweep proves these endpoints answer; it cannot tell whether a
// branch manager's "branch report" quietly includes other branches (or another
// tenant). Reports aggregate across orgs by design, which is exactly where a
// missing org predicate hides. For every role and every report endpoint this
// walks the JSON, collects every org_id / user_id it mentions, and checks them
// against what that role covers:
//
//   tenant-wide roles (tenant_admin, super_admin) -> any org of their tenant
//   everyone else -> their active iam.user_org_mapping branches + home branch
//
// Also: POST /analytics/report/send (emails a report) must be refused to roles
// without the capability. It is never fired for allowed roles.
//
//   node suites/lms/analytics-scope.mjs
import { ROLES, roleMeta, APPS, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'lms';
const fail = finder(TOOL, 'Analytics & reports scope');
const L = `${APPS['lms-web']}/api`;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const qs = `?from=${monthAgo}&to=${today}&start_date=${monthAgo}&end_date=${today}`;
const REPORTS = ['/analytics/dashboard', '/analytics/dashboard/campaigns', '/analytics/performance', '/analytics/pipeline',
  '/analytics/report/branches', '/analytics/report/users', '/analytics/report/sources', '/dashboard', '/org/performance'];

function collect(node, out = { orgs: new Set(), users: new Set() }) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) {
        if (k === 'org_id' || k === 'branch_id') out.orgs.add(v);
        if (k === 'user_id' || k === 'assigned_user_id') out.users.add(v);
      } else collect(v, out);
    }
  }
  return out;
}

for (const role of ROLES) {
  if (!fs.existsSync(authFile(role))) continue;
  const u = rows(`SELECT u.id, u.org_id, o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(roleMeta(role).email)}`, ['id', 'home', 'tenant'])[0];
  if (!u) continue;
  const tenantWide = ['tenant_admin', 'super_admin'].includes(role);
  const covered = new Set(rows(tenantWide
    ? `SELECT id FROM entity.organizations WHERE tenant_id=${lit(u.tenant)}`
    : `SELECT org_id FROM iam.user_org_mapping WHERE user_id=${lit(u.id)} AND is_active UNION SELECT ${lit(u.home)}::uuid`, ['id']).map((r) => r.id));
  const a = await actor(role);
  try {
    const caps = await sessionCaps(a);
    for (const p of REPORTS) {
      const r = await apiGet(a, `${L}${p}${qs}`);
      if (!isOk(r.status)) continue; // gating/5xx are graded by the API-surface sweep
      const { orgs, users } = collect(r.body);
      const foreignTenant = [...orgs].filter((o) => scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(o)}`) !== u.tenant);
      const outside = [...orgs].filter((o) => !covered.has(o) && !foreignTenant.includes(o));
      const foreignUsers = [...users].filter((x) => scalar(`SELECT o.tenant_id FROM iam.users uu JOIN entity.organizations o ON o.id=uu.org_id WHERE uu.id=${lit(x)}`) !== u.tenant);
      if (foreignTenant.length || foreignUsers.length || outside.length) console.log(`  ${role.padEnd(26)} ${p.padEnd(32)} foreignTenantOrgs=${foreignTenant.length} foreignUsers=${foreignUsers.length} outsideCoverage=${outside.length}`);
      if (foreignTenant.length || foreignUsers.length) fail('critical', role, `${p} returns data of ANOTHER tenant`, `Only tenant ${u.tenant}`, `orgs=${foreignTenant.slice(0, 3).join(',')} users=${foreignUsers.slice(0, 3).join(',')}`, `${p}${qs}`, 'Every analytics query must run in the caller\'s withRoleTx (RLS) — a report built under withServiceTx needs an explicit tenant predicate.');
      else if (outside.length) fail('high', role, `${p} includes branches ${role} does not cover`, 'Only the caller\'s branches (getCoveredOrgIds)', `${outside.length} extra org(s): ${outside.slice(0, 3).join(', ')}`, `${p}${qs}`, 'Filter by the covered org set; canSeeOrgFilter is tenant-wide only, so a branch-scoped role must never receive other branches\' rows.');
    }
    if (caps && !caps.has('lms.analytics.view')) { // send is gated on lms.analytics.view (analytics router)
      const s = await apiPost(a, `${L}/analytics/report/send`, { e2e_invalid: true });
      if (isOk(s.status)) fail('high', role, `${role} can trigger the emailed lead report`, '403', `HTTP ${s.status}`, JSON.stringify(s.body).slice(0, 200), 'Gate POST /analytics/report/send on its capability before validating the body.');
    }
  } finally { await a.close(); }
}
console.log('\nanalytics scope sweep done.');
