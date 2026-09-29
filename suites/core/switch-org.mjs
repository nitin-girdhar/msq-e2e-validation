// Branch switching — GET /auth/my-orgs + POST /auth/switch-org.
//
// NEW since the last pass (08720ad "switch-org to all branches"): every shell
// now carries a BranchSwitcher, tenant-wide roles get an "All branches" mode
// (branch_scope:'all' claim), and switching RE-MINTS the session and REVOKES the
// previous jti. That last part is why this suite never touches .auth/ state —
// it logs in fresh (conc.freshLogin) for every actor.
//
// Rules under test (identity-service auth.service.ts getMyOrgs / switchOrg,
// users.repository.ts getCoveredOrgIds):
//   1. my-orgs == the actor's coverage: tenant-wide role -> every non-deleted
//      org of the tenant; anyone else -> active mappings + home org. The picker
//      and the data behind it must never disagree, and must never list another
//      tenant's branch (critical).
//   2. can_view_all is true only for tenant-wide roles.
//   3. Switching to a mapped branch works, /auth/me follows it, lead lists are
//      scoped to it, and the OLD token is dead (401).
//   4. Switching to an unmapped branch, another tenant's branch, or "all
//      branches" without tenant-wide authority is 403 — and the session
//      survives the refusal.
//   5. Garbage input is a 4xx, never a 5xx.
//
// Rate limit: switch-org shares the 10/min login bucket; with429Retry waits it out.
//
//   node suites/core/switch-org.mjs
import { roleMeta, ROLES, APPS, GATEWAY, CROSS_TENANT } from '../../lib.mjs';
import { freshLogin, with429Retry, readResp, apiGet } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, idsOf } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';
import { chromium } from '@playwright/test';

const TOOL = 'core';
const fail = finder(TOOL, 'Branch switcher (/auth/my-orgs, /auth/switch-org)');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const TENANT_WIDE = new Set(['super_admin', 'tenant_admin']);
const userRow = (email) => rows(
  `SELECT u.id, u.org_id, o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(email)}`,
  ['id', 'home', 'tenant'])[0];
const coverage = (u, tenantWide) => new Set(rows(tenantWide
  ? `SELECT id FROM entity.organizations WHERE tenant_id=${lit(u.tenant)} AND NOT is_deleted`
  : `SELECT uom.org_id FROM iam.user_org_mapping uom JOIN entity.organizations o ON o.id=uom.org_id AND NOT o.is_deleted
       WHERE uom.user_id=${lit(u.id)} AND uom.is_active
     UNION SELECT ${lit(u.home)}::uuid`, ['id']).map((r) => r.id));
const bOrg = CROSS_TENANT[0] ? scalar(`SELECT u.org_id FROM iam.users u WHERE u.email=${lit(CROSS_TENANT[0].email)}`) : null;

const switchOrg = async (s, body) => readResp(await with429Retry(
  () => s.request.post(`${GATEWAY}/auth/switch-org`, { data: body, failOnStatusCode: false }), { label: 'switch-org' }));
const me = async (s) => apiGet(s, `${GATEWAY}/auth/me`);
const orgOfMe = (r) => r.body?.data?.user?.org_id ?? r.body?.data?.org_id ?? null;

// A replay client holding ONLY the pre-switch cookies — proves revocation.
async function replayWith(cookies) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const r = await readResp(await ctx.request.get(`${GATEWAY}/auth/me`, { failOnStatusCode: false }));
  await browser.close();
  return r;
}

// Actors: every tenant-A role that exists in roles.json. Multi-branch non-
// tenant-wide users are the interesting ones for the mapped-switch path.
for (const role of ROLES) {
  const meta = roleMeta(role);
  const u = userRow(meta.email);
  if (!u) continue;
  const tenantWide = TENANT_WIDE.has(role);
  const expected = coverage(u, tenantWide);
  const s = await freshLogin(meta.email);
  try {
    if (!isOk(s.loginStatus)) { console.log(`${role.padEnd(26)} login http=${s.loginStatus} — skipped`); continue; }

    // ── 1 + 2. my-orgs vs coverage ─────────────────────────────────────────
    const mo = await apiGet(s, `${GATEWAY}/auth/my-orgs`);
    const listed = new Set((mo.body?.data?.orgs ?? []).map((o) => o.org_id));
    const canAll = mo.body?.data?.can_view_all;
    const extra = [...listed].filter((id) => !expected.has(id));
    const missing = [...expected].filter((id) => !listed.has(id));
    const foreign = [...listed].filter((id) => scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(id)}`) !== u.tenant);
    console.log(`${role.padEnd(26)} my-orgs http=${mo.status} listed=${listed.size} expected=${expected.size} extra=${extra.length} missing=${missing.length} foreign=${foreign.length} can_view_all=${canAll}`);
    logAction({ tool: TOOL, role, area: 'Branch switcher', action: 'list my branches', method: 'GET', endpoint: '/auth/my-orgs', status: mo.status, outcome: outcomeOf(mo.status) });
    if (foreign.length) fail('critical', role, 'The branch picker lists a branch from ANOTHER tenant', `Only tenant ${u.tenant} branches`, `${foreign.length} foreign org(s): ${foreign.join(', ')}`, `user=${meta.email}`, 'getUserOrgs joins iam.user_org_mapping without asserting o.tenant_id = the user\'s tenant; add that predicate and delete the stray mapping rows (see data-health).');
    if (extra.length || missing.length) fail('medium', role, 'Branch picker disagrees with the branches the data layer covers', 'my-orgs == getCoveredOrgIds (active mappings + home, or the whole tenant for tenant-wide roles)', `extra=[${extra.join(', ')}] missing=[${missing.join(', ')}]`, `user=${meta.email}`, 'Keep auth.service getMyOrgs and users.repository getCoveredOrgIds on one rule — the comment in getCoveredOrgIds says exactly this class of drift is the bug.');
    if (canAll !== undefined && canAll !== tenantWide) fail(canAll ? 'high' : 'medium', role, `can_view_all=${canAll} for ${role}`, `can_view_all=${tenantWide} (tenant-wide roles only)`, `can_view_all=${canAll}`, `user=${meta.email}`, 'canViewAllBranches must equal isTenantWideRole(platform_role).');

    // ── 5. garbage input ───────────────────────────────────────────────────
    const junk = await switchOrg(s, { org_id: 'not-a-uuid' });
    if (junk.status >= 500) fail('medium', role, 'switch-org with a malformed org_id 5xxs', '400/422 validation error', `HTTP ${junk.status}`, JSON.stringify(junk.body).slice(0, 200), 'switchOrgSchema.parse must run before the service; map ZodError to 4xx in identity-service.');

    // ── 4a. another tenant's branch ────────────────────────────────────────
    if (bOrg && bOrg !== u.home) {
      const x = await switchOrg(s, { org_id: bOrg });
      console.log(`   switch -> tenant B org http=${x.status} (expect 403)`);
      if (isOk(x.status)) fail('critical', role, 'switch-org into ANOTHER TENANT\'s branch succeeds', '403 You do not have access to the selected branch', `HTTP ${x.status}`, JSON.stringify(x.body).slice(0, 200), 'getUserById(sub, target, role) must require an active mapping in the SAME tenant; tenant-wide roles must be limited to their own tenant\'s orgs.');
    }

    // ── 4b. all_branches without authority ─────────────────────────────────
    const all = await switchOrg(s, { all_branches: true });
    console.log(`   switch -> all branches http=${all.status} (expect ${tenantWide ? '2xx' : '403'})`);
    if (!tenantWide && isOk(all.status)) fail('high', role, '"All branches" mode granted to a branch-scoped role', '403 You do not have access to all branches', `HTTP ${all.status}`, JSON.stringify(all.body).slice(0, 200), 'switchOrg must check canViewAllBranches(platform_role) before minting branch_scope:"all".');
    if (tenantWide && !isOk(all.status)) fail('medium', role, '"All branches" refused for a tenant-wide role', '2xx and a session with branch_scope "all"', `HTTP ${all.status}`, JSON.stringify(all.body).slice(0, 200), 'Tenant-wide roles are entitled to the all-branches view (canViewAllBranches).');

    // ── 4c. unmapped branch in the SAME tenant ─────────────────────────────
    if (!tenantWide) {
      const unmapped = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(u.tenant)} AND NOT is_deleted AND is_active
                                 AND id NOT IN (${[...expected].map(lit).join(',') || "'00000000-0000-0000-0000-000000000000'"}) LIMIT 1`);
      if (unmapped) {
        const r = await switchOrg(s, { org_id: unmapped });
        const still = await me(s);
        console.log(`   switch -> unmapped org http=${r.status} (expect 403) session-after=${still.status}`);
        if (isOk(r.status)) fail('critical', role, 'switch-org into an UNMAPPED branch of the same tenant succeeds', '403 — only branches in iam.user_org_mapping', `HTTP ${r.status}`, `target=${unmapped}`, 'getUserById must join an ACTIVE iam.user_org_mapping row for the target org.');
        if (!isOk(still.status)) fail('medium', role, 'A refused switch-org logs the user out', 'The current session survives a 403 switch', `/auth/me -> HTTP ${still.status}`, `target=${unmapped}`, 'Only revoke the old jti after the new token has been minted.');
      }
    }

    // ── 3. a real switch: me follows, data follows, old token dies ─────────
    const current = orgOfMe(await me(s));
    const target = [...listed].find((id) => id !== current && expected.has(id)) ?? null;
    if (!target) { console.log('   single-branch user — no mapped switch to exercise'); continue; }
    const oldCookies = await s.cookies();
    const sw = await switchOrg(s, { org_id: target });
    const after = await me(s);
    const landed = orgOfMe(after);
    logAction({ tool: TOOL, role, area: 'Branch switcher', action: 'switch to a mapped branch', method: 'POST', endpoint: '/auth/switch-org', status: sw.status, outcome: outcomeOf(sw.status, landed === target) });
    console.log(`   switch -> mapped org http=${sw.status} me.org=${landed === target ? 'target' : landed}`);
    if (!isOk(sw.status)) {
      fail('medium', role, 'switch-org into a branch the picker offers is refused', '2xx — the picker only lists switchable branches', `HTTP ${sw.status}`, JSON.stringify(sw.body).slice(0, 200), 'getMyOrgs and switchOrg disagree on eligibility for this user; align them.');
      continue;
    }
    if (landed !== target) fail('high', role, '/auth/me does not follow a successful branch switch', `org_id=${target}`, `org_id=${landed}`, JSON.stringify(after.body).slice(0, 200), 'The new cookie from switch-org must replace the old one (same cookie name/path/domain as login).');

    const replay = await replayWith(oldCookies);
    console.log(`   replay pre-switch token -> http=${replay.status} (expect 401)`);
    if (isOk(replay.status)) fail('high', role, 'The pre-switch session token still works after switch-org', '401 — switchOrg revokes the old jti so only one active branch exists per session', `/auth/me with the old cookie -> HTTP ${replay.status}`, `user=${meta.email}`, 'revokeJti(payload.jti, payload.exp) must run on every successful switch, and resolveSession must consult the revocation list.');

    // lms.leads.view.tenant makes the DEFAULT list tenant-wide by design; only a
    // branch-scoped viewer's list must follow the switch.
    const meNow = await apiGet(s, `${GATEWAY}/auth/me`);
    const viewsTenant = (meNow.body?.data?.user?.capabilities ?? []).includes('lms.leads.view.tenant');
    if (!tenantWide && !viewsTenant) {
      const leads = await apiGet(s, `${APPS['lms-web']}/api/leads?page=1&page_size=50`);
      if (isOk(leads.status)) {
        const ids = idsOf(leads.body);
        const wrong = ids.filter((id) => scalar(`SELECT org_id FROM lms.marketing_leads WHERE id=${lit(id)}`) !== target);
        console.log(`   leads after switch rows=${ids.length} outside-target=${wrong.length}`);
        if (wrong.length) fail('high', role, 'Lead list still shows the previous branch after switching', `Only leads of org ${target}`, `${wrong.length}/${ids.length} rows from another org`, JSON.stringify(wrong.slice(0, 5)), 'The leads list must scope by the session\'s org_id (RLS GUC app.current_org_id), not by a cached/previous org.');
      }
    }
  } finally {
    await s.close();
  }
}

// ── Audit trail stays in the caller's tenant ──────────────────────────────────
// The refusals above ("switch -> tenant B org") used to be filed under the
// REQUESTED org, i.e. in tenant B's audit trail, handing tenant B's admins
// tenant A user ids (openissues cycle 4, #1). Tenant B's activity feed must
// hold no row performed by a tenant-A user, and the DB must hold no denied
// switch filed outside the performer's own tenant.
{
  const tb = CROSS_TENANT.find((a) => a.role === 'tenant_admin');
  const misfiled = Number(scalar(`SELECT COUNT(*) FROM audit.activities a
      JOIN iam.users u ON u.id = a.performed_by
      JOIN entity.organizations ho ON ho.id = u.org_id
      JOIN entity.organizations ro ON ro.id = a.org_id
     WHERE a.action_type = 'org_switch_denied' AND ro.tenant_id <> ho.tenant_id`));
  logAction({ tool: TOOL, role: 'db', area: 'Branch switcher', action: 'denied switches are filed in the performer\'s own tenant', method: 'SQL', endpoint: 'audit.activities', status: null, outcome: misfiled ? 'error' : 'allowed', verified: misfiled === 0 });
  if (misfiled) fail('critical', 'any', 'Denied switch-org filed in another tenant\'s audit trail', '0 cross-tenant org_switch_denied rows', `${misfiled} row(s)`, '', 'auth.service switchOrg must log org_id: payload.org_id (the caller\'s own org).');
  if (tb) {
    const s = await freshLogin(tb.email);
    try {
      const feed = await apiGet(s, `${GATEWAY}/activities`);
      const performers = [...new Set((feed.body?.data ?? []).map((x) => x.performed_by).filter(Boolean))];
      const foreign = performers.length ? Number(scalar(`SELECT COUNT(*) FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id
          WHERE u.id = ANY(ARRAY[${performers.map(lit).join(',')}]::uuid[])
            AND o.tenant_id <> (SELECT tenant_id FROM entity.organizations WHERE name=${lit(tb.org)} LIMIT 1)`)) : 0;
      console.log(`tenant B activity feed http=${feed.status} rows=${(feed.body?.data ?? []).length} foreign-performers=${foreign}`);
      logAction({ tool: TOOL, role: tb.stateKey, area: 'Activity feed', action: 'read own activity feed — no other tenant\'s users', method: 'GET', endpoint: '/activities', status: feed.status, outcome: outcomeOf(feed.status, foreign === 0), verified: foreign === 0 });
      if (foreign) fail('critical', tb.stateKey, 'Activity feed shows another tenant\'s users', 'Only own-tenant performers', `${foreign} foreign performer(s)`, '', 'Tenant-fence listActivities and file every activity under the performer\'s own org.');
    } finally { await s.close(); }
  }
}
