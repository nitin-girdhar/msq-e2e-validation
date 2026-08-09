// Regularization backdate window — NEW in msq-hrms since the last e2e pass
// (8a8e235 "feat: hirerchy fix and regularization configurable"). Product
// itself only ships manual .bru probes for this
// (api-testing/HR-Attendance/Create-Regularization-{Future,Too-Old}.bru,
// Update-Rules-Admin-Tenant-Scope.bru) — nothing runs them in CI. This suite
// automates the same three rules end-to-end:
//
//   - FUTURE date is always rejected (hard rule, NOT configurable — widening
//     regularization_max_backdate_days does not help)
//   - Backdate window is per-org CONFIGURABLE
//     (hr.attendance_rules.regularization_max_backdate_days, default 30,
//     capped 0..365 by schema); a date older than the window → 400 naming the
//     earliest acceptable date
//   - Writing the TENANT-WIDE default row (PUT .../rules/admin {scope:
//     'tenant'}) requires platform_role tenant_admin/super_admin —
//     HR_ATTENDANCE_ADMIN_RULES_UPDATE alone (which org_admin/hr_head hold) is
//     NOT enough, since it changes what every OTHER org inherits
//
// Actors: org_admin (rank 980, in-org rules authority) narrows the window and
// requests as rep1's approver; rep1 (sales_representative) files the
// regularizations; super_admin proves the tenant-scope write that org_admin
// must be denied. Self-cleaning: restores the org's rules row exactly as
// found (snapshotted via GET before any write).
//
//   node suites/hr/regularization-window.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPut } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
const REG_URL = `${HR}/api/hr/attendance/regularizations`;
const RULES_URL = `${HR}/api/hr/attendance/rules/admin`;
const REQUESTER = 'sales_representative';
const ADMIN = 'org_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const reqId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
if (!reqId) { console.log('Could not resolve rep1 — aborting'); process.exit(0); }

const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
const regRowId = (workDate) => scalar(
  `SELECT id FROM hr.attendance_regularizations WHERE user_id=${lit(reqId)} AND work_date=${lit(workDate)}
     AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`);

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: REQUESTER, tool: TOOL, page: 'Attendance rules > Regularization window', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const rep = await actor(REQUESTER);
const admin = await actor(ADMIN);
const sa = await actor('super_admin');
const usedDates = [];
let snapshot = null;
try {
  // ── 0. Snapshot the org's current rules so we can restore them exactly ───────
  const cur = await apiGet(admin, RULES_URL);
  snapshot = cur.body?.data ?? cur.body ?? null;
  if (!snapshot || typeof snapshot.regularization_max_backdate_days !== 'number') {
    console.log('Could not read current admin rules — aborting'); process.exit(0);
  }
  console.log(`0. snapshot current rules  backdate=${snapshot.regularization_max_backdate_days} approvalLevels=${snapshot.regularization_approval_levels}`);

  // ── 1. FUTURE date → 400, not configurable ────────────────────────────────────
  const future = d(30);
  const f = await apiPost(rep, REG_URL, { work_date: future, requested_status_name: 'present', reason: `E2E-future-${stamp}` });
  console.log(`1. future date (${future}) http=${f.status} (expect 4xx)`);
  if (f.status >= 200 && f.status < 300) {
    usedDates.push(future);
    fail('high', 'File a regularization for a future work_date', 'Rejected 400 — a day that has not happened cannot be corrected',
      `HTTP ${f.status}`, JSON.stringify(f.body),
      'Enforce workDate <= orgToday unconditionally in regularizationWindowError, independent of the configurable backdate window.');
  } else if (f.status >= 500) {
    fail('medium', 'Future-date rejection error shape', 'Clean 4xx', `HTTP ${f.status}`, JSON.stringify(f.body),
      'Map the future-date validation to 400, not a raw 500.');
  }

  // ── 2. Narrow the window to 5 days ────────────────────────────────────────────
  const narrow = { ...snapshot, regularization_max_backdate_days: 5 };
  delete narrow.org_id; delete narrow.created_at; delete narrow.updated_at; delete narrow.id;
  const setNarrow = await apiPut(admin, RULES_URL, narrow);
  console.log(`2. set backdate=5          http=${setNarrow.status}`);

  // ── 3. Within the 5-day window → accepted ─────────────────────────────────────
  const within = d(-3);
  const w = await apiPost(rep, REG_URL, { work_date: within, requested_status_name: 'present', reason: `E2E-within-${stamp}` });
  usedDates.push(within);
  const idW = regRowId(within);
  console.log(`3. within window (${within}) http=${w.status} id=${idW} (expect accepted)`);
  if (!idW) {
    fail('medium', 'File a regularization inside the (narrowed) 5-day backdate window', 'A pending regularization row is created',
      `HTTP ${w.status}`, JSON.stringify(w.body),
      'Confirm the window check accepts a workDate within [today-5, today] once regularization_max_backdate_days=5.');
  }

  // ── 4. Outside the 5-day window (10 days back) → 400 naming the earliest date ─
  const outside = d(-10);
  const o = await apiPost(rep, REG_URL, { work_date: outside, requested_status_name: 'present', reason: `E2E-outside-${stamp}` });
  usedDates.push(outside);
  const idO = regRowId(outside);
  const msg = JSON.stringify(o.body);
  const nameEarliest = /accepted for the last 5 day|on or after/i.test(msg);
  console.log(`4. outside window (${outside}) http=${o.status} id=${idO} namesEarliest=${nameEarliest} (expect 4xx, no row)`);
  if (idO || o.status < 400 || o.status >= 500) {
    fail('high', 'File a regularization older than the configured backdate window',
      'Rejected 400, no hr.attendance_regularizations row written',
      `HTTP ${o.status}, rowCreated=${!!idO}`, msg.slice(0, 300),
      'Enforce regularizationWindowError(workDate, rules) server-side before insert — not just a UI date-picker min.');
  } else if (!nameEarliest) {
    fail('low', 'Backdate-window rejection message', 'Names the earliest acceptable date so the UI can show it',
      `Message did not mention the window: ${msg.slice(0, 200)}`, `days=5`,
      'Keep the "only accepted for the last N day(s) - on or after <date>" message so the client can render the real bound.');
  }

  // ── 5. Tenant-scope write — org_admin denied, super_admin allowed ────────────
  const tenantAttempt = { ...narrow, scope: 'tenant' };
  const denied = await apiPut(admin, RULES_URL, tenantAttempt);
  console.log(`5. org_admin tenant-scope PUT http=${denied.status} (expect 403)`);
  if (denied.status !== 403) {
    fail('critical', 'org_admin writes the TENANT-WIDE attendance-rules default (scope: tenant)',
      'Denied 403 — only tenant_admin/super_admin may change what every OTHER org inherits',
      `HTTP ${denied.status}`, JSON.stringify(denied.body),
      'Keep isTenantHrAdmin(ctx.role) gating scope=tenant separately from HR_ATTENDANCE_ADMIN_RULES_UPDATE — the capability says "may configure attendance", not "may reconfigure siblings".');
  }
  const allowed = await apiPut(sa, RULES_URL, tenantAttempt);
  console.log(`   super_admin tenant-scope PUT http=${allowed.status} (expect 2xx)`);
  if (!(allowed.status >= 200 && allowed.status < 300)) {
    fail('medium', 'super_admin writes the tenant-wide attendance-rules default',
      'Accepted 2xx — a genuine tenant admin can set the default every unconfigured org inherits',
      `HTTP ${allowed.status}`, JSON.stringify(allowed.body),
      'Confirm isTenantHrAdmin recognises super_admin (platform_role) for the tenant-scope write.');
  }
} finally {
  // ── Restore: put the org's rules row back exactly as snapshotted (org scope) ──
  if (snapshot) {
    const restore = { ...snapshot };
    delete restore.org_id; delete restore.created_at; delete restore.updated_at; delete restore.id;
    await apiPut(admin, RULES_URL, restore).catch(() => {});
  }
  await rep.close();
  await admin.close();
  await sa.close();
  q(`DELETE FROM hr.attendance_regularizations WHERE user_id=${lit(reqId)} AND reason LIKE ${lit(`%${stamp}%`)}`);
  for (const wd of usedDates) q(`DELETE FROM hr.attendance_days WHERE user_id=${lit(reqId)} AND work_date=${lit(wd)}`);
  console.log(`\ncleaned up regularizations + restored org rules for stamp ${stamp}.`);
}
