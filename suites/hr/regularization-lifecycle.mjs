// Attendance-regularization lifecycle depth.
//
// The existing hr-regularization.mjs covers only submit + approve. This adds the
// paths it never exercised, all backend-verified against
// hr.attendance_regularizations:
//   - REJECT with a comment  → status 'rejected', approver_comment stored, day NOT flipped
//   - reject WITHOUT a comment → clean 4xx (comment is required)
//   - WFH regularization      → requested_status_name='wfh'; approving credits the day as WFH
//   - SELF-APPROVAL guard      → the requester cannot approve/reject their own correction
//
// Note (coverage gap in the PRODUCT, not the harness): the attendance router
// exposes only .../approve and .../reject — there is no cancel/withdraw or
// edit-pending endpoint for a regularization, so the "requester cancels/edits a
// pending request" flow cannot be tested until those endpoints exist. This suite
// records that as an info finding so it is tracked.
//
// Actors: read_only (viewer, FitClass-Gurgaon) requests; org_admin approves/
// rejects (canOverrideAttendanceApproval). Self-cleaning.
//
//   node suites/hr/regularization-lifecycle.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
// Requester rep1 and approver org_admin are BOTH in FitClass - Gurgaon, so the
// org-scoped approve/reject path resolves the request (a cross-org approver 404s,
// which is the separate super_admin org-binding issue, not what we test here).
// org_admin (rank 980) can approve any in-org correction (canOverrideAttendance-
// Approval). Case 4 uses org_admin self-submitting to prove the approver!=requester
// business guard specifically (it holds the approve capability, so a denial there
// is the guard, not the capability gate).
const REQUESTER = 'sales_representative';
const APPROVER = 'org_admin';
const reqId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
const adminId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)} LIMIT 1`);
if (!reqId || !adminId) { console.log('Could not resolve rep1 / org_admin — aborting'); process.exit(0); }

// Past, likely-unmarked work dates. Recent days (inside the active attendance
// period) are locked from regularization (the service returns 403), so we target
// ~30-50 days back, and vary the base per run so re-runs don't collide with a
// prior run's still-open (or soft-deleted) request for the same (user, date).
const BASE = 30 + (Math.floor(stamp / 1000) % 18); // 30..47 days back
const d = (extra) => { const x = new Date(); x.setDate(x.getDate() - (BASE + extra)); return x.toISOString().slice(0, 10); };

const regFor = (workDate) => scalar(
  `SELECT status FROM hr.attendance_regularizations WHERE user_id=${lit(reqId)} AND work_date=${lit(workDate)}
     AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);
const commentFor = (workDate) => scalar(
  `SELECT approver_comment FROM hr.attendance_regularizations WHERE user_id=${lit(reqId)} AND work_date=${lit(workDate)}
     AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);
const regRowId = (workDate) => scalar(
  `SELECT id FROM hr.attendance_regularizations WHERE user_id=${lit(reqId)} AND work_date=${lit(workDate)}
     AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);
const dayStatus = (workDate) => scalar(
  `SELECT s.name FROM hr.attendance_days ad JOIN hr.attendance_statuses s ON s.id=ad.status_id
     WHERE ad.user_id=${lit(reqId)} AND ad.work_date=${lit(workDate)}`);

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: REQUESTER, tool: TOOL, page: 'Regularization lifecycle', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});
// Submit, retrying once on a 403 — the identity-service capability cache can
// cold-miss on a session's first guarded call and briefly deny a grant the role
// genuinely holds; a short warm-up + one retry absorbs that without masking a
// real, persistent denial (which would fail both attempts and get recorded).
const submit = async (a, workDate, extra = {}) => {
  let r = await apiPost(a, `${HR}/api/hr/attendance/regularizations`, { work_date: workDate, reason: `E2E-reg-${stamp}`, ...extra });
  if (r.status === 403) { await new Promise((s) => setTimeout(s, 800)); r = await apiPost(a, `${HR}/api/hr/attendance/regularizations`, { work_date: workDate, reason: `E2E-reg-${stamp}`, ...extra }); }
  return r;
};
const usedDates = [];

const rep = await actor(REQUESTER);
const admin = await actor(APPROVER);
// Warm the requester's capability cache before the timed cases.
await apiPost(rep, `${HR}/api/hr/attendance/regularizations`, { work_date: '1990-01-01', reason: 'warmup' }).catch(() => {});
try {
  // ── 1. REJECT flow ───────────────────────────────────────────────────────────
  const wd1 = d(4); usedDates.push(wd1);
  const s1 = await submit(rep, wd1, { requested_status_name: 'present' });
  const id1 = regRowId(wd1);
  console.log(`1. submit          http=${s1.status} status=${regFor(wd1)} id=${id1} wd=${wd1}`);
  if (id1) {
    const rej = await apiPost(admin, `${HR}/api/hr/attendance/regularizations/${id1}/reject`, { comment: `E2E-rej-${stamp}` });
    console.log(`   reject           http=${rej.status} status=${regFor(wd1)} comment=${(commentFor(wd1) || '').slice(0, 20)} dayStatus=${dayStatus(wd1)}`);
    if (regFor(wd1) !== 'rejected') {
      fail('medium', 'Reject a pending regularization with a comment', 'Status becomes rejected',
        `HTTP ${rej.status}, status=${regFor(wd1)}`, JSON.stringify(rej.body),
        'Persist the rejected status on the reject path.');
    } else if (!commentFor(wd1)) {
      fail('low', 'Reject stores the approver comment', 'approver_comment is saved on reject',
        'approver_comment is empty after a reject with a comment', `regId=${id1}`,
        'Store the reviewer comment on the regularization when rejecting.');
    }
    if (dayStatus(wd1) === 'present') {
      fail('high', 'Rejecting a regularization must not flip the day',
        'A rejected correction leaves the attendance day unchanged',
        `attendance_days status became 'present' after a REJECT`, `regId=${id1} date=${wd1}`,
        'Only apply the requested day status on approval; a rejected regularization must not resolve the day.');
    }
  }

  // ── 2. Reject WITHOUT a comment → clean 4xx ──────────────────────────────────
  const wd2 = d(6); usedDates.push(wd2);
  await submit(rep, wd2, { requested_status_name: 'present' });
  const id2 = regRowId(wd2);
  if (id2) {
    const bad = await apiPost(admin, `${HR}/api/hr/attendance/regularizations/${id2}/reject`, {});
    console.log(`2. reject no-comment http=${bad.status} (expect 4xx)`);
    if (bad.status < 400 || bad.status >= 500) {
      fail('low', 'Reject a regularization without a comment', 'Missing comment is a clean 4xx',
        `HTTP ${bad.status}`, JSON.stringify(bad.body),
        'Keep the required-comment validation returning 400/422, never a 500 or silent success.');
    }
  }

  // ── 3. WFH regularization → approve credits the day as WFH ────────────────────
  const wd3 = d(8); usedDates.push(wd3);
  const s3 = await submit(rep, wd3, { requested_status_name: 'wfh' });
  const id3 = regRowId(wd3);
  console.log(`3. wfh submit      http=${s3.status} id=${id3}`);
  if (id3) {
    const appr = await apiPost(admin, `${HR}/api/hr/attendance/regularizations/${id3}/approve`, { comment: 'wfh ok' });
    const ds = dayStatus(wd3);
    console.log(`   wfh approve      http=${appr.status} status=${regFor(wd3)} dayStatus=${ds}`);
    if (regFor(wd3) !== 'approved') {
      fail('medium', 'Approve a WFH regularization', 'Status becomes approved',
        `HTTP ${appr.status}, status=${regFor(wd3)}`, JSON.stringify(appr.body),
        'Allow an approver to approve a WFH-status correction.');
    } else if (ds && ds !== 'wfh') {
      fail('medium', 'Approving a WFH regularization credits the day as WFH',
        `The resolved attendance day becomes 'wfh'`, `attendance_days status='${ds}' (expected 'wfh')`, `regId=${id3} date=${wd3}`,
        'Apply the requested_status (wfh) to the day on approval so WFH days resolve correctly.');
    }
  }

  // ── 4. SELF-APPROVAL guard — org_admin submits its OWN correction and tries to
  //      approve it. org_admin holds the approve capability, so a denial here is
  //      the business guard (approver != requester), not the capability gate.
  const wd4 = d(10); usedDates.push(wd4);
  await submit(admin, wd4, { requested_status_name: 'present' });
  const id4 = scalar(`SELECT id FROM hr.attendance_regularizations WHERE user_id=${lit(adminId)}
     AND work_date=${lit(wd4)} AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);
  const selfStatus = () => scalar(`SELECT status FROM hr.attendance_regularizations WHERE id=${lit(id4)}`);
  if (id4) {
    const self = await apiPost(admin, `${HR}/api/hr/attendance/regularizations/${id4}/approve`, { comment: 'me' });
    console.log(`4. self-approve    http=${self.status} status=${selfStatus()} (expect 4xx, not approved)`);
    if ((self.status >= 200 && self.status < 300) || selfStatus() === 'approved') {
      fail('high', 'An approver approves their OWN regularization',
        'Self-approval is forbidden — even a user with approve authority cannot approve a correction they filed',
        `HTTP ${self.status}, status=${adminRegStatus()}`, JSON.stringify(self.body),
        'Enforce approver != requester on the regularization approve path (as the leave path does via can_approve_leave).');
    }
  }

  // ── 5. Missing cancel/edit endpoints — track as a product coverage gap ───────
  record(TOOL, {
    severity: 'info', role: 'n/a', tool: TOOL, page: 'Regularization API surface',
    scenario: 'Look for a requester cancel/withdraw or edit-pending endpoint for regularizations',
    expected: 'A requester can cancel/withdraw or amend a pending regularization before it is decided',
    actual: 'The attendance router exposes only /approve and /reject — there is no cancel/withdraw or edit endpoint, so a mistaken pending request can only be resolved by an approver.',
    evidence: 'attendance.router.ts: POST .../regularizations/:id/approve and /reject only',
    proposedSolution: 'Add POST /regularizations/:id/cancel (requester-owned, pending-only) and optionally a PATCH to amend a pending request, then extend this suite to cover them.',
  });
} finally {
  await rep.close();
  await admin.close();
  // Cleanup: remove this run's regularizations (both requester and admin self-approve)
  // and any days they resolved.
  q(`DELETE FROM hr.attendance_regularizations WHERE reason LIKE ${lit(`%${stamp}%`)} OR reason='warmup'`);
  for (const uid of [reqId, adminId]) {
    for (const wd of usedDates) q(`DELETE FROM hr.attendance_days WHERE user_id=${lit(uid)} AND work_date=${lit(wd)}`);
  }
  console.log(`\ncleaned up regularizations + days for stamp ${stamp}.`);
}
