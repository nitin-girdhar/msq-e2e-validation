// Split-shift attendance day classification (docs/ATTENDANCE_DAY_CLASSIFICATION.md
// §1 "Split shifts" / §4.5 "Manual end-to-end validation").
//
// Two behaviors changed together and are only meaningfully tested jointly:
//   1. worked_minutes is now the SUM of paired check-in->check-out sessions,
//      not last_out-first_in — a split-shift employee is no longer paid for
//      the multi-hour gap between segments.
//   2. A punch outside every declared segment is still accepted and counted,
//      but flags the event (is_off_segment) and the day
//      (has_off_window_punch) for review instead of being silently folded in.
//
// This suite seeds the punches directly as hr.attendance_events (controlling
// occurred_at precisely, which a live API punch cannot do inside a test run),
// forces resolution via the recompute endpoint added in the same change
// (POST /hr/attendance/recompute — previously unreachable through the gateway,
// see the note below), and asserts on hr.attendance_days.
//
// It also proves the "balances" commit's gateway-route fix actually works:
// GET /hr/attendance/events was registered in hr-service but had NO gateway
// route at all until that change, so calling it through the gateway 404'd
// regardless of role — a broken-by-construction feature no crawl of the UI
// would have caught (there was nothing to click; the only consumer is the
// split-shift punch-history drill-down).
//
// SAFETY: creates its own throwaway shift + assignment, seeds only rep1's
// events for TODAY, and deletes everything (events, day, assignment, shift)
// in a finally block.
//
//   node suites/hr/attendance-split-shift.mjs
import { APPS, record, roleMeta, HR_EMPLOYEE } from '../../lib.mjs';
import { actor, apiPost, apiGet } from '../../conc.mjs';
import { dbReachable, scalar, q, rows, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
// tenant_admin, not org_admin: FitClass grants org_admin no HR capabilities at
// all (tenant config), so an org_admin shift create is a correct 403.
const ADMIN_ROLE = 'tenant_admin'; // holds HR_ATTENDANCE_ADMIN_ASSIGNMENTS_MANAGE + HR_ATTENDANCE_PHOTO_VIEW
const EMPLOYEE_ROLE = HR_EMPLOYEE; // rep1 — reused the same way attendance-geofence-guard.mjs does

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgName = roleMeta(EMPLOYEE_ROLE)?.org;
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
const userId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta(HR_EMPLOYEE).email)} LIMIT 1`);
if (!orgId || !userId) { console.log(`Could not resolve org (${orgName}) / rep1 user — aborting`); process.exit(0); }

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const shiftName = `E2E-split-${Date.now()}`;
const iso = (hhmm) => `${today}T${hhmm}:00+05:30`;

console.log(`Split-shift day classification · org=${orgName} user=rep1 date=${today}`);

let shiftId = null;
let assignmentId = null;
const admin = await actor(ADMIN_ROLE);

// Clear any pre-existing state for today so resolution is deterministic.
function clearDay() {
  q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
  q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)} AND occurred_at::date=${lit(today)}`);
}
clearDay();

try {
  // ── 1. Create a split shift: 09:00-13:00 + 17:00-21:00 inside 09:00-21:00 ──
  const shiftBody = {
    name: shiftName,
    start_time: '09:00',
    end_time: '21:00',
    is_split: true,
    segments: [
      { seq: 1, start_time: '09:00', end_time: '13:00' },
      { seq: 2, start_time: '17:00', end_time: '21:00' },
    ],
  };
  const shiftRes = await apiPost(admin, `${HR}/api/hr/shifts`, shiftBody);
  shiftId = shiftRes.body?.data?.id ?? null;
  console.log(`  create split shift -> ${shiftRes.status} id=${shiftId}`);
  if (!shiftId) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'POST /api/hr/shifts',
      scenario: 'Create a split shift with two segments in one request',
      expected: 'HTTP 2xx with the created shift id',
      actual: `HTTP ${shiftRes.status}: ${JSON.stringify(shiftRes.body).slice(0, 300)}`,
      evidence: JSON.stringify(shiftBody),
      proposedSolution: 'Check createShiftSchema.superRefine(checkSegments) accepts two non-overlapping segments nested inside the outer window.',
    });
    throw new Error('shift creation failed — aborting suite');
  }

  // ── 2. Assign it to rep1, effective today ───────────────────────────────
  const assignRes = await apiPost(admin, `${HR}/api/hr/shift-assignments`, {
    user_id: userId, shift_id: shiftId, effective_from: today,
  });
  assignmentId = assignRes.body?.data?.id ?? null;
  console.log(`  assign to rep1 -> ${assignRes.status} id=${assignmentId}`);
  if (!assignmentId) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'POST /api/hr/shift-assignments',
      scenario: 'Assign the split shift to an employee effective today',
      expected: 'HTTP 2xx with the created assignment id',
      actual: `HTTP ${assignRes.status}: ${JSON.stringify(assignRes.body).slice(0, 300)}`,
      evidence: `user_id=${userId} shift_id=${shiftId} effective_from=${today}`,
      proposedSolution: 'Check for an overlapping-assignment exclusion conflict with an existing default assignment for this user.',
    });
    throw new Error('shift assignment failed — aborting suite');
  }

  // ── 3. Seed the punches directly (occurred_at needs to be exact) ───────
  // Segment 1 (09:00-13:00, 240m) + segment 2 (17:00-21:00, 240m) = 480m paired.
  // Plus one off-window pair (15:00-15:30, 30m) — inside the outer window but
  // outside both segments, so it must be flagged, not silently merged in.
  const punches = [
    ['check_in', '09:00', false],
    ['check_out', '13:00', false],
    ['check_in', '17:00', false],
    ['check_out', '21:00', false],
    ['check_in', '15:00', true],
    ['check_out', '15:30', true],
  ];
  for (const [eventType, time, offSegment] of punches) {
    q(`INSERT INTO hr.attendance_events
         (user_id, org_id, event_type, occurred_at, source, is_within_geofence, is_wfh, is_off_segment)
       VALUES (${lit(userId)}, ${lit(orgId)}, ${lit(eventType)}, ${lit(iso(time))}::timestamptz,
               'api', TRUE, FALSE, ${offSegment ? 'TRUE' : 'NULL'})`);
  }
  console.log(`  seeded ${punches.length} events for ${today}`);

  // ── 4. Force resolution via the recompute endpoint ─────────────────────
  const recomputeRes = await apiPost(admin, `${HR}/api/hr/attendance/recompute`, {
    user_id: userId, from: today, to: today,
  });
  console.log(`  recompute -> ${recomputeRes.status}`);
  if (recomputeRes.status < 200 || recomputeRes.status >= 300) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'POST /api/hr/attendance/recompute',
      scenario: 'Recompute a day after seeding split-shift punches',
      expected: 'HTTP 2xx',
      actual: `HTTP ${recomputeRes.status}: ${JSON.stringify(recomputeRes.body).slice(0, 300)}`,
      evidence: `user_id=${userId} from=${today} to=${today}`,
      proposedSolution: 'Confirm HR_ATTENDANCE_ADMIN_ASSIGNMENTS_MANAGE is granted to org_admin and the route exists at both hr-service and the gateway.',
    });
  }

  // ── 5. Assert the resolved day ──────────────────────────────────────────
  const day = rows(
    `SELECT worked_minutes, has_off_window_punch, has_open_session, resolution_source
     FROM hr.attendance_days WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`,
    ['worked_minutes', 'has_off_window_punch', 'has_open_session', 'resolution_source']
  )[0];
  console.log(`  resolved day: ${JSON.stringify(day)}`);

  if (!day) {
    record(TOOL, {
      severity: 'high', role: ADMIN_ROLE, tool: TOOL, page: 'hr.attendance_days',
      scenario: 'Read the resolved day after recompute',
      expected: 'A row exists for rep1 / today',
      actual: 'No row found — recompute reported success but wrote nothing.',
      evidence: `user_id=${userId} work_date=${today}`,
      proposedSolution: 'Trace resolve-attendance / computeDayResolution for a no-op that reports 2xx without persisting.',
    });
  } else {
    const workedMinutes = Number(day.worked_minutes);
    // 480 (two full segments) + 30 (off-window pair) = 510. The bug this
    // fixed would instead compute last_out(21:00) - first_in(09:00) = 720,
    // crediting the 4-hour gap between segments as worked time.
    if (workedMinutes !== 510) {
      record(TOOL, {
        severity: 'critical', role: ADMIN_ROLE, tool: TOOL, page: 'hr.attendance_days.worked_minutes',
        scenario: 'Split shift: in 09:00/out 13:00, in 17:00/out 21:00, plus an off-window in 15:00/out 15:30',
        expected: 'worked_minutes = 510 (sum of the three paired sessions: 240+240+30)',
        actual: `worked_minutes = ${workedMinutes}${workedMinutes === 720 ? ' — this is first_in-to-last_out, the exact regression this feature fixed (it pays for the inter-segment gap)' : ''}`,
        evidence: JSON.stringify(day),
        proposedSolution: 'Check the day-resolution session-summing logic pairs check_in/check_out chronologically and sums each closed pair, rather than spanning first-to-last.',
      });
    } else {
      console.log('  OK: worked_minutes correctly sums paired sessions (510), not the span (720)');
    }

    if (day.has_off_window_punch !== 't') {
      record(TOOL, {
        severity: 'medium', role: ADMIN_ROLE, tool: TOOL, page: 'hr.attendance_days.has_off_window_punch',
        scenario: 'A punch pair (15:00-15:30) falls outside both declared segments but inside the outer shift window',
        expected: 'has_off_window_punch = true',
        actual: `has_off_window_punch = ${day.has_off_window_punch}`,
        evidence: JSON.stringify(day),
        proposedSolution: 'Check the day resolver ORs is_off_segment across the day\'s events into has_off_window_punch.',
      });
    } else {
      console.log('  OK: has_off_window_punch correctly flagged');
    }

    if (day.resolution_source !== 'events') {
      record(TOOL, {
        severity: 'low', role: ADMIN_ROLE, tool: TOOL, page: 'hr.attendance_days.resolution_source',
        scenario: 'A day with real punches should be distinguishable from a bare no-show',
        expected: "resolution_source = 'events'",
        actual: `resolution_source = '${day.resolution_source}'`,
        evidence: JSON.stringify(day),
        proposedSolution: "Confirm computeDayResolution sets resolution_source='events' whenever attendance_events exist for the day.",
      });
    }
  }

  const seededEvents = rows(
    `SELECT event_type, is_off_segment FROM hr.attendance_events
     WHERE user_id=${lit(userId)} AND occurred_at::date=${lit(today)} ORDER BY occurred_at`,
    ['event_type', 'is_off_segment']
  );
  const offSegmentEvents = seededEvents.filter((e) => e.is_off_segment === 't').length;
  console.log(`  events: ${seededEvents.length} total, ${offSegmentEvents} flagged is_off_segment`);
  if (offSegmentEvents !== 2) {
    record(TOOL, {
      severity: 'low', role: ADMIN_ROLE, tool: TOOL, page: 'hr.attendance_events.is_off_segment',
      scenario: 'Both events of the 15:00-15:30 off-window pair should carry is_off_segment',
      expected: '2 events flagged',
      actual: `${offSegmentEvents} flagged (of ${seededEvents.length} total events)`,
      evidence: JSON.stringify(seededEvents),
    });
  }

  // ── 6. The gateway route this suite exists to regression-guard ─────────
  // GET /hr/attendance/events had no gateway registration at all before the
  // fix — a 404 here regardless of role/capability would mean it regressed.
  const eventsUrl = `${HR}/api/hr/attendance/events?user_id=${userId}&date=${today}`;
  const eventsRes = await apiGet(admin, eventsUrl);
  const returnedCount = Array.isArray(eventsRes.body?.data) ? eventsRes.body.data.length : null;
  console.log(`  GET /hr/attendance/events -> ${eventsRes.status} (${returnedCount ?? '?'} events)`);
  if (eventsRes.status === 404) {
    record(TOOL, {
      severity: 'critical', role: ADMIN_ROLE, tool: TOOL, page: eventsUrl,
      scenario: 'Read every punch of a work date via GET /hr/attendance/events',
      expected: 'HTTP 2xx — this is the only way to reach a split shift\'s middle punches and their selfies',
      actual: 'HTTP 404 — the gateway has no route for this path (regression of the fix that added it).',
      evidence: eventsUrl,
      proposedSolution: "Confirm api-gateway/src/server.ts registers app.get('/hr/attendance/events', ...) proxying to hr-service's /api/v1/attendance/events.",
    });
  } else if (returnedCount !== punches.length) {
    record(TOOL, {
      severity: 'medium', role: ADMIN_ROLE, tool: TOOL, page: eventsUrl,
      scenario: 'Read every punch of the seeded split-shift day',
      expected: `${punches.length} events`,
      actual: `${returnedCount} events returned (HTTP ${eventsRes.status})`,
      evidence: JSON.stringify(eventsRes.body).slice(0, 300),
    });
  } else {
    console.log('  OK: /hr/attendance/events reachable and returns every punch');
  }
} finally {
  // ── Cleanup: seeded punches/day, the assignment, and the throwaway shift ─
  clearDay();
  if (assignmentId) q(`DELETE FROM hr.shift_assignments WHERE id=${lit(assignmentId)}`);
  if (shiftId) {
    q(`DELETE FROM hr.shift_segments WHERE shift_id=${lit(shiftId)}`);
    q(`DELETE FROM hr.shifts WHERE id=${lit(shiftId)}`);
  }
  console.log(`cleaned up: shift=${shiftId} assignment=${assignmentId} events/day for rep1 (${today})`);
  await admin.close();
}

console.log('\ndone.');
