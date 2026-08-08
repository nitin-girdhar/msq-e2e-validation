// Attendance geo-exceptions — NEW in msq-hrms since the last e2e pass
// (e2817a4 "fix: wfh + approved list"), not covered anywhere in the harness.
//
// A geo-exception is a PER-EMPLOYEE row (hr.attendance_geo_exceptions) that lets
// HR exempt one person from the geofence for named dates, independent of the
// org-wide allow_wfh_checkin toggle already covered by
// attendance-geofence-guard.mjs case 4. Two exception_type values with a subtle,
// easy-to-regress labelling rule (services/hr-service/src/lib/attendance/
// geo-bypass.ts resolveGeoBypass):
//   'wfh'          → bypasses the fence AND marks the punch is_wfh=true, even
//                    though the employee ticked nothing on the punch itself.
//   'remote_role'  → bypasses the fence but must NOT be recorded as WFH — this
//                    person is out in the field, not at home; mislabelling it
//                    corrupts WFH reporting/payroll.
// This suite proves: capability gating on GET/POST, CRUD persists correctly,
// validation on a too-short reason, and — the part most likely to silently
// regress — the exact is_wfh/geo_exception_type labelling on a real check-in
// punched from outside the fence under each exception type, plus that ending
// the exception (PATCH is_active=false) re-engages enforcement.
//
// Actors: org_admin (canManageGeoExceptions) manages; rep1
// (sales_representative, FitClass-Gurgaon) is the exempted employee and also
// serves as the unprivileged actor for the negative capability checks.
//
//   node suites/hr/geo-exceptions.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
const GEO_URL = `${HR}/api/hr/attendance/geo-exceptions`;
const CHECK_IN = `${HR}/api/hr/attendance/check-in`;
const REQUESTER = 'sales_representative';
const ADMIN = 'org_admin';

const CENTER = { lat: 28.4595, lng: 77.0266 };
const OUTSIDE = { lat: 28.5300, lng: 77.1200 }; // ~11 km away, well outside default 200m
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const orgName = roleMeta(REQUESTER)?.org;
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
const userId = scalar(`SELECT id FROM iam.users WHERE email='rep1@fitclass.ggn.in' LIMIT 1`);
if (!orgId || !userId) { console.log(`Could not resolve org (${orgName}) / rep1 — aborting`); process.exit(0); }

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 86400000));

const exceptionRow = () => q(
  `SELECT id, exception_type, is_active FROM hr.attendance_geo_exceptions
     WHERE user_id=${lit(userId)} AND reason LIKE ${lit(`%${stamp}%`)} ORDER BY created_at DESC LIMIT 1`)[0];
const eventRow = () => q(
  `SELECT is_wfh, geo_exception_type FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)} ORDER BY created_at DESC LIMIT 1`)[0];
const eventsCount = () => Number(scalar(
  `SELECT COUNT(*) FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`) ?? 0);
const clearDay = () => {
  q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
  q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)}
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`);
};

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: REQUESTER, tool: TOOL, page: 'Attendance geo-exceptions', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const prior = q(`SELECT geo_lat, geo_lng FROM entity.organizations WHERE id=${lit(orgId)}`)[0] ?? ['', ''];
const priorLat = prior[0] === '' ? null : prior[0];
const priorLng = prior[1] === '' ? null : prior[1];
q(`UPDATE entity.organizations SET geo_lat=${CENTER.lat}, geo_lng=${CENTER.lng} WHERE id=${lit(orgId)}`);
clearDay();

const rep = await actor(REQUESTER);
const admin = await actor(ADMIN);
let excId = null;
try {
  // ── 1. Capability gate — an ordinary employee must not view or manage exceptions ──
  const viewDenied = await apiGet(rep, `${GEO_URL}?user_id=${userId}`);
  console.log(`1. rep GET geo-exceptions  http=${viewDenied.status} (expect 403)`);
  if (viewDenied.status !== 403) {
    fail('high', 'A non-admin employee lists geo-exceptions', 'HR_ATTENDANCE_ADMIN_GEO_EXCEPTIONS_VIEW is required — 403 for a plain employee',
      `HTTP ${viewDenied.status}`, JSON.stringify(viewDenied.body),
      'Gate GET /geo-exceptions on HR_ATTENDANCE_ADMIN_GEO_EXCEPTIONS_VIEW.');
  }
  const createDenied = await apiPost(rep, GEO_URL, {
    user_id: userId, exception_type: 'wfh', effective_from: today, reason: `E2E-deny-${stamp}`,
  });
  console.log(`   rep POST geo-exceptions http=${createDenied.status} (expect 403)`);
  if (createDenied.status !== 403) {
    fail('critical', 'A non-admin employee grants themself a geo-exception',
      'HR_ATTENDANCE_ADMIN_GEO_EXCEPTIONS_MANAGE is required — 403 for a plain employee',
      `HTTP ${createDenied.status}`, JSON.stringify(createDenied.body),
      'Gate POST /geo-exceptions on HR_ATTENDANCE_ADMIN_GEO_EXCEPTIONS_MANAGE; an employee bypassing their own geofence is a critical control gap.');
  }

  // ── 2. Validation — reason is required and must be >= 3 chars ────────────────
  const badReason = await apiPost(admin, GEO_URL, {
    user_id: userId, exception_type: 'wfh', effective_from: today, reason: 'hi',
  });
  console.log(`2. create short reason     http=${badReason.status} (expect 4xx)`);
  if (badReason.status < 400 || badReason.status >= 500) {
    fail('low', 'Create a geo-exception with a too-short reason', 'Clean 4xx validation error (reason min length 3)',
      `HTTP ${badReason.status}`, JSON.stringify(badReason.body),
      'Keep the reason-length validation returning 400/422, never a 500 or silent success.');
  }

  // ── 3. Create a 'remote_role' exception, open-ended-to-tomorrow ──────────────
  const create = await apiPost(admin, GEO_URL, {
    user_id: userId, exception_type: 'remote_role', effective_from: today, effective_to: tomorrow,
    reason: `E2E-remote-${stamp}`,
  });
  const row1 = exceptionRow();
  excId = row1?.id ?? create.body?.data?.id ?? create.body?.id ?? null;
  console.log(`3. create remote_role      http=${create.status} row=${JSON.stringify(row1)}`);
  if (!row1 || row1.exception_type !== 'remote_role' || row1.is_active !== true) {
    fail('high', 'HR grants a remote_role geo-exception', 'A row is created with exception_type=remote_role, is_active=true',
      `HTTP ${create.status}, row=${JSON.stringify(row1)}`, JSON.stringify(create.body),
      'Confirm createGeoException persists exception_type/effective dates and defaults is_active=true.');
  }

  // ── 4. List — the admin's GET reflects it, scoped by user_id ─────────────────
  const list = await apiGet(admin, `${GEO_URL}?user_id=${userId}`);
  const listed = JSON.stringify(list.body).includes(String(excId));
  console.log(`4. list geo-exceptions     http=${list.status} listed=${listed}`);
  if (list.status !== 200 || !listed) {
    fail('medium', 'List geo-exceptions filtered by user_id', 'The just-created exception appears in the list',
      `HTTP ${list.status}, listed=${listed}`, JSON.stringify(list.body).slice(0, 300),
      'Confirm listGeoExceptions honours the user_id filter and returns active-by-default rows.');
  }

  // ── 5. Punch outside the fence, undeclared WFH → bypass allowed, but the punch
  //      must be labelled is_wfh=false / geo_exception_type='remote_role'. This is
  //      the exact regression this suite exists to catch: a 'remote_role' punch
  //      mislabelled as WFH corrupts WFH reporting for a field employee.
  if (row1) {
    const punch = await apiPost(rep, CHECK_IN, { geo_lat: OUTSIDE.lat, geo_lng: OUTSIDE.lng, photo: PHOTO });
    const ev = eventRow();
    console.log(`5. punch under remote_role http=${punch.status} event=${JSON.stringify(ev)}`);
    if (!(punch.status >= 200 && punch.status < 300) || !ev) {
      fail('high', 'Check in from outside the fence while a remote_role exception is active',
        'The exception bypasses OUTSIDE_GEOFENCE and the punch succeeds',
        `HTTP ${punch.status}, event=${JSON.stringify(ev)}`, JSON.stringify(punch.body),
        'resolveGeoBypass must treat any active geo-exception (exceptionType !== null) as bypass=true regardless of allow_wfh_checkin.');
    } else if (ev.is_wfh !== false || ev.geo_exception_type !== 'remote_role') {
      fail('high', 'remote_role punch labelling',
        'attendance_events.is_wfh=false and geo_exception_type=remote_role (a field visit is not a WFH day)',
        `is_wfh=${ev.is_wfh}, geo_exception_type=${ev.geo_exception_type}`, `eventDate=${today}`,
        'resolveGeoBypass.isWfh must stay false for a remote_role exception unless the employee ALSO ticked is_wfh on the punch.');
    }
    clearDay();
  }

  // ── 6. End the exception (PATCH is_active=false) → enforcement re-engages ────
  if (excId) {
    const end = await apiPatch(admin, `${GEO_URL}/${excId}`, { is_active: false });
    const row2 = exceptionRow();
    console.log(`6. end exception           http=${end.status} is_active=${row2?.is_active}`);
    if (row2?.is_active !== false) {
      fail('medium', 'End (deactivate) a geo-exception via PATCH is_active=false', 'is_active flips to false',
        `HTTP ${end.status}, is_active=${row2?.is_active}`, JSON.stringify(end.body),
        'Confirm updateGeoException persists is_active on the PATCH path.');
    } else {
      const before = eventsCount();
      const punch2 = await apiPost(rep, CHECK_IN, { geo_lat: OUTSIDE.lat, geo_lng: OUTSIDE.lng, photo: PHOTO });
      const noRow = eventsCount() === before;
      console.log(`   punch after end         http=${punch2.status} noRow=${noRow} (expect 4xx, no row)`);
      if (!(punch2.status >= 400 && punch2.status < 500) || !noRow) {
        fail('critical', 'Punch from outside the fence after the geo-exception was ended',
          'OUTSIDE_GEOFENCE is enforced again — a deactivated exception must not still bypass',
          `HTTP ${punch2.status}, rowLeaked=${!noRow}`, JSON.stringify(punch2.body),
          'activeGeoException must exclude rows where is_active=false (or whose effective_to has passed) from the bypass lookup.');
      }
      clearDay();
    }
  }
} finally {
  await rep.close();
  await admin.close();
  q(`DELETE FROM hr.attendance_geo_exceptions WHERE user_id=${lit(userId)} AND reason LIKE ${lit(`%${stamp}%`)}`);
  clearDay();
  if (priorLat === null && priorLng === null) {
    q(`UPDATE entity.organizations SET geo_lat=NULL, geo_lng=NULL WHERE id=${lit(orgId)}`);
  } else {
    q(`UPDATE entity.organizations SET geo_lat=${priorLat ?? 'NULL'}, geo_lng=${priorLng ?? 'NULL'} WHERE id=${lit(orgId)}`);
  }
  console.log(`\ncleaned up geo-exceptions + punches for stamp ${stamp}, restored org geo.`);
}
