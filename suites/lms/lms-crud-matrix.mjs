// LMS functional CRUD, exercised as EVERY role.
//
// Fills the biggest gap in the harness: lead CREATE, follow-up create/edit,
// interaction logging, and API-token management were never tested at all, and
// what write coverage existed ran as ~6 hardcoded roles. Each action below runs
// through the full 19-role ladder and is graded against the capability that
// guards it in leads.router.ts, so both privilege escalation and broken-for-a-
// legitimate-user show up.
//
// Every created row is tracked and soft-deleted at the end.
//
//   node suites/lms/lms-crud-matrix.mjs
import { APPS, roleMeta, cfg } from '../../lib.mjs';
import { apiPost, apiPatch } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'lms';
const LMS = APPS['lms-web'];
const GATEWAY = cfg.gateway;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const orgName = roleMeta('org_admin').org;           // FitClass - Gurgaon
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
const createdLeads = [];

// A lead every role can be pointed at for follow-up/interaction tests.
const sharedLeadId = scalar(
  `SELECT id FROM lms.marketing_leads WHERE org_id=${lit(orgId)} AND is_active AND NOT is_deleted ORDER BY created_at DESC LIMIT 1`
);
console.log(`org=${orgName} sharedLead=${sharedLeadId}\n`);

// ── 1. CREATE LEAD — guarded by LMS_LEADS_CREATE ───────────────────────────
// Sales ladder from rep (20) upward creates leads; read_only (0) must not.
console.log('— create lead (LMS_LEADS_CREATE) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a new lead', endpoint: 'POST /api/leads', minRank: 20,
  area: 'Leads', tab: null,
  act: (a, role) => apiPost(a, `${LMS}/api/leads`, {
    first_name: 'E2E', last_name: `Create-${role}-${stamp}`,
    phone: `+9198${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    email: `e2e.${role}.${stamp}@example.test`,
  }),
  verify: (role) => {
    const id = scalar(`SELECT id FROM lms.marketing_leads WHERE last_name=${lit(`Create-${role}-${stamp}`)} LIMIT 1`);
    if (id) createdLeads.push(id);
    return !!id;
  },
});

// ── 2. LOG INTERACTION — guarded by LMS_LEADS_INTERACTION_LOG ──────────────
console.log('\n— log interaction (LMS_LEADS_INTERACTION_LOG) —');
if (sharedLeadId) {
  await runRoleMatrix({
    tool: TOOL, action: 'log an interaction on an existing lead',
    endpoint: 'POST /api/leads/:id/interactions', minRank: 20,
    area: 'Leads', tab: 'Timeline / Interactions',
    act: (a, role) => apiPost(a, `${LMS}/api/leads/${sharedLeadId}/interactions`, {
      interaction_type: 'call', notes: `E2E interaction ${role} ${stamp}`,
    }),
    verify: (role) => Number(scalar(
      `SELECT COUNT(*) FROM lms.lead_interactions WHERE lead_id=${lit(sharedLeadId)} AND notes LIKE ${lit(`%${role} ${stamp}%`)}`
    ) ?? 0) > 0,
  });
}

// ── 3. CREATE FOLLOW-UP — guarded by LMS_FOLLOWUPS_CREATE ──────────────────
console.log('\n— create follow-up (LMS_FOLLOWUPS_CREATE) —');
if (sharedLeadId) {
  const due = new Date(Date.now() + 7 * 864e5).toISOString();
  await runRoleMatrix({
    tool: TOOL, action: 'create a follow-up on a lead',
    endpoint: 'POST /api/leads/:id/follow-ups', minRank: 20,
    area: 'Follow-ups', tab: null,
    act: (a, role) => apiPost(a, `${LMS}/api/leads/${sharedLeadId}/follow-ups`, {
      scheduled_at: due, notes: `E2E follow-up ${role} ${stamp}`,
    }),
    verify: (role) => Number(scalar(
      `SELECT COUNT(*) FROM lms.lead_follow_ups WHERE lead_id=${lit(sharedLeadId)} AND notes LIKE ${lit(`%${role} ${stamp}%`)}`
    ) ?? 0) > 0,
  });
}

// ── 4. TRANSFER / REASSIGN LEAD — guarded by LMS_LEADS_TRANSFER ────────────
// Reassignment is a manager-and-up action (org_manager rank 60).
console.log('\n— transfer lead (LMS_LEADS_TRANSFER) —');
const repUserId = scalar(`SELECT id FROM iam.users WHERE email=${lit(cfg.secondaryActors.find((a) => a.actor === 'rep2').email)} LIMIT 1`);
if (sharedLeadId && repUserId) {
  const originalAssignee = scalar(`SELECT COALESCE(assigned_user_id::text,'') FROM lms.marketing_leads WHERE id=${lit(sharedLeadId)}`);
  await runRoleMatrix({
    tool: TOOL, action: 'transfer/reassign a lead to another user',
    endpoint: 'POST /api/leads/:id/transfer', minRank: 60,
    area: 'Assignments', tab: null,
    act: (a) => apiPost(a, `${LMS}/api/leads/${sharedLeadId}/transfer`, { to_user_id: repUserId }),
    verify: () => scalar(`SELECT COALESCE(assigned_user_id::text,'') FROM lms.marketing_leads WHERE id=${lit(sharedLeadId)}`) === repUserId,
    cleanup: () => {
      if (originalAssignee) q(`UPDATE lms.marketing_leads SET assigned_user_id=${lit(originalAssignee)}::uuid WHERE id=${lit(sharedLeadId)}`);
      else q(`UPDATE lms.marketing_leads SET assigned_user_id=NULL WHERE id=${lit(sharedLeadId)}`);
    },
  });
}

// ── 5. API TOKENS — admin-only surface (/dashboard/api-clients) ────────────
// NOTE: this page talks to the GATEWAY (`${GATEWAY_URL}/api-clients`), not the
// lms-web origin — see components/api-clients/*.tsx. Rows land in iam.api_clients.
// Only super/tenant/org admin reach that page, so anything lower succeeding is
// a privilege escalation on a credential-issuing endpoint: grade it critical.
console.log('\n— create API client/token (admin-only, via gateway) —');
await runRoleMatrix({
  tool: TOOL, action: 'create an API client/token (issues an integration credential)',
  endpoint: 'POST {gateway}/api-clients',
  area: 'API Tokens', tab: null,
  minRank: 980, severityOver: 'critical',
  act: (a, role) => apiPost(a, `${GATEWAY}/api-clients`, { name: `E2E-token-${role}-${stamp}` }),
  verify: (role) => Number(scalar(
    `SELECT COUNT(*) FROM iam.api_clients WHERE name=${lit(`E2E-token-${role}-${stamp}`)}`
  ) ?? 0) > 0,
});

// ── cleanup ────────────────────────────────────────────────────────────────
for (const id of createdLeads) {
  q(`UPDATE lms.marketing_leads SET is_deleted=TRUE, is_active=FALSE WHERE id=${lit(id)}`);
}
q(`DELETE FROM lms.lead_interactions WHERE notes LIKE ${lit(`%${stamp}%`)}`);
q(`DELETE FROM lms.lead_follow_ups WHERE notes LIKE ${lit(`%${stamp}%`)}`);
// Any credential this run managed to issue must not be left usable.
q(`DELETE FROM iam.api_client_orgs WHERE api_client_id IN (SELECT id FROM iam.api_clients WHERE name LIKE ${lit(`E2E-token-%${stamp}`)})`);
q(`DELETE FROM iam.api_clients WHERE name LIKE ${lit(`E2E-token-%${stamp}`)}`);
console.log(`\ncleaned up ${createdLeads.length} lead(s) + interactions/follow-ups + api tokens for stamp ${stamp}.`);
