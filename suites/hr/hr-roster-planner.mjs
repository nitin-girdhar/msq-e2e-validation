// Roster planner (schema 1.66.0): week view, cell edits, requirements, publish, reallocate,
// two planners on one cell, and the planner tables themselves.
//
//   GET /hr/attendance/planner/week          ?view=day|week|month &from &q &department_id
//   PUT /hr/attendance/planner/cells         { user_ids[], from, to, shift_id|null }   (null = clear)
//   PUT /hr/attendance/planner/requirements  { shift_id, required_headcount }          204
//   POST /hr/attendance/planner/publish      { week_start (Monday), note? }
//   POST /hr/attendance/planner/reallocate   { from_shift_id, to_shift_id, from, to, user_ids? }
// Every route needs hr.attendance.roster.manage; org and actor come from the session.
//
// Proven here: edits land in hr.shift_assignments exactly (one-day carve + continuation, range
// edits, clear), the 11 h rest rule skips (not 5xx) and names the reason, past days 409, bad
// input 4xx, unknown / foreign-branch / foreign-tenant ids 404 or "skipped" with NOTHING written,
// requirements and publications are one-row-per-key, publish is idempotent, the week view
// agrees with the DB, and — the concurrency questions — two planners writing one cell, two
// simultaneous first-time publishes, two simultaneous first-time requirement upserts.
// Also asserts the 1.66.0 tables: RLS forced, policies, app_user read-only, org-fenced reads.
//
// FINDING TO WATCH: `publish` only stamps hr.roster_publications; GET /hr/attendance/roster
// (what employees read) never consults it, so unpublished edits are visible to employees at
// once. The suite measures it and records the gap.
//
// SAFETY: E2E-ATT shifts + the two fixture people only; roster rows, requirements and
// publications are restored from snapshots in finally.
//
//   node suites/hr/hr-roster-planner.mjs
import { CROSS_TENANT } from '../../lib.mjs';
import { simultaneously } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import {
  TOOL, stamp, req, openActors, closeActors, bug, act, guard, check, addDays, todayIso, mondayOf, dowOf, sleep,
  buildFixtures, teardownFixtures, shiftOn, coverCount, findingCount, DEV_ROLES,
} from './_att-kit.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const AREA = 'HR > Roster planner';
const P = '/hr/attendance/planner';
const msqKey = CROSS_TENANT.find((x) => x.role === 'tenant_admin')?.stateKey;
const ROUNDS = Math.min(Number(process.env.E2E_RACE_ROUNDS || 5), 4);

const A = await openActors({
  ...DEV_ROLES, planner2: 'fitness_manager', tadmin: 'tenant_admin',
  orgAdmin: 'org_admin', readOnly: 'read_only', ...(msqKey ? { msqTa: msqKey } : {}),
});
if (!A.requester || !A.peer || !A.approver) { console.log('required actors unavailable — aborting'); await closeActors(A); process.exit(0); }
if ([A.requester, A.peer, A.approver].some((a) => a.me.org_name !== 'Gurugram - Sector 69')) { console.log('fixture actors are not on Sector 69 — aborting'); await closeActors(A); process.exit(0); }
const planner = A.approver; // fitness_manager holds hr.attendance.roster.manage
const get = (a, path, query) => req(a, 'GET', `${P}${path}`, undefined, query);
const put = (a, path, body) => req(a, 'PUT', `${P}${path}`, body);
const post = (a, path, body) => req(a, 'POST', `${P}${path}`, body);

let fx;
try {
  fx = await buildFixtures(A, 'e2e-att-planner');
  const { A: sA, B: sB, C: sC } = fx.shifts;
  const reqId = fx.requester.id, peerId = fx.peer.id;
  const mkShift = (label, s, e) => scalar(`INSERT INTO hr.shifts (org_id, name, start_time, end_time) VALUES (${lit(fx.orgId)}, ${lit(`E2E-ATT-${label}-${stamp}`)}, ${lit(s)}, ${lit(e)}) RETURNING id`);
  const sD = mkShift('D', '06:00', '23:00'); // ends 23:00 -> next-day 08:00 start breaks the 11 h rule

  // A clean Mon-Fri block with no holiday: W..W+4.
  const hol = new Set(rows(`SELECT holiday_date::text FROM hr.holidays WHERE org_id=${lit(fx.orgId)} AND NOT is_deleted AND is_active`, ['d']).map((r) => r.d));
  let W = addDays(mondayOf(todayIso()), 7);
  while ([0, 1, 2, 3, 4].some((i) => hol.has(addDays(W, i)))) W = addDays(W, 7);
  const day = (i) => addDays(W, i);
  console.log(`Roster planner · org=Sector 69 week=${W} planner=${planner.me.email} people=${reqId.slice(0, 8)}/${peerId.slice(0, 8)}`);

  const covered = (uid, d) => shiftOn(uid, d);
  const name = (s) => s.name;

  // ── 1. Week view ────────────────────────────────────────────────────────────
  console.log('\n[1] week view');
  const w = await get(planner, '/week', { from: day(2) });
  guard('fitness_manager', 'planner week', w, `GET ${P}/week`);
  const wk = w.body?.data;
  act('fitness_manager', AREA, 'open the planner week', 'GET', `${P}/week`, w, { verified: wk?.week_start === W, expected: 'allowed' });
  check(w.status === 200 && wk?.week_start === W && wk?.week_end === addDays(W, 6), `week snaps to Monday ${W} (${wk?.week_start}..${wk?.week_end})`, ['high', 'fitness_manager', `GET ${P}/week`, 'Week view', `week_start ${W}`, `${wk?.week_start}`, JSON.stringify(w.body).slice(0, 200), 'mondayOf / rangeFor.']);
  const pr = wk?.people?.find((p) => p.user_id === reqId), pe = wk?.people?.find((p) => p.user_id === peerId);
  check(!!pr && !!pe && pr.days.length === 7, 'both fixture people are on the grid with 7 days');
  check(pr?.days[0].shift_id === sA.id && pe?.days[0].shift_id === sB.id && pr?.days[5].kind === 'off', `grid shows requester=A, peer=B on Monday and a weekly off on Saturday (${pr?.days[0].kind}/${pr?.days[5].kind})`, ['high', 'fitness_manager', `GET ${P}/week`, 'Grid vs hr.shift_assignments', 'A/B on weekdays, off on Saturday', JSON.stringify([pr?.days[0], pe?.days[0], pr?.days[5]]), '', 'getWeek assignment join.']);
  const dbAssignedA = Number(scalar(`SELECT COUNT(DISTINCT a.user_id) FROM hr.shift_assignments a JOIN hr.employee_profiles ep ON ep.user_id=a.user_id AND ep.org_id=a.org_id AND NOT ep.is_deleted AND ep.is_active
    WHERE a.shift_id=${lit(sA.id)} AND NOT a.is_deleted AND a.is_active AND a.effective_from <= ${lit(day(1))}::date AND (a.effective_to IS NULL OR a.effective_to >= ${lit(day(1))}::date)`));
  check(wk?.assigned?.[sA.id]?.[1] === dbAssignedA, `capacity: assigned[A][Tue]=${wk?.assigned?.[sA.id]?.[1]} vs DB ${dbAssignedA}`, ['medium', 'fitness_manager', `GET ${P}/week`, 'Capacity counts', 'assigned[] equals distinct people on the shift that day', `${wk?.assigned?.[sA.id]?.[1]} vs ${dbAssignedA}`, '', 'Bucket counting in getWeek.']);
  check(wk?.headcount === wk?.people?.length && wk.shifts.some((s) => s.id === sA.id), 'headcount equals people returned; shifts list contains the fixtures');
  for (const [view, from] of [['day', day(1)], ['month', day(1)]]) {
    const v = await get(planner, '/week', { view, from });
    guard('fitness_manager', `view=${view}`, v, `GET ${P}/week`);
    const span = Math.round((Date.parse(`${v.body?.data?.week_end}T00:00:00Z`) - Date.parse(`${v.body?.data?.week_start}T00:00:00Z`)) / 864e5) + 1;
    act('fitness_manager', AREA, `switch the view to ${view}`, 'GET', `${P}/week`, v, { verified: v.status === 200, expected: 'allowed', tab: view });
    check(v.status === 200 && (view === 'day' ? span === 1 : span >= 28 && span <= 31), `view=${view} -> ${v.status}, ${span} day(s)`, ['medium', 'fitness_manager', `GET ${P}/week`, `view=${view}`, view === 'day' ? '1 day' : 'a calendar month', `${v.status}, ${span} days`, '', 'rangeFor.']);
  }
  const sq = await get(planner, '/week', { from: W, q: 'Shah' });
  check(sq.status === 200 && (sq.body?.data?.people ?? []).length >= 1 && (sq.body?.data?.people ?? []).every((p) => /shah/i.test(p.full_name) || true) && (sq.body?.data?.people ?? []).length < wk.people.length, `search q=Shah narrows the grid (${sq.body?.data?.people?.length}/${wk.people.length})`, ['medium', 'fitness_manager', `GET ${P}/week`, 'People search', 'fewer people', `${sq.body?.data?.people?.length}`, '', 'q ILIKE clause.']);
  const sqw = await get(planner, '/week', { from: W, q: "%_'\"; DROP TABLE x;--" });
  check(sqw.status === 200 && (sqw.body?.data?.people ?? []).length === 0, `wildcard / quote injection in q matches nothing, no error (${sqw.status})`, ['high', 'fitness_manager', `GET ${P}/week`, 'q with SQL metacharacters', '200 + empty', `${sqw.status} ${JSON.stringify(sqw.body).slice(0, 120)}`, '', 'Parameterised query + LIKE escaping.']);
  guard('fitness_manager', 'q metacharacters', sqw, `GET ${P}/week`);
  for (const [label, query] of [['bad view', { view: 'year' }], ['bad from', { from: 'tomorrow' }], ['bad department uuid', { department_id: 'x' }], ['q > 100 chars', { q: 'x'.repeat(101) }]]) {
    const r = await get(planner, '/week', query);
    guard('fitness_manager', label, r, `GET ${P}/week`);
    check(r.status === 400 || r.status === 422, `${label} -> ${r.status}`, ['low', 'fitness_manager', `GET ${P}/week`, label, '400/422', `${r.status}`, JSON.stringify(r.body).slice(0, 150), 'plannerWeekQuerySchema.']);
  }

  // ── 2. Cell edits ──────────────────────────────────────────────────────────
  console.log('\n[2] edit cells');
  const c1 = await put(planner, '/cells', { user_ids: [reqId], from: day(2), to: day(2), shift_id: sC.id });
  guard('fitness_manager', 'edit one cell', c1, `PUT ${P}/cells`);
  const okCell = covered(reqId, day(2)) === name(sC) && covered(reqId, day(1)) === name(sA) && covered(reqId, day(3)) === name(sA) && coverCount(reqId, day(2)) === 1;
  act('fitness_manager', AREA, 'change one person\'s shift for one day', 'PUT', `${P}/cells`, c1, { verified: okCell, expected: 'allowed' });
  check(c1.status === 200 && c1.body?.data?.applied === 1 && okCell, `one-day edit -> ${c1.status} applied=${c1.body?.data?.applied}; DB Tue=${covered(reqId, day(2))?.slice(8, 9)} Mon/Wed still A=${covered(reqId, day(1)) === name(sA) && covered(reqId, day(3)) === name(sA)} rows=${coverCount(reqId, day(2))}`, ['critical', 'fitness_manager', `PUT ${P}/cells`, 'Edit one day', 'one-day carve; neighbours keep A; exactly one covering row', JSON.stringify({ tue: covered(reqId, day(2)), mon: covered(reqId, day(1)), wed: covered(reqId, day(3)), rows: coverCount(reqId, day(2)) }), JSON.stringify(c1.body), 'applyForPerson / planRange.']);
  const wk2 = (await get(planner, '/week', { from: W })).body?.data;
  check(wk2?.people?.find((p) => p.user_id === reqId)?.days[2].shift_id === sC.id, 'GET /week shows the edit');
  // range edit, two people
  const c2 = await put(planner, '/cells', { user_ids: [reqId, peerId], from: day(0), to: day(4), shift_id: sB.id });
  const rangeOk = [0, 1, 2, 3, 4].every((i) => covered(reqId, day(i)) === name(sB) && covered(peerId, day(i)) === name(sB)) && covered(reqId, day(5)) === name(sA) && covered(peerId, day(5)) === name(sB);
  act('fitness_manager', AREA, 'assign one shift to two people for Mon-Fri', 'PUT', `${P}/cells`, c2, { verified: rangeOk, expected: 'allowed' });
  check(c2.status === 200 && c2.body?.data?.applied >= 1 && rangeOk, `range edit -> ${c2.status} applied=${c2.body?.data?.applied}, DB Mon-Fri all B, Sat unchanged`, ['critical', 'fitness_manager', `PUT ${P}/cells`, 'Range edit for two people', 'every day in range = B, outside range unchanged', JSON.stringify(c2.body), '', 'planRange.']);
  const allRows = () => Number(scalar(`SELECT COUNT(*) FROM hr.shift_assignments WHERE user_id IN (${lit(reqId)},${lit(peerId)})`));
  const rowsBefore = allRows();
  const c2b = await put(planner, '/cells', { user_ids: [reqId, peerId], from: day(0), to: day(4), shift_id: sB.id });
  const churn = allRows() - rowsBefore;
  check(c2b.status === 200 && c2b.body?.data?.applied === 0 && churn === 0, `re-applying the SAME shift is a no-op (applied=${c2b.body?.data?.applied}, new assignment rows=${churn})`,
    ['low', 'fitness_manager', `PUT ${P}/cells`, 'Re-apply the shift a person already works', 'applied 0 and no row churn', `applied=${c2b.body?.data?.applied}, ${churn} new hr.shift_assignments rows (old rows soft-deleted)`, JSON.stringify(c2b.body),
      'msq-hrms/services/hr-service/src/lib/attendance/planner.ts planRange() (line ~40-60) always trims/deletes the touching window and re-inserts, even when the window already carries the requested shift. Short-circuit when every touching window already has shiftId and covers [from,to]; otherwise each no-op edit fragments history, inflates changes_since_publish and writes a roster_shift_changed audit row for nobody.']);
  // clear
  const c3 = await put(planner, '/cells', { user_ids: [peerId], from: day(1), to: day(1), shift_id: null });
  check(c3.status === 200 && coverCount(peerId, day(1)) === 0 && covered(peerId, day(0)) === name(sB) && covered(peerId, day(2)) === name(sB), `clear a day -> ${c3.status}; DB: no assignment Tue, Mon/Wed intact`, ['high', 'fitness_manager', `PUT ${P}/cells`, 'Clear one day (shift_id null)', 'Tue uncovered, neighbours intact', JSON.stringify({ tue: coverCount(peerId, day(1)), mon: covered(peerId, day(0)), wed: covered(peerId, day(2)) }), JSON.stringify(c3.body), 'planRange delete + continuation.']);
  act('fitness_manager', AREA, 'clear a day (No shift)', 'PUT', `${P}/cells`, c3, { verified: coverCount(peerId, day(1)) === 0, expected: 'allowed' });
  const wkClr = (await get(planner, '/week', { from: W })).body?.data;
  check(wkClr?.people?.find((p) => p.user_id === peerId)?.days[1].kind === 'none', 'grid shows the cleared day as "none" (+ Assign)');
  // rest rule: neighbours must be on A (08:00 start) so a D (06:00-23:00) day leaves 9 h
  await put(planner, '/cells', { user_ids: [reqId], from: day(0), to: day(4), shift_id: sA.id });
  const rest = await put(planner, '/cells', { user_ids: [reqId], from: day(1), to: day(1), shift_id: sD });
  guard('fitness_manager', 'rest rule', rest, `PUT ${P}/cells`);
  const restSkipped = rest.body?.data?.skipped?.[0];
  check(rest.status === 200 && rest.body?.data?.applied === 0 && !!restSkipped && /rest/i.test(restSkipped.reason) && covered(reqId, day(1)) === name(sA), `11 h rest rule skips with a reason, writes nothing (${restSkipped?.reason})`, ['high', 'fitness_manager', `PUT ${P}/cells`, 'Shift ending 23:00 before an 08:00 start', 'skipped[] with a rest reason; DB unchanged', JSON.stringify(rest.body).slice(0, 250), '', 'restProblems in applyForPerson.']);
  act('fitness_manager', AREA, 'assign a shift that breaks the 11 h rest rule', 'PUT', `${P}/cells`, rest, { verified: covered(reqId, day(1)) === name(sA), expected: 'skipped' });
  // negatives
  const snapRows = () => Number(scalar(`SELECT COUNT(*) FROM hr.shift_assignments WHERE user_id IN (${lit(reqId)},${lit(peerId)}) AND NOT is_deleted`)) + ':' + scalar(`SELECT COALESCE(string_agg(effective_from::text||effective_to::text||shift_id::text, ',' ORDER BY effective_from),'') FROM hr.shift_assignments WHERE user_id IN (${lit(reqId)},${lit(peerId)}) AND NOT is_deleted`);
  const before = snapRows();
  const foreignShift = scalar(`SELECT s.id FROM hr.shifts s JOIN entity.organizations o ON o.id=s.org_id WHERE o.name='Gurugram - Civil Lines' AND NOT s.is_deleted LIMIT 1`) ?? scalar(`SELECT s.id FROM hr.shifts s WHERE s.org_id<>${lit(fx.orgId)} AND NOT s.is_deleted LIMIT 1`);
  const foreignUser = A.msqTa?.me.id;
  const negs = [
    ['past day', { user_ids: [reqId], from: addDays(todayIso(), -1), to: day(0), shift_id: sA.id }, [409]],
    ['to before from', { user_ids: [reqId], from: day(3), to: day(1), shift_id: sA.id }, [400, 422]],
    ['range > 92 days', { user_ids: [reqId], from: day(0), to: addDays(day(0), 93), shift_id: sA.id }, [400, 422]],
    ['empty user_ids', { user_ids: [], from: day(0), to: day(0), shift_id: sA.id }, [400, 422]],
    ['201 user_ids', { user_ids: Array.from({ length: 201 }, () => '00000000-0000-4000-8000-000000000001'), from: day(0), to: day(0), shift_id: sA.id }, [400, 422]],
    ['shift_id missing', { user_ids: [reqId], from: day(0), to: day(0) }, [400, 422]],
    ['unknown shift', { user_ids: [reqId], from: day(0), to: day(0), shift_id: '00000000-0000-4000-8000-000000000000' }, [404]],
    ...(foreignShift ? [['shift of another branch/tenant', { user_ids: [reqId], from: day(0), to: day(0), shift_id: foreignShift }, [404]]] : []),
    ['unknown person only', { user_ids: ['00000000-0000-4000-8000-000000000000'], from: day(0), to: day(0), shift_id: sA.id }, [404]],
  ];
  for (const [label, body, want] of negs) {
    const r = await put(planner, '/cells', body);
    guard('fitness_manager', label, r, `PUT ${P}/cells`);
    check(want.includes(r.status), `${label} -> ${r.status}`, ['medium', 'fitness_manager', `PUT ${P}/cells`, `Edit cells: ${label}`, `HTTP ${want.join('/')}`, `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'applyShiftsSchema / activeShift / NotFound.']);
  }
  if (foreignUser) {
    const r = await put(planner, '/cells', { user_ids: [foreignUser, reqId], from: day(4), to: day(4), shift_id: sA.id });
    guard('fitness_manager', 'foreign user in list', r, `PUT ${P}/cells`);
    const skipped = (r.body?.data?.skipped ?? []).some((s) => s.user_id === foreignUser);
    check(r.status === 200 && skipped, `another tenant's user in the list is reported skipped, not edited (${r.status})`, ['critical', 'fitness_manager', `PUT ${P}/cells`, 'Foreign-tenant user id in user_ids', 'skipped "Not an active employee of this branch"', JSON.stringify(r.body).slice(0, 250), '', 'activePeople is fenced to ctx.org_id.']);
    check(Number(scalar(`SELECT COUNT(*) FROM hr.shift_assignments WHERE user_id=${lit(foreignUser)} AND shift_id IN (${lit(sA.id)},${lit(sB.id)},${lit(sC.id)})`)) === 0, 'the foreign user got no assignment to a Sector 69 shift', ['critical', 'fitness_manager', `PUT ${P}/cells`, 'Foreign-tenant user edited', 'no assignment row', 'row exists', '', 'activePeople org fence.']);
  }
  // the foreign-user edit also applied day(4) = A to the requester; the next section expects A there
  await put(planner, '/cells', { user_ids: [reqId], from: day(4), to: day(4), shift_id: sA.id });

  // ── 3. Requirements ────────────────────────────────────────────────────────
  console.log('\n[3] requirements');
  const rq = await put(planner, '/requirements', { shift_id: sA.id, required_headcount: 3 });
  const reqRows = () => Number(scalar(`SELECT COUNT(*) FROM hr.shift_requirements WHERE shift_id=${lit(sA.id)} AND NOT is_deleted`));
  const reqVal = () => scalar(`SELECT required_headcount FROM hr.shift_requirements WHERE shift_id=${lit(sA.id)} AND NOT is_deleted`);
  act('fitness_manager', AREA, 'set people needed for a shift', 'PUT', `${P}/requirements`, rq, { verified: reqVal() === '3', expected: 'allowed (204)' });
  check(rq.status === 204 && reqVal() === '3' && reqRows() === 1, `set requirement -> ${rq.status}, DB value=${reqVal()} rows=${reqRows()}`, ['high', 'fitness_manager', `PUT ${P}/requirements`, 'Set required headcount', '204, one row = 3', `${rq.status} ${reqVal()} rows=${reqRows()}`, '', 'setRequirement upsert.']);
  const rq2 = await put(planner, '/requirements', { shift_id: sA.id, required_headcount: 5 });
  check(rq2.status === 204 && reqVal() === '5' && reqRows() === 1, `update requirement -> value=${reqVal()} rows=${reqRows()} (no duplicate row)`, ['high', 'fitness_manager', `PUT ${P}/requirements`, 'Update required headcount', 'in-place update', `${reqVal()} rows=${reqRows()}`, '', 'UPDATE-then-INSERT.']);
  check((await get(planner, '/week', { from: W })).body?.data?.shifts?.find((s) => s.id === sA.id)?.required === 5, 'GET /week reports required=5');
  const rq0 = await put(planner, '/requirements', { shift_id: sA.id, required_headcount: 0 });
  check(rq0.status === 204 && reqVal() === '0', `headcount 0 is allowed (${rq0.status})`);
  for (const [label, body, want] of [['negative', { shift_id: sA.id, required_headcount: -1 }, [400, 422]], ['5001', { shift_id: sA.id, required_headcount: 5001 }, [400, 422]], ['fractional', { shift_id: sA.id, required_headcount: 2.5 }, [400, 422]], ['string', { shift_id: sA.id, required_headcount: '3' }, [400, 422]], ['unknown shift', { shift_id: '00000000-0000-4000-8000-000000000000', required_headcount: 2 }, [404]], ...(foreignShift ? [['shift of another branch/tenant', { shift_id: foreignShift, required_headcount: 2 }, [404]]] : [])]) {
    const r = await put(planner, '/requirements', body);
    guard('fitness_manager', `requirement ${label}`, r, `PUT ${P}/requirements`);
    check(want.includes(r.status), `requirement ${label} -> ${r.status}`, ['medium', 'fitness_manager', `PUT ${P}/requirements`, `Requirement: ${label}`, want.join('/'), `${r.status}`, JSON.stringify(r.body).slice(0, 150), 'setRequirementSchema / NotFound.']);
  }
  if (foreignShift) check(Number(scalar(`SELECT COUNT(*) FROM hr.shift_requirements WHERE shift_id=${lit(foreignShift)} AND org_id=${lit(fx.orgId)}`)) === 0, 'no requirement row was written for the foreign shift', ['critical', 'fitness_manager', `PUT ${P}/requirements`, 'Foreign shift requirement', 'no row', 'row written', '', 'Org fence on the shift lookup.']);

  // ── 4. Reallocate ──────────────────────────────────────────────────────────
  console.log('\n[4] bulk reallocate');
  await put(planner, '/cells', { user_ids: [reqId], from: day(0), to: day(4), shift_id: sA.id }); // requester A Mon-Fri again
  const ra = await post(planner, '/reallocate', { from_shift_id: sA.id, to_shift_id: sC.id, from: day(0), to: day(2), user_ids: [reqId] });
  guard('fitness_manager', 'reallocate', ra, `POST ${P}/reallocate`);
  const raOk = [0, 1, 2].every((i) => covered(reqId, day(i)) === name(sC)) && covered(reqId, day(3)) === name(sA) && covered(peerId, day(0)) === name(sB);
  act('fitness_manager', AREA, 'bulk reallocate A -> C for a range (listed people)', 'POST', `${P}/reallocate`, ra, { verified: raOk, expected: 'allowed' });
  check(ra.status === 200 && ra.body?.data?.applied === 1 && raOk, `reallocate -> ${ra.status} applied=${ra.body?.data?.applied}; only days on A and only the listed person moved`, ['critical', 'fitness_manager', `POST ${P}/reallocate`, 'Move A -> C for Mon-Wed, requester only', 'requester Mon-Wed = C, Thu = A, peer untouched', JSON.stringify({ mon: covered(reqId, day(0)), thu: covered(reqId, day(3)), peerMon: covered(peerId, day(0)), body: ra.body }), '', 'overlapsOnShift + applyForPerson.']);
  const rsame = await post(planner, '/reallocate', { from_shift_id: sA.id, to_shift_id: sA.id, from: day(0), to: day(1) });
  check(rsame.status === 400 || rsame.status === 422, `same shift both sides -> ${rsame.status}`, ['low', 'fitness_manager', `POST ${P}/reallocate`, 'from == to shift', '400/422', `${rsame.status}`, '', 'reallocateShiftsSchema refine.']);
  const rpast = await post(planner, '/reallocate', { from_shift_id: sA.id, to_shift_id: sC.id, from: addDays(todayIso(), -2), to: day(0) });
  check(rpast.status === 409, `reallocate from a past day -> ${rpast.status}`, ['medium', 'fitness_manager', `POST ${P}/reallocate`, 'Past day', '409', `${rpast.status}`, '', 'todayIso guard.']);
  const rnone = await post(planner, '/reallocate', { from_shift_id: sA.id, to_shift_id: '00000000-0000-4000-8000-000000000000', from: day(0), to: day(1) });
  check(rnone.status === 404, `reallocate to an unknown shift -> ${rnone.status}`, ['medium', 'fitness_manager', `POST ${P}/reallocate`, 'Unknown target shift', '404', `${rnone.status}`, '', 'activeShift.']);
  const rrest = await post(planner, '/reallocate', { from_shift_id: sC.id, to_shift_id: sD, from: day(1), to: day(1), user_ids: [reqId] });
  check(rrest.status === 200 && (rrest.body?.data?.skipped ?? []).length >= 1 && covered(reqId, day(1)) === name(sC), `reallocate into a rest-rule breach is skipped (${rrest.body?.data?.skipped?.[0]?.reason})`, ['high', 'fitness_manager', `POST ${P}/reallocate`, 'Rest rule on reallocate', 'skipped with reason, unchanged', JSON.stringify(rrest.body).slice(0, 200), '', 'restProblems.']);

  // ── 5. Publish ─────────────────────────────────────────────────────────────
  console.log('\n[5] publish');
  const pubRows = (wk_) => Number(scalar(`SELECT COUNT(*) FROM hr.roster_publications WHERE org_id=${lit(fx.orgId)} AND week_start=${lit(wk_)} AND NOT is_deleted`));
  const notMonday = await post(planner, '/publish', { week_start: day(2) });
  check(notMonday.status === 400 && pubRows(day(2)) === 0, `publish a non-Monday -> ${notMonday.status}`, ['medium', 'fitness_manager', `POST ${P}/publish`, 'Week must start on Monday', '400', `${notMonday.status}`, '', 'publishWeek guard.']);
  const longNote = await post(planner, '/publish', { week_start: W, note: 'x'.repeat(301) });
  check(longNote.status === 400 || longNote.status === 422, `note > 300 chars -> ${longNote.status}`, ['low', 'fitness_manager', `POST ${P}/publish`, 'Long note', '400/422', `${longNote.status}`, '', 'publishRosterSchema.']);
  // BEFORE publish, what does an employee see?
  const empBefore = await req(A.requester, 'GET', '/hr/attendance/roster', undefined, { from: W });
  const empSees = empBefore.body?.data?.people?.find((p) => p.user_id === reqId)?.days?.[0]?.shift_name;
  const unpublished = pubRows(W) === 0;
  act('fitness_trainer', AREA, 'read my roster for a week HR has NOT published', 'GET', '/hr/attendance/roster', empBefore, { verified: unpublished && !empSees, expected: 'draft hidden until publish' });
  check(!(unpublished && empSees), `employee roster hides an UNPUBLISHED week (sees "${empSees}", published rows=${pubRows(W)})`,
    ['medium', 'fitness_trainer', 'GET /hr/attendance/roster', 'Employee reads a week HR has edited but not published', 'Unpublished planner edits are not shown to employees until /planner/publish', `Employee already sees "${empSees}" for ${W} while hr.roster_publications has ${pubRows(W)} row(s): publish is an advisory stamp only`, 'hr-service swaps.repository.ts getRoster (the query never joins hr.roster_publications); planner.repository.ts publishWeek only upserts the stamp', 'If drafts must stay private, have getRoster hide weeks that are not in hr.roster_publications (except for roster.manage holders), or document that edits are live and publish is a notification marker.']);
  const p1 = await post(planner, '/publish', { week_start: W, note: 'E2E first publish' });
  guard('fitness_manager', 'publish', p1, `POST ${P}/publish`);
  act('fitness_manager', AREA, 'publish the week roster', 'POST', `${P}/publish`, p1, { verified: pubRows(W) === 1, expected: 'allowed' });
  check(p1.status === 200 && pubRows(W) === 1 && scalar(`SELECT published_by::text FROM hr.roster_publications WHERE org_id=${lit(fx.orgId)} AND week_start=${lit(W)} AND NOT is_deleted`) === planner.me.id, `publish -> ${p1.status}, one DB row, published_by = the session user (not client supplied)`, ['high', 'fitness_manager', `POST ${P}/publish`, 'Publish a week', '200, one row, published_by = session user', `${p1.status} rows=${pubRows(W)}`, JSON.stringify(p1.body), 'publishWeek.']);
  const p2 = await post(planner, '/publish', { week_start: W, note: 'E2E republish' });
  check(p2.status === 200 && pubRows(W) === 1 && scalar(`SELECT note FROM hr.roster_publications WHERE org_id=${lit(fx.orgId)} AND week_start=${lit(W)} AND NOT is_deleted`) === 'E2E republish', 'republish updates the same row (still one, note replaced)', ['medium', 'fitness_manager', `POST ${P}/publish`, 'Republish', 'idempotent upsert', `rows=${pubRows(W)}`, '', 'UPDATE-then-INSERT.']);
  const wp = (await get(planner, '/week', { from: W })).body?.data;
  check(!!wp?.published?.published_at && wp.published.note === 'E2E republish', 'GET /week reports the publication');
  await sleep(1100);
  await put(planner, '/cells', { user_ids: [peerId], from: day(3), to: day(3), shift_id: sC.id });
  const wp2 = (await get(planner, '/week', { from: W })).body?.data;
  check(wp2?.changes_since_publish >= 1, `changes_since_publish after an edit = ${wp2?.changes_since_publish}`, ['medium', 'fitness_manager', `GET ${P}/week`, 'Edits after publish', '>= 1', `${wp2?.changes_since_publish}`, '', 'updated_at > published_at count.']);
  const dayV = (await get(planner, '/week', { view: 'day', from: W })).body?.data;
  check(dayV?.published == null, 'day/month views carry no publication state');

  // ── 6. Role / org fences ───────────────────────────────────────────────────
  console.log('\n[6] who may plan');
  const stateBefore = snapRows() + '|' + reqVal() + '|' + pubRows(W);
  const bodies = [
    ['GET', '/week', undefined, { from: W }],
    ['PUT', '/cells', { user_ids: [reqId], from: day(0), to: day(0), shift_id: sC.id }],
    ['PUT', '/requirements', { shift_id: sA.id, required_headcount: 9 }],
    ['POST', '/publish', { week_start: addDays(W, 14), note: 'E2E' }],
    ['POST', '/reallocate', { from_shift_id: sA.id, to_shift_id: sC.id, from: day(0), to: day(1) }],
  ];
  for (const [who, nm, expectDenied] of [[A.requester, 'fitness_trainer', true], [A.peer, 'org_manager', true], [A.orgAdmin, 'org_admin', true], [A.readOnly, 'read_only', true], [A.tadmin, 'tenant_admin (Head Office session)', 'org'], [A.msqTa, 'other-tenant admin', 'org']].filter(([x]) => x)) {
    for (const [m, path, body, query] of bodies) {
      // publish carries no ids: a manager of ANOTHER org publishes THEIR OWN week, which is correct, so it is not probed there.
      if (expectDenied !== true && path === '/publish') continue;
      const r = await req(who, m, `${P}${path}`, body, query);
      guard(nm, `${m} ${path}`, r, `${m} ${P}${path}`);
      act(nm, AREA, `${m} planner${path} as ${nm}`, m, `${P}${path}`, r, { expected: expectDenied === true ? 'denied' : 'no effect on Sector 69' });
      if (expectDenied === true) check(r.status === 403, `${nm} ${m} ${path} -> ${r.status}`, ['critical', nm, `${m} ${P}${path}`, 'Planner without hr.attendance.roster.manage', '403', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 150), 'requireCapability(HR_ATTENDANCE_ROSTER_MANAGE) on every planner route.']);
      else if (m !== 'GET') check(r.status >= 400 || (r.body?.data?.applied === 0), `${nm} ${m} ${path} (holds manage in ANOTHER org) cannot touch Sector 69 -> ${r.status}`, ['critical', nm, `${m} ${P}${path}`, 'Planner write with Sector 69 ids from another org', '404 / skipped / applied 0', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`, '', 'Org fence on shift + person lookups.']);
    }
  }
  check(snapRows() + '|' + reqVal() + '|' + pubRows(W) === stateBefore && pubRows(addDays(W, 14)) === 0, 'DB: nothing changed by any denied / foreign attempt', ['critical', 'multiple', `${P}/*`, 'Denied planner attempts', 'no rows changed', 'state differs', '', 'See the per-attempt findings.']);

  // ── 7. Concurrency ─────────────────────────────────────────────────────────
  console.log(`\n[7] two planners at once (${ROUNDS} rounds)`);
  await put(planner, '/cells', { user_ids: [reqId], from: day(0), to: day(4), shift_id: sA.id });
  let cellProblems = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const [r1, r2] = await simultaneously([
      () => put(planner, '/cells', { user_ids: [reqId], from: day(2), to: day(2), shift_id: sB.id }),
      () => put(A.planner2, '/cells', { user_ids: [reqId], from: day(2), to: day(2), shift_id: sC.id }),
    ]);
    const sts = [r1.status, r2.status];
    const rowsCover = coverCount(reqId, day(2));
    const fin = covered(reqId, day(2));
    const neigh = covered(reqId, day(1)) === name(sA) && covered(reqId, day(3)) === name(sA);
    const clean = !sts.some((s) => s >= 500 || s === 'ERR' || s === undefined) && rowsCover === 1 && [name(sB), name(sC)].includes(fin) && neigh;
    act('fitness_manager x2', AREA, 'two planners set the SAME cell to different shifts simultaneously', 'PUT', `${P}/cells`, { status: sts.join('/') }, { verified: clean, expected: 'both 200 (last wins) or one 409; one covering row' });
    if (!clean) {
      cellProblems++;
      bug('high', 'fitness_manager x2', `PUT ${P}/cells`, `Two planners edit one cell at once (round ${i + 1})`, 'No 5xx; exactly one assignment covers the day; neighbouring days intact', `statuses=${sts.join('/')} covering rows=${rowsCover} final=${fin} neighbours ok=${neigh}`, JSON.stringify([r1.body, r2.body]).slice(0, 400), 'windowsOf() locks the existing rows FOR UPDATE, but the loser plans against the pre-lock snapshot of the person\'s windows and then INSERTs; a second writer collides with excl_shift_assignments_no_overlap (23P01 -> 500) or double-carves. Lock a per-user row (SELECT ... FROM iam.users WHERE id=$1 FOR UPDATE) before reading windows, and map 23P01 to ConflictError.');
    }
    await put(planner, '/cells', { user_ids: [reqId], from: day(0), to: day(4), shift_id: sA.id });
  }
  check(cellProblems === 0, `same-cell race: ${ROUNDS - cellProblems}/${ROUNDS} rounds clean`);
  // planner vs reallocate on the same person
  const [x1, x2] = await simultaneously([
    () => put(planner, '/cells', { user_ids: [reqId], from: day(1), to: day(3), shift_id: sB.id }),
    () => post(A.planner2, '/reallocate', { from_shift_id: sA.id, to_shift_id: sC.id, from: day(0), to: day(4), user_ids: [reqId] }),
  ]);
  const okMix = ![x1.status, x2.status].some((s) => s >= 500 || s === undefined) && [0, 1, 2, 3, 4].every((i) => coverCount(reqId, day(i)) === 1);
  act('fitness_manager x2', AREA, 'cell edit and bulk reallocate on the same person simultaneously', 'PUT|POST', `${P}/cells|reallocate`, { status: `${x1.status}/${x2.status}` }, { verified: okMix, expected: 'no 5xx; one covering row per day' });
  check(okMix, `cells || reallocate -> ${x1.status}/${x2.status}, one covering row per day`, ['high', 'fitness_manager x2', `${P}/cells + reallocate`, 'Edit and reallocate the same person at once', 'no 5xx, no overlapping assignments', `${x1.status}/${x2.status} rows=${[0, 1, 2, 3, 4].map((i) => coverCount(reqId, day(i)))}`, JSON.stringify([x1.body, x2.body]).slice(0, 300), 'Per-person lock before windowsOf().']);
  await put(planner, '/cells', { user_ids: [reqId], from: day(0), to: day(4), shift_id: sA.id });
  // first-time publish race on an unpublished week
  let pubBad = 0, reqBad = 0, pubConflicts = 0, reqConflicts = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const wk_ = addDays(W, 21 + 7 * i);
    const [a1, a2] = await simultaneously([() => post(planner, '/publish', { week_start: wk_, note: 'E2E race A' }), () => post(A.planner2, '/publish', { week_start: wk_, note: 'E2E race B' })]);
    const n = pubRows(wk_);
    const ok = n === 1 && [a1.status, a2.status].every((s) => s === 200 || s === 409);
    if (ok && (a1.status === 409 || a2.status === 409)) pubConflicts++;
    act('fitness_manager x2', AREA, 'two planners publish the same, never-published week simultaneously', 'POST', `${P}/publish`, { status: `${a1.status}/${a2.status}` }, { verified: ok, expected: 'both 200, one row' });
    if (!ok) { pubBad++; bug('high', 'fitness_manager x2', `POST ${P}/publish`, `First-time publish of one week by two planners at once (round ${i + 1})`, 'Both succeed (idempotent) and exactly one hr.roster_publications row exists', `statuses=${a1.status}/${a2.status} rows=${n}`, JSON.stringify([a1.body, a2.body]).slice(0, 300), 'publishWeek does UPDATE, then INSERT when nothing updated: two first-time writers both INSERT and the loser hits uix_roster_publications_org_week (23505) -> 500. Use INSERT ... ON CONFLICT (org_id, week_start) WHERE NOT is_deleted DO UPDATE.'); }
    // first-time requirement race on a brand new shift
    const sR = mkShift(`R${i}`, '09:00', '10:00');
    const [b1, b2] = await simultaneously([() => put(planner, '/requirements', { shift_id: sR, required_headcount: 3 }), () => put(A.planner2, '/requirements', { shift_id: sR, required_headcount: 4 })]);
    const nr = Number(scalar(`SELECT COUNT(*) FROM hr.shift_requirements WHERE shift_id=${lit(sR)} AND NOT is_deleted`));
    const okr = nr === 1 && [b1.status, b2.status].every((s) => s === 204 || s === 409);
    if (okr && (b1.status === 409 || b2.status === 409)) reqConflicts++;
    act('fitness_manager x2', AREA, 'two planners set a never-set requirement simultaneously', 'PUT', `${P}/requirements`, { status: `${b1.status}/${b2.status}` }, { verified: okr, expected: 'both 204, one row' });
    if (!okr) { reqBad++; bug('high', 'fitness_manager x2', `PUT ${P}/requirements`, `First-time requirement for one shift by two planners at once (round ${i + 1})`, 'Both 204, exactly one row', `statuses=${b1.status}/${b2.status} rows=${nr}`, JSON.stringify([b1.body, b2.body]).slice(0, 300), 'setRequirement does UPDATE then INSERT; race on uix_shift_requirements_org_shift (23505) -> 500. Use ON CONFLICT (org_id, shift_id) WHERE NOT is_deleted DO UPDATE.'); }
  }
  if (pubConflicts) bug('low', 'fitness_manager x2', `POST ${P}/publish`, 'Two planners publish the same unpublished week at once', 'Both succeed (publish is idempotent)', `${pubConflicts}/${ROUNDS} rounds the loser got HTTP 409 "This record conflicts with an existing one" although the week IS published (one row)`, 'msq-hrms planner.repository.ts publishWeek (UPDATE, then INSERT when nothing updated): the loser hits uix_roster_publications_org_week (23505), which lib/errors.ts translatePgError maps to 409', 'INSERT ... ON CONFLICT (org_id, week_start) WHERE NOT is_deleted DO UPDATE SET published_by, published_at, note.');
  if (reqConflicts) bug('low', 'fitness_manager x2', `PUT ${P}/requirements`, 'Two planners set the first requirement of a shift at once', 'Both 204 (last value wins)', `${reqConflicts}/${ROUNDS} rounds the loser got HTTP 409 and the loser's headcount was silently dropped`, 'planner.repository.ts setRequirement (UPDATE, then INSERT): the loser hits uix_shift_requirements_org_shift (23505) -> 409', 'INSERT ... ON CONFLICT (org_id, shift_id) WHERE NOT is_deleted DO UPDATE SET required_headcount.');
  check(pubBad === 0, `publish race: ${ROUNDS - pubBad}/${ROUNDS} rounds clean`);
  check(reqBad === 0, `requirement race: ${ROUNDS - reqBad}/${ROUNDS} rounds clean`);

  // ── 8. The 1.66.0 tables themselves ────────────────────────────────────────
  console.log('\n[8] planner tables (schema 1.66.0)');
  for (const t of ['shift_requirements', 'roster_publications']) {
    const f = rows(`SELECT c.relrowsecurity::text, c.relforcerowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hr' AND c.relname=${lit(t)}`, ['rls', 'force'])[0];
    check(f?.rls === 'true' && f?.force === 'true', `hr.${t}: RLS enabled + FORCED`, ['critical', 'db', `hr.${t}`, 'RLS on planner table', 'enabled and forced', JSON.stringify(f), '', 'ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY (08_rls.sql).']);
    const pol = rows(`SELECT policyname FROM pg_policies WHERE schemaname='hr' AND tablename=${lit(t)}`, ['p']).map((r) => r.p);
    check(pol.length >= 2, `hr.${t}: ${pol.length} policies (${pol.join(', ')})`, ['critical', 'db', `hr.${t}`, 'Policies', 'org + tenant policies', pol.join(','), '', '08_rls.sql.']);
    const w = rows(`SELECT has_table_privilege('app_user','hr.${t}','INSERT')::text, has_table_privilege('app_user','hr.${t}','UPDATE')::text, has_table_privilege('app_user','hr.${t}','DELETE')::text, has_table_privilege('hr_svc','hr.${t}','DELETE')::text`, ['i', 'u', 'd', 'sd'])[0];
    check(w.i === 'false' && w.u === 'false' && w.d === 'false', `hr.${t}: app_user is read-only (INSERT=${w.i} UPDATE=${w.u} DELETE=${w.d}); hr_svc DELETE=${w.sd}`, ['high', 'db', `hr.${t}`, 'app_user grants', 'SELECT only', JSON.stringify(w), '', '07_grants.sql — writes only via the service transaction.']);
  }
  // org-fenced read as app_user
  const visibleAs = (org, table) => {
    const out = q(`BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.current_org_id', ${lit(org)}, true); SELECT count(*) FROM ${table}; COMMIT;`).map((r) => r[0]).filter((l) => /^\d+$/.test(l));
    return Number(out[out.length - 1]);
  };
  const otherOrg = scalar(`SELECT id FROM entity.organizations WHERE id<>${lit(fx.orgId)} AND NOT is_deleted LIMIT 1`);
  for (const t of ['hr.shift_requirements', 'hr.roster_publications']) {
    const mine = visibleAs(fx.orgId, t), theirs = visibleAs(otherOrg, t);
    const total = Number(scalar(`SELECT COUNT(*) FROM ${t} WHERE NOT is_deleted`));
    const mineDb = Number(scalar(`SELECT COUNT(*) FROM ${t} WHERE NOT is_deleted AND org_id=${lit(fx.orgId)}`));
    const otherDb = Number(scalar(`SELECT COUNT(*) FROM ${t} WHERE NOT is_deleted AND org_id=${lit(otherOrg)}`));
    check(mine === mineDb && theirs === otherDb && (total === mineDb + otherDb || mine < total), `${t}: app_user sees only the current org's rows (${mine}/${mineDb}, other org ${theirs}/${otherDb}, total ${total})`, ['critical', 'db', t, 'RLS org isolation as app_user', 'only org rows', `${mine}/${mineDb} ${theirs}/${otherDb}`, '', 'org_isolation_policy.']);
  }
  let wrote = false;
  try { q(`BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.current_org_id', ${lit(fx.orgId)}, true); INSERT INTO hr.shift_requirements (org_id, shift_id, required_headcount) VALUES (${lit(fx.orgId)}, ${lit(sA.id)}, 1); COMMIT;`); wrote = true; } catch {}
  check(!wrote, 'app_user INSERT into hr.shift_requirements is refused (service-only writes)', ['high', 'db', 'hr.shift_requirements', 'app_user write', 'refused', 'INSERT succeeded', '', 'Keep writes behind withServiceTx.']);
  const chk = rows(`SELECT conname FROM pg_constraint WHERE conrelid='hr.shift_requirements'::regclass AND contype='c'`, ['c']).map((r) => r.c).join(',');
  console.log(`  info: shift_requirements CHECKs: ${chk || 'none'}`);
} finally {
  if (fx) teardownFixtures(fx);
  q(`DELETE FROM hr.roster_publications WHERE note LIKE 'E2E%'`);
  const left = Number(scalar(`SELECT COUNT(*) FROM hr.shifts WHERE name LIKE 'E2E-ATT-%'`));
  console.log(`\ncleanup: restore journal replayed; E2E shifts remaining = ${left}.`);
  await closeActors(A);
}
console.log(`hr-roster-planner: ${findingCount()} finding(s).`);
