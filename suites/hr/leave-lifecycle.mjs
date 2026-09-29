// Leave lifecycle depth — beyond apply+approve.
//
// The existing suites cover "apply" and the two-approver race. They never prove
// the parts that actually move a balance: that APPROVING debits the ledger, that
// CANCELLING an approved leave credits it back, that REJECTING stores a comment
// and debits nothing, and that the business rules (overlap, self-approval) hold
// with a clean 4xx rather than a 500.
//
// Balance model (leave.service.ts): balance = SUM(hr.leave_ledger.amount).
// Approve appends a debit (negative); cancel appends the reversal (net 0).
//
// Actors: rep1 (sales_representative, FitClass-Gurgaon) requests; org_admin
// (rank 980, canOverrideLeaveApproval / can_approve_leave rank>=80) approves.
// Self-contained: seeds rep1 a casual balance, then purges every ledger/request
// row it created so the dev balance is left exactly as found.
//
//   node suites/hr/leave-lifecycle.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { leaveTypeFor, seedLeaveBalance } from '../../fixtures.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const LEAVE_TYPE = leaveTypeFor(roleMeta('sales_representative').email);
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('sales_representative').org)} LIMIT 1`);
const tenantId = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgId)}`);
const typeId = scalar(`SELECT id FROM hr.leave_types WHERE name=${lit(LEAVE_TYPE)} AND tenant_id=${lit(tenantId)}::uuid LIMIT 1`);
if (!repId || !orgId || !typeId) { console.log('Could not resolve rep1/org/leave_type — aborting'); process.exit(0); }

// A future window (past min_notice_days) so apply is accepted; single days.
const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
const DAY1 = d(21), DAY2 = d(22), DAY3 = d(28);

// Diagnostic console.log calls in this suite call these unconditionally
// (before any "did the request even get created" guard), so a failed apply
// (id === null) must return a harmless placeholder instead of running a
// WHERE id='null' query that psql rejects outright.
const statusOf = (id) => id ? scalar(
  `SELECT s.name FROM hr.leave_requests r JOIN hr.leave_request_statuses s ON s.id=r.status_id WHERE r.id=${lit(id)}`) : null;
const ledgerNet = (id) => id ? Number(scalar(`SELECT COALESCE(SUM(amount),0) FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`) ?? 0) : 0;
const ledgerRows = (id) => id ? Number(scalar(`SELECT COUNT(*) FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`) ?? 0) : 0;
const created = [];

function purge(id) {
  if (!id) return;
  q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_requests WHERE id=${lit(id)}`);
}
const idFrom = (body) => body?.data?.id ?? body?.id ?? body?.data?.request?.id ?? null;
const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: 'sales_representative', tool: TOOL, page: 'Leave lifecycle', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const rep = await actor('sales_representative');
const admin = await actor('hr_admin'); // holds hr.leave.approve; Fitclass org_admin has no HR caps
try {
  // ── Seed a casual balance so apply is never blocked by insufficient balance ──
  const seed = await apiPost(admin, `${HR}/api/hr/leave/adjustments`, {
    user_id: repId, leave_type_name: LEAVE_TYPE, amount: 5, note: `E2E-lifecycle-seed-${stamp}`,
  });
  console.log(`seed ${LEAVE_TYPE} +5 for rep1 -> http=${seed.status}`);
  // The adjustment endpoint is capability-gated per tenant; the balance is only a precondition here.
  if (seed.status >= 300) console.log(`  fallback DB seed: ${seedLeaveBalance(roleMeta('sales_representative').email, LEAVE_TYPE, 5, `E2E-lifecycle-seed-${stamp}`)} row`);

  // ── 1. APPLY ────────────────────────────────────────────────────────────────
  const apply = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: DAY1, end_date: DAY1, reason: `E2E-lifecycle-${stamp}`,
  });
  const reqId = idFrom(apply.body);
  if (reqId) created.push(reqId);
  console.log(`1. apply           http=${apply.status} status=${statusOf(reqId)} id=${reqId}`);
  if (!reqId || statusOf(reqId) !== 'pending') {
    fail('high', 'Apply for casual leave (1 day)', 'A pending leave_requests row is created',
      `HTTP ${apply.status}, status=${statusOf(reqId)}`, JSON.stringify(apply.body),
      'Confirm apply persists a pending request for a valid, in-balance, in-notice date.');
  }

  // ── 2. APPROVE → ledger must debit ───────────────────────────────────────────
  if (reqId) {
    const before = ledgerNet(reqId);
    const appr = await apiPost(admin, `${HR}/api/hr/leave/requests/${reqId}/approve`, { comment: 'ok' });
    const after = ledgerNet(reqId);
    const st = statusOf(reqId);
    console.log(`2. approve         http=${appr.status} status=${st} ledgerNet ${before}->${after} rows=${ledgerRows(reqId)}`);
    if (st !== 'approved') {
      fail('high', 'Approve a pending leave as org_admin', 'Status becomes approved',
        `HTTP ${appr.status}, status=${st}`, JSON.stringify(appr.body),
        'org_admin (rank>=80) must be able to approve an in-org request (hr.can_approve_leave).');
    } else if (!(after < before) && ledgerRows(reqId) === 0) {
      fail('high', 'Approving leave debits the balance ledger',
        'A negative hr.leave_ledger entry is appended for the approved request (balance decremented)',
        `ledger net stayed ${after} with ${ledgerRows(reqId)} rows`, `reqId=${reqId}`,
        'Append a leave_ledger debit of days_count on approval so the balance actually reflects taken leave.');
    }

    // ── 3. CANCEL an approved leave → ledger reversed (net 0) ───────────────────
    const cancel = await apiPost(rep, `${HR}/api/hr/leave/requests/${reqId}/cancel`, { comment: 'changed plans' });
    const net = ledgerNet(reqId);
    const st2 = statusOf(reqId);
    console.log(`3. cancel          http=${cancel.status} status=${st2} ledgerNet=${net}`);
    if (st2 !== 'cancelled') {
      fail('medium', 'Cancel an approved leave', 'Status becomes cancelled',
        `HTTP ${cancel.status}, status=${st2}`, JSON.stringify(cancel.body),
        'Allow the requester (or admin) to cancel an approved leave and set status=cancelled.');
    } else if (ledgerRows(reqId) > 0 && Math.abs(net) > 0.001) {
      fail('high', 'Cancelling an approved leave credits the balance back',
        'The ledger for the request nets to 0 (debit reversed) so the days return to the balance',
        `ledger net after cancel = ${net} (expected ~0)`, `reqId=${reqId}`,
        'On cancel of an APPROVED request, append the reversing credit so the employee is not charged for leave they did not take.');
    }
  }

  // ── 4. REJECT (separate request) → comment stored, no debit ──────────────────
  const apply2 = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: DAY3, end_date: DAY3, reason: `E2E-reject-${stamp}`,
  });
  const rejId = idFrom(apply2.body);
  if (rejId) created.push(rejId);
  if (rejId) {
    const rej = await apiPost(admin, `${HR}/api/hr/leave/requests/${rejId}/reject`, { comment: `E2E-reject-reason-${stamp}` });
    const st = statusOf(rejId);
    const debit = ledgerRows(rejId);
    console.log(`4. reject          http=${rej.status} status=${st} ledgerRows=${debit}`);
    if (st !== 'rejected') {
      fail('medium', 'Reject a pending leave with a comment', 'Status becomes rejected',
        `HTTP ${rej.status}, status=${st}`, JSON.stringify(rej.body),
        'Persist rejection status and the approver comment.');
    } else if (debit > 0) {
      fail('high', 'Rejecting leave must not debit the balance',
        'A rejected request appends no ledger debit', `ledger has ${debit} row(s) for a rejected request`, `reqId=${rejId}`,
        'Only debit on approval; a rejected request must leave the balance untouched.');
    }
    // reject with NO comment must be rejected by validation (comment is required).
    const apply3 = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
      leave_type_name: LEAVE_TYPE, start_date: DAY2, end_date: DAY2, reason: `E2E-nocomment-${stamp}`,
    });
    const nc = idFrom(apply3.body); if (nc) created.push(nc);
    if (nc) {
      const bad = await apiPost(admin, `${HR}/api/hr/leave/requests/${nc}/reject`, {});
      console.log(`   reject w/o comment http=${bad.status} (expect 4xx)`);
      if (bad.status < 400 || bad.status >= 500) {
        fail('low', 'Reject without a comment', 'A missing comment is a clean 4xx validation error',
          `HTTP ${bad.status}`, JSON.stringify(bad.body),
          'Keep the "comment required to reject" validation returning 400/422, never a 500 or a silent success.');
      }
    }
  }

  // ── 5. OVERLAP business rule — a second open request on a taken day → 4xx ─────
  const oa = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: d(40), end_date: d(42), reason: `E2E-overlap-base-${stamp}`,
  });
  const baseId = idFrom(oa.body); if (baseId) created.push(baseId);
  const ob = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: d(41), end_date: d(41), reason: `E2E-overlap-dup-${stamp}`,
  });
  const dupId = idFrom(ob.body); if (dupId) created.push(dupId);
  console.log(`5. overlap         base=${oa.status} overlapping=${ob.status} (expect overlapping 4xx)`);
  if (ob.status >= 200 && ob.status < 300) {
    fail('medium', 'Apply for a leave that overlaps an existing open request',
      'The overlapping request is rejected (409/422) — the exclusion constraint forbids two open requests on the same day',
      `overlapping apply returned HTTP ${ob.status} (accepted)`, JSON.stringify(ob.body),
      'Detect the overlap (or the exclusion-constraint violation) and return a clean 409, not a second open request.');
  } else if (ob.status >= 500) {
    fail('medium', 'Overlap rejection error shape',
      'An overlapping request is a clean 4xx', `HTTP ${ob.status} (raw server error leaked)`, JSON.stringify(ob.body),
      'Map the exclusion-constraint violation to 409 Conflict instead of surfacing a 500.');
  }

  // ── 6. SELF-APPROVAL guard — requester cannot approve own request ────────────
  const sa = await apiPost(rep, `${HR}/api/hr/leave/requests`, {
    leave_type_name: LEAVE_TYPE, start_date: d(60), end_date: d(60), reason: `E2E-selfapprove-${stamp}`,
  });
  const saId = idFrom(sa.body); if (saId) created.push(saId);
  if (saId) {
    const self = await apiPost(rep, `${HR}/api/hr/leave/requests/${saId}/approve`, { comment: 'me' });
    console.log(`6. self-approve    http=${self.status} status=${statusOf(saId)} (expect 403, not approved)`);
    if ((self.status >= 200 && self.status < 300) || statusOf(saId) === 'approved') {
      fail('high', 'A requester approves their own leave',
        'Self-approval is forbidden (403) — hr.can_approve_leave returns FALSE when approver = requester',
        `HTTP ${self.status}, status=${statusOf(saId)}`, JSON.stringify(self.body),
        'Enforce the approver != requester rule server-side for every approval path.');
    }
  }
} finally {
  await rep.close();
  await admin.close();
  // ── Cleanup: purge every request + ledger row this run created, and the seed ──
  for (const id of created) purge(id);
  q(`DELETE FROM hr.leave_ledger WHERE note LIKE ${lit(`%E2E-lifecycle-seed-${stamp}%`)}`);
  console.log(`\ncleaned up ${created.length} leave request(s) + seed for stamp ${stamp}.`);
}
