// Bulk lead assignment — NEW in msq-lms since the last e2e pass (folded into
// the 00b6a35/3da9d20/375e359 "bug fixes" range; nav entry 'bulk-assign' added
// to apps/lms-web/src/config/navigation.ts under CAPABILITY.LMS_LEADS_ASSIGN_BULK).
// POST /assignments/bulk (lead_ids: 1..500 UUIDs, assigned_to: 1 UUID) has THREE
// independent guards stacked in assignments.service.ts bulkAssignLeads, each
// with its own failure shape — worth proving separately so a future refactor
// that collapses them doesn't silently widen who can bulk-move leads:
//   1. actorRank >= LMS_RANKS.SSE (40)               → else 403, capability check alone is not enough
//   2. targetRank <= LMS_RANKS.SSE (40)               → "stricter than canAssignToUser": bulk can ONLY
//                                                        target individual contributors, even if the actor
//                                                        outranks a manager they'd otherwise be allowed to assign to
//   3. every lead + the target must share ONE org_id  → else 400 "must belong to the same org" /
//                                                        "assignee must belong to the org the leads live in"
// Plus: previousAssigneeByLead feeds the activity log's action_type
// (assignment_created vs assignment_reassigned) — verified against
// lms.lead_activity_log, not just the HTTP response.
//
// Actors: org_admin (LMS rank 980 on this mixed scale, well above SSE) bulk-
// assigns; sales_representative (rank 20, target-only) proves the actor-rank
// floor; org_manager (rank 60, target-too-senior) proves the target-rank cap.
//
//   node suites/lms/bulk-assign.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';

const TOOL = 'lms';
const LMS = APPS['lms-web'];
const URL = `${LMS}/api/assignments/bulk`;
const ACTOR_ROLE = 'org_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgName = roleMeta(ACTOR_ROLE)?.org ?? 'FitClass - Gurgaon';
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
if (!orgId || !repId) { console.log('Could not resolve org/rep1 — aborting'); process.exit(0); }

// Two leads in-org, currently NOT assigned to rep1 (so a real reassignment happens).
const candidateLeads = rows(
  `SELECT id, assigned_user_id FROM lms.marketing_leads
     WHERE org_id=${lit(orgId)} AND NOT is_deleted AND (assigned_user_id IS NULL OR assigned_user_id <> ${lit(repId)})
     ORDER BY created_at DESC LIMIT 2`, ['id', 'assigned_user_id']);
// A lead from a DIFFERENT org, for the cross-org guard.
const otherOrgLead = rows(
  `SELECT ml.id FROM lms.marketing_leads ml
     WHERE ml.org_id <> ${lit(orgId)} AND NOT ml.is_deleted LIMIT 1`, ['id'])[0];

if (candidateLeads.length < 2) { console.log('Not enough leads in org to bulk-assign — aborting'); process.exit(0); }
const leadIds = candidateLeads.map((r) => r.id);
const priorAssignees = new Map(candidateLeads.map((r) => [r.id, r.assigned_user_id]));

const assignedTo = (id) => scalar(`SELECT assigned_user_id FROM lms.marketing_leads WHERE id=${lit(id)}`);
// The assignment trail lives in lms.lead_assignment_log (action: initial |
// reassigned | unassigned | self_assigned); lms.lead_activity_log no longer exists.
const activityFor = (id, action, to) => scalar(
  `SELECT COUNT(*) FROM lms.lead_assignment_log WHERE lead_id=${lit(id)} AND action=${lit(action)}
     AND assigned_to_id=${lit(to)} AND assigned_at > now() - interval '10 minutes'`);

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: ACTOR_ROLE, tool: TOOL, page: 'Bulk Assign', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const admin = await actor(ACTOR_ROLE);
const rep = await actor('sales_representative');
try {
  // ── 1. Actor-rank floor — sales_representative (rank 20 < SSE 40) denied ─────
  const lowRank = await apiPost(rep, URL, { lead_ids: leadIds, assigned_to: repId });
  console.log(`1. actor rank floor (sales_rep)  http=${lowRank.status} (expect 403)`);
  if (lowRank.status !== 403) {
    fail('high', 'sales_representative (rank 20) attempts a bulk assignment',
      'Denied 403 — bulk-assign requires actorRank >= LMS_RANKS.SSE, not just the capability grant',
      `HTTP ${lowRank.status}`, JSON.stringify(lowRank.body),
      'Keep the explicit actorRank < LMS_RANKS.SSE guard in bulkAssignLeads independent of capability gating.');
  }

  // ── 2. Target-rank cap — bulk-assigning TO org_manager (rank 60 > SSE 40) ────
  const mgrId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('org_manager').email)} LIMIT 1`)
    ?? scalar(`SELECT u.id FROM iam.users u JOIN iam.user_org_mapping uom ON uom.user_id=u.id
                 JOIN iam.user_roles ur ON ur.id=uom.role_id WHERE uom.org_id=${lit(orgId)} AND ur.name='org_manager' LIMIT 1`);
  if (mgrId) {
    const tooSenior = await apiPost(admin, URL, { lead_ids: leadIds, assigned_to: mgrId });
    console.log(`2. target rank cap (org_manager) http=${tooSenior.status} (expect 403)`);
    if (tooSenior.status !== 403) {
      fail('medium', 'org_admin bulk-assigns leads TO an org_manager (rank 60 > SSE 40)',
        'Denied 403 — bulk assignment is capped at individual contributors regardless of actor authority',
        `HTTP ${tooSenior.status}`, JSON.stringify(tooSenior.body),
        'Keep targetRank > LMS_RANKS.SSE rejected even when the actor could single-assign to that person via canAssignToUser.');
    }
  } else {
    console.log('2. target rank cap — skipped, no org_manager user resolvable');
  }

  // ── 3. Cross-org guard — one lead from a different org in the same batch ─────
  if (otherOrgLead) {
    const crossOrg = await apiPost(admin, URL, { lead_ids: [...leadIds, otherOrgLead.id], assigned_to: repId });
    console.log(`3. cross-org batch               http=${crossOrg.status} (expect 4xx)`);
    if (crossOrg.status >= 200 && crossOrg.status < 300) {
      fail('critical', 'Bulk-assign a batch mixing leads from two different orgs',
        'Rejected 400 — "All selected leads must belong to the same org"',
        `HTTP ${crossOrg.status}`, JSON.stringify(crossOrg.body),
        'Enforce the single-org invariant before any row is updated (orgIds.size > 1 check in bulkAssignLeads).');
    }
    // Same-org batch but assignee belongs to a DIFFERENT org than the leads.
    const outsideAssignee = scalar(`SELECT assigned_user_id FROM lms.marketing_leads WHERE id=${lit(otherOrgLead.id)}`);
    if (outsideAssignee) {
      const wrongOrgAssignee = await apiPost(admin, URL, { lead_ids: leadIds, assigned_to: outsideAssignee });
      console.log(`   assignee from other org        http=${wrongOrgAssignee.status} (expect 4xx)`);
      if (wrongOrgAssignee.status >= 200 && wrongOrgAssignee.status < 300) {
        fail('critical', 'Bulk-assign in-org leads to a user from a DIFFERENT org',
          'Rejected 400 — "the assignee must belong to the org the leads live in"',
          `HTTP ${wrongOrgAssignee.status}`, JSON.stringify(wrongOrgAssignee.body),
          'Compare targetUser.org_id against the leads\' org_id before assigning — do not trust the caller\'s org context alone.');
      }
    }
  } else {
    console.log('3. cross-org batch — skipped, no lead in a second org resolvable');
  }

  // ── 4. Happy path — org_admin bulk-assigns 2 in-org leads to rep1 ────────────
  const before = leadIds.map((id) => ({ id, prior: priorAssignees.get(id) }));
  const ok = await apiPost(admin, URL, { lead_ids: leadIds, assigned_to: repId });
  const allAssigned = leadIds.every((id) => assignedTo(id) === repId);
  console.log(`4. happy path bulk-assign         http=${ok.status} allAssigned=${allAssigned}`);
  if (!(ok.status >= 200 && ok.status < 300) || !allAssigned) {
    fail('high', 'org_admin bulk-assigns 2 in-org leads to a Senior Sales Executive-or-below target',
      'HTTP 2xx and every lead\'s marketing_leads.assigned_user_id updates to the target',
      `HTTP ${ok.status}, allAssigned=${allAssigned}`, JSON.stringify(ok.body).slice(0, 300),
      'A valid same-org, in-rank bulk assignment must succeed for all leads in the batch (all-or-nothing update).');
  } else {
    for (const { id, prior } of before) {
      const expectedAction = prior ? 'reassigned' : 'initial';
      const logged = Number(activityFor(id, expectedAction, repId) ?? 0) > 0;
      if (!logged) {
        fail('low', `Activity log entry for a bulk-assigned lead (prior assignee=${prior ?? 'none'})`,
          `An lms.lead_assignment_log row with action=${expectedAction}`,
          `No matching activity row found for lead ${id}`, `leadId=${id}`,
          'Confirm logActivity is awaited (Promise.all(updated.map(...))) for every lead in the batch, not just the first.');
      }
    }
  }
} finally {
  await admin.close();
  await rep.close();
  // Restore prior assignees exactly as found.
  for (const { id, assigned_user_id } of candidateLeads) {
    q(`UPDATE lms.marketing_leads SET assigned_user_id=${assigned_user_id ? lit(assigned_user_id) : 'NULL'} WHERE id=${lit(id)}`);
  }
  console.log(`\nrestored prior assignees for ${candidateLeads.length} lead(s).`);
}
