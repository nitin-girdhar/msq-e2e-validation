// Team / user-management CONTRACTS — the rules added since the last pass.
//
// user-management.mjs proves the basic create/edit/reset round trip. This
// covers what changed after it was written, each rule verified in Postgres:
//
//   c2fba5e  canonical lowercase emails     -> Mixed.Case@X is stored lowercase;
//                                              a case-variant duplicate is 409.
//   1.4x     multi-branch create (org_assignments + role_id per branch)
//            -> cannot grant a role above your own rank via role_id (403);
//               cannot name a branch or a role of ANOTHER tenant (4xx).
//   044f345  Team edit keeps manager       -> a PATCH that omits manager_id
//                                              leaves the reporting line alone.
//            PATCH returns 200 { hr_profile_synced } and hr.employee_profiles
//            follows the identity row (home branch + active flag).
//            email is read-only in the UI  -> probe whether the API agrees.
//            super_admin ?tenant_id= honoured for SA ONLY; users outside the
//            administered tenant 404.
//   ranks    reset-password on a HIGHER-ranked user is refused (account
//            takeover) — probed against a throwaway victim, never a real admin.
//   picker   role-catalog never offers a role above the caller; manager
//            candidates / weights never reach another tenant or branch.
//
// All users are throwaway (@e2e.local) and purged FK-aware at the end.
//
//   node suites/admin/team-user-contracts.mjs
import { roleMeta, GATEWAY, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar, one, lit } from '../../db.mjs';
import { finder, isOk, idsOf, purgeE2eUsers, e2eMarker } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'admin';
const fail = finder(TOOL, 'Team / user management contracts');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const MARK = e2eMarker('team');
const U = `${GATEWAY}/users`;
const email = (who) => `${MARK}-${who}@e2e.local`;
const userBy = (em) => one(`SELECT id, email, org_id, manager_id, role_id, is_active FROM iam.users WHERE lower(email)=lower(${lit(em)})`);
const idOf = (em) => userBy(em)?.[0] ?? null;
const roleOfUser = (em) => scalar(`SELECT role_id FROM iam.users WHERE email=${lit(em)}`);
const rankOfRole = (rid) => Number(scalar(`SELECT rank FROM iam.user_roles WHERE id=${lit(rid)}`) ?? -1);

const orgA = scalar(`SELECT org_id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgA)}`);
const orgAdminId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const repRole = roleOfUser(roleMeta('sales_representative').email);
const tenantAdminRole = roleOfUser(roleMeta('tenant_admin').email);
const orgAdminRole = roleOfUser(roleMeta('org_admin').email);
const bActor = CROSS_TENANT[0];
const orgB = bActor ? scalar(`SELECT org_id FROM iam.users WHERE email=${lit(bActor.email)}`) : null;
const tenantB = orgB ? scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgB)}`) : null;
const roleB = bActor ? roleOfUser(bActor.email) : null;
const userInB = orgB ? scalar(`SELECT id FROM iam.users WHERE org_id=${lit(orgB)} AND NOT is_deleted LIMIT 1`) : null;
if (!orgA || !repRole) { console.log('Could not resolve tenant-A fixtures — aborting'); process.exit(0); }

const body = (who, over = {}) => ({
  first_name: 'E2E', last_name: who.slice(0, 40), email: email(who),
  org_assignments: [{ org_id: orgA, role_id: repRole }], home_org_id: orgA,
  send_email_notification: false, ...over,
});

const admin = await actor('org_admin');
const sa = fs.existsSync(authFile('super_admin')) ? await actor('super_admin') : null;
const mgr = fs.existsSync(authFile('org_manager')) ? await actor('org_manager') : null;
const rep = await actor('sales_representative');

try {
  // ── 1. Canonical lowercase email + case-insensitive duplicate ─────────────
  const mixed = `${MARK}-Mixed.CASE@E2E.Local`;
  const c1 = await apiPost(admin, U, body('x', { email: mixed }));
  const stored = scalar(`SELECT email FROM iam.users WHERE lower(email)=lower(${lit(mixed)})`);
  console.log(`1. create Mixed.Case email http=${c1.status} stored=${stored}`);
  if (!isOk(c1.status)) {
    fail('high', 'org_admin', 'Create a team member with org_assignments (multi-branch create)', '201 and a new iam.users row', `HTTP ${c1.status}`, JSON.stringify(c1.body).slice(0, 300), 'Check createUser/resolveAssignments for this payload; org_admin must be able to add a sales rep to their own branch.');
  } else if (stored !== mixed.toLowerCase()) {
    fail('high', 'org_admin', 'Emails are stored in canonical lowercase', `iam.users.email = ${mixed.toLowerCase()}`, `stored as ${stored}`, 'chk_users_email_lowercase', 'Parse the body with emailInputSchema (trim + lowercase) on every write path, incl. lookup-admin create.');
  }
  const dup = await apiPost(admin, U, body('x', { email: mixed.toUpperCase() }));
  const dupCount = Number(scalar(`SELECT COUNT(*) FROM iam.users WHERE lower(email)=lower(${lit(mixed)})`));
  console.log(`   duplicate (UPPER) http=${dup.status} rows=${dupCount} (expect 409, 1 row)`);
  if (dupCount > 1) fail('critical', 'org_admin', 'Two accounts for one email differing only by case', 'Exactly one iam.users row per canonical email', `${dupCount} rows`, mixed, 'Normalize before insert and keep a unique index on the canonical email; a second account per address splits identity and login.');
  else if (dup.status !== 409) fail('medium', 'org_admin', 'Case-variant duplicate email is not a clean 409', '409 "A user with this email already exists."', `HTTP ${dup.status}`, JSON.stringify(dup.body).slice(0, 200), 'mapUniqueViolation should translate the unique-index error to ConflictError.');

  // ── 2. Escalation via role_id, cross-tenant branch / role ─────────────────
  const probes = [
    ['grant tenant_admin role (rank above org_admin)', 'esc', { org_assignments: [{ org_id: orgA, role_id: tenantAdminRole }] }, 'critical', 403],
    orgB && ['place the user in ANOTHER TENANT\'s branch', 'xorg', { org_assignments: [{ org_id: orgB, role_id: repRole }], home_org_id: orgB }, 'critical', 400],
    roleB && roleB !== repRole && ['assign a role owned by ANOTHER TENANT', 'xrole', { org_assignments: [{ org_id: orgA, role_id: roleB }] }, 'critical', 400],
  ].filter(Boolean);
  for (const [label, who, over, sev] of probes) {
    if (!over.org_assignments[0].role_id) continue;
    const r = await apiPost(admin, U, body(who, over));
    const made = idOf(email(who));
    console.log(`2. org_admin ${label}: http=${r.status} created=${!!made}`);
    if (made || isOk(r.status)) fail(sev, 'org_admin', `org_admin can ${label} via POST /users org_assignments`, '403/400 and no row', `HTTP ${r.status}, row created=${!!made}`, JSON.stringify(r.body).slice(0, 200), 'resolveAssignments must reject any org_id/role_id outside the actor\'s tenant and any role with rank > actor rank BEFORE writing.');
    else if (r.status >= 500) fail('high', 'org_admin', `POST /users trying to ${label} 5xxs`, '4xx', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Throw BadRequest/Forbidden from resolveAssignments; do not let the FK/trigger error surface.');
  }

  // ── 3. Edit keeps manager; PATCH contract; HR profile follows ─────────────
  const subjectEmail = email('subject');
  const cs = await apiPost(admin, U, body('subject', { manager_id: orgAdminId }));
  const subjectId = idOf(subjectEmail);
  if (subjectId) {
    const profile = () => one(`SELECT org_id, is_active::text FROM hr.employee_profiles WHERE user_id=${lit(subjectId)}`);
    const p0 = profile();
    console.log(`3. subject created http=${cs.status} manager=${userBy(subjectEmail)?.[3] === orgAdminId} hrProfile=${!!p0}`);
    if (!p0) fail('medium', 'org_admin', 'Team create syncs an HR employee profile', 'hr.employee_profiles row for the new member (identity-service -> hr-service /internal/employees/sync)', 'no profile row', `user=${subjectId}; response=${JSON.stringify(cs.body).slice(0, 150)}`, 'Check the hr-service internal sync endpoint and that createUser surfaces hr_profile_synced=false when it fails.');
    else if (p0[0] !== orgA) fail('medium', 'org_admin', 'HR profile branch does not match the identity home branch', `hr.employee_profiles.org_id = ${orgA}`, `org_id=${p0[0]}`, subjectId, 'syncHrProfile must pass the home org.');

    const e1 = await apiPatch(admin, `${U}/${subjectId}`, { first_name: 'E2E-renamed' });
    const afterMgr = userBy(subjectEmail)?.[3];
    console.log(`   PATCH name only http=${e1.status} body.hr_profile_synced=${e1.body?.data?.hr_profile_synced} manager kept=${afterMgr === orgAdminId}`);
    if (afterMgr !== orgAdminId) fail('high', 'org_admin', 'Editing a member without touching the manager clears the reporting line', `manager_id stays ${orgAdminId}`, `manager_id=${afterMgr}`, subjectId, 'updateUser must only write manager_id when the key is present; the EditUserModal fix (044f345) is client-side — keep the server from nulling on omission too.');
    if (isOk(e1.status) && e1.status !== 200) fail('low', 'org_admin', 'PATCH /users/:id response contract', '200 { data: { hr_profile_synced } } (044f345 changed it from 204)', `HTTP ${e1.status}`, JSON.stringify(e1.body).slice(0, 150), 'Return the documented body so the modal can warn when the HR sync failed.');

    const off = await apiPatch(admin, `${U}/${subjectId}`, { is_active: false });
    const p1 = profile();
    console.log(`   PATCH is_active=false http=${off.status} hrProfile.is_active=${p1?.[1]}`);
    if (isOk(off.status) && p1 && p1[1] === 'true') fail('medium', 'org_admin', 'Deactivating a member leaves their HR profile active', 'hr.employee_profiles.is_active follows iam.users.is_active', 'profile still active', subjectId, 'Pass isActiveAfter to syncHrProfile on every update path (incl. the multi-branch branch).');

    const newEmail = email('changed');
    const em = await apiPatch(admin, `${U}/${subjectId}`, { email: newEmail });
    const emailNow = userBy(newEmail) ? newEmail : subjectEmail;
    console.log(`   PATCH email http=${em.status} changed=${emailNow === newEmail}`);
    if (emailNow === newEmail) fail('low', 'org_admin', 'Email is read-only in Team edit, but the API still changes it', 'Either the API refuses email on PATCH /users/:id, or the UI restriction is documented as cosmetic', 'PATCH { email } changed iam.users.email', subjectId, 'Confirm intent: if email is an identity key that must not change from Team, drop `email` from updateUserSchema (or gate it to tenant-wide roles).');

    // ── 4. reset-password against a HIGHER-ranked throwaway ────────────────
    if (sa) {
      const victimEmail = email('victim');
      await apiPost(sa, U, body('victim', { org_assignments: [{ org_id: orgA, role_id: orgAdminRole }] }));
      const victimId = idOf(victimEmail);
      const before = victimId ? scalar(`SELECT password_hash FROM iam.users WHERE id=${lit(victimId)}`) : null;
      for (const [who, a] of [['sales_representative', rep], ['org_manager', mgr]].filter(([, x]) => x && victimId)) {
        const r = await apiPost(a, `${U}/${victimId}/reset-password`, { new_password: `E2e!${Date.now()}Aa`, send_email_notification: false, force_password_change: false });
        const changed = scalar(`SELECT password_hash FROM iam.users WHERE id=${lit(victimId)}`) !== before;
        console.log(`4. ${who} resets an org_admin-ranked user's password http=${r.status} changed=${changed}`);
        if (changed || isOk(r.status)) fail('critical', who, `${who} resets the password of a HIGHER-ranked user`, '403 You cannot manage a user with a higher role', `HTTP ${r.status}, hash changed=${changed}`, `victim=${victimId}`, 'resetPassword must call canManageUser(actorRank, targetRank) before hashing; this is an account-takeover path.');
      }
      if (!victimId) console.log('4. (could not create victim as super_admin — skipped)');
    }
  } else {
    console.log('3. could not create the subject user — edit contracts skipped');
  }

  // ── 5. ?tenant_id= is super_admin only ─────────────────────────────────────
  if (tenantB) {
    const r = await apiGet(admin, `${U}?tenant_id=${tenantB}&page_size=100`);
    const leaked = idsOf(r.body).filter((id) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.id=${lit(id)}`) === tenantB);
    console.log(`5. org_admin GET /users?tenant_id=B http=${r.status} tenantB rows=${leaked.length}`);
    if (leaked.length) fail('critical', 'org_admin', 'Non-super-admin reads another tenant\'s users via ?tenant_id=', 'The parameter is ignored (own tenant) or refused (403) below super_admin', `${leaked.length} tenant-B user(s) returned`, JSON.stringify(leaked.slice(0, 3)), 'resolveTargetScope must honour tenant_id only when rank >= SUPER_ADMIN.');
    if (sa) {
      const s1 = await apiGet(sa, `${U}?tenant_id=${tenantB}&page_size=100`);
      const sIds = idsOf(s1.body);
      const notB = sIds.filter((id) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.id=${lit(id)}`) !== tenantB);
      const outside = await apiGet(sa, `${U}/${orgAdminId}?tenant_id=${tenantB}`);
      console.log(`   super_admin ?tenant_id=B http=${s1.status} rows=${sIds.length} notB=${notB.length}; tenant-A user under B -> ${outside.status} (expect 404)`);
      if (!isOk(s1.status)) fail('medium', 'super_admin', 'super_admin cannot list users of an administered tenant', '2xx with that tenant\'s users', `HTTP ${s1.status}`, JSON.stringify(s1.body).slice(0, 200), 'lookup-admin Users depends on ?tenant_id= for super_admin (044f345).');
      if (notB.length) fail('high', 'super_admin', '?tenant_id=B returns users from other tenants', 'Only tenant B users', `${notB.length} foreign rows`, JSON.stringify(notB.slice(0, 3)), 'Pin the query to the administered tenant.');
      if (isOk(outside.status)) fail('medium', 'super_admin', 'A user outside the administered tenant is served under ?tenant_id=', '404 (userBelongsToTenant)', `HTTP ${outside.status}`, orgAdminId, 'resolveTargetScope must 404 users outside the selected tenant.');
    }
  }

  // ── 6. Pickers never cross the actor's ceiling / tenant ────────────────────
  for (const [who, a] of [['org_manager', mgr], ['org_admin', admin]].filter(([, x]) => x)) {
    const cat = await apiGet(a, `${U}/role-catalog`);
    const list = Array.isArray(cat.body?.data) ? cat.body.data : (cat.body?.data?.roles ?? []);
    const myRank = roleMeta(who)?.rank ?? 0;
    const above = list.filter((r) => Number(r.rank ?? rankOfRole(r.id)) > myRank);
    console.log(`6. ${who} role-catalog http=${cat.status} roles=${list.length} aboveOwnRank=${above.length}`);
    if (above.length) fail('medium', who, 'Role catalog offers roles above the caller\'s own rank', `Only roles with rank <= ${myRank}`, above.map((r) => `${r.name ?? r.id}(${r.rank})`).join(', '), '', 'getRoleCatalog must filter by canGrantRole(actorRank, role.rank) — the create call will 403 anyway, so the UI is offering dead options.');
    if (orgB) {
      const mc = await apiGet(a, `${U}/manager-candidates?org_id=${orgB}`);
      const bIds = idsOf(mc.body);
      if (isOk(mc.status) && bIds.length) fail('critical', who, 'manager-candidates lists another tenant\'s users', '400 Branch not found in this tenant', `${bIds.length} users of tenant B`, JSON.stringify(bIds.slice(0, 3)), 'getManagerCandidates must resolve org_id inside the actor\'s tenant first.');
      const w = await apiGet(a, `${U}/assignment-weights?org_id=${orgB}`);
      if (isOk(w.status) && idsOf(w.body).length) fail('critical', who, 'assignment-weights readable for another tenant\'s branch', '403/400', `HTTP ${w.status}`, JSON.stringify(w.body).slice(0, 200), 'getAssignmentWeights must reject org ids outside the tenant (and outside coverage for branch-scoped roles).');
    }
  }
  if (subjectId && tenantB) {
    const typeB = scalar(`SELECT id FROM marketing.campaign_types WHERE tenant_id=${lit(tenantB)} LIMIT 1`);
    const typeA = scalar(`SELECT id FROM marketing.campaign_types WHERE tenant_id=${lit(tenantA)} LIMIT 1`);
    for (const [label, w, sev] of [
      ['weight above 100', { user_id: subjectId, campaign_type_id: typeA, weight: 101 }, 'medium'],
      typeB && ['a campaign type of ANOTHER tenant', { user_id: subjectId, campaign_type_id: typeB, weight: 10 }, 'critical'],
    ].filter(Boolean)) {
      if (!w.campaign_type_id) continue;
      const put = await admin.request.put(`${U}/assignment-weights`, { data: { weights: [w] }, failOnStatusCode: false });
      const st = put.status();
      console.log(`7. PUT assignment-weights with ${label} http=${st} (expect 4xx)`);
      if (st >= 200 && st < 300) fail(sev, 'org_admin', `PUT /users/assignment-weights accepts ${label}`, '400', `HTTP ${st}`, JSON.stringify(w), 'updateAssignmentWeights must validate 0..100 and that every campaign_type_id belongs to the actor\'s tenant (the DB trigger fn_assert_weight_type_tenant is the backstop, not the gate).');
      else if (st >= 500) fail('high', 'org_admin', `PUT /users/assignment-weights with ${label} 5xxs`, '400', `HTTP ${st}`, JSON.stringify(w), 'Validate before writing so the trigger exception never surfaces.');
    }
  }
} finally {
  for (const a of [admin, sa, mgr, rep]) if (a) await a.close();
  const purged = purgeE2eUsers(`${MARK}-%@e2e.local`);
  console.log(`\npurged throwaway users: ${JSON.stringify(purged)}`);
}
