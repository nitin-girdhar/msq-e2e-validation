// Issue #3 regression — cross-org lead sub-resource writes.
//
// follow-ups / interactions carry their own org_id and DB triggers reject a row
// whose acting/assigned user has no active mapping to the lead's org. A platform
// super_admin (homed in one branch) or a tenant_admin acting on another branch's
// lead has no such mapping, so recording activity on a cross-org — especially an
// UNASSIGNED — lead raised inside the trigger and surfaced as a raw 500.
//
// The fix: iam.fn_actor_can_act_in_org accepts super_admin (any org) and
// tenant_admin (own tenant), and effectiveInOrgActor attributes an unassigned
// cross-org write to the actor. A genuinely cross-org NON-admin still can't see
// the lead (single-org RLS) → clean 404, never 500.
//
// This forces the hard case: it picks a lead OUTSIDE super_admin's home org and
// temporarily clears its assignee, then asserts:
//   • super_admin / tenant_admin  create follow-up + interaction -> 2xx, row lands
//   • a cross-org non-admin (sales_head) -> a clean 4xx, never 5xx
// The assignee is restored and every created row is deleted by marker.
//
//   node suites/lms/crossorg-subresource-authority.mjs
import { record, roleMeta, APPS, authFile } from '../../lib.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, one, scalar, count, q, lit } from '../../db.mjs';
import fs from 'node:fs';

const TOOL = 'lms';
const LMS = APPS['lms-web'];
const stamp = Date.now();
const MARKER = `e2e-crossorg-${stamp}`;
const soon = new Date(Date.now() + 86_400_000).toISOString();

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

// super_admin's home org — leads outside it are cross-org for them.
const superHomeOrg = roleMeta('super_admin').org;
const superHomeOrgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(superHomeOrg)} LIMIT 1`);

// A non-deleted lead OUTSIDE super_admin's home org, in the SAME tenant (so
// tenant_admin can act on it too, and sales_head — homed in superHomeOrg — is
// cross-org to it).
const leadRow = one(`
  SELECT ml.id, ml.org_id, ml.assigned_user_id
  FROM lms.marketing_leads ml
  JOIN entity.organizations o    ON o.id = ml.org_id
  JOIN entity.organizations home ON home.id = ${lit(superHomeOrgId)}
  WHERE ml.org_id <> ${lit(superHomeOrgId)}
    AND o.tenant_id = home.tenant_id
    AND NOT ml.is_deleted
  ORDER BY ml.id LIMIT 1`);
if (!leadRow) { console.log('no cross-org lead found in the primary tenant — cannot run'); process.exit(0); }
const [leadId, leadOrgId, origAssignee] = leadRow;
console.log(`cross-org lead ${leadId} in org ${leadOrgId} (super_admin home ${superHomeOrgId})`);

const fuUrl  = `${LMS}/api/leads/${leadId}/follow-ups`;
const ixUrl  = `${LMS}/api/leads/${leadId}/interactions`;
let failures = 0;

const badIf500 = (role, kind, res) => {
  if (res.status >= 500) {
    failures++;
    record(TOOL, {
      severity: 'high', role, tool: TOOL, page: `cross-org ${kind}`,
      scenario: `${role} creates a ${kind} on an UNASSIGNED cross-org lead`,
      expected: 'A clean status — 2xx for platform/tenant admins (accepted by iam.fn_actor_can_act_in_org), or 4xx for a non-admin who can’t see the lead. Never a 5xx.',
      actual: `HTTP ${res.status} (raw server error — the FK-org-scope trigger raised).`,
      evidence: `lead=${leadId} org=${leadOrgId}; ${JSON.stringify(res.body).slice(0, 300)}`,
      proposedSolution: 'Ensure the FK-org-scope triggers authorize via iam.fn_actor_can_act_in_org and effectiveInOrgActor attributes unassigned cross-org writes to the actor.',
    });
    return true;
  }
  return false;
};

try {
  // Force the UNASSIGNED case — the one that used to 500. Setting assigned_user_id
  // NULL skips the lead trigger's user-scope branch, so this setup write is safe.
  q(`UPDATE lms.marketing_leads SET assigned_user_id = NULL WHERE id = ${lit(leadId)}`);

  // ── super_admin / tenant_admin must SUCCEED (2xx) ─────────────────────────
  for (const role of ['super_admin', 'tenant_admin']) {
    if (!fs.existsSync(authFile(role))) { console.log(`  skip ${role} (no auth state)`); continue; }
    const a = await actor(role);
    try {
      const fu = await apiPost(a, fuUrl, { scheduled_at: soon, notes: `${MARKER}-fu-${role}` });
      const ix = await apiPost(a, ixUrl, { notes: `${MARKER}-ix-${role}` });
      console.log(`  ${role.padEnd(13)} follow-up=${fu.status} interaction=${ix.status} (expect 2xx)`);

      const fu500 = badIf500(role, 'follow-up', fu);
      const ix500 = badIf500(role, 'interaction', ix);
      const fuRow = count('lms.lead_follow_ups', `notes=${lit(`${MARKER}-fu-${role}`)} AND org_id=${lit(leadOrgId)}`);
      const ixRow = count('lms.lead_interactions', `notes=${lit(`${MARKER}-ix-${role}`)} AND org_id=${lit(leadOrgId)}`);

      if (!fu500 && (fu.status < 200 || fu.status >= 300 || fuRow === 0)) {
        failures++;
        record(TOOL, {
          severity: 'high', role, tool: TOOL, page: 'cross-org follow-up',
          scenario: `${role} creates a follow-up on an unassigned cross-org lead`,
          expected: 'HTTP 2xx and a lead_follow_ups row stamped with the lead’s org',
          actual: `HTTP ${fu.status}, row-in-lead-org=${fuRow}`,
          evidence: `lead=${leadId} org=${leadOrgId}; ${JSON.stringify(fu.body).slice(0, 300)}`,
          proposedSolution: 'A platform/tenant admin must be able to record activity on any lead they can see; verify iam.fn_actor_can_act_in_org accepts their tier.',
        });
      }
      if (!ix500 && (ix.status < 200 || ix.status >= 300 || ixRow === 0)) {
        failures++;
        record(TOOL, {
          severity: 'high', role, tool: TOOL, page: 'cross-org interaction',
          scenario: `${role} logs an interaction on an unassigned cross-org lead`,
          expected: 'HTTP 2xx and a lead_interactions row stamped with the lead’s org',
          actual: `HTTP ${ix.status}, row-in-lead-org=${ixRow}`,
          evidence: `lead=${leadId} org=${leadOrgId}; ${JSON.stringify(ix.body).slice(0, 300)}`,
          proposedSolution: 'Same as follow-ups — attribute unassigned cross-org writes to the actor and accept the admin tier in the trigger.',
        });
      }
    } finally {
      await a.close();
    }
  }

  // ── a cross-org NON-admin must get a clean 4xx (never 5xx) ────────────────
  const nonAdmin = 'sales_head'; // homed in super_admin's home org → cross-org to leadOrgId
  if (fs.existsSync(authFile(nonAdmin))) {
    const a = await actor(nonAdmin);
    try {
      const fu = await apiPost(a, fuUrl, { scheduled_at: soon, notes: `${MARKER}-fu-${nonAdmin}` });
      console.log(`  ${nonAdmin.padEnd(13)} follow-up=${fu.status} (expect 4xx, e.g. 404/403)`);
      badIf500(nonAdmin, 'follow-up', fu);
    } finally {
      await a.close();
    }
  }
} finally {
  // Restore the lead's original assignee and remove every row this run created.
  q(`UPDATE lms.marketing_leads SET assigned_user_id = ${origAssignee ? lit(origAssignee) : 'NULL'} WHERE id = ${lit(leadId)}`);
  q(`DELETE FROM lms.lead_follow_ups   WHERE notes LIKE ${lit(`${MARKER}-%`)}`);
  q(`DELETE FROM lms.lead_interactions WHERE notes LIKE ${lit(`${MARKER}-%`)}`);
  console.log(`[cleanup] restored assignee on ${leadId} and deleted ${MARKER} rows.`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
