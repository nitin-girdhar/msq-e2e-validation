// Face-enrollment + profile-photo lifecycle — the "avatar IS the biometric
// reference, and every guard is server-side" suite.
//
// Covers the new enrollment model where the reference photo is the user's avatar
// (iam.users.photo_key, written by identity-service) and hr-service enrolls that
// stored photo with CompreFace. None of these cases needs CompreFace running:
// each asserts a guard that fires BEFORE the CompreFace call, or an identity
// photo endpoint (which never calls CompreFace at all).
//
// Server contracts under test:
//   identity  POST /api/users/me/photo    consent:false → 422 PHOTO_CONSENT_REQUIRED
//   identity  POST /api/users/me/photo    valid         → 201 + photo_key
//   identity  GET  /api/users/:id/photo   → 200 bytes + ETag; If-None-Match → 304
//   hr        GET  /api/hr/attendance/face/me  → self context (has_photo flips)
//   hr        POST /api/hr/attendance/face/enroll:
//               consent:false                     → 422 FACE_CONSENT_REQUIRED
//               self, no avatar                    → 400 FACE_NO_PHOTO
//               someone else, as non-admin         → 403
//               self, within cooldown              → 422 FACE_CHANGE_COOLDOWN
//
//   node suites/hr/attendance-face-enroll.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';

const TOOL = 'hr';
const HR = APPS['hr-web'];
const ROLE = 'sales_representative'; // rep1 — a normal employee in FitClass - Gurgaon
const PHOTO_URL = `${HR}/api/users/me/photo`;
const FACE_ME = `${HR}/api/hr/attendance/face/me`;
const ENROLL = `${HR}/api/hr/attendance/face/enroll`;

// A minimal valid 1×1 JPEG — enough for identity to store (it never runs face
// detection); the CompreFace-dependent happy path is out of scope here.
const JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const userId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)} LIMIT 1`);
if (!userId) { console.log('Could not resolve rep1 — aborting'); process.exit(0); }
const orgId = scalar(`SELECT org_id FROM iam.users WHERE id=${lit(userId)}`);
if (!orgId) { console.log('Could not resolve rep1 org — aborting'); process.exit(0); }
const otherId = scalar(
  `SELECT id FROM iam.users WHERE org_id=${lit(orgId)} AND id<>${lit(userId)} AND NOT is_deleted LIMIT 1`,
);

// ── Snapshot state we mutate, so we can restore it afterward ──────────────────
const priorPhoto = q(`SELECT photo_key, photo_content_type FROM iam.users WHERE id=${lit(userId)}`)[0] ?? ['', ''];
const priorEnroll = q(
  `SELECT face_subject_id, face_enrolled_at, reference_photo_url FROM hr.employee_profiles WHERE user_id=${lit(userId)}`,
)[0] ?? null;

function resetSubject() {
  q(`UPDATE iam.users SET photo_key=NULL, photo_content_type=NULL, photo_uploaded_at=NULL,
        photo_uploaded_by=NULL, photo_consent_at=NULL WHERE id=${lit(userId)}`);
  q(`UPDATE hr.employee_profiles SET face_subject_id=NULL, face_enrolled_at=NULL, reference_photo_url=NULL
        WHERE user_id=${lit(userId)}`);
}

let pass = 0;
let fail = 0;
let priorRule; // undefined = step 9 never ran; null = no branch rule existed
function grade(label, ok, detail, sev = 'high', fix = '') {
  console.log(`  ${label.padEnd(34)} ${ok ? 'OK' : 'FAIL'}${ok ? '' : ` — ${detail}`}`);
  if (ok) { pass++; return; }
  fail++;
  record(TOOL, {
    severity: sev, role: ROLE, tool: TOOL, page: '/attendance (face enroll)',
    scenario: label,
    expected: detail,
    actual: detail,
    evidence: String(detail).slice(0, 400),
    proposedSolution: fix || 'Enforce the guard server-side in hr-service/identity-service.',
  });
}

// hr-service puts the machine code under details.code ({ success:false, error:'<message>',
// details:{ code:'FACE_CONSENT_REQUIRED' } }); reading only error/code graded every
// correct refusal as a failure.
const code = (b) => b?.details?.code || b?.error?.code || b?.code || (typeof b?.error === 'string' ? b.error : '') || '';

const a = await actor(ROLE);
try {
  resetSubject();
  console.log(`Face enrollment as ${ROLE} (rep1) · org=${roleMeta(ROLE)?.org}`);

  // 1. face/me on a fresh subject → no photo, not enrolled, may change.
  {
    const { status, body } = await apiGet(a, FACE_ME);
    const d = body?.data ?? {};
    grade('face/me fresh (no photo)',
      status === 200 && d.has_photo === false && d.enrolled === false && d.can_change_photo === true,
      `http=${status} ${JSON.stringify(d)}`);
  }

  // 2. enroll self with consent:false → 422 FACE_CONSENT_REQUIRED (before anything else).
  {
    const { status, body } = await apiPost(a, ENROLL, { user_id: userId, consent: false });
    grade('enroll self, consent=false → 422',
      status === 422 && String(code(body)).includes('FACE_CONSENT_REQUIRED'),
      `http=${status} code=${code(body)}`);
  }

  // 3. enroll self with consent but NO avatar → 400 FACE_NO_PHOTO.
  {
    const { status, body } = await apiPost(a, ENROLL, { user_id: userId, consent: true });
    grade('enroll self, no avatar → 400 FACE_NO_PHOTO',
      status === 400 && String(code(body)).includes('FACE_NO_PHOTO'),
      `http=${status} code=${code(body)}`);
  }

  // 4. enroll SOMEONE ELSE as a non-admin → 403.
  if (otherId) {
    const { status } = await apiPost(a, ENROLL, { user_id: otherId, consent: true });
    grade('enroll other as non-admin → 403', status === 403, `http=${status}`,
      'critical', 'Service must reject enrolling a user other than self unless the caller can manage attendance.');
  }

  // 5. identity photo upload, consent:false → 422 PHOTO_CONSENT_REQUIRED.
  {
    const { status, body } = await apiPost(a, PHOTO_URL, { photo: JPEG, consent: false });
    grade('upload photo, consent=false → 422',
      status === 422 && String(code(body)).includes('PHOTO_CONSENT_REQUIRED'),
      `http=${status} code=${code(body)}`);
  }

  // 6. identity photo upload, valid → 201 + photo_key.
  {
    const { status, body } = await apiPost(a, PHOTO_URL, { photo: JPEG, consent: true });
    grade('upload photo, valid → 201 + key',
      status === 201 && !!body?.data?.photo_key,
      `http=${status} ${JSON.stringify(body?.data ?? body)}`);
  }

  // 7. GET the photo → 200 bytes + ETag; a conditional re-GET → 304.
  {
    const r1 = await a.request.get(`${HR}/api/users/${userId}/photo`);
    const etag = r1.headers()['etag'];
    const ct = r1.headers()['content-type'] || '';
    grade('GET photo → 200 image + ETag',
      r1.status() === 200 && ct.startsWith('image/') && !!etag,
      `http=${r1.status()} ct=${ct} etag=${etag}`);
    if (etag) {
      const r2 = await a.request.get(`${HR}/api/users/${userId}/photo`, { headers: { 'If-None-Match': etag } });
      grade('GET photo If-None-Match → 304', r2.status() === 304, `http=${r2.status()}`,
        'low', 'Return 304 on a matching ETag so the team grid caches avatars.');
    }
  }

  // 8. face/me now reports the photo.
  {
    const { body } = await apiGet(a, FACE_ME);
    grade('face/me after upload → has_photo', body?.data?.has_photo === true, JSON.stringify(body?.data ?? {}));
  }

  // 9. Cooldown: simulate a recent enrolment + a 30-day org cooldown, then a
  //    self re-enroll must be refused with FACE_CHANGE_COOLDOWN (pre-CompreFace).
  {
    // Snapshot the branch's rule row first — this is REAL attendance config
    // (require_face_match): an earlier run left a 30-day / face-required rule on
    // the branch because nothing put it back.
    priorRule = q(`SELECT id, photo_change_cooldown_days, require_face_match::text FROM hr.attendance_rules
      WHERE org_id=${lit(orgId)} AND NOT is_deleted LIMIT 1`)[0] ?? null;
    q(`INSERT INTO hr.attendance_rules (org_id, photo_change_cooldown_days, require_face_match)
         VALUES (${lit(orgId)}, 30, TRUE)
       ON CONFLICT (tenant_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE NOT is_deleted
       DO UPDATE SET photo_change_cooldown_days=30, require_face_match=TRUE, updated_at=CLOCK_TIMESTAMP()`);
    q(`UPDATE hr.employee_profiles SET face_enrolled_at=CLOCK_TIMESTAMP() WHERE user_id=${lit(userId)}`);
    const { status, body } = await apiPost(a, ENROLL, { user_id: userId, consent: true });
    grade('self re-enroll within cooldown → 422',
      status === 422 && String(code(body)).includes('FACE_CHANGE_COOLDOWN'),
      `http=${status} code=${code(body)}`,
      'high', 'Enforce photo_change_cooldown_days for self-service enrolment (admins bypass).');
  }

  console.log(`\nFace-enroll suite: ${pass} passed, ${fail} failed.`);
} finally {
  // ── Restore the subject to its prior state ──────────────────────────────────
  resetSubject();
  if (priorPhoto[0]) {
    q(`UPDATE iam.users SET photo_key=${lit(priorPhoto[0])},
         photo_content_type=${priorPhoto[1] ? lit(priorPhoto[1]) : 'NULL'} WHERE id=${lit(userId)}`);
  }
  if (priorEnroll && priorEnroll[0]) {
    q(`UPDATE hr.employee_profiles SET face_subject_id=${lit(priorEnroll[0])},
         face_enrolled_at=${priorEnroll[1] ? lit(priorEnroll[1]) : 'NULL'},
         reference_photo_url=${priorEnroll[2] ? lit(priorEnroll[2]) : 'NULL'} WHERE user_id=${lit(userId)}`);
  }
  if (priorRule === null) {
    q(`DELETE FROM hr.attendance_rules WHERE org_id=${lit(orgId)} AND NOT is_deleted`); // hard delete: db.q runs DELETE as root_service
  } else if (priorRule) {
    q(`UPDATE hr.attendance_rules SET photo_change_cooldown_days=${priorRule[1] === '' ? 'NULL' : Number(priorRule[1])},
         require_face_match=${priorRule[2] === 't'} WHERE id=${lit(priorRule[0])}`);
  }
  await a.close();
}
