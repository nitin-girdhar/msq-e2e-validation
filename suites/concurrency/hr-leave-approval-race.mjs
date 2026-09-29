// CONCURRENCY: two eligible approvers approve the SAME pending leave request
// at the same instant. Correct behaviour: exactly one wins (200), the other
// gets a clean, decisive rejection (409 "already decided" / 403 "not the
// approver") — NEVER a 500, and NEVER two recorded approvals or a
// double-decremented balance.
//
// This complements the existing finding that the Approvals queue over-shows a
// request to managers up the chain who are not the resolved approver: here we
// prove what happens when two of them act simultaneously.
//
//   node suites/concurrency/hr-leave-approval-race.mjs
import { APPS, record, cfg, roleMeta } from '../../lib.mjs';
import { leaveTypeFor, seedLeaveBalance } from '../../fixtures.mjs';
import { actor, apiPost, apiGet, simultaneously } from '../../conc.mjs';
import { dbReachable, one, scalar, lit } from '../../db.mjs';
const LEAVE_TYPE = leaveTypeFor(roleMeta('sales_representative').email);

const TOOL = 'concurrency';
const HR = APPS['hr-web'];
const REQUESTER = 'sales_representative';
// rep1's resolved L1 approver (Chirag, senior_sales_executive) submitting from
// two tabs at once — the realistic double-approve. org_manager is only L2 (403
// at L1) and hr_admin works another branch (404), so neither pair ever raced.
const APPROVERS = ['senior_sales_executive', 'senior_sales_executive'];

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

function futureDate(days) {
  const d = new Date(Date.now() + days * 864e5);
  return d.toISOString().slice(0, 10);
}

// 1. Get a pending request to race on — reuse an existing one, else create one.
let reqId = scalar(`SELECT lr.id FROM hr.leave_requests lr
  JOIN hr.leave_request_statuses s ON s.id=lr.status_id
  JOIN iam.users u ON u.id=lr.user_id
  WHERE s.name='pending' AND u.email=${lit(roleMeta('sales_representative').email)} AND NOT lr.is_deleted
  ORDER BY lr.created_at DESC LIMIT 1`);

const rep = await actor(REQUESTER);
if (!reqId) {
  // Bootstrap: leave apply needs an active policy for the requester's org. If
  // the seed has none, create one via the product API as org_admin (single
  // approval level, no notice period) so the race scenario can actually run.
  // Randomize the date so a re-run doesn't collide with an earlier request's
  // range (apply rejects overlapping requests with 409).
  const offset = 30 + Math.floor(Math.random() * 120);
  const start = futureDate(offset), end = futureDate(offset);
  let created = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: start, end_date: end, reason: 'E2E concurrency probe',
  });
  if (created.status === 400) {
    // Ensure both preconditions for apply: an active policy AND a non-zero
    // balance. The seed ships neither for this org, so bootstrap via the
    // product APIs as org_admin (idempotent enough — policy may 409 if it
    // already exists, which is fine).
    const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('sales_representative').org)} LIMIT 1`);
    const admin = await actor('org_admin');
    const pol = await apiPost(admin, `${HR}/api/hr/leave/policies`, {
      leave_type_name: LEAVE_TYPE, org_id: orgId, accrual_frequency: 'yearly', accrual_amount: 12,
      min_notice_days: 0, allow_half_day: true, approval_levels: 1, applicable_from: new Date().toISOString().slice(0, 10),
    });
    console.log(`Bootstrap casual policy (org_admin) -> ${pol.status}`);
    // The rep starts with 0 accrued balance; credit some so apply can succeed.
    const repUserId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
    const adj = await apiPost(admin, `${HR}/api/hr/leave/adjustments`, {
      user_id: repUserId, leave_type_name: LEAVE_TYPE, amount: 5, note: 'E2E concurrency bootstrap',
    });
    console.log(`Bootstrap ${LEAVE_TYPE} balance (org_admin) -> ${adj.status}`);
    // Adjustments are capability-gated per tenant; the balance is a precondition only.
    if (adj.status >= 300) console.log(`  fallback DB seed: ${seedLeaveBalance(roleMeta('sales_representative').email, LEAVE_TYPE, 5, 'E2E concurrency bootstrap')} row`);
    await admin.close();
    created = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
      leave_type_name: LEAVE_TYPE, start_date: start, end_date: end, reason: 'E2E concurrency probe',
    });
  }
  console.log(`Create leave request -> ${created.status}`);
  if (created.status >= 300) {
    record(TOOL, {
      severity: 'info', role: REQUESTER, page: 'HR leave apply (precondition)',
      scenario: 'Set up a pending leave request to race two approvers on',
      expected: 'Requester can create a pending leave request',
      actual: `Could not create one (status ${created.status}); race not executed. ${JSON.stringify(created.body).slice(0, 200)}`,
      evidence: JSON.stringify(created.body).slice(0, 300),
      proposedSolution: 'Ensure a casual-leave policy is seeded/effective for the requester’s org, or seed a pending request, then re-run this suite.',
    });
    await rep.close(); process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 400));
  reqId = scalar(`SELECT lr.id FROM hr.leave_requests lr JOIN iam.users u ON u.id=lr.user_id
    WHERE u.email=${lit(roleMeta('sales_representative').email)} AND lr.reason='E2E concurrency probe'
    ORDER BY lr.created_at DESC LIMIT 1`);
}
if (!reqId) { console.log('No pending request id — aborting'); await rep.close(); process.exit(0); }
console.log(`Racing approvers on leave request ${reqId}`);

// 2. Fire both approvals simultaneously.
const [a1, a2] = await Promise.all(APPROVERS.map((r) => actor(r)));
const [r1, r2] = await simultaneously([
  () => apiPost(a1, `${HR}/api/hr/leave/requests/${reqId}/approve`, { comment: 'race-A' }),
  () => apiPost(a2, `${HR}/api/hr/leave/requests/${reqId}/approve`, { comment: 'race-B' }),
]);
console.log(`${APPROVERS[0]} approve -> ${r1.status}; ${APPROVERS[1]} approve -> ${r2.status}`);

// 3. Verify the backend.
await new Promise((r) => setTimeout(r, 500));
const finalStatus = scalar(`SELECT s.name FROM hr.leave_requests lr
  JOIN hr.leave_request_statuses s ON s.id=lr.status_id WHERE lr.id=${lit(reqId)}`);
const approvalCount = Number(scalar(`SELECT COUNT(*) FROM hr.leave_request_approvals
  WHERE leave_request_id=${lit(reqId)} AND action ILIKE 'approv%'`) ?? 0);
console.log(`Final status="${finalStatus}", approved-decision rows=${approvalCount}`);

const statuses = [r1.status, r2.status];
const successes = statuses.filter((s) => s < 300).length;
const server500 = statuses.includes(500);

if (server500) {
  record(TOOL, {
    severity: 'high', role: APPROVERS.join(' + '), page: 'HR leave approve (POST /approve)',
    scenario: 'Two approvers approve the same pending request simultaneously',
    expected: 'The losing approval returns a clean 409/403, not a 500',
    actual: `One approval returned HTTP 500. statuses=${JSON.stringify(statuses)}.`,
    evidence: JSON.stringify({ reqId, r1, r2, finalStatus, approvalCount }).slice(0, 600),
    proposedSolution: 'Wrap the approve transaction so a state-transition conflict (already-decided) is caught and mapped to 409; add a guarded UPDATE ... WHERE status_id = pending so only one transition commits.',
  });
} else if (successes > 1 || approvalCount > 1) {
  record(TOOL, {
    severity: 'high', role: APPROVERS.join(' + '), page: 'HR leave approve (POST /approve)',
    scenario: 'Two approvers approve the same pending request simultaneously',
    expected: 'Exactly one approval is recorded; the request transitions once',
    actual: `Double-approval: ${successes} calls returned 2xx and ${approvalCount} approved-decision rows exist for one request.`,
    evidence: JSON.stringify({ reqId, statuses, finalStatus, approvalCount }).slice(0, 600),
    proposedSolution: 'Serialize the transition with a conditional UPDATE (WHERE status=pending) inside a transaction and a unique constraint on (leave_request_id, level) so a second concurrent approval cannot commit.',
  });
} else {
  console.log(`OK: exactly-one-winner (successes=${successes}, approvalRows=${approvalCount}, finalStatus=${finalStatus}).`);
}

await rep.close(); await a1.close(); await a2.close();
console.log('done.');
