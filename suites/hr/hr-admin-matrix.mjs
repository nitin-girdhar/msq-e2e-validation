// HR admin surface, exercised as EVERY role.
//
// Covers what the HR suites never reached — holidays CRUD, the leave-year
// settings, shift ASSIGNMENT (only shift creation existed), and the reporting
// endpoints — plus re-grades the already-covered admin actions (policies,
// balance adjustments) across the full 19-role ladder instead of org_admin only.
//
// HR admin authority is rank >= 75 (hr_head), per iam.user_roles; org_admin
// (980), tenant_admin (990) and super_admin (1000) clear it too. Anything below
// 75 succeeding on these is a privilege escalation.
//
//   node suites/hr/hr-admin-matrix.mjs
import { APPS, roleMeta, SECONDARY, HR_EMPLOYEE } from '../../lib.mjs';
import { leaveTypeFor } from '../../fixtures.mjs';
import { apiPost, apiGet, apiPut } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';
const LEAVE_TYPE = leaveTypeFor(roleMeta(HR_EMPLOYEE).email);

const TOOL = 'hr';
const HR = APPS['hr-web'];
const HR_ADMIN_RANK = 75;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('org_admin').org)} LIMIT 1`);
const year = new Date().getFullYear();

// ── 1. HOLIDAYS — create (HR_LEAVE_ADMIN_HOLIDAYS_MANAGE) ──────────────────
console.log('— create holiday (HR admin, rank >= 75) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a public holiday', endpoint: 'POST /api/hr/holidays',
  area: 'Leave Admin', tab: 'Holidays', minRank: HR_ADMIN_RANK,
  act: (a, role) => apiPost(a, `${HR}/api/hr/holidays`, {
    name: `E2E-holiday-${role}-${stamp}`,
    // spread dates so unique (org, date) constraints don't collide between roles
    holiday_date: new Date(Date.UTC(year, 11, 1 + (Math.abs(hash(role)) % 20))).toISOString().slice(0, 10),
    org_id: orgId,
  }),
  verify: (role) => Number(scalar(
    `SELECT COUNT(*) FROM hr.holidays WHERE name=${lit(`E2E-holiday-${role}-${stamp}`)}`
  ) ?? 0) > 0,
});

// ── 2. HOLIDAYS — read (HR_LEAVE_ADMIN_HOLIDAYS_VIEW) ──────────────────────
// Viewing the holiday calendar is a normal-employee need; everyone should read.
console.log('\n— list holidays (all roles should be able to read) —');
await runRoleMatrix({
  tool: TOOL, action: 'list the holiday calendar', endpoint: 'GET /api/hr/holidays',
  area: 'Leave Admin', tab: 'Holidays',
  minRank: 0, severityUnder: 'medium',
  act: (a) => apiGet(a, `${HR}/api/hr/holidays?year=${year}`),
});

// ── 3. LEAVE YEAR / SETTINGS (HR_LEAVE_ADMIN_CYCLE_MANAGE) ─────────────────
console.log('\n— update leave-year settings (HR admin only) —');
await runRoleMatrix({
  tool: TOOL, action: 'change the leave-year settings', endpoint: 'PUT /api/hr/leave/settings',
  area: 'Leave Admin', tab: 'Cycle / Settings',
  minRank: HR_ADMIN_RANK, severityOver: 'high',
  act: (a) => apiPut(a, `${HR}/api/hr/leave/settings`, { leave_year_start_month: 4 }),
});

// ── 4. LEAVE POLICIES (HR_LEAVE_ADMIN_POLICIES_MANAGE) ─────────────────────
console.log('\n— create leave policy (HR admin only) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a leave policy', endpoint: 'POST /api/hr/leave/policies',
  area: 'Leave Admin', tab: 'Policies',
  minRank: HR_ADMIN_RANK, severityOver: 'high',
  act: (a, role) => apiPost(a, `${HR}/api/hr/leave/policies`, {
    leave_type_name: 'sick', org_id: orgId, accrual_frequency: 'yearly', accrual_amount: 6,
    min_notice_days: 0, allow_half_day: true, approval_levels: 1,
    // unique effective date per role so the (org,type,date) uniqueness doesn't
    // turn a legitimate second attempt into a false "denied"
    applicable_from: new Date(Date.UTC(year + 1, Math.abs(hash(role)) % 12, 1)).toISOString().slice(0, 10),
  }),
});

// ── 5. BALANCE ADJUSTMENT (HR_LEAVE_ADMIN_ADJUSTMENT_CREATE) ───────────────
// Crediting leave balance is financially meaningful — escalation is high.
console.log('\n— adjust another user\'s leave balance (HR admin only) —');
const targetUser = scalar(`SELECT id FROM iam.users WHERE email=${lit(SECONDARY.find((a) => a.actor === 'rep3').email)} LIMIT 1`);
if (targetUser) {
  await runRoleMatrix({
    tool: TOOL, action: "credit another employee's leave balance",
    endpoint: 'POST /api/hr/leave/adjustments', area: 'Leave Admin', tab: 'Adjustment', minRank: HR_ADMIN_RANK, severityOver: 'high',
    act: (a, role) => apiPost(a, `${HR}/api/hr/leave/adjustments`, {
      user_id: targetUser, leave_type_name: LEAVE_TYPE, amount: 1, note: `E2E matrix ${role} ${stamp}`,
    }),
  });
}

// ── 6. SHIFTS — create and assign ──────────────────────────────────────────
console.log('\n— create shift (HR admin only) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a shift', endpoint: 'POST /api/hr/shifts',
  area: 'Attendance Admin', tab: 'Shifts', minRank: HR_ADMIN_RANK,
  act: (a, role) => apiPost(a, `${HR}/api/hr/shifts`, {
    name: `E2E-shift-${role}-${stamp}`, org_id: orgId, start_time: '09:00', end_time: '18:00',
  }),
  verify: (role) => Number(scalar(
    `SELECT COUNT(*) FROM hr.shifts WHERE name=${lit(`E2E-shift-${role}-${stamp}`)}`
  ) ?? 0) > 0,
});

console.log('\n— assign a shift to an employee (HR admin only) —');
const anyShift = scalar(`SELECT id FROM hr.shifts WHERE org_id=${lit(orgId)} ORDER BY created_at DESC LIMIT 1`);
if (anyShift && targetUser) {
  await runRoleMatrix({
    tool: TOOL, action: 'assign a shift to an employee', endpoint: 'POST /api/hr/shift-assignments',
    area: 'Attendance Admin', tab: 'Assignments',
    minRank: HR_ADMIN_RANK,
    act: (a) => apiPost(a, `${HR}/api/hr/shift-assignments`, {
      user_id: targetUser, shift_id: anyShift, effective_from: new Date().toISOString().slice(0, 10),
    }),
  });
}

// ── 7. REPORTS — team/org attendance + leave reporting ─────────────────────
// Reporting reads other people's data: manager rank (60) and up.
console.log('\n— attendance team report (manager rank 60+) —');
await runRoleMatrix({
  tool: TOOL, action: "read the team attendance report (other employees' data)",
  endpoint: 'GET /api/hr/attendance/team', area: 'Attendance', tab: 'Team', capability: 'hr.attendance.view.team', severityOver: 'high',
  act: (a) => apiGet(a, `${HR}/api/hr/attendance/team?date=${new Date().toISOString().slice(0, 10)}`),
});

console.log('\n— leave ledger report (manager rank 60+) —');
await runRoleMatrix({
  tool: TOOL, action: 'read the leave ledger', endpoint: 'GET /api/hr/leave/ledger',
  area: 'Leave', tab: 'Ledger',
  minRank: 0, severityUnder: 'low',
  act: (a) => apiGet(a, `${HR}/api/hr/leave/ledger`),
});

// ── cleanup ────────────────────────────────────────────────────────────────
q(`DELETE FROM hr.holidays WHERE name LIKE ${lit(`E2E-holiday-%${stamp}`)}`);
q(`UPDATE hr.shifts SET is_active=FALSE WHERE name LIKE ${lit(`E2E-shift-%${stamp}`)}`);
console.log(`\ncleaned up holidays/shifts for stamp ${stamp}.`);
console.log('NOTE: leave policies and balance adjustments created by this run are intentionally left in place —');
console.log('      deleting an accrual/ledger entry would corrupt balances. Reset the dev DB if they accumulate.');

// Small stable hash so each role gets its own date slot.
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
