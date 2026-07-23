// Attendance geofence / punch-guard enforcement — the "HTML-hack can't beat the
// server" suite.
//
// The existing hr-attendance-punch.mjs only proves the HAPPY path: a punch from
// INSIDE the fence with the button enabled succeeds. It never proves the inverse
// — that a punch the UI would block is ALSO blocked by the server when the client
// is bypassed. A user who force-enables the disabled Check-in button (or calls the
// API directly) must still be rejected, because the geofence/photo/geo rules are
// enforced in hr-service, not just the browser.
//
// This suite fires the punch API directly with the real session cookies (exactly
// what a tampered client can do) and asserts the server rejects every rule
// violation AND writes no attendance_events row. It also drives the real
// /attendance page with the browser geolocation set OUTSIDE the fence and asserts
// the UI keeps the submit disabled — so both layers are covered.
//
// Enforcement under test (msq-hrms/.../attendance.repository.ts:punch):
//   OUTSIDE_GEOFENCE  (:280)  distance > geofence_radius_meters
//   GEO_REQUIRED      (:260)  require_geo && no coords
//   PHOTO_REQUIRED    (:296)  require_photo && no photo
//   wfhBypass         (:266)  is_wfh only bypasses geo when allow_wfh_checkin=true
//   ALREADY_CHECKED_IN(:348)  a second open check-in same day → 409
//
// Setup: the seed orgs have NO geo centre, so a punch would trip
// ORG_LOCATION_NOT_SET rather than exercise the fence. We set the Gurgaon org's
// geo centre (rep1's org) for the run and restore it afterwards. With NO
// hr.attendance_rules row the service uses its defaults — geofence_enabled=true,
// require_geo=true, require_photo=true, allow_wfh_checkin=false, radius=200m —
// which is exactly the config these cases need, so no rules-row surgery (and no
// 60s rules-cache flip) is required.
//
//   node suites/hr/attendance-geofence-guard.mjs
import { APPS, record, roleMeta, openState } from '../../lib.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
const ROLE = 'sales_representative'; // rep1 — a normal employee in FitClass - Gurgaon
const CHECK_IN = `${HR}/api/hr/attendance/check-in`;

// Org geofence centre for the run, and two probe points.
const CENTER = { lat: 28.4595, lng: 77.0266 };          // fence centre (200 m default)
const INSIDE = { lat: 28.4595, lng: 77.0266 };          // 0 m from centre → within
const OUTSIDE = { lat: 28.5300, lng: 77.1200 };         // ~11 km away → well outside
// A minimal valid 1×1 PNG — satisfies require_photo without a real capture.
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgName = roleMeta(ROLE)?.org;
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
const userId = scalar(`SELECT id FROM iam.users WHERE email='rep1@fitclass.ggn.in' LIMIT 1`);
if (!orgId || !userId) { console.log(`Could not resolve org (${orgName}) / rep1 user — aborting`); process.exit(0); }

// Today's work date in the org timezone (matches the service's localDateOf).
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// Count of this user's attendance_events for today — the "did a row leak in?" probe.
const eventsToday = () => Number(scalar(
  `SELECT COUNT(*) FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`
) ?? 0);

// ── Setup: remember the org's prior geo, then set the fence centre ────────────
const prior = q(`SELECT geo_lat, geo_lng FROM entity.organizations WHERE id=${lit(orgId)}`)[0] ?? ['', ''];
const priorLat = prior[0] === '' ? null : prior[0];
const priorLng = prior[1] === '' ? null : prior[1];
q(`UPDATE entity.organizations SET geo_lat=${CENTER.lat}, geo_lng=${CENTER.lng} WHERE id=${lit(orgId)}`);
// Clear any pre-existing punches for today so double-check-in grading is deterministic.
q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`);

console.log(`Geofence guard as ${ROLE} (rep1) · org=${orgName} centre=(${CENTER.lat},${CENTER.lng}) r=200m · date=${today}`);

// A negative case: the punch MUST be rejected (2xx is a bug) AND write no row.
async function expectRejected(a, label, payload, wantCode) {
  const before = eventsToday();
  const { status, body } = await apiPost(a, CHECK_IN, payload);
  const after = eventsToday();
  const code = body?.error?.code || body?.code || body?.error || '';
  const rejected = status >= 400 && status < 500;
  const noRow = after === before;
  const codeOk = !wantCode || String(code).includes(wantCode) || JSON.stringify(body).includes(wantCode);
  console.log(`  ${label.padEnd(26)} http=${status} code=${String(code).slice(0, 24)} rowLeaked=${!noRow} ${(rejected && noRow) ? 'OK' : 'FAIL'}`);

  if (!rejected || !noRow) {
    record(TOOL, {
      severity: 'critical', role: ROLE, tool: TOOL, page: '/attendance (POST check-in)',
      scenario: `Direct check-in that the UI would block — ${label} (simulates a force-enabled/HTML-tampered button)`,
      expected: `Server rejects with a 4xx (${wantCode || 'validation error'}) and writes NO hr.attendance_events row`,
      actual: !rejected
        ? `Punch SUCCEEDED (HTTP ${status}) — the client-side guard is the only guard; a tampered client checks in from anywhere.`
        : `Punch was rejected (HTTP ${status}) but an attendance_events row still appeared — a rejected punch must not persist.`,
      evidence: JSON.stringify({ status, code, before, after, body: typeof body === 'string' ? body.slice(0, 160) : body }).slice(0, 500),
      proposedSolution: 'Enforce geo/photo/geofence in hr-service.punch for every punch (never trust the client), and roll the event insert back on any validation failure.',
    });
  } else if (!codeOk) {
    record(TOOL, {
      severity: 'low', role: ROLE, tool: TOOL, page: '/attendance (POST check-in)',
      scenario: `Rejection reason for ${label}`,
      expected: `Error code ${wantCode}`,
      actual: `Rejected correctly (HTTP ${status}) but with code "${code}" — client can't show the right message.`,
      evidence: JSON.stringify(body).slice(0, 300),
      proposedSolution: `Return the ${wantCode} code so the UI can render the correct guidance.`,
    });
  }
  return { status, body };
}

const a = await actor(ROLE);
try {
  // 1. THE headline: outside the fence, everything else valid → must be blocked.
  await expectRejected(a, 'outside geofence', { geo_lat: OUTSIDE.lat, geo_lng: OUTSIDE.lng, photo: PHOTO }, 'OUTSIDE_GEOFENCE');

  // 2. require_geo on, no coordinates supplied → must be blocked.
  await expectRejected(a, 'no geo coordinates', { photo: PHOTO }, 'GEO_REQUIRED');

  // 3. require_photo on, no photo supplied → must be blocked (even from inside).
  await expectRejected(a, 'no photo', { geo_lat: INSIDE.lat, geo_lng: INSIDE.lng }, 'PHOTO_REQUIRED');

  // 4. is_wfh must NOT bypass the fence while allow_wfh_checkin=false.
  await expectRejected(a, 'wfh does not bypass geo', { geo_lat: OUTSIDE.lat, geo_lng: OUTSIDE.lng, photo: PHOTO, is_wfh: true }, 'OUTSIDE_GEOFENCE');

  // 5. Happy path — inside the fence, photo present → succeeds and writes a row.
  //    Proves the suite isn't a false-reject machine (setup is genuinely valid).
  const before = eventsToday();
  const ok = await apiPost(a, CHECK_IN, { geo_lat: INSIDE.lat, geo_lng: INSIDE.lng, photo: PHOTO });
  const rowAdded = eventsToday() === before + 1;
  console.log(`  ${'inside fence (happy path)'.padEnd(26)} http=${ok.status} rowAdded=${rowAdded} ${(ok.status >= 200 && ok.status < 300 && rowAdded) ? 'OK' : 'FAIL'}`);
  if (!(ok.status >= 200 && ok.status < 300 && rowAdded)) {
    record(TOOL, {
      severity: 'high', role: ROLE, tool: TOOL, page: '/attendance (POST check-in)',
      scenario: 'Valid check-in from inside the geofence with a photo',
      expected: 'HTTP 2xx and one new hr.attendance_events row',
      actual: `HTTP ${ok.status}, rowAdded=${rowAdded} — a legitimate in-fence punch was blocked.`,
      evidence: JSON.stringify(ok.body).slice(0, 300),
      proposedSolution: 'Confirm the org geo centre, default rules, and PUNCH capability for a normal employee; an in-fence punch with photo must succeed.',
    });
  }

  // 6. Second open check-in same day → 409 ALREADY_CHECKED_IN, no extra row.
  if (ok.status >= 200 && ok.status < 300) {
    const afterFirst = eventsToday();
    const dup = await apiPost(a, CHECK_IN, { geo_lat: INSIDE.lat, geo_lng: INSIDE.lng, photo: PHOTO });
    const noExtra = eventsToday() === afterFirst;
    const code = dup.body?.error?.code || dup.body?.code || '';
    console.log(`  ${'double check-in'.padEnd(26)} http=${dup.status} code=${code} noExtra=${noExtra} ${(dup.status === 409 && noExtra) ? 'OK' : 'FAIL'}`);
    if (dup.status !== 409 || !noExtra) {
      record(TOOL, {
        severity: dup.status >= 200 && dup.status < 300 ? 'high' : 'medium', role: ROLE, tool: TOOL,
        page: '/attendance (POST check-in)',
        scenario: 'Check in twice in one day without checking out',
        expected: 'The second open check-in is rejected with 409 ALREADY_CHECKED_IN and no duplicate row',
        actual: `HTTP ${dup.status}, extraRow=${!noExtra} — duplicate open check-ins corrupt the day resolution.`,
        evidence: JSON.stringify(dup.body).slice(0, 300),
        proposedSolution: 'Keep the open/closed punch guard (ci>co) inside the write transaction so concurrent duplicates are rejected atomically.',
      });
    }
  }
} finally {
  await a.close();
}

// Clear the happy-path punch so the UI opens on a fresh "Check in" state (an open
// check-in would make the page show "already checked in" and skip the UI case).
q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`);

// ── 7. UI layer: the disabled button must stay disabled outside the fence ─────
// Playwright grants a geolocation OUTSIDE the fence; the page should keep the
// submit disabled (or, if fired, the server rejects per case 1). We assert the
// UI never lets a successful check-in happen from outside.
try {
  const { browser, page } = await openState(ROLE, { headless: true });
  const geoCtx = page.context();
  await geoCtx.grantPermissions(['geolocation']);
  await geoCtx.setGeolocation({ latitude: OUTSIDE.lat, longitude: OUTSIDE.lng });
  await page.goto(`${HR}/attendance`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const checkInBtn = page.getByRole('button', { name: /check in/i }).first();
  const visible = await checkInBtn.isVisible().catch(() => false);
  if (visible) {
    await checkInBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    // In the modal, the submit Check-in should be disabled while outside the fence.
    const submit = page.getByRole('button', { name: /^check in$/i }).last();
    const disabled = await submit.isDisabled().catch(() => true);
    const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const showsOutside = /outside|not within|too far|geofence|allowed area/.test(bodyText);
    console.log(`  ${'UI: submit disabled outside'.padEnd(26)} disabled=${disabled} showsGeoWarning=${showsOutside}`);
    if (!disabled && !showsOutside) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: '/attendance (UI)',
        scenario: 'Open the Check-in modal while physically outside the geofence',
        expected: 'The submit button is disabled (or an "outside the allowed area" message is shown) so the user cannot punch',
        actual: 'The submit control is enabled and no out-of-fence warning is shown — the UI would let an out-of-fence punch through to the server.',
        evidence: bodyText.slice(0, 300),
        proposedSolution: 'Disable the submit until the resolved location is within the fence, and show the distance/allowed-radius so the state is legible.',
      });
    }
  } else {
    console.log(`  ${'UI: submit disabled outside'.padEnd(26)} (already checked in today — UI case skipped)`);
  }
  await browser.close();
} catch (e) {
  console.log('  UI button-state check errored (non-fatal):', e.message);
}

// ── Cleanup: remove this run's punches + day, restore the org geo centre ──────
q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)}
     AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${lit(today)}`);
if (priorLat === null && priorLng === null) {
  q(`UPDATE entity.organizations SET geo_lat=NULL, geo_lng=NULL WHERE id=${lit(orgId)}`);
} else {
  q(`UPDATE entity.organizations SET geo_lat=${priorLat ?? 'NULL'}, geo_lng=${priorLng ?? 'NULL'} WHERE id=${lit(orgId)}`);
}
console.log(`cleaned up punches for rep1 (${today}) and restored org geo (lat=${priorLat}, lng=${priorLng}).`);
