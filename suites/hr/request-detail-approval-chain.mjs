// Leave / regularization "detail" modal — NEW in msq-hrms since the last e2e
// pass (73c69cd "HRMS - new modal to show leave stats, pending on etc.").
// Adds GET /leave/requests/:id and GET /attendance/regularizations/:id, each
// returning the full multi-level approval_chain (level, approver, action,
// acted_at, comment) plus a derived pending_with. Neither existed before —
// zero harness coverage.
//
// Both are explicitly OWN-scope endpoints: gated on the plain view capability
// (HR_LEAVE_VIEW / HR_ATTENDANCE_VIEW), not an approver capability, because
// "ownership is enforced in the repository query" (router comment) — the
// WHERE clause pins user_id = ctx.user_id. That means even the assigned
// APPROVER gets a 404 calling this endpoint for someone else's request (they
// have a separate team/approvals list for that). This suite's sharpest case is
// exactly that: proving the shared-capability shortcut didn't accidentally
// turn into an IDOR by asserting an approver, not just a stranger, is shadow-
// 404'd off another user's request via this endpoint.
//
// Also exercises the resolveApprovers(tx, orgId, tenantId, ...) call sites
// this same commit touched (added the tenant_id param) — a signature change
// that would break the chain fetch entirely if a call site were missed, which
// approval_chain.length > 0 below would catch immediately.
//
// Actors: rep1 (sales_representative) requests; org_admin approves AND stands
// in as "an approver who is not the owner" for the negative case.
//
//   node suites/hr/request-detail-approval-chain.mjs
import { APPS, record, roleMeta, HR_EMPLOYEE } from '../../lib.mjs';
import { leaveTypeFor, seedLeaveBalance } from '../../fixtures.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';
const LEAVE_TYPE = leaveTypeFor(roleMeta(HR_EMPLOYEE).email);

const TOOL = 'hr';
const HR = APPS['hr-web'];
const REQUESTER = HR_EMPLOYEE;
// rep1's L2 approver in the reporting line, holding hr.leave.view + approve
// (org_admin holds no HR capability in Fitclass, so it 403'd at the route gate).
const APPROVER = 'org_manager';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta(HR_EMPLOYEE).email)} LIMIT 1`);
if (!repId) { console.log('Could not resolve rep1 — aborting'); process.exit(0); }

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: REQUESTER, tool: TOOL, page: 'Leave/Regularization detail modal', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const rep = await actor(REQUESTER);
const approver = await actor(APPROVER);
let leaveId = null;
let regId = null;
try {
  // ── LEAVE detail ───────────────────────────────────────────────────────────
  const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
  seedLeaveBalance(roleMeta(REQUESTER).email, LEAVE_TYPE, 2, `E2E-detail-seed-${stamp}`);
  const apply = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: d(25), end_date: d(25), reason: `E2E-detail-${stamp}`,
  });
  leaveId = apply.body?.data?.id ?? apply.body?.id ?? null;
  console.log(`1. apply leave     http=${apply.status} id=${leaveId}`);

  if (leaveId) {
    const own = await apiGet(rep, `${HR}/api/hr/leave/requests/${leaveId}`);
    const chain = own.body?.data?.approval_chain;
    const pendingWith = own.body?.data?.pending_with;
    console.log(`2. own leave detail http=${own.status} chainLen=${chain?.length} pendingWith=${JSON.stringify(pendingWith)}`);
    if (own.status !== 200 || !Array.isArray(chain) || chain.length === 0) {
      fail('high', 'Requester fetches their own leave-request detail', 'HTTP 200 with a non-empty approval_chain',
        `HTTP ${own.status}, chain=${JSON.stringify(chain)}`, JSON.stringify(own.body).slice(0, 300),
        'Confirm resolveApprovers(tx, orgId, tenantId, ...) — note the tenant_id param this commit added — is threaded through every call site so the chain is actually populated.');
    } else if (!pendingWith || pendingWith.approver_id !== chain[0].approver_id) {
      fail('medium', 'pending_with reflects the first pending approval level',
        'pending_with matches the chain entry whose action=pending',
        `pending_with=${JSON.stringify(pendingWith)}, chain[0]=${JSON.stringify(chain[0])}`, `leaveId=${leaveId}`,
        'Derive pending_with from chain.find(s => s.action === "pending"), not a stale/hardcoded level-1 assumption.');
    }

    // Ownership / IDOR: the APPROVER (who legitimately acts on this request via
    // the approvals list) must still get 404 hitting the OWN-scope detail route
    // for someone else's request — that authority lives on a different endpoint.
    const asApprover = await apiGet(approver, `${HR}/api/hr/leave/requests/${leaveId}`);
    console.log(`3. approver fetches rep's own-detail http=${asApprover.status} (expect 404)`);
    if (asApprover.status !== 404) {
      fail('high', 'An approver (not the owner) calls GET /leave/requests/:id for someone else\'s request',
        '404 — this route is scoped to e.user_id = ctx.user_id, approval authority does not grant read access here',
        `HTTP ${asApprover.status}`, JSON.stringify(asApprover.body).slice(0, 300),
        'Keep the WHERE user_id = ctx.user_id clause in getOwnRequestDetail; do not widen this route to approvers — use the team/approvals list for that.');
    }

    // Approve → chain flips to approved, pending_with clears (single-level policy).
    const appr = await apiPost(approver, `${HR}/api/hr/leave/requests/${leaveId}/approve`, { comment: `E2E-approve-${stamp}` });
    const after = await apiGet(rep, `${HR}/api/hr/leave/requests/${leaveId}`);
    const afterChain = after.body?.data?.approval_chain ?? [];
    const afterPending = after.body?.data?.pending_with;
    const step0 = afterChain[0];
    console.log(`4. approve+refetch http=${appr.status} step0=${JSON.stringify(step0)} pendingWith=${JSON.stringify(afterPending)}`);
    if (step0?.action !== 'approved' || !step0?.acted_at || step0?.comment !== `E2E-approve-${stamp}`) {
      fail('medium', 'Approval chain entry updates on approve', 'action=approved, acted_at set, comment stored',
        `step0=${JSON.stringify(step0)}`, `leaveId=${leaveId}`,
        'Update the matching hr.leave_request_approvals row (action/acted_at/comment) when a level is decided.');
    }
    if (afterPending !== null && afterPending !== undefined) {
      fail('low', 'pending_with clears once every level is decided', 'pending_with is null after the final approval',
        `pending_with=${JSON.stringify(afterPending)}`, `leaveId=${leaveId}`,
        'pending_with should be null once chain.find(action===pending) finds nothing.');
    }
  }

  // ── REGULARIZATION detail (same shape, separate table/router) ────────────────
  const wd = d(-15);
  const sub = await apiPost(rep, `${HR}/api/hr/attendance/regularizations`, {
    work_date: wd, requested_status_name: 'present', reason: `E2E-regdetail-${stamp}`,
  });
  regId = scalar(`SELECT id FROM hr.attendance_regularizations WHERE user_id=${lit(repId)} AND work_date=${lit(wd)}
     AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);
  console.log(`5. submit regularization http=${sub.status} id=${regId}`);

  if (regId) {
    const own = await apiGet(rep, `${HR}/api/hr/attendance/regularizations/${regId}`);
    const chain = own.body?.data?.approval_chain;
    console.log(`6. own reg detail  http=${own.status} chainLen=${chain?.length}`);
    if (own.status !== 200 || !Array.isArray(chain) || chain.length === 0) {
      fail('high', 'Requester fetches their own regularization detail', 'HTTP 200 with a non-empty approval_chain',
        `HTTP ${own.status}, chain=${JSON.stringify(chain)}`, JSON.stringify(own.body).slice(0, 300),
        'Same fix as the leave-side: thread ctx.tenant_id through resolveApprovers on the regularization submit path too.');
    }
    const asApprover = await apiGet(approver, `${HR}/api/hr/attendance/regularizations/${regId}`);
    console.log(`7. approver fetches rep's own-detail http=${asApprover.status} (expect 404)`);
    if (asApprover.status !== 404) {
      fail('high', 'An approver (not the owner) calls GET /attendance/regularizations/:id for someone else\'s request',
        '404 — same own-scope rule as the leave detail route', `HTTP ${asApprover.status}`,
        JSON.stringify(asApprover.body).slice(0, 300),
        'Keep the WHERE user_id = ctx.user_id clause in getOwnRegularizationDetail.');
    }
  }
} finally {
  await rep.close();
  await approver.close();
  if (leaveId) {
    q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(leaveId)}`);
    q(`DELETE FROM hr.leave_ledger WHERE note=${lit(`E2E-detail-seed-${stamp}`)}`);
    q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(leaveId)}`);
    q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(leaveId)}`);
    q(`DELETE FROM hr.leave_requests WHERE id=${lit(leaveId)}`);
  }
  if (regId) {
    q(`DELETE FROM hr.attendance_regularization_approvals WHERE regularization_id=${lit(regId)}`);
    q(`DELETE FROM hr.attendance_regularizations WHERE id=${lit(regId)}`);
  }
  console.log(`\ncleaned up leave/regularization detail-modal test data for stamp ${stamp}.`);
}
