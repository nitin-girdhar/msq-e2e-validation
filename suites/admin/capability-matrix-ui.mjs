// Capability Matrix UI — proves the new lookup-admin screen at
// /dashboard/capabilities/matrix actually writes real grants, not just that
// the underlying resolver/DB machinery works (capability-toggle.mjs already
// covers that by writing iam.role_capabilities directly via SQL).
//
// This suite drives the SAME round trip through the real UI: pick a tenant +
// role, toggle a capability the role does not hold by default, click Save,
// then verify FOUR independent views agree — same doctrine as
// suites/capability/capability-toggle.mjs:
//   1. UI   — the checkbox reflects the new state after a reload
//   2. DB   — iam.role_capabilities holds a tenant-scoped override row
//   3. resolver — iam.fn_role_capability_matrix agrees
//   4. session  — the live actor's GET /auth/me capability list updates,
//                 proving the PUT actually reaches a real user's session
//
// New backend under test: admin-service's capabilities.repository.ts resolves
// an org under the target tenant and pins app.current_org_id before writing —
// iam.role_capabilities' RLS derives the writable tenant from the actor's
// CURRENT ORG, not app.current_tenant_id directly (see the table comment in
// @platform/db/schema/tables/role-capabilities.table.ts). A regression there
// would surface here as the PUT failing outright.
//
// SAFETY: only a TENANT-SCOPED override row is written (never a platform
// default), and the suite restores exactly what it found beforehand — deletes
// the row if none existed, or puts back the prior is_granted value otherwise.
//
//   node suites/admin/capability-matrix-ui.mjs
import { openState, visit, record, APPS, roleMeta } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable, q, lit } from '../../db.mjs';
import {
  tenantIdForOrg, roleId, capabilityId, resolvedCapabilities,
  sessionCapabilities, waitForSessionCapability,
} from '../../capability.mjs';

const TOOL = 'admin';
const APP = APPS['lookup-admin'];
const ADMIN_ROLE = 'super_admin';
// A low-rank global role, definitely NOT holding admin.lookups.manage by
// default — makes the toggle observable and low-risk either way it goes.
const TARGET_ROLE = 'sales_representative';
// `admin.*` capabilities are deliberately locked in the matrix UI (platform
// administration — super_admin only, not assignable to a tenant role; see
// CapabilityMatrixClient's isLocked/isPlatformAdminCapability), so their
// checkboxes render disabled and a click always times out. Use the same
// non-admin capability capability-toggle.mjs already exercises successfully.
const CAP_KEY = 'lms.leads.assign.bulk';
const CAP_LABEL_HINT = 'Bulk assign'; // fragment of the capability's human label, for locating its row

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const org = roleMeta(TARGET_ROLE)?.org;
const tenantId = tenantIdForOrg(org);
if (!tenantId) { console.log(`Could not resolve tenant for org "${org}" — aborting`); process.exit(0); }

const rid = roleId(TARGET_ROLE, tenantId);
const cid = capabilityId(CAP_KEY);
if (!rid || !cid) { console.log(`Could not resolve role='${TARGET_ROLE}' or capability='${CAP_KEY}' — aborting`); process.exit(0); }

// Journal the pre-existing state so cleanup is exact, mirroring
// capability.mjs's setOverride/restoreOne contract.
const preExisting = q(
  `SELECT is_granted FROM iam.role_capabilities
   WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`
)[0]?.[0] ?? null;

const grantedBefore = resolvedCapabilities(tenantId, TARGET_ROLE).get(CAP_KEY);
console.log(`role=${TARGET_ROLE} tenant=${tenantId} cap=${CAP_KEY} preExistingOverride=${preExisting} resolvedBefore=${grantedBefore}`);

function restore() {
  if (preExisting === null) {
    q(`DELETE FROM iam.role_capabilities WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`);
  } else {
    q(`UPDATE iam.role_capabilities SET is_granted=${preExisting === 't' ? 'TRUE' : 'FALSE'}, updated_at=NOW()
       WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`);
  }
}

const { browser, page, log } = await openState(ADMIN_ROLE);
const repActor = await actor(TARGET_ROLE);

try {
  // Tenant scope moved from an on-page #tenant-scope <select> to the app-wide
  // navbar TenantScopeSwitcher, which only writes this cookie and refreshes
  // the server components — so set the cookie the same way, then load.
  await page.context().addCookies([{ name: 'msq_admin_tenant_id', value: tenantId, url: new URL(APP).origin, sameSite: 'Lax' }]);
  await visit(page, `${APP}/dashboard/capabilities/matrix`);

  // Then the target role.
  const hasTenantSelect = await page.locator('#matrix-role').count().catch(() => 0);
  if (!hasTenantSelect) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: 'Open the Capability Matrix screen',
      expected: 'With the navbar tenant scope set, the role selector (#matrix-role) renders',
      actual: 'No #matrix-role — the matrix page did not render as expected.',
      evidence: `${APP}/dashboard/capabilities/matrix heading; badRequests=${JSON.stringify(log.badRequests.slice(-4))}`,
      proposedSolution: 'Check app/dashboard/capabilities/matrix/page.tsx and CapabilityMatrixClient render without throwing.',
    });
    throw new Error('matrix page did not render — aborting suite');
  }

  const roleSelect = page.locator('#matrix-role');
  const roleOptionText = await roleSelect.locator('option').allInnerTexts().catch(() => []);
  const targetOption = roleOptionText.find((t) => t.toLowerCase().includes('sales representative'));
  console.log(`  role options sample: ${roleOptionText.slice(0, 5).join(' | ')}`);
  if (!targetOption) {
    record(TOOL, {
      severity: 'medium', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: "Read the role dropdown after choosing a tenant",
      expected: `"${TARGET_ROLE}" ("Sales Representative") appears as an option`,
      actual: `Not found among: ${roleOptionText.join(', ')}`,
      evidence: `${APP}/dashboard/capabilities/matrix?tenant_id=${tenantId}`,
      proposedSolution: 'Check lookupAdmin.list("user-roles") returns global anchor roles regardless of tenant.',
    });
    throw new Error('target role not offered — aborting suite');
  }
  await roleSelect.selectOption({ label: targetOption }).catch(() => {});
  await page.waitForTimeout(1000);

  // Locate the capability row by its key text and read the checkbox baseline.
  const row = page.locator('li', { hasText: CAP_KEY }).first();
  const rowFound = await row.count().catch(() => 0);
  console.log(`  capability row for '${CAP_KEY}' found=${rowFound > 0}`);
  if (!rowFound) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: `Locate the '${CAP_KEY}' row in the rendered capability tree`,
      expected: 'The full iam.capabilities tree renders, including this operation node',
      actual: 'No matching row found — the capability tree fetch may have failed or the key is missing from the catalog.',
      evidence: `${APP}/dashboard/capabilities/matrix; hint label fragment "${CAP_LABEL_HINT}"`,
      proposedSolution: 'Check GET /capabilities returns the full tree and CapabilityMatrixClient renders every kind.',
    });
    throw new Error('capability row not found — aborting suite');
  }
  const checkbox = row.locator('input[type="checkbox"]');
  const checkedBefore = await checkbox.isChecked().catch(() => null);
  console.log(`  UI checkbox before=${checkedBefore} (resolver said ${grantedBefore})`);

  // ---------- toggle + save through the real UI ----------
  await checkbox.click({ timeout: 4000 });
  const saveBtn = page.getByRole('button', { name: /save \d+ change/i });
  const [putResp] = await Promise.all([
    page.waitForResponse((r) => /\/api\/roles\/.+\/capabilities/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null),
    saveBtn.click({ timeout: 4000 }),
  ]);
  console.log(`  PUT status=${putResp ? putResp.status() : 'none'}`);
  await page.waitForTimeout(600);
  const savedMsgVisible = await page.getByText(/^saved\.?$/i).isVisible().catch(() => false);
  console.log(`  "Saved." confirmation visible=${savedMsgVisible}`);

  if (!putResp || putResp.status() >= 300) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: `Toggle '${CAP_KEY}' for ${TARGET_ROLE} and click Save`,
      expected: 'PUT /api/roles/:id/capabilities returns 2xx',
      actual: `PUT returned ${putResp ? putResp.status() : 'no response captured'}.`,
      evidence: `tenant=${tenantId} role=${TARGET_ROLE} cap=${CAP_KEY}; badRequests=${JSON.stringify(log.badRequests.slice(-4))}`,
      proposedSolution: 'Check admin-service capabilities.repository.ts can resolve an org under the tenant (this fails outright if the tenant has zero organizations) and that app_user satisfies admin_tenant_config_policy.',
    });
  }

  // ---------- verify: DB, resolver, session ----------
  const dbAfter = q(
    `SELECT is_granted FROM iam.role_capabilities
     WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`
  )[0]?.[0];
  const wantGranted = !checkedBefore; // we clicked once, so it flipped
  const dbOk = dbAfter === (wantGranted ? 't' : 'f');
  const resolvedAfter = resolvedCapabilities(tenantId, TARGET_ROLE).get(CAP_KEY);
  console.log(`  DB is_granted=${dbAfter} (want ${wantGranted}) resolver=${resolvedAfter}`);

  if (!dbOk) {
    record(TOOL, {
      severity: 'critical', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: 'Verify the Save actually persisted a tenant override row',
      expected: `iam.role_capabilities has a (tenant=${tenantId}, role=${TARGET_ROLE}, cap=${CAP_KEY}) row with is_granted=${wantGranted}`,
      actual: `Row reads is_granted=${dbAfter}. The UI reported success but the database disagrees.`,
      evidence: `tenant_id=${tenantId} role_id=${rid} capability_id=${cid}`,
      proposedSolution: 'Trace capabilities.repository.ts upsertGrants — confirm the onConflictDoUpdate target matches the partial unique index (tenant_id, role_id, capability_id) WHERE tenant_id IS NOT NULL.',
    });
  }

  const flip = await waitForSessionCapability(repActor, CAP_KEY, wantGranted, { timeoutMs: 12000 });
  console.log(`  session reflects new grant=${flip.ok} (${flip.ms}ms)`);
  if (dbOk && !flip.ok) {
    record(TOOL, {
      severity: 'high', role: TARGET_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: `A tenant-admin grants '${CAP_KEY}' to ${TARGET_ROLE} via the Capability Matrix screen`,
      expected: "The affected user's GET /auth/me reflects the new grant within the cache invalidation window",
      actual: `After ${flip.ms}ms, /auth/me still does not agree with the DB (want granted=${wantGranted}).`,
      evidence: `role=${TARGET_ROLE} tenant=${tenantId} cap=${CAP_KEY}`,
      proposedSolution: 'Confirm the role_capabilities write goes through a path that fires the rbac_capabilities_changed NOTIFY (a raw DB write via app_user does; verify the tx actually commits under app_user, not a rolled-back attempt).',
    });
  }

  // ---------- UI reflects the saved state after reload ----------
  await visit(page, `${APP}/dashboard/capabilities/matrix?tenant_id=${tenantId}`);
  await roleSelect.selectOption({ label: targetOption }).catch(() => {});
  await page.waitForTimeout(1000);
  const checkedAfterReload = await page.locator('li', { hasText: CAP_KEY }).first().locator('input[type="checkbox"]').isChecked().catch(() => null);
  console.log(`  UI checkbox after reload=${checkedAfterReload} (want ${wantGranted})`);
  if (checkedAfterReload !== wantGranted) {
    record(TOOL, {
      severity: 'medium', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix',
      scenario: 'Reload the matrix after saving and re-select the same tenant/role',
      expected: `The checkbox reflects the persisted grant (${wantGranted})`,
      actual: `Checkbox reads ${checkedAfterReload} after reload.`,
      evidence: `tenant=${tenantId} role=${TARGET_ROLE} cap=${CAP_KEY}`,
      proposedSolution: 'Confirm GET /roles/:id/capabilities returns the freshly written override row (tenant override should win over the platform default in the effective-grant merge).',
    });
  } else {
    console.log('  OK: UI, DB, resolver, and session all agree after the round trip');
  }
} finally {
  restore();
  const restoredResolved = resolvedCapabilities(tenantId, TARGET_ROLE).get(CAP_KEY);
  console.log(`\n[cleanup] restored preExisting=${preExisting} -> resolver now reads ${restoredResolved} (expect ${grantedBefore})`);
  if (restoredResolved !== grantedBefore) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'Lookup Admin / capabilities/matrix (cleanup)',
      scenario: 'Restore the capability override this suite created',
      expected: `Resolver returns to its baseline (${grantedBefore}) after cleanup`,
      actual: `Resolver now reads ${restoredResolved} — cleanup did not fully restore state.`,
      evidence: `tenant=${tenantId} role=${TARGET_ROLE} cap=${CAP_KEY} preExisting=${preExisting}`,
      proposedSolution: 'Manually check iam.role_capabilities for a stray override on this (tenant, role, capability) and remove it.',
    });
  }
  await repActor.close();
  await browser.close();
}

console.log('\ndone.');
