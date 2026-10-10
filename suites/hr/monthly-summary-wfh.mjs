// Attendance monthly summary — WFH count (05_views.sql, uncommitted 2026-09-29).
//
// A work-from-home punch is an ordinary PRESENT day flagged on the EVENT
// (hr.attendance_events.is_wfh); the resolver never sets status 'wfh'. The old
// view counted `st.name = 'wfh'` only, so wfh_count was always 0 on the payroll
// export. The fix counts a day when a counted (not rejected / not pending face
// review) WFH punch falls inside first_in..last_out, or an approved
// regularization asked for the wfh status.
//
// Proves, against an independent recount from raw rows:
//   1. the view installed in the DB is the fixed one (the uncommitted
//      05_views.sql is easy to forget to apply — see schema-version-can-lie);
//   2. view wfh_count == recount for every (branch, user, month) in the last
//      three months of tenant A;
//   3. the report API (GET /hr/attendance/reports/summary, the payroll export
//      source) returns the same numbers as the view for the caller's branch;
//   4. the report is capability-gated: read_only / sales_rep denied.
//
//   node suites/hr/monthly-summary-wfh.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiGet } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';

const TOOL = 'hr';
const PAGE = 'Attendance Admin > Reports (monthly summary)';
const HR = APPS['hr-web'];
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

let findings = 0;
const fail = (severity, role, scenario, expected, actual, evidence, fix) => {
  findings++;
  record(TOOL, { severity, role, tool: TOOL, page: PAGE, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 400), proposedSolution: fix });
};

// ── 1. installed view definition ──────────────────────────────────────────
// Matched in SQL: db.scalar() returns only the FIRST line of a multi-line value.
const fixedInstalled = scalar(`SELECT pg_get_viewdef('hr.vw_attendance_monthly_summary'::regclass) LIKE '%is_wfh%'`) === 't';
const def = fixedInstalled ? '' : 'view body has no is_wfh reference';
logAction({ tool: TOOL, role: 'db', area: PAGE, action: 'check installed vw_attendance_monthly_summary counts WFH punches', method: 'SQL', endpoint: 'pg_get_viewdef', status: null, outcome: fixedInstalled ? 'allowed' : 'error', verified: fixedInstalled });
if (!fixedInstalled) fail('high', 'db', 'Installed monthly-summary view counts WFH punches', 'view body references attendance_events.is_wfh (05_views.sql)',
  'old definition (st.name = \'wfh\' only) — wfh_count is always 0', def.slice(0, 200), 'Apply db_scripts/05_views.sql (CREATE OR REPLACE VIEW hr.vw_attendance_monthly_summary) and bump 09_schema_version.sql.');

// ── 2. recount vs view ────────────────────────────────────────────────────
const orgA = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('hr_admin').org)} LIMIT 1`);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgA)}`);
const recount = `
  SELECT ad.org_id, ad.user_id, to_char(ad.work_date,'YYYY-MM') AS month,
         COUNT(*) FILTER (WHERE st.name='wfh' OR EXISTS (
           SELECT 1 FROM hr.attendance_events e WHERE e.user_id=ad.user_id AND e.is_wfh
             AND COALESCE(e.face_review_status,'') NOT IN ('rejected','pending')
             AND e.occurred_at BETWEEN ad.first_in AND COALESCE(ad.last_out, ad.first_in))) AS wfh
  FROM hr.attendance_days ad
  JOIN entity.organizations o ON o.id=ad.org_id
  JOIN hr.attendance_statuses st ON st.id=ad.status_id AND st.tenant_id=o.tenant_id
  WHERE o.tenant_id=${lit(tenantA)} AND ad.work_date >= date_trunc('month', now()) - interval '2 months'
  GROUP BY 1,2,3`;
const diffs = rows(`
  WITH r AS (${recount})
  SELECT r.org_id, r.user_id, r.month, r.wfh::text, COALESCE(v.wfh_count,-1)::text
  FROM r LEFT JOIN hr.vw_attendance_monthly_summary v ON v.org_id=r.org_id AND v.user_id=r.user_id AND v.month=r.month
  WHERE COALESCE(v.wfh_count,-1) <> r.wfh`, ['org', 'user', 'month', 'expected', 'view']);
const wfhDays = Number(scalar(`WITH r AS (${recount}) SELECT COALESCE(SUM(wfh),0) FROM r`) ?? 0);
logAction({ tool: TOOL, role: 'db', area: PAGE, action: `recount WFH days from raw events (last 3 months, tenant A: ${wfhDays} WFH day(s)) vs view`, method: 'SQL', endpoint: 'hr.vw_attendance_monthly_summary', status: null, outcome: diffs.length ? 'error' : 'allowed', verified: diffs.length === 0 });
if (diffs.length) fail('medium', 'db', 'wfh_count agrees with a recount from attendance_events', 'view == recount for every (branch,user,month)',
  `${diffs.length} mismatching row(s)`, JSON.stringify(diffs.slice(0, 3)), 'See 05_views.sql wfh_count FILTER; a mismatch after the fix is applied means the event window or face_review predicate differ.');
if (wfhDays === 0) fail('info', 'db', 'WFH data present to exercise the fix', '>= 1 WFH punch in the window', '0 — the equality check above is vacuous', '', 'Punch once with is_wfh on a local user to exercise it.');

// ── 3/4. report API vs view, and its gate ─────────────────────────────────
const month = new Date().toISOString().slice(0, 7);
for (const role of ['hr_admin', 'org_admin', 'tenant_admin', 'org_manager', 'sales_representative', 'read_only']) {
  let a; try { a = await actor(role); } catch { continue; }
  try {
    const r = await apiGet(a, `${HR}/api/hr/attendance/reports/summary?month=${month}`);
    // Graded by the role's LIVE capability (tenant overrides and parent-denial
    // cascade included), not by role name — role names are not the authz boundary.
    const caps = await sessionCaps(a);
    const shouldAllow = caps ? caps.has('hr.reports.attendance.view') : !['sales_representative', 'read_only'].includes(role);
    const data = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.data?.rows) ? r.body.data.rows : [];
    let mismatch = [];
    if (r.status === 200) {
      const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta(role).org)} LIMIT 1`);
      const view = Object.fromEntries(rows(`SELECT user_id, wfh_count::text FROM hr.vw_attendance_monthly_summary WHERE org_id=${lit(orgId)} AND month=${lit(month)}`, ['u', 'w']).map((x) => [x.u, Number(x.w)]));
      mismatch = data.filter((x) => x.user_id in view && Number(x.wfh_count) !== view[x.user_id]);
    }
    logAction({ tool: TOOL, role, area: PAGE, action: `open monthly summary report for ${month} and compare wfh_count with the view`, method: 'GET', endpoint: '/hr/attendance/reports/summary', status: r.status, outcome: outcomeOf(r.status, mismatch.length === 0), verified: r.status === 200 ? mismatch.length === 0 : null, expected: shouldAllow ? '200' : '403' });
    if (shouldAllow && r.status !== 200) fail(r.status >= 500 ? 'high' : 'medium', role, `Open monthly summary report (${month})`, '200', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Check hr.reports.attendance.view grant for this role.');
    if (!shouldAllow && r.status === 200) fail('high', role, 'Monthly summary report is capability-gated', '403', `200 with ${data.length} rows (payroll data)`, '', 'requireCapability(HR_REPORTS_ATTENDANCE_VIEW) must deny this role.');
    if (mismatch.length) fail('medium', role, 'Report wfh_count equals the view', 'identical', `${mismatch.length} user(s) differ`, JSON.stringify(mismatch.slice(0, 2)), 'monthlySummary reads the view directly; a difference means a second code path computes it.');
  } finally { await a.close(); }
}
console.log(`monthly-summary-wfh: view fixed=${fixedInstalled}, recount mismatches=${diffs.length}, wfh days=${wfhDays}, findings=${findings}`);
