// Punch hub & attendance admin tools (schema 1.64.0) + muster + payroll readiness.
//
//   GET  /hr/attendance/me/punches?month=YYYY-MM   own punch log          hr.attendance.view
//   GET  /hr/attendance/me/nudges                  reminders HR sent me    hr.attendance.view
//   POST /hr/attendance/admin/manual-punch         add a missed punch      hr.attendance.admin.override
//   POST /hr/attendance/admin/bulk-regularize      one status, many people hr.attendance.admin.override
//   POST /hr/attendance/admin/nudge                remind non-punchers     hr.attendance.admin.override
//   GET  /hr/attendance/reports/muster             combined sheet          hr.reports.attendance.view
//   GET  /hr/payroll/admin/readiness?month=        month-end checklist     hr.reports.payroll.manage
//
// Rules proven (attendance-tools.router.ts):
//   * me/punches is pinned to the verified caller; me/nudges to the caller + their branch
//   * the admin tools are fenced to the caller's BRANCH: another branch / tenant / unknown id is
//     "not found" (manual-punch) or a per-person {ok:false} (bulk) or silently not nudged
//   * manual punch: stored as source 'manual' with reason + acting user in device_info; the day
//     is re-derived; not future, not > 60 days old, never on yourself, blocked by a locked month
//   * bulk regularize: partial failure is reported per person (200 + results), writes only the
//     valid ones, unknown status writes nothing, locked month writes nothing
//   * nudge only reaches people who have not punched that day, never the caller
//   * muster: branch=all only with tenant reach; org_id outside the caller's reach is a 403
//   * readiness counts equal the DB for the caller's branch and move by exactly what was seeded
//
// SAFETY: only the fixture people's events/days/pay_periods are touched; every table is
// snapshotted (journalled first) and restored in finally. Audit rows are append-only by design.
//
//   node suites/hr/hr-punch-hub-admin.mjs
import { CROSS_TENANT } from '../../lib.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { journalRestore, runRestore, restorePending } from '../../fixtures.mjs';
import {
  API, dbSnapshot, isoDaysAgo, stamp, req, openActors, closeActors, bug, act, guard, check, addDays, todayIso, dowOf, sleep, findingCount,
} from './_att-kit.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const AREA = 'HR > Attendance > Punch hub & admin tools';
const T = '/hr/attendance';
const msqTa = CROSS_TENANT.find((x) => x.role === 'tenant_admin')?.stateKey;
const msqOa = CROSS_TENANT.find((x) => x.role === 'org_admin')?.stateKey;
const msqRep = CROSS_TENANT.find((x) => x.role === 'sales_representative')?.stateKey;

const A = await openActors({
  trainer: 'fitness_trainer', peer: 'org_manager', admin: 'fitness_manager', tadmin: 'tenant_admin', orgAdmin: 'org_admin',
  readOnly: 'read_only', noCap: 'sales_representative', noida: 'assistant_fitness_manager', hr: 'hr_admin', sa: 'super_admin',
  ...(msqTa ? { msqTa } : {}), ...(msqOa ? { msqOa } : {}), ...(msqRep ? { msqRep } : {}),
});
if (!A.trainer || !A.peer || !A.admin) { console.log('required actors unavailable — aborting'); await closeActors(A); process.exit(0); }
if ([A.trainer, A.peer, A.admin].some((a) => a.me.org_name !== 'Gurugram - Sector 69')) { console.log('fixture actors are not on Sector 69 — aborting'); await closeActors(A); process.exit(0); }

const key = 'e2e-att-punch';
restorePending('e2e-att');
const orgId = A.admin.me.org_id, tenantId = A.admin.me.tenant_id;
const trainer = A.trainer.me, peer = A.peer.me, admin = A.admin.me;
const post = (a, path, body) => req(a, 'POST', path, body);
const get = (a, path, query) => req(a, 'GET', path, undefined, query);

// ── snapshots (held in scratch DB tables; journalled BEFORE any write) ───────
const fixtureUsers = [trainer.id, peer.id, admin.id];
const seedTargets = new Map(); // readiness seeding: org -> one employee of that branch
for (const a of [A.tadmin, A.hr, A.sa, A.msqTa, A.msqOa].filter(Boolean)) {
  if (!seedTargets.has(a.me.org_id)) seedTargets.set(a.me.org_id, scalar(`SELECT user_id FROM hr.employee_profiles WHERE org_id=${lit(a.me.org_id)} AND is_active AND NOT is_deleted ORDER BY user_id LIMIT 1`));
}
const seedUsers = [...new Set([...seedTargets.values()].filter(Boolean))];
const inUsers = fixtureUsers.map(lit).join(',');
const RMONTH = addDays(`${todayIso().slice(0, 7)}-01`, -1).slice(0, 7); // previous month (readiness)
const SEED_DATES = [`${RMONTH}-02`, `${RMONTH}-03`];
const LO = isoDaysAgo(75), LO_DATE = LO.slice(0, 10);
const snapParts = [
  dbSnapshot(key, 1, 'hr.attendance_events', `user_id IN (${inUsers}) AND occurred_at >= ${lit(LO)}::timestamptz`),
  dbSnapshot(key, 2, 'hr.attendance_days', `user_id IN (${inUsers}) AND work_date >= ${lit(LO_DATE)}::date`),
  dbSnapshot(key, 3, 'hr.pay_periods', `org_id=${lit(orgId)}`),
  ...(seedUsers.length ? [dbSnapshot(key, 4, 'hr.attendance_days', `user_id IN (${seedUsers.map(lit).join(',')}) AND work_date IN (${SEED_DATES.map(lit).join(',')})`)] : []),
];
journalRestore(key, 'HR punch hub suite: events, days, pay_periods of the fixture people', snapParts.flatMap((p) => p.stmts));
console.log(`  snapshot held in scratch tables: ${snapParts.map((p) => `${p.table.split('.')[1]}=${p.cnt}`).join(', ')}`);

// ── dates (org-local, IST) ──────────────────────────────────────────────────
const holidays = new Set(rows(`SELECT holiday_date::text FROM hr.holidays WHERE org_id=${lit(orgId)} AND NOT is_deleted AND is_active`, ['d']).map((r) => r.d));
const workday = (back) => { let d = addDays(todayIso(), -back); while ([0, 6].includes(dowOf(d)) || holidays.has(d)) d = addDays(d, -1); return d; };
const D1 = workday(2), D2 = workday(3), D3 = workday(4), D4 = workday(5);
const month = (d) => d.slice(0, 7);
const at = (d, hhmm) => `${d}T${hhmm}:00+05:30`;
const eventsOf = (uid, d) => rows(`SELECT event_type, source, device_info::text, occurred_at::text FROM hr.attendance_events WHERE user_id=${lit(uid)} AND (occurred_at AT TIME ZONE 'Asia/Kolkata')::date=${lit(d)} ORDER BY occurred_at`, ['t', 'src', 'dev', 'at']);
const dayRow = (uid, d) => rows(`SELECT s.name, ad.worked_minutes::text, ad.resolution_source, ad.first_in::text, ad.last_out::text FROM hr.attendance_days ad JOIN hr.attendance_statuses s ON s.id=ad.status_id WHERE ad.user_id=${lit(uid)} AND ad.work_date=${lit(d)}`, ['status', 'worked', 'src', 'fin', 'lout'])[0] ?? null;
// Only the days this suite plays on (the last ~6 days up to tomorrow); older history is never touched.
const CLEAR_FROM = addDays(todayIso(), -8);
const clearUserDays = () => { q(`DELETE FROM hr.attendance_events WHERE user_id IN (${inUsers}) AND occurred_at >= ${lit(CLEAR_FROM)}::timestamptz`); q(`DELETE FROM hr.attendance_days WHERE user_id IN (${inUsers}) AND work_date >= ${lit(CLEAR_FROM)}::date`); };
const auditCount = (action, uid, since) => Number(scalar(`SELECT COUNT(*) FROM audit.activities WHERE action_type=${lit(action)} AND target_id=${lit(uid)} AND created_at >= ${lit(since)}::timestamptz`));
const noidaUser = scalar(`SELECT u.id FROM iam.users u JOIN hr.employee_profiles ep ON ep.user_id=u.id JOIN entity.organizations o ON o.id=ep.org_id WHERE o.name='Noida - Knowledge Park 2' AND u.is_active AND NOT ep.is_deleted LIMIT 1`);
const msqUser = A.msqRep?.me.id ?? A.msqTa?.me.id;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const t0 = () => new Date(Date.now() - 2000).toISOString();

try {
  clearUserDays();
  console.log(`Punch hub & admin tools · org=Sector 69 admin=${admin.email} trainer=${trainer.email} peer=${peer.email}; days D1=${D1} D2=${D2} D3=${D3}`);

  // ── 1. own punch log ───────────────────────────────────────────────────────
  console.log('\n[1] GET /me/punches');
  const ins = (uid, iso, type = 'check_in') => q(`INSERT INTO hr.attendance_events (user_id, org_id, event_type, occurred_at, source, is_within_geofence, device_info) VALUES (${lit(uid)}, ${lit(orgId)}, ${lit(type)}, ${lit(iso)}::timestamptz, 'web', TRUE, '{"e2e":true}'::jsonb)`);
  ins(trainer.id, at(D1, '09:05')); ins(trainer.id, at(D1, '18:00'), 'check_out'); ins(peer.id, at(D1, '09:10'));
  const mm = month(D1);
  const mine = await get(A.trainer, `${T}/me/punches`, { month: mm });
  guard('fitness_trainer', 'own punches', mine, `GET ${T}/me/punches`);
  const list = mine.body?.data ?? [];
  const ownOnly = list.every((r) => eventsOf(trainer.id, D1).length >= 0) && !list.some((r) => r.id && Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE id=${lit(r.id)} AND user_id<>${lit(trainer.id)}`)) > 0);
  act('fitness_trainer', AREA, 'open the punch log for a month', 'GET', `${T}/me/punches`, mine, { verified: ownOnly && list.length >= 2, expected: 'own punches only', tab: 'Biometric & geofence logs' });
  check(mine.status === 200 && list.length >= 2 && ownOnly, `trainer sees ${list.length} own punch(es), none of the peer's (peer also punched ${D1})`, ['critical', 'fitness_trainer', `GET ${T}/me/punches`, 'Punch log scope', 'only the caller\'s events', `${list.length} rows, ownOnly=${ownOnly}`, '', 'WHERE e.user_id = caller (verified session).']);
  check(list.every((r, i) => i === 0 || r.occurred_at <= list[i - 1].occurred_at), 'newest first');
  check(['id', 'event_type', 'occurred_at', 'source', 'is_within_geofence', 'face_review_status'].every((k) => list[0] && k in list[0]), 'row carries the geofence + face-review fields the UI renders');
  for (const [label, query, want] of [['no month', {}, [400, 422]], ['month 2026-13', { month: '2026-13' }, [400, 422]], ['month 2026-1', { month: '2026-1' }, [400, 422]], ['injection in month', { month: "2026-10' OR '1'='1" }, [400, 422]], ['user_id override attempt', { month: mm, user_id: peer.id }, [200]]]) {
    const r = await get(A.trainer, `${T}/me/punches`, query);
    guard('fitness_trainer', label, r, `GET ${T}/me/punches`);
    let ok = want.includes(r.status);
    if (label === 'user_id override attempt') ok = ok && !(r.body?.data ?? []).some((x) => Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE id=${lit(x.id)} AND user_id=${lit(peer.id)}`)) > 0);
    check(ok, `${label} -> ${r.status}`, ['high', 'fitness_trainer', `GET ${T}/me/punches`, label, want.join('/') + ' and never another user\'s rows', `${r.status}`, JSON.stringify(r.body).slice(0, 150), 'punchLogQuerySchema; identity from the session only.']);
  }
  const ro = await get(A.readOnly, `${T}/me/punches`, { month: mm });
  act('read_only', AREA, 'open own punch log', 'GET', `${T}/me/punches`, ro, { expected: 'allowed (own, empty)' });
  check(ro.status === 200 && (ro.body?.data ?? []).length === 0, `read_only -> ${ro.status}, ${(ro.body?.data ?? []).length} rows`);
  const nc = await get(A.noCap, `${T}/me/punches`, { month: mm });
  check([403].includes(nc.status), `role without hr.attendance.view -> ${nc.status}`, ['high', 'sales_representative', `GET ${T}/me/punches`, 'No attendance capability', '403', `${nc.status}`, '', 'requireCapability(HR_ATTENDANCE_VIEW).']);
  // month edge: a punch at 00:30 IST on the 1st of the NEXT month (UTC date is still the 31st)
  const nextMonthFirst = `${addDays(D1.slice(0, 7) + '-28', 8).slice(0, 7)}-01`;
  ins(trainer.id, at(nextMonthFirst, '00:30'));
  const edge = (await get(A.trainer, `${T}/me/punches`, { month: mm })).body?.data ?? [];
  const localMonth = (t) => new Date(Date.parse(String(t).replace(' ', 'T').replace(/\+00$/, 'Z'))).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
  const leaked = edge.filter((r) => localMonth(r.occurred_at) !== mm);
  console.log(`  info: month-window API returned ${edge.length} rows incl. ${leaked.length} from the NEXT org-local month (server pads +-1 day; the page trims)`);
  act('fitness_trainer', AREA, 'month window around a 00:30 punch on the 1st', 'GET', `${T}/me/punches`, mine, { verified: null, expected: 'padding only', note: `${leaked.length} out-of-month rows returned` });

  // ── 2. manual punch ────────────────────────────────────────────────────────
  console.log('\n[2] POST /admin/manual-punch');
  clearUserDays();
  const since = t0();
  const mpIn = await post(A.admin, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: `E2E-manual-in-${stamp}` });
  guard('fitness_manager', 'manual punch in', mpIn, `POST ${T}/admin/manual-punch`);
  const ev1 = eventsOf(trainer.id, D2);
  const dev = (() => { try { return JSON.parse(ev1[0]?.dev ?? '{}'); } catch { return {}; } })();
  act('fitness_manager', AREA, 'add a missed check-in for an employee', 'POST', `${T}/admin/manual-punch`, mpIn, { verified: ev1.length === 1 && ev1[0].src === 'manual', expected: 'allowed (201)' });
  check(mpIn.status === 201 && mpIn.body?.data?.work_date === D2 && ev1.length === 1 && ev1[0].src === 'manual' && dev.manual === true && dev.added_by === admin.id && /E2E-manual-in/.test(dev.reason ?? ''), `check-in -> ${mpIn.status}; DB: source=${ev1[0]?.src}, added_by=${dev.added_by === admin.id ? 'admin' : dev.added_by}, reason kept`, ['high', 'fitness_manager', `POST ${T}/admin/manual-punch`, 'Manual punch provenance', "source 'manual', device_info {manual,reason,added_by = session user}", JSON.stringify({ s: mpIn.status, ev1 }), '', 'attendance-tools.router.ts manual-punch insert.']);
  const mpOut = await post(A.admin, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_out', occurred_at: at(D2, '17:30'), reason: `E2E-manual-out-${stamp}` });
  const d2row = dayRow(trainer.id, D2);
  check(mpOut.status === 201 && d2row && Number(d2row.worked) === 510 && d2row.src === 'events', `check-out -> ${mpOut.status}; attendance_days re-derived: ${JSON.stringify(d2row)} (want 510 min, source events)`, ['high', 'fitness_manager', `POST ${T}/admin/manual-punch`, 'Day recompute after manual punches', 'worked_minutes 510, resolution_source events', JSON.stringify(d2row), '', 'recomputeAttendance after the insert.']);
  await sleep(1200);
  check(auditCount('attendance_manual_punch', trainer.id, since) >= 2, 'audit rows attendance_manual_punch written (2)', ['low', 'fitness_manager', 'audit.activities', 'Manual punch audit', '>= 2 rows', String(auditCount('attendance_manual_punch', trainer.id, since)), '', 'audit() after recompute.']);
  // timezone: 20:30Z the day before = 02:00 IST on D3
  const tz = await post(A.admin, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_in', occurred_at: `${addDays(D3, -1)}T20:30:00Z`, reason: `E2E-manual-tz-${stamp}` });
  check(tz.status === 201 && tz.body?.data?.work_date === D3, `work_date follows the ORG time zone: 20:30Z -> ${tz.body?.data?.work_date} (want ${D3})`, ['high', 'fitness_manager', `POST ${T}/admin/manual-punch`, 'Org-local work date', D3, `${tz.body?.data?.work_date}`, '', 'AT TIME ZONE o.timezone.']);
  const dupBefore = eventsOf(trainer.id, D2).length;
  const dup = await post(A.admin, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: `E2E-manual-dup-${stamp}` });
  const dupAfter = eventsOf(trainer.id, D2).length;
  console.log(`  info: identical duplicate manual check-in -> ${dup.status}, events ${dupBefore} -> ${dupAfter}`);
  if (dup.status < 300 && dupAfter > dupBefore) bug('low', 'fitness_manager', `POST ${T}/admin/manual-punch`, 'Same check-in time submitted twice (double click)', 'The second identical punch is rejected or de-duplicated', `HTTP ${dup.status}; events ${dupBefore} -> ${dupAfter} (a second identical check-in row)`, JSON.stringify(eventsOf(trainer.id, D2)), 'attendance-tools.router.ts manual-punch has no duplicate check; reject an event of the same user/type/occurred_at (or add a unique index) so a double submit does not create a phantom session.');
  const negs = [
    ['future time', { user_id: trainer.id, event_type: 'check_in', occurred_at: new Date(Date.now() + 3600e3).toISOString(), reason: 'E2E-x' }, [400]],
    ['older than 60 days', { user_id: trainer.id, event_type: 'check_in', occurred_at: new Date(Date.now() - 61 * 864e5).toISOString(), reason: 'E2E-x' }, [400]],
    ['on yourself', { user_id: admin.id, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: 'E2E-x' }, [400]],
    ['missing reason', { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '09:00') }, [400, 422]],
    ['blank reason', { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: '  ' }, [400, 422]],
    ['reason > 500', { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: 'x'.repeat(501) }, [400, 422]],
    ['bad event_type', { user_id: trainer.id, event_type: 'break', occurred_at: at(D2, '09:00'), reason: 'E2E-x' }, [400, 422]],
    ['time without offset', { user_id: trainer.id, event_type: 'check_in', occurred_at: `${D2}T09:00:00`, reason: 'E2E-x' }, [400, 422]],
    ['unknown employee', { user_id: UNKNOWN, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: 'E2E-x' }, [404]],
    ...(noidaUser ? [['employee of ANOTHER BRANCH', { user_id: noidaUser, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: 'E2E-x' }, [404]]] : []),
    ...(msqUser ? [['employee of ANOTHER TENANT', { user_id: msqUser, event_type: 'check_in', occurred_at: at(D2, '09:00'), reason: 'E2E-x' }, [404]]] : []),
  ];
  const evCount = () => Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE user_id IN (${inUsers}${msqUser ? `,${lit(msqUser)}` : ''}${noidaUser ? `,${lit(noidaUser)}` : ''}) AND occurred_at >= ${lit(LO)}::timestamptz AND source='manual'`));
  const before = evCount();
  for (const [label, body, want] of negs) {
    const r = await post(A.admin, `${T}/admin/manual-punch`, body);
    guard('fitness_manager', label, r, `POST ${T}/admin/manual-punch`);
    act('fitness_manager', AREA, `manual punch: ${label}`, 'POST', `${T}/admin/manual-punch`, r, { expected: `rejected ${want.join('/')}` });
    check(want.includes(r.status), `${label} -> ${r.status}`, ['high', 'fitness_manager', `POST ${T}/admin/manual-punch`, `Manual punch: ${label}`, `HTTP ${want.join('/')}`, `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Validate in the route; branch fence via inOrg().']);
  }
  check(evCount() === before, 'DB: no manual event written by any rejected attempt', ['critical', 'fitness_manager', `POST ${T}/admin/manual-punch`, 'Rejected manual punches', 'no rows', `${evCount() - before} extra`, '', 'See per-attempt findings.']);
  // who may
  for (const [who, nm, expect] of [[A.trainer, 'fitness_trainer', 'denied'], [A.peer, 'org_manager', 'denied'], [A.orgAdmin, 'org_admin', 'denied'], [A.readOnly, 'read_only', 'denied'], [A.noCap, 'sales_representative', 'denied'], [A.tadmin, 'tenant_admin (Head Office session)', 'other-org'], [A.msqTa, 'other-tenant admin', 'other-org'], [A.noida, 'assistant_fitness_manager (Noida)', 'denied']].filter(([x]) => x)) {
    const b4 = evCount();
    const r = await post(who, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_in', occurred_at: at(D2, '10:00'), reason: 'E2E-x' });
    guard(nm, 'manual punch', r, `POST ${T}/admin/manual-punch`);
    act(nm, AREA, 'manual punch for a Sector 69 employee', 'POST', `${T}/admin/manual-punch`, r, { verified: evCount() === b4, expected: expect === 'denied' ? 'denied' : 'not found (other branch)' });
    check(r.status >= 400 && r.status < 500 && evCount() === b4, `${nm} -> ${r.status}, no row`, ['critical', nm, `POST ${T}/admin/manual-punch`, 'Manual punch without override / from another branch', '403/404 and no row', `HTTP ${r.status}, rows +${evCount() - b4}`, JSON.stringify(r.body).slice(0, 150), 'requireCapability(ADMIN_OVERRIDE) + inOrg().']);
  }
  // payroll lock
  const lockedDay = addDays(todayIso(), -45), lockedMonth = `${lockedDay.slice(0, 7)}-01`;
  q(`DELETE FROM hr.pay_periods WHERE org_id=${lit(orgId)} AND period=${lit(lockedMonth)}`);
  q(`INSERT INTO hr.pay_periods (org_id, period, status, locked_at) VALUES (${lit(orgId)}, ${lit(lockedMonth)}, 'locked', now())`);
  const lockRows = () => Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE user_id=${lit(trainer.id)} AND (occurred_at AT TIME ZONE 'Asia/Kolkata')::date=${lit(lockedDay)}`)) + Number(scalar(`SELECT COUNT(*) FROM hr.attendance_days WHERE user_id=${lit(trainer.id)} AND work_date=${lit(lockedDay)}`));
  const lockBefore = lockRows();
  const lk = await post(A.admin, `${T}/admin/manual-punch`, { user_id: trainer.id, event_type: 'check_in', occurred_at: at(lockedDay, '09:00'), reason: 'E2E-locked' });
  const lkBulk = await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: [trainer.id], work_date: lockedDay, status_name: 'present', reason: 'E2E-locked' });
  const lkRows = lockRows() - lockBefore;
  act('fitness_manager', AREA, 'manual punch / bulk regularize inside a LOCKED payroll month', 'POST', `${T}/admin/*`, { status: `${lk.status}/${lkBulk.status}` }, { verified: lkRows === 0, expected: 'denied (409)' });
  check(lk.status === 409 && lkBulk.status === 409 && lkRows === 0, `locked month: manual punch ${lk.status}, bulk ${lkBulk.status}, rows written=${lkRows}`, ['high', 'fitness_manager', `POST ${T}/admin/manual-punch|bulk-regularize`, 'Payroll month lock', '409 and no row', `${lk.status}/${lkBulk.status} rows=${lkRows}`, JSON.stringify([lk.body, lkBulk.body]).slice(0, 250), 'assertPeriodOpen before any write.']);
  q(`DELETE FROM hr.pay_periods WHERE org_id=${lit(orgId)} AND period=${lit(lockedMonth)}`);

  // ── 3. bulk regularize ─────────────────────────────────────────────────────
  console.log('\n[3] POST /admin/bulk-regularize');
  clearUserDays();
  const since3 = t0();
  const ids = [trainer.id, peer.id, ...(msqUser ? [msqUser] : []), ...(noidaUser ? [noidaUser] : []), UNKNOWN, trainer.id];
  const expectBad = ids.filter((x, i) => ids.indexOf(x) === i).length - 2;
  const br = await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: ids, work_date: D4, status_name: 'wfh', reason: `E2E-bulk-${stamp}` });
  guard('fitness_manager', 'bulk regularize', br, `POST ${T}/admin/bulk-regularize`);
  const bd = br.body?.data;
  const dT = dayRow(trainer.id, D4), dP = dayRow(peer.id, D4);
  const strayDays = Number(scalar(`SELECT COUNT(*) FROM hr.attendance_days WHERE work_date=${lit(D4)} AND user_id IN (${[msqUser, noidaUser, UNKNOWN].filter(Boolean).map(lit).join(',')})`));
  act('fitness_manager', AREA, 'bulk-regularize several people (some invalid)', 'POST', `${T}/admin/bulk-regularize`, br, { verified: bd?.succeeded === 2 && bd?.failed === expectBad && strayDays === 0, expected: 'partial success reported per person' });
  check(br.status === 200 && bd?.requested === ids.length - 1 && bd?.succeeded === 2 && bd?.failed === expectBad && (bd?.results ?? []).filter((r) => !r.ok).every((r) => r.error), `partial failure: requested=${bd?.requested} succeeded=${bd?.succeeded} failed=${bd?.failed} (want ${ids.length - 1}/2/${expectBad}); every failure carries an error`, ['high', 'fitness_manager', `POST ${T}/admin/bulk-regularize`, 'Mixed valid / foreign / unknown / duplicate ids', '200 with per-person results; duplicates collapsed', JSON.stringify(bd).slice(0, 300), '', 'inOrg() split in bulk-regularize.']);
  check(dT?.status === 'wfh' && dT.src === 'regularization' && dP?.status === 'wfh' && strayDays === 0, `DB: both valid people stamped wfh/regularization; 0 rows for foreign/unknown ids (days: ${JSON.stringify(dT)})`, ['critical', 'fitness_manager', `POST ${T}/admin/bulk-regularize`, 'Writes only for valid people', 'valid rows written, foreign/unknown none', JSON.stringify({ dT, dP, strayDays }), '', 'Only ids in valid set are INSERTed.']);
  await sleep(1200);
  check(auditCount('attendance_bulk_regularized', trainer.id, since3) === 1 && auditCount('attendance_bulk_regularized', peer.id, since3) === 1 && (!msqUser || auditCount('attendance_bulk_regularized', msqUser, since3) === 0), 'one audit row per SUCCESSFUL person, none for the rejected', ['medium', 'fitness_manager', 'audit.activities', 'Bulk regularize audit', '1 per valid person', 'mismatch', '', 'audit loop over results.filter(ok).']);
  const br2 = await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: [trainer.id, peer.id], work_date: D4, status_name: 'present', reason: 'E2E-again' });
  check(br2.status === 200 && dayRow(trainer.id, D4)?.status === 'present' && Number(scalar(`SELECT COUNT(*) FROM hr.attendance_days WHERE user_id=${lit(trainer.id)} AND work_date=${lit(D4)}`)) === 1, 'second bulk run upserts the same day (no duplicate row)', ['high', 'fitness_manager', `POST ${T}/admin/bulk-regularize`, 'Re-run', 'upsert on (user_id, work_date)', JSON.stringify(br2.body).slice(0, 150), '', 'ON CONFLICT.']);
  const bneg = [
    ['unknown status', { user_ids: [trainer.id], work_date: D4, status_name: 'on_vacation', reason: 'E2E-x' }, [400]],
    ['future date', { user_ids: [trainer.id], work_date: addDays(todayIso(), 2), status_name: 'present', reason: 'E2E-x' }, [400]],
    ['missing reason', { user_ids: [trainer.id], work_date: D4, status_name: 'present' }, [400, 422]],
    ['empty user_ids', { user_ids: [], work_date: D4, status_name: 'present', reason: 'E2E-x' }, [400, 422]],
    ['101 user_ids', { user_ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), work_date: D4, status_name: 'present', reason: 'E2E-x' }, [400, 422]],
    ['bad uuid', { user_ids: ['nope'], work_date: D4, status_name: 'present', reason: 'E2E-x' }, [400, 422]],
    ['bad date', { user_ids: [trainer.id], work_date: '4/10/2026', status_name: 'present', reason: 'E2E-x' }, [400, 422]],
    ['status of another tenant (id-like string)', { user_ids: [trainer.id], work_date: D4, status_name: "present' OR '1'='1", reason: 'E2E-x' }, [400]],
  ];
  const snapDay = () => scalar(`SELECT COALESCE(string_agg(user_id::text||status_id::text, ',' ORDER BY user_id),'') FROM hr.attendance_days WHERE work_date=${lit(D4)} AND user_id IN (${inUsers})`);
  const dBefore = snapDay();
  for (const [label, body, want] of bneg) {
    const r = await post(A.admin, `${T}/admin/bulk-regularize`, body);
    guard('fitness_manager', label, r, `POST ${T}/admin/bulk-regularize`);
    check(want.includes(r.status), `${label} -> ${r.status}`, ['medium', 'fitness_manager', `POST ${T}/admin/bulk-regularize`, `Bulk regularize: ${label}`, want.join('/'), `${r.status}`, JSON.stringify(r.body).slice(0, 150), 'bulkRegularizeSchema / status lookup.']);
  }
  check(snapDay() === dBefore, 'DB: invalid bulk requests changed nothing');
  // self
  const selfR = await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: [admin.id], work_date: D4, status_name: 'present', reason: 'E2E-self' });
  const selfDay = dayRow(admin.id, D4);
  act('fitness_manager', AREA, 'bulk-regularize YOUR OWN day', 'POST', `${T}/admin/bulk-regularize`, selfR, { verified: !selfDay, expected: 'denied (manual-punch forbids self)' });
  check(!(selfR.status < 300 && selfR.body?.data?.succeeded === 1 && selfDay), `admin cannot regularize their own day (HTTP ${selfR.status}, succeeded=${selfR.body?.data?.succeeded}, row=${!!selfDay})`, ['medium', 'fitness_manager', `POST ${T}/admin/bulk-regularize`, 'Segregation of duties: admin marks their own attendance', 'Refused, like manual-punch ("You cannot add a punch to your own attendance")', `HTTP ${selfR.status}; own day ${D4} written as ${selfDay?.status}/${selfDay?.src}`, JSON.stringify(selfR.body).slice(0, 200), 'msq-hrms attendance-tools.router.ts bulk-regularize (~line 121-150): manual-punch rejects b.user_id === c.user_id but the bulk path only checks inOrg(); drop c.user_id from ids (report it as ok:false "You cannot change your own attendance").']);
  for (const [who, nm] of [[A.trainer, 'fitness_trainer'], [A.peer, 'org_manager'], [A.orgAdmin, 'org_admin'], [A.readOnly, 'read_only'], [A.tadmin, 'tenant_admin (Head Office session)'], [A.msqTa, 'other-tenant admin'], [A.noida, 'assistant_fitness_manager (Noida)']].filter(([x]) => x)) {
    const b4 = snapDay();
    const r = await post(who, `${T}/admin/bulk-regularize`, { user_ids: [trainer.id, peer.id], work_date: D4, status_name: 'absent', reason: 'E2E-x' });
    guard(nm, 'bulk regularize', r, `POST ${T}/admin/bulk-regularize`);
    const noWrite = snapDay() === b4;
    act(nm, AREA, 'bulk-regularize Sector 69 people', 'POST', `${T}/admin/bulk-regularize`, r, { verified: noWrite, expected: 'denied or nothing written' });
    // a manager of ANOTHER branch legitimately gets 200 with every id reported not-in-branch
    const ok = r.status >= 400 || (r.status === 200 && r.body?.data?.succeeded === 0);
    check(ok && noWrite, `${nm} -> ${r.status}${r.status === 200 ? ` succeeded=${r.body?.data?.succeeded}` : ''}, nothing written`, ['critical', nm, `POST ${T}/admin/bulk-regularize`, 'Bulk regularize without override or from another branch', '403, or 200 with every person ok:false', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 150)} written=${!noWrite}`, '', 'requireCapability + inOrg().']);
  }

  // ── 4. nudge + me/nudges ───────────────────────────────────────────────────
  console.log('\n[4] nudge and the banner feed');
  clearUserDays();
  const today = todayIso();
  const since4 = t0();
  const nu = await post(A.admin, `${T}/admin/nudge`, { user_ids: [trainer.id, peer.id, admin.id, ...(noidaUser ? [noidaUser] : []), ...(msqUser ? [msqUser] : []), UNKNOWN], work_date: today });
  guard('fitness_manager', 'nudge', nu, `POST ${T}/admin/nudge`);
  await sleep(1200);
  const nT = auditCount('attendance_nudge', trainer.id, since4), nP = auditCount('attendance_nudge', peer.id, since4);
  const nStray = [admin.id, noidaUser, msqUser].filter(Boolean).reduce((s, u) => s + auditCount('attendance_nudge', u, since4), 0);
  act('fitness_manager', AREA, 'nudge people who have not punched', 'POST', `${T}/admin/nudge`, nu, { verified: nu.body?.data?.nudged === 2 && nStray === 0, expected: 'nudges the 2 valid non-punchers' });
  check(nu.status === 200 && nu.body?.data?.nudged === 2 && nT === 1 && nP === 1 && nStray === 0, `nudge -> requested=${nu.body?.data?.requested} nudged=${nu.body?.data?.nudged}; audit trainer=${nT} peer=${nP}, self/other-branch/other-tenant=${nStray}`, ['high', 'fitness_manager', `POST ${T}/admin/nudge`, 'Nudge a mixed list', 'only branch members who have not punched, never the caller / other branch / other tenant', JSON.stringify({ body: nu.body, nT, nP, nStray }), '', 'inOrg() + id !== caller.']);
  const feed = await get(A.trainer, `${T}/me/nudges`);
  guard('fitness_trainer', 'my nudges', feed, `GET ${T}/me/nudges`);
  const mineN = feed.body?.data ?? [];
  act('fitness_trainer', AREA, 'see the reminder HR sent me', 'GET', `${T}/me/nudges`, feed, { verified: mineN.length >= 1, expected: 'banner feed shows the nudge', tab: 'Dashboard' });
  check(feed.status === 200 && mineN.length >= 1 && mineN[0].from_name === admin.name, `trainer's feed has the nudge from "${mineN[0]?.from_name}" (want ${admin.name})`, ['high', 'fitness_trainer', `GET ${T}/me/nudges`, 'Nudge banner feed', 'the reminder with the sender\'s name', JSON.stringify(feed.body).slice(0, 200), '', 'audit.activities target_id = caller.']);
  for (const [who, nm] of [[A.noCap, 'sales_representative (no attendance.view)'], [A.msqRep, 'other-tenant employee'], [A.orgAdmin, 'org_admin']].filter(([x]) => x)) {
    const r = await get(who, `${T}/me/nudges`);
    guard(nm, 'my nudges', r, `GET ${T}/me/nudges`);
    check(!(Array.isArray(r.body?.data) && r.body.data.some((n) => n.work_date === today && n.from_name === admin.name)), `${nm} does not see the trainer's nudge (${r.status})`, ['critical', nm, `GET ${T}/me/nudges`, 'Nudge feed scope', 'only my own', 'saw another person\'s nudge', '', 'target_id = caller + org.']);
  }
  // after peer punches, the next nudge skips him
  await post(A.admin, `${T}/admin/manual-punch`, { user_id: peer.id, event_type: 'check_in', occurred_at: new Date(Date.now() - 5 * 60e3).toISOString(), reason: `E2E-nudge-setup-${stamp}` });
  const nu2 = await post(A.admin, `${T}/admin/nudge`, { user_ids: [trainer.id, peer.id], work_date: today });
  check(nu2.status === 200 && nu2.body?.data?.nudged === 1, `a person who has already punched is not nudged (nudged=${nu2.body?.data?.nudged}, want 1)`, ['high', 'fitness_manager', `POST ${T}/admin/nudge`, 'Nudge a person who has punched today', 'skipped', JSON.stringify(nu2.body), '', 'punched set in the nudge handler.']);
  for (const [who, nm] of [[A.trainer, 'fitness_trainer'], [A.peer, 'org_manager'], [A.orgAdmin, 'org_admin'], [A.readOnly, 'read_only']].filter(([x]) => x)) {
    const r = await post(who, `${T}/admin/nudge`, { user_ids: [trainer.id], work_date: today });
    check(r.status === 403, `${nm} nudge -> ${r.status}`, ['high', nm, `POST ${T}/admin/nudge`, 'Nudge without override', '403', `${r.status}`, '', 'requireCapability(ADMIN_OVERRIDE).']);
  }
  for (const [who, nm] of [[A.msqTa, 'other-tenant admin'], [A.tadmin, 'tenant_admin (Head Office session)']].filter(([x]) => x)) {
    const b4 = auditCount('attendance_nudge', trainer.id, since4);
    const r = await post(who, `${T}/admin/nudge`, { user_ids: [trainer.id], work_date: today });
    await sleep(800);
    check(r.status < 300 ? r.body?.data?.nudged === 0 && auditCount('attendance_nudge', trainer.id, since4) === b4 : r.status >= 400, `${nm} nudging a Sector 69 employee reaches nobody (${r.status} nudged=${r.body?.data?.nudged})`, ['critical', nm, `POST ${T}/admin/nudge`, 'Nudge across branch/tenant', 'nudged 0', JSON.stringify(r.body), '', 'inOrg().']);
  }
  const bad = [['empty list', { user_ids: [], work_date: today }], ['bad date', { user_ids: [trainer.id], work_date: 'today' }], ['201 ids', { user_ids: Array.from({ length: 201 }, () => UNKNOWN), work_date: today }]];
  for (const [label, body] of bad) { const r = await post(A.admin, `${T}/admin/nudge`, body); check(r.status === 400 || r.status === 422, `nudge ${label} -> ${r.status}`, ['low', 'fitness_manager', `POST ${T}/admin/nudge`, label, '400/422', `${r.status}`, '', 'nudgeSchema.']); }
  // date sanity + throttling
  const fut = await post(A.admin, `${T}/admin/nudge`, { user_ids: [trainer.id], work_date: addDays(today, 30) });
  const rep = [];
  for (let i = 0; i < 4; i++) rep.push((await post(A.admin, `${T}/admin/nudge`, { user_ids: [trainer.id], work_date: today })).body?.data?.nudged);
  await sleep(800);
  const rowsN = auditCount('attendance_nudge', trainer.id, since4);
  console.log(`  info: nudge for a date 30 days AHEAD -> nudged=${fut.body?.data?.nudged}; 4 back-to-back nudges -> ${rep.join(',')} (audit rows for the trainer now ${rowsN})`);
  if (fut.status < 300 && fut.body?.data?.nudged > 0) bug('low', 'fitness_manager', `POST ${T}/admin/nudge`, 'Nudge with a work_date in the future', 'Rejected (a person cannot have "not punched" on a day that has not happened)', `nudged=${fut.body.data.nudged}: the trainer's Home banner would say "you have not punched in" for next month`, JSON.stringify(fut.body), 'attendance-tools.router.ts nudge: validate work_date <= today (and ideally skip people on approved leave / weekly off / holiday that day).');
  if (rep.every((n) => n === 1)) bug('low', 'fitness_manager', `POST ${T}/admin/nudge`, 'Repeated nudges to the same person', 'Throttled (one reminder per person per day)', `4 back-to-back nudges all delivered (${rowsN} audit rows for one person) — the banner can be spammed`, JSON.stringify(rep), 'Skip people already nudged today for that work_date (check audit.activities) or rate-limit per actor.');

  // ── 5. muster ──────────────────────────────────────────────────────────────
  console.log('\n[5] muster report scope + consistency');
  clearUserDays();
  const mm5 = month(D1);
  await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: [trainer.id], work_date: D1, status_name: 'present', reason: 'E2E-muster' });
  await post(A.admin, `${T}/admin/bulk-regularize`, { user_ids: [peer.id], work_date: D1, status_name: 'absent', reason: 'E2E-muster' });
  const mu = await get(A.admin, `${T}/reports/muster`, { month: mm5, branch: 'current', format: 'json' });
  guard('fitness_manager', 'muster', mu, `GET ${T}/reports/muster`);
  const mrows = mu.body?.data?.rows ?? [];
  const cell = (uid) => mrows.find((r) => r.user_id === uid)?.days?.[Number(D1.slice(8, 10)) - 1];
  act('fitness_manager', AREA, 'open the combined attendance (muster) sheet for my branch', 'GET', `${T}/reports/muster`, mu, { verified: cell(trainer.id) === 'P' && cell(peer.id) === 'A', expected: 'allowed', tab: 'Reports > Muster' });
  check(mu.status === 200 && cell(trainer.id) === 'P' && cell(peer.id) === 'A', `muster ${D1}: trainer=${cell(trainer.id)} (want P), peer=${cell(peer.id)} (want A) — matches the DB days`, ['high', 'fitness_manager', `GET ${T}/reports/muster`, 'Muster vs hr.attendance_days', 'P / A', `${cell(trainer.id)} / ${cell(peer.id)}`, '', 'musterDay() / reportMuster.']);
  check(mrows.every((r) => r.org_id === orgId), `branch=current returns only Sector 69 rows (${mrows.length})`, ['critical', 'fitness_manager', `GET ${T}/reports/muster`, 'Muster scope', 'only the session branch', 'rows from other branches', '', 'tenantBranches filter.']);
  check(mrows.every((r) => r.total_paid === r.present + r.weekoff_paid + r.paid_leave + r.holidays), 'total_paid = present + weekoff + paid leave + holidays for every row');
  const forb = [
    ['branch=all as a branch-level manager', A.admin, { month: mm5, branch: 'all' }],
    ['org_id of another branch (same tenant)', A.admin, { month: mm5, org_id: scalar(`SELECT id FROM entity.organizations WHERE name='Noida - Knowledge Park 2'`) }],
    ['org_id of another tenant', A.admin, { month: mm5, org_id: A.msqTa?.me.org_id ?? UNKNOWN }],
    ...(A.msqTa ? [['org_id of a Fitclass branch as the other tenant\'s admin', A.msqTa, { month: mm5, org_id: orgId }]] : []),
  ];
  for (const [label, who, query] of forb) {
    const r = await get(who, `${T}/reports/muster`, query);
    guard(who.key, label, r, `GET ${T}/reports/muster`);
    act(who.key, AREA, `muster: ${label}`, 'GET', `${T}/reports/muster`, r, { expected: 'denied (403)' });
    check(r.status === 403 && !(r.body?.data?.rows?.length), `${label} -> ${r.status}`, ['critical', who.key, `GET ${T}/reports/muster`, label, '403 (not an empty sheet)', `HTTP ${r.status} rows=${r.body?.data?.rows?.length}`, JSON.stringify(r.body).slice(0, 150), 'musterReport() reach/branch checks.']);
  }
  if (A.tadmin) {
    const all = await get(A.tadmin, `${T}/reports/muster`, { month: mm5, branch: 'all' });
    const orgs = new Set((all.body?.data?.rows ?? []).map((r) => r.org_id));
    const foreignOrgs = [...orgs].filter((o) => scalar(`SELECT tenant_id::text FROM entity.organizations WHERE id=${lit(o)}`) !== tenantId);
    const branches = (all.body?.data?.branches ?? []).map((b) => b.id);
    const foreignBranches = branches.filter((o) => scalar(`SELECT tenant_id::text FROM entity.organizations WHERE id=${lit(o)}`) !== tenantId);
    act('tenant_admin', AREA, 'muster for ALL branches of the tenant', 'GET', `${T}/reports/muster`, all, { verified: foreignOrgs.length === 0, expected: 'tenant reach' });
    check(all.status === 200 && foreignOrgs.length === 0 && foreignBranches.length === 0, `tenant_admin branch=all -> ${all.status}: ${orgs.size} branch(es) of data, ${branches.length} offered, 0 outside the tenant`, ['critical', 'tenant_admin', `GET ${T}/reports/muster`, 'branch=all', 'only branches of the caller\'s tenant', `${foreignOrgs.length} foreign data orgs, ${foreignBranches.length} foreign branches offered`, '', 'tenantBranches derives from the verified tenant.']);
  }
  if (A.msqTa) {
    const all = await get(A.msqTa, `${T}/reports/muster`, { month: mm5, branch: 'all' });
    const leakedRows = (all.body?.data?.rows ?? []).filter((r) => scalar(`SELECT tenant_id::text FROM entity.organizations WHERE id=${lit(r.org_id)}`) !== A.msqTa.me.tenant_id);
    check(leakedRows.length === 0, `other-tenant admin branch=all -> ${all.status}, ${(all.body?.data?.rows ?? []).length} rows, 0 from Fitclass`, ['critical', 'msq_tenant_admin', `GET ${T}/reports/muster`, 'Cross-tenant muster', 'none of Fitclass', `${leakedRows.length} Fitclass rows`, '', 'Tenant fence.']);
  }
  for (const [who, nm] of [[A.trainer, 'fitness_trainer'], [A.peer, 'org_manager'], [A.orgAdmin, 'org_admin'], [A.readOnly, 'read_only']].filter(([x]) => x)) {
    const r = await get(who, `${T}/reports/muster`, { month: mm5 });
    check(r.status === 403, `${nm} muster -> ${r.status}`, ['high', nm, `GET ${T}/reports/muster`, 'Muster without hr.reports.attendance.view', '403', `${r.status}`, '', 'requireCapability(HR_REPORTS_ATTENDANCE_VIEW).']);
  }
  const xl = await A.admin.request.get(`${API}${T}/reports/muster?month=${mm5}&format=xlsx`, { failOnStatusCode: false });
  const ct = xl.headers()['content-type'] ?? '', cd = xl.headers()['content-disposition'] ?? '';
  check(xl.status() === 200 && /spreadsheetml/.test(ct) && /\.xlsx/.test(cd), `format=xlsx -> ${xl.status()} ${ct.slice(0, 50)} ${cd.slice(0, 60)}`, ['medium', 'fitness_manager', `GET ${T}/reports/muster`, 'XLSX download', 'spreadsheet content-type + filename', `${xl.status()} ${ct} ${cd}`, '', 'musterXlsx().']);
  for (const [label, q_] of [['month 2026-13', { month: '2026-13' }], ['format=csv', { month: mm5, format: 'csv' }], ['branch=everything', { month: mm5, branch: 'everything' }], ['org_id not a uuid', { month: mm5, org_id: 'x' }]]) {
    const r = await get(A.admin, `${T}/reports/muster`, q_);
    check(r.status === 400 || r.status === 422, `muster ${label} -> ${r.status}`, ['low', 'fitness_manager', `GET ${T}/reports/muster`, label, '400/422', `${r.status}`, '', 'reportsMusterQuerySchema.']);
  }

  // ── 6. month-end readiness ─────────────────────────────────────────────────
  console.log('\n[6] payroll readiness vs the DB');
  const RM = RMONTH;
  const readyAs = async (who) => (await get(who, '/hr/payroll/admin/readiness', { month: RM }));
  const dbCounts = (oid) => {
    const first = `${RM}-01`;
    const end = `(${lit(first)}::date + INTERVAL '1 month')::date`;
    const n = (sqlText) => Number(scalar(sqlText));
    return {
      headcount: n(`SELECT count(*) FROM hr.employee_profiles WHERE org_id=${lit(oid)} AND is_active AND NOT is_deleted`),
      pending_regularizations: n(`SELECT count(*) FROM hr.attendance_regularizations WHERE org_id=${lit(oid)} AND status='pending' AND NOT is_deleted AND work_date >= ${lit(first)}::date AND work_date < ${end}`),
      pending_leave: n(`SELECT count(*) FROM hr.leave_requests lr JOIN hr.leave_request_statuses s ON s.id=lr.status_id WHERE lr.org_id=${lit(oid)} AND s.name='pending' AND NOT lr.is_deleted AND lr.start_date < ${end} AND lr.end_date >= ${lit(first)}::date`),
      missed_punch_days: n(`SELECT count(*) FROM hr.attendance_days d JOIN hr.attendance_statuses s ON s.id=d.status_id WHERE d.org_id=${lit(oid)} AND s.name='missed_punch' AND d.work_date >= ${lit(first)}::date AND d.work_date < ${end}`),
      draft_payslips: n(`SELECT count(*) FROM hr.payslips WHERE org_id=${lit(oid)} AND period=${lit(first)}::date AND published_at IS NULL AND NOT is_deleted`),
      published_payslips: n(`SELECT count(*) FROM hr.payslips WHERE org_id=${lit(oid)} AND period=${lit(first)}::date AND published_at IS NOT NULL AND NOT is_deleted`),
    };
  };
  const payrollActors = [[A.tadmin, 'tenant_admin'], [A.hr, 'hr_admin'], [A.sa, 'super_admin'], [A.msqTa, 'other-tenant admin'], [A.msqOa, 'other-tenant org admin']].filter(([x]) => x);
  const baseline = new Map();
  for (const [who, nm] of payrollActors) {
    const r = await readyAs(who);
    guard(nm, 'readiness', r, '/hr/payroll/admin/readiness');
    if (r.status === 403) { console.log(`  ${nm}: no payroll.manage -> 403`); act(nm, AREA, 'open the month-end readiness checklist', 'GET', '/hr/payroll/admin/readiness', r, { expected: 'denied (no capability)' }); continue; }
    const d = r.body?.data ?? {}, db = dbCounts(who.me.org_id);
    const same = Object.keys(db).every((k) => d[k] === db[k]);
    baseline.set(nm, d);
    act(nm, AREA, 'open the month-end readiness checklist', 'GET', '/hr/payroll/admin/readiness', r, { verified: same, expected: 'counts equal the DB for my branch', tab: 'Payroll' });
    check(r.status === 200 && same && d.month === RM, `${nm} (${who.me.org_name}): API ${JSON.stringify(Object.fromEntries(Object.keys(db).map((k) => [k, d[k]])))} == DB ${JSON.stringify(db)}`, ['high', nm, '/hr/payroll/admin/readiness', 'Readiness counts vs DB', 'every count equals the DB for the session branch', `API ${JSON.stringify(d)} DB ${JSON.stringify(db)}`, '', 'payroll.router.ts readiness queries.']);
  }
  // seed in one org, see the delta there and ONLY there
  const seedActor = payrollActors.find(([w]) => baseline.has(w === A.tadmin ? 'tenant_admin' : w === A.hr ? 'hr_admin' : w === A.sa ? 'super_admin' : w === A.msqTa ? 'other-tenant admin' : 'other-tenant org admin'));
  if (seedActor) {
    const [who, nm] = seedActor;
    const uid = seedTargets.get(who.me.org_id), oid = who.me.org_id;
    const stId = scalar(`SELECT s.id FROM hr.attendance_statuses s JOIN entity.organizations o ON o.tenant_id=s.tenant_id WHERE o.id=${lit(oid)} AND s.name='missed_punch'`);
    if (uid && stId) {
      const [d1, d2] = SEED_DATES;
      const myBase = dbCounts(oid).missed_punch_days;
      q(`DELETE FROM hr.attendance_days WHERE user_id=${lit(uid)} AND work_date IN (${lit(d1)}, ${lit(d2)})`);
      for (const d of [d1, d2]) q(`INSERT INTO hr.attendance_days (user_id, org_id, work_date, status_id, resolution_source) VALUES (${lit(uid)}, ${lit(oid)}, ${lit(d)}, ${lit(stId)}, 'events')`);
      const after = (await readyAs(who)).body?.data;
      check(after?.missed_punch_days === myBase + 2, `${nm}: seeding 2 missed-punch days moves missed_punch_days ${myBase} -> ${after?.missed_punch_days} (want +2)`, ['high', nm, '/hr/payroll/admin/readiness', 'Readiness reflects new missed punches', `${myBase + 2}`, `${after?.missed_punch_days}`, '', 'missed_punch_days query.']);
      for (const [w2, n2] of payrollActors) {
        if (w2 === who || !baseline.has(n2) || w2.me.org_id === oid) continue;
        const o = (await readyAs(w2)).body?.data;
        check(o?.missed_punch_days === baseline.get(n2).missed_punch_days, `${n2} (other branch/tenant) unaffected by the seed (${o?.missed_punch_days})`, ['critical', n2, '/hr/payroll/admin/readiness', 'Readiness isolation', 'counts of another branch/tenant do not move', `${o?.missed_punch_days} vs ${baseline.get(n2).missed_punch_days}`, '', 'org fence in every readiness query.']);
      }
      q(`DELETE FROM hr.attendance_days WHERE user_id=${lit(uid)} AND work_date IN (${lit(d1)}, ${lit(d2)})`);
    } else console.log('  (no employee/status to seed in the payroll actor\'s branch — delta test skipped)');
  }
  for (const [who, nm] of [[A.admin, 'fitness_manager'], [A.trainer, 'fitness_trainer'], [A.peer, 'org_manager'], [A.orgAdmin, 'org_admin'], [A.readOnly, 'read_only'], [A.noida, 'assistant_fitness_manager']].filter(([x]) => x)) {
    const r = await readyAs(who);
    act(nm, AREA, 'open the month-end readiness checklist', 'GET', '/hr/payroll/admin/readiness', r, { expected: 'denied (no payroll.manage)' });
    check(r.status === 403, `${nm} readiness -> ${r.status}`, ['high', nm, '/hr/payroll/admin/readiness', 'Readiness without hr.reports.payroll.manage', '403', `${r.status}`, '', 'requireCapability(HR_REPORTS_PAYROLL_MANAGE).']);
  }
  for (const [label, query] of [['no month', {}], ['month 2026-13', { month: '2026-13' }], ['month "abc"', { month: 'abc' }]]) {
    const who = payrollActors[0]?.[0]; if (!who) break;
    const r = await get(who, '/hr/payroll/admin/readiness', query);
    check(r.status === 400 || r.status === 422, `readiness ${label} -> ${r.status}`, ['low', payrollActors[0][1], '/hr/payroll/admin/readiness', label, '400/422', `${r.status}`, '', 'payrollMonthQuerySchema.']);
  }
} finally {
  try { runRestore(key); } catch (e) { console.log(`  !! restore failed: ${String(e.message).split('\n')[0]} — run restore.mjs`); }
  const left = Number(scalar(`SELECT COUNT(*) FROM hr.attendance_events WHERE user_id IN (${inUsers}) AND source='manual' AND device_info->>'reason' LIKE 'E2E-%'`));
  console.log(`\ncleanup: restored events/days/pay_periods from snapshot; E2E manual events remaining = ${left}.`);
  await closeActors(A);
}
console.log(`hr-punch-hub-admin: ${findingCount()} finding(s).`);
