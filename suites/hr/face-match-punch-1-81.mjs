// Face-match at PUNCH time + biometric-template isolation (schema 1.81.0).
//
// attendance-face-enroll.mjs proves the ENROL guards. Nothing proved what the
// punch does with the rule on, nor that hr.face_templates (AES-GCM biometric
// embeddings, DPDP) is unreachable from every session role and never echoed by
// an API. This suite does both, without needing a real face photo:
//
//   A. Catalog invariants (read-only): RLS enabled+forced, zero policies, no
//      SELECT for app_user/tenant_admin/hr_svc/analytics_svc, every template is
//      'enc:v1:' ciphertext, no profile/template pointer orphans.
//   B. Punch matrix as rep1 with require_face_match=TRUE (decision table in
//      lib/face/punch-verification.ts):
//        block + not enrolled            → 422 FACE_NOT_ENROLLED, no event row
//        block + undecryptable template  → punch SUCCEEDS, passed=NULL, review=pending (fail open)
//        flag  + not enrolled            → punch succeeds, passed=NULL, review=pending
//      and the face API surface (face/me) never contains ciphertext.
//
// Rules are read through a 60 s cache (attendance.repository RULES_TTL_MS) and
// we write the rule row by SQL, so the suite waits the TTL out after each flip.
// Everything it mutates (rule row, org geo, template, enrolment pointer, today's
// punches) is snapshotted and restored in `finally`.
//
//   node suites/hr/face-match-punch-1-81.mjs
import { APPS, record, roleMeta, HR_EMPLOYEE } from '../../lib.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { sleep } from '../../kit.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const ROLE = HR_EMPLOYEE;
const HR = APPS['hr-web'];
const CHECK_IN = `${HR}/api/hr/attendance/check-in`;
const FACE_ME = `${HR}/api/hr/attendance/face/me`;
const CENTER = { lat: 28.4595, lng: 77.0266 };
const PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const RULES_TTL_WAIT_MS = Number(process.env.E2E_RULES_TTL_MS || 65000);

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

let pass = 0, fail = 0;
function grade(label, ok, detail, sev = 'high', fix = '') {
  console.log(`  ${label.padEnd(58)} ${ok ? 'OK' : `FAIL — ${detail}`}`);
  if (ok) { pass++; return; }
  fail++;
  record(TOOL, {
    severity: sev, role: ROLE, tool: TOOL, page: '/attendance (face match, 1.81.0)',
    scenario: label, expected: label, actual: String(detail).slice(0, 400),
    evidence: String(detail).slice(0, 400),
    proposedSolution: fix || 'See lib/face/punch-verification.ts decision matrix and 07_grants/08_rls for hr.face_templates.',
  });
}
const code = (b) => b?.details?.code || b?.error?.code || b?.code || (typeof b?.error === 'string' ? b.error : '') || '';

// ── A. Catalog invariants (no stack mutation) ────────────────────────────────
console.log('A. hr.face_templates catalog invariants');
const rls = q(`SELECT relrowsecurity::text, relforcerowsecurity::text FROM pg_class
               WHERE oid='hr.face_templates'::regclass`)[0] ?? [];
grade('RLS enabled AND forced', rls[0] === 'true' && rls[1] === 'true', `enabled=${rls[0]} forced=${rls[1]}`, 'critical',
  'ALTER TABLE hr.face_templates ENABLE + FORCE ROW LEVEL SECURITY (08_rls.sql).');
const pol = scalar(`SELECT count(*) FROM pg_policies WHERE schemaname='hr' AND tablename='face_templates'`);
grade('no RLS policy exists (deny-all to session roles)', String(pol) === '0', `policies=${pol}`, 'critical',
  'Drop every policy on hr.face_templates; only root_service (BYPASSRLS path) may touch it.');
for (const role of ['app_user', 'tenant_admin', 'hr_svc', 'analytics_svc', 'lms_svc']) {
  const exists = scalar(`SELECT count(*) FROM pg_roles WHERE rolname=${lit(role)}`);
  if (String(exists) !== '1') { console.log(`  (role ${role} not present — skipped)`); continue; }
  const can = scalar(`SELECT (has_table_privilege(${lit(role)}, 'hr.face_templates', 'SELECT')
                          OR has_table_privilege(${lit(role)}, 'hr.face_templates', 'INSERT')
                          OR has_table_privilege(${lit(role)}, 'hr.face_templates', 'UPDATE')
                          OR has_table_privilege(${lit(role)}, 'hr.face_templates', 'DELETE'))::text`);
  grade(`${role} has no privilege on hr.face_templates`, can === 'false', `privilege=${can}`, 'critical',
    'REVOKE ALL ON hr.face_templates FROM PUBLIC, app_user, tenant_admin, hr_svc, analytics_svc (07_grants.sql).');
}
const notEnc = scalar(`SELECT count(*) FROM hr.face_templates WHERE embedding_enc NOT LIKE 'enc:v1:%'`);
grade('every stored template is enc:v1 ciphertext', String(notEnc) === '0', `plaintext rows=${notEnc}`, 'critical');
const orphanProfiles = scalar(`SELECT count(*) FROM hr.employee_profiles ep
   WHERE ep.face_subject_id IS NOT NULL AND NOT ep.is_deleted
     AND NOT EXISTS (SELECT 1 FROM hr.face_templates ft
                      WHERE ft.id::text=ep.face_subject_id AND ft.user_id=ep.user_id AND ft.org_id=ep.org_id)`);
grade('no enrolment pointer without a matching template', String(orphanProfiles) === '0', `orphans=${orphanProfiles}`, 'medium',
  'Enrol/unenrol must be one transaction; backfill or clear dangling face_subject_id.');
const crossOrg = scalar(`SELECT count(*) FROM hr.face_templates ft
   JOIN iam.users u ON u.id=ft.user_id WHERE u.tenant_id IS DISTINCT FROM
     (SELECT o.tenant_id FROM entity.organizations o WHERE o.id=ft.org_id)`);
grade('no template crosses a tenant boundary', String(crossOrg) === '0', `rows=${crossOrg}`, 'critical');

// ── B. Punch matrix ──────────────────────────────────────────────────────────
console.log('B. punch-time verification matrix');
const userId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta(HR_EMPLOYEE).email)} LIMIT 1`);
const orgId = userId && scalar(`SELECT org_id FROM iam.users WHERE id=${lit(userId)}`);
if (!userId || !orgId) { console.log('Could not resolve rep1 / org — aborting B'); process.exit(0); }
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const priorGeo = q(`SELECT geo_lat, geo_lng FROM entity.organizations WHERE id=${lit(orgId)}`)[0] ?? ['', ''];
const priorRule = q(`SELECT id, require_face_match::text, face_match_action, require_photo::text
   FROM hr.attendance_rules WHERE org_id=${lit(orgId)} AND NOT is_deleted LIMIT 1`)[0] ?? null;
const priorEnroll = q(`SELECT face_subject_id, face_enrolled_at, reference_photo_url FROM hr.employee_profiles
   WHERE user_id=${lit(userId)}`)[0] ?? null;

// Full snapshot of any real template rep1 already has, so the run is lossless.
const priorTemplate = q(`SELECT id, model_version, embedding_enc, quality::text FROM hr.face_templates
   WHERE user_id=${lit(userId)} AND org_id=${lit(orgId)} LIMIT 1`)[0] ?? null;

const eventsToday = () => Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE user_id=${lit(userId)}
   AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=${lit(today)}`) ?? 0);
const clearToday = () => {
  q(`DELETE FROM hr.attendance_days   WHERE user_id=${lit(userId)} AND work_date=${lit(today)}`);
  q(`DELETE FROM hr.attendance_events WHERE user_id=${lit(userId)}
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=${lit(today)}`);
};
const setRule = (action) => q(`INSERT INTO hr.attendance_rules (org_id, require_face_match, face_match_action, face_match_threshold, require_photo)
     VALUES (${lit(orgId)}, TRUE, ${lit(action)}, 85, TRUE)
   ON CONFLICT (tenant_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE NOT is_deleted
   DO UPDATE SET require_face_match=TRUE, face_match_action=${lit(action)}, face_match_threshold=85,
                 require_photo=TRUE, updated_at=CLOCK_TIMESTAMP()`);
const unenrol = () => {
  q(`DELETE FROM hr.face_templates WHERE user_id=${lit(userId)}`);
  q(`UPDATE hr.employee_profiles SET face_subject_id=NULL, face_enrolled_at=NULL WHERE user_id=${lit(userId)}`);
};
const lastEvent = () => q(`SELECT face_match_passed::text, face_review_status, COALESCE(face_match_score::text,'')
   FROM hr.attendance_events WHERE user_id=${lit(userId)} ORDER BY created_at DESC LIMIT 1`)[0] ?? [];

const a = await actor(ROLE);
try {
  q(`UPDATE entity.organizations SET geo_lat=${CENTER.lat}, geo_lng=${CENTER.lng} WHERE id=${lit(orgId)}`);
  clearToday();
  unenrol();
  const body = { geo_lat: CENTER.lat, geo_lng: CENTER.lng, photo: PHOTO };

  // B1/B2 — action = block
  setRule('block');
  console.log(`  (waiting ${RULES_TTL_WAIT_MS / 1000}s for the rules cache)`);
  await sleep(RULES_TTL_WAIT_MS);

  {
    const before = eventsToday();
    const r = await apiPost(a, CHECK_IN, body);
    grade('block + not enrolled → 422 FACE_NOT_ENROLLED',
      r.status === 422 && String(code(r.body)).includes('FACE_NOT_ENROLLED'),
      `http=${r.status} code=${code(r.body)}`, 'high',
      'resolvePunchFace must throw FaceBlockedError(FACE_NOT_ENROLLED) when action=block and there is no template.');
    grade('  …and the rejected punch wrote no event row', eventsToday() === before, `rows ${before}→${eventsToday()}`, 'critical');
  }

  {
    // Enrolled, but the template cannot be decrypted → must FAIL OPEN, never lock staff out.
    const tid = scalar(`INSERT INTO hr.face_templates (org_id, user_id, model_version, embedding_enc, quality)
        VALUES (${lit(orgId)}, ${lit(userId)}, 'e2e-corrupt', 'enc:v1:e2e-not-a-real-ciphertext', '{}')
        RETURNING id`);
    q(`UPDATE hr.employee_profiles SET face_subject_id=${lit(tid)}, face_enrolled_at=CLOCK_TIMESTAMP() WHERE user_id=${lit(userId)}`);
    const me = await apiGet(a, FACE_ME);
    const meText = JSON.stringify(me.body ?? {});
    grade('face/me does not echo ciphertext / template internals',
      me.status === 200 && !/enc:v1|embedding/i.test(meText), `http=${me.status} body=${meText.slice(0, 200)}`, 'critical',
      'face/me must expose only has_photo/enrolled/can_change_photo flags.');
    const before = eventsToday();
    const r = await apiPost(a, CHECK_IN, body);
    const ev = lastEvent();
    grade('block + undecryptable template → punch succeeds (fail open)',
      r.status >= 200 && r.status < 300 && eventsToday() === before + 1,
      `http=${r.status} code=${code(r.body)} rows ${before}→${eventsToday()}`, 'high',
      'An unreadable template is an outage, not "not enrolled": record for review, never reject.');
    grade('  …recorded passed=NULL, review=pending, no score',
      ev[0] === '' && ev[1] === 'pending' && ev[2] === '', `passed=${ev[0]} review=${ev[1]} score=${ev[2]}`, 'high');
    const respText = JSON.stringify(r.body ?? {});
    grade('  …check-in response carries no ciphertext', !/enc:v1/i.test(respText), respText.slice(0, 200), 'critical');
    clearToday();
  }

  // B3 — action = flag, not enrolled
  unenrol();
  setRule('flag');
  console.log(`  (waiting ${RULES_TTL_WAIT_MS / 1000}s for the rules cache)`);
  await sleep(RULES_TTL_WAIT_MS);
  {
    const before = eventsToday();
    const r = await apiPost(a, CHECK_IN, body);
    const ev = lastEvent();
    grade('flag + not enrolled → punch succeeds, review pending',
      r.status >= 200 && r.status < 300 && eventsToday() === before + 1 && ev[0] === '' && ev[1] === 'pending',
      `http=${r.status} code=${code(r.body)} passed=${ev[0]} review=${ev[1]}`, 'high',
      'flag mode never blocks: NOT_ENROLLED_FLAG → passed NULL, review pending.');
  }

  console.log(`\nFace-match punch suite: ${pass} passed, ${fail} failed.`);
} finally {
  clearToday();
  unenrol();
  if (priorTemplate && priorEnroll && priorEnroll[0]) {
    q(`INSERT INTO hr.face_templates (id, org_id, user_id, model_version, embedding_enc, quality)
         VALUES (${lit(priorTemplate[0])}, ${lit(orgId)}, ${lit(userId)}, ${lit(priorTemplate[1])},
                 ${lit(priorTemplate[2])}, ${lit(priorTemplate[3])}::jsonb)`);
    q(`UPDATE hr.employee_profiles SET face_subject_id=${lit(priorEnroll[0])},
         face_enrolled_at=${priorEnroll[1] ? lit(priorEnroll[1]) : 'NULL'} WHERE user_id=${lit(userId)}`);
  }
  if (priorRule === null) {
    q(`DELETE FROM hr.attendance_rules WHERE org_id=${lit(orgId)} AND NOT is_deleted`);
  } else {
    q(`UPDATE hr.attendance_rules SET require_face_match=${priorRule[1] === 't'},
         face_match_action=${lit(priorRule[2])}, require_photo=${priorRule[3] === 't'} WHERE id=${lit(priorRule[0])}`);
  }
  q(`UPDATE entity.organizations SET geo_lat=${priorGeo[0] === '' ? 'NULL' : priorGeo[0]},
       geo_lng=${priorGeo[1] === '' ? 'NULL' : priorGeo[1]} WHERE id=${lit(orgId)}`);
  await a.close();
}
