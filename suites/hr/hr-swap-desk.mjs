// Shift swap desk (schema 1.61.0): requester -> peer -> approver lifecycle, wrong actors,
// cross-org / cross-tenant ids, simultaneous deciders, and the roster rewrite verified in
// hr.shift_assignments.
//
//   GET  /hr/attendance/roster            hr.attendance.roster.view  (team; whole branch for .admin)
//   GET  /hr/attendance/swaps             hr.attendance.view         (swaps I am part of)
//   GET  /hr/attendance/swaps/queue       hr.attendance.swap.approve (assigned; whole branch for .admin)
//   POST /hr/attendance/swaps             hr.attendance.swap.request
//   POST /hr/attendance/swaps/:id/respond | cancel   hr.attendance.swap.request
//   POST /hr/attendance/swaps/:id/approve | reject   hr.attendance.swap.approve
//
// Rules proven here (swaps.repository.ts + lib/attendance/swap.ts):
//   * only the NAMED peer answers; only the requester withdraws; nobody decides their own swap
//   * the peer must share the requester's manager, same org; a foreign/unknown id is a 404
//     (existence never leaks), never a 403/500
//   * approve rewrites BOTH people's assignments for that one day (carve + continuation); reject,
//     decline and cancel change nothing
//   * a swap is decided exactly once: two simultaneous deciders -> one 200, the other 409
//   * a person may be in only one open swap per day (also under a simultaneous request race)
//
// Actors: requester fitness_trainer, peer org_manager (re-parented for the run), approver
// fitness_manager; wrong actors: tenant_admin (inactive Head Office session -> a different org
// of the same tenant), assistant_fitness_manager (Noida), msq_* (the other tenant).
//
// SAFETY: three E2E-ATT shifts + one assignment per peer, all journalled first and restored
// from a snapshot in finally. No session-killing calls.
//
//   node suites/hr/hr-swap-desk.mjs
import { CROSS_TENANT } from '../../lib.mjs';
import { simultaneously } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import {
  TOOL, stamp, req, openActors, closeActors, bug, act, guard, check, weekdays, addDays, todayIso, mondayOf, sleep,
  buildFixtures, teardownFixtures, shiftOn, coverCount, swapRow, findingCount, DEV_ROLES,
} from './_att-kit.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const AREA = 'HR > Team > Shift swap desk';
const msqKey = CROSS_TENANT.find((x) => x.role === 'tenant_admin')?.stateKey;
const msqOrgKey = CROSS_TENANT.find((x) => x.role === 'org_admin')?.stateKey;

const A = await openActors({
  ...DEV_ROLES,
  approver2: 'fitness_manager', // a second SESSION of the approver, for the simultaneous-decider race
  tadmin: 'tenant_admin', otherBranch: 'assistant_fitness_manager', trainerNoCap: 'sales_representative',
  ...(msqKey ? { msqTa: msqKey } : {}), ...(msqOrgKey ? { msqOa: msqOrgKey } : {}),
});
if (!A.requester || !A.peer || !A.approver) { console.log('required actors unavailable — aborting'); await closeActors(A); process.exit(0); }

const orgName = 'Gurugram - Sector 69';
for (const k of ['requester', 'peer', 'approver']) {
  if (A[k].me.org_name !== orgName) { console.log(`${k} session is on '${A[k].me.org_name}', not ${orgName} — aborting`); await closeActors(A); process.exit(0); }
}
let fx;
const swapIds = [];
const post = (a, path, body) => req(a, 'POST', path, body);
const SW = '/hr/attendance/swaps';

try {
  fx = await buildFixtures(A);
  console.log(`Swap desk · org=${orgName} requester=${A.requester.me.email} peer=${A.peer.me.email} approver=${A.approver.me.email}`);
  const sameMgr = fx.requesterManager === fx.approver.id;
  if (!check(sameMgr, 'precondition: requester reports to the approver', ['info', 'harness', AREA, 'Fixture', 'requester.manager_id = fitness_manager', `manager=${fx.requesterManager}`, '', 'Tenant data: set the trainer\'s manager.'])) throw new Error('fixture precondition failed');
  const [d1, d2, d3, d4, d5, d6] = weekdays(fx.orgId, 6, { ahead: 3, gap: 3 });
  const a = fx.shifts.A, b = fx.shifts.B;
  const reqId = fx.requester.id, peerId = fx.peer.id;
  const mk = (day, tag, who = A.requester, peer = peerId) => post(who, SW, { peer_id: peer, swap_date: day, reason: `E2E-swap-${tag}-${stamp}` });

  // ── 1. Request validation + peer eligibility ────────────────────────────────
  console.log('\n[1] request validation');
  const neg = [
    ['peer = self', { peer_id: reqId, swap_date: d1, reason: `E2E-swap-self-${stamp}` }, [400]],
    ['missing reason', { peer_id: peerId, swap_date: d1 }, [400, 422]],
    ['blank reason', { peer_id: peerId, swap_date: d1, reason: '   ' }, [400, 422]],
    ['reason > 500 chars', { peer_id: peerId, swap_date: d1, reason: 'E2E'.padEnd(501, 'x') }, [400, 422]],
    ['bad peer uuid', { peer_id: 'not-a-uuid', swap_date: d1, reason: 'E2E-x' }, [400, 422]],
    ['bad date format', { peer_id: peerId, swap_date: '05/10/2026', reason: 'E2E-x' }, [400, 422]],
    ['today (must be future)', { peer_id: peerId, swap_date: todayIso(), reason: 'E2E-x' }, [400]],
    ['yesterday', { peer_id: peerId, swap_date: addDays(todayIso(), -1), reason: 'E2E-x' }, [400]],
    ['weekly off day', { peer_id: peerId, swap_date: addDays(mondayOf(addDays(todayIso(), 7)), 5), reason: 'E2E-x' }, [400]],
    ['peer is the manager (not a teammate)', { peer_id: fx.approver.id, swap_date: d1, reason: 'E2E-x' }, [404]],
    ['peer unknown uuid', { peer_id: '00000000-0000-4000-8000-000000000000', swap_date: d1, reason: 'E2E-x' }, [404]],
  ];
  const foreign = scalar(`SELECT u.id FROM iam.users u JOIN hr.employee_profiles ep ON ep.user_id=u.id JOIN entity.organizations o ON o.id=ep.org_id WHERE o.name='Noida - Knowledge Park 2' AND u.is_active LIMIT 1`);
  if (foreign) neg.push(['peer in another branch (same tenant)', { peer_id: foreign, swap_date: d1, reason: 'E2E-x' }, [404]]);
  const otherTenantUser = A.msqTa?.me.id;
  if (otherTenantUser) neg.push(['peer in another tenant', { peer_id: otherTenantUser, swap_date: d1, reason: 'E2E-x' }, [404]]);
  for (const [label, body, want] of neg) {
    const r = await post(A.requester, SW, body);
    guard('fitness_trainer', label, r, `POST ${SW}`);
    const ok = want.includes(r.status);
    act('fitness_trainer', AREA, `request a swap: ${label}`, 'POST', SW, r, { verified: null, expected: `rejected ${want.join('/')}` });
    check(ok, `${label} -> ${r.status} (want ${want.join('/')})`, ok ? null : ['medium', 'fitness_trainer', `POST ${SW}`, `Swap request: ${label}`, `HTTP ${want.join('/')}`, `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 300), 'Validate in the schema/repository and return a 4xx AppError.']);
    if (r.status < 300 && r.body?.data?.id) swapIds.push(r.body.data.id);
  }
  const strayRows = Number(scalar(`SELECT COUNT(*) FROM hr.shift_swap_requests WHERE reason LIKE ${lit(`E2E-%${stamp}`)} OR reason='E2E-x'`));
  check(strayRows === 0, `rejected requests wrote no rows (found ${strayRows})`, ['high', 'fitness_trainer', `POST ${SW}`, 'Rejected swap requests', 'No hr.shift_swap_requests row for a 4xx', `${strayRows} stray rows`, '', 'Validate before INSERT; keep the whole create in one transaction.']);

  // A role without swap.request
  const nc = A.trainerNoCap ? await post(A.trainerNoCap, SW, { peer_id: peerId, swap_date: d1, reason: 'E2E-x' }) : null;
  if (nc) { act('sales_representative', AREA, 'request a swap without swap.request', 'POST', SW, nc, { expected: 'denied' }); check(nc.status === 403 || nc.status === 404, `no-capability role denied (${nc.status})`, ['high', 'sales_representative', `POST ${SW}`, 'Swap request without hr.attendance.swap.request', '403', `HTTP ${nc.status}`, JSON.stringify(nc.body).slice(0, 200), 'requireCapability(HR_ATTENDANCE_SWAP_REQUEST) on the route.']); }

  // ── 2. Full lifecycle L1 (approve) ──────────────────────────────────────────
  console.log('\n[2] lifecycle: request -> peer accepts -> approver approves');
  const c1 = await mk(d1, 'L1');
  guard('fitness_trainer', 'create swap', c1);
  const L1 = c1.body?.data?.id;
  act('fitness_trainer', AREA, 'request a shift swap with a teammate', 'POST', SW, c1, { verified: !!L1, expected: 'allowed (201)' });
  if (!check(c1.status === 201 && !!L1, `create -> ${c1.status}`, ['high', 'fitness_trainer', `POST ${SW}`, 'Create a swap with a valid teammate/day', '201 + id', `HTTP ${c1.status}: ${JSON.stringify(c1.body).slice(0, 200)}`, `d=${d1}`, 'Check the peer/manager/rest-rule preconditions in the fixture.'])) throw new Error('cannot continue without a swap');
  swapIds.push(L1);
  let row = swapRow(L1);
  check(row?.status === 'pending_peer' && row.manager_id === fx.approver.id, `DB: status=${row?.status} manager=${row?.manager_id === fx.approver.id ? 'approver' : row?.manager_id}`,
    ['high', 'fitness_trainer', `POST ${SW}`, 'New swap row', 'status pending_peer, manager_id = the requester\'s manager', JSON.stringify(row), '', 'resolveApprovers should return the reporting-line manager.']);
  check(row && scalar(`SELECT requester_shift_id::text||'/'||peer_shift_id::text FROM hr.shift_swap_requests WHERE id=${lit(L1)}`) === `${a.id}/${b.id}`, 'DB: shifts were read server-side from the two rosters (requester=A, peer=B)',
    ['high', 'fitness_trainer', `POST ${SW}`, 'Shift ids on the swap', 'taken from the rosters, not the client', 'mismatch', '', 'Never accept shift ids from the body.']);

  // Duplicate / reverse / overlapping open swap
  const dup = await mk(d1, 'L1-dup');
  act('fitness_trainer', AREA, 'request a second open swap for the same day', 'POST', SW, dup, { expected: 'denied (409)' });
  check(dup.status === 409, `second open swap same day -> ${dup.status}`, ['medium', 'fitness_trainer', `POST ${SW}`, 'One open swap per person per day', '409', `HTTP ${dup.status}`, JSON.stringify(dup.body).slice(0, 200), 'Clash check + 23505 -> ConflictError.']);
  const rev = await mk(d1, 'L1-rev', A.peer, reqId);
  act('org_manager', AREA, 'peer requests the REVERSE swap while one is open', 'POST', SW, rev, { expected: 'denied (409)' });
  check(rev.status === 409, `reverse swap same day -> ${rev.status}`, ['medium', 'org_manager', `POST ${SW}`, 'Reverse swap on an already-open day', '409', `HTTP ${rev.status}`, JSON.stringify(rev.body).slice(0, 200), 'Clash check covers requester OR peer.']);

  // Lists while pending_peer
  const mine = async (who) => (await req(who, 'GET', SW)).body?.data ?? [];
  check((await mine(A.requester)).some((s) => s.id === L1), 'GET /swaps (requester) lists it');
  check((await mine(A.peer)).some((s) => s.id === L1), 'GET /swaps (peer) lists it');
  check((await mine(A.approver)).some((s) => s.id === L1), 'GET /swaps (assigned approver) lists it');
  for (const [who, nm] of [[A.otherBranch, 'other branch'], [A.msqTa, 'other tenant'], [A.tadmin, 'tenant_admin (other org)']].filter(([w]) => w)) {
    const l = await req(who, 'GET', SW);
    guard(nm, 'list swaps', l);
    check(!(l.body?.data ?? []).some?.((s) => s.id === L1), `GET /swaps (${nm}) does not list it`, ['critical', who.key, `GET ${SW}`, `Swap list as ${nm}`, 'Only swaps I am part of', `Saw swap ${L1}`, '', 'Filter by participant + org.']);
  }
  const qa = await req(A.approver, 'GET', `${SW}/queue`);
  check(!(qa.body?.data ?? []).some((s) => s.id === L1), 'queue (approver) hides a swap still awaiting the PEER', ['medium', 'fitness_manager', `GET ${SW}/queue`, 'Queue before peer answer', 'only pending_manager', 'listed', '', 'status = pending_manager filter.']);

  // Wrong actors on respond / cancel / approve / reject while pending_peer
  console.log('  wrong actors (must all change nothing)');
  const before = JSON.stringify(swapRow(L1));
  const attempts = [
    [A.approver, 'respond', `${SW}/${L1}/respond`, { accept: true }, [403], 'a non-peer (the approver) answers'],
    [A.requester, 'respond', `${SW}/${L1}/respond`, { accept: true }, [403], 'the requester accepts their own swap'],
    [A.peer, 'cancel', `${SW}/${L1}/cancel`, undefined, [403], 'the peer cancels the requester\'s swap'],
    [A.approver, 'cancel', `${SW}/${L1}/cancel`, undefined, [403], 'the approver cancels the requester\'s swap'],
    [A.approver, 'approve', `${SW}/${L1}/approve`, {}, [409], 'approve while still awaiting the peer'],
    [A.requester, 'approve', `${SW}/${L1}/approve`, {}, [403], 'the requester approves their own swap (no approve capability)'],
    [A.otherBranch, 'respond', `${SW}/${L1}/respond`, { accept: true }, [403, 404], 'a user of ANOTHER BRANCH answers'],
    [A.tadmin, 'approve', `${SW}/${L1}/approve`, {}, [403, 404], 'tenant_admin acting on another org of the tenant approves'],
    [A.msqTa, 'respond', `${SW}/${L1}/respond`, { accept: true }, [403, 404], 'a user of ANOTHER TENANT answers'],
    [A.msqTa, 'approve', `${SW}/${L1}/approve`, {}, [403, 404], 'another tenant\'s admin approves'],
    [A.msqTa, 'reject', `${SW}/${L1}/reject`, { comment: 'E2E' }, [403, 404], 'another tenant\'s admin rejects'],
    [A.msqOa, 'cancel', `${SW}/${L1}/cancel`, undefined, [403, 404], 'another tenant\'s org admin cancels'],
  ].filter(([who]) => who);
  for (const [who, op, path, body, want, label] of attempts) {
    const r = await post(who, path, body);
    guard(who.key, label, r, `POST ${SW}/:id/${op}`);
    const bad = r.status < 300;
    act(who.key, AREA, label, 'POST', `${SW}/:id/${op}`, r, { verified: JSON.stringify(swapRow(L1)) === before, expected: 'denied' });
    check(want.includes(r.status), `${who.key}: ${label} -> ${r.status}`, ['critical', who.key, `POST ${SW}/:id/${op}`, label, `HTTP ${want.join('/')} and no change`, `HTTP ${r.status}${bad ? ' — the action SUCCEEDED' : ''}`, JSON.stringify(r.body).slice(0, 200), 'Participant / assigned-approver / org fence in swaps.repository (loadSwap + role checks).']);
  }
  check(JSON.stringify(swapRow(L1)) === before, 'DB: swap untouched by every wrong-actor attempt', ['critical', 'multiple', `${SW}/:id/*`, 'Wrong-actor attempts', 'row unchanged', JSON.stringify(swapRow(L1)), before, 'See the per-attempt findings.']);
  // 404 for foreign id must be indistinguishable from unknown id (no existence leak)
  if (A.msqTa) {
    const foreignId = await post(A.msqTa, `${SW}/${L1}/respond`, { accept: true });
    const unknownId = await post(A.msqTa, `${SW}/00000000-0000-4000-8000-000000000000/respond`, { accept: true });
    check(foreignId.status === unknownId.status, `foreign id and unknown id answer alike (${foreignId.status} vs ${unknownId.status})`, ['medium', 'msq_tenant_admin', `POST ${SW}/:id/respond`, 'Existence oracle', 'identical status for foreign vs unknown id', `${foreignId.status} vs ${unknownId.status}`, '', 'Return 404 for both.']);
  }
  const badUuid = await post(A.peer, `${SW}/not-a-uuid/respond`, { accept: true });
  guard('org_manager', 'respond with a non-uuid id', badUuid, `POST ${SW}/:id/respond`);
  check(badUuid.status >= 400 && badUuid.status < 500, `non-uuid id -> ${badUuid.status} (a 4xx, not a 500)`, ['medium', 'org_manager', `POST ${SW}/:id/respond`, 'Malformed id', '400/404', `HTTP ${badUuid.status}`, JSON.stringify(badUuid.body).slice(0, 200), 'Validate :id as uuid in the route.']);
  const badBody = await post(A.peer, `${SW}/${L1}/respond`, { accept: 'yes' });
  check(badBody.status === 400 || badBody.status === 422, `respond with accept:"yes" -> ${badBody.status}`, ['low', 'org_manager', `POST ${SW}/:id/respond`, 'Non-boolean accept', '400', `HTTP ${badBody.status}`, '', 'respondShiftSwapSchema.']);

  // Peer accepts
  const acc = await post(A.peer, `${SW}/${L1}/respond`, { accept: true });
  guard('org_manager', 'peer accepts', acc);
  row = swapRow(L1);
  act('org_manager', AREA, 'peer accepts the swap', 'POST', `${SW}/:id/respond`, acc, { verified: row?.status === 'pending_manager', expected: 'allowed' });
  check(acc.status === 200 && row?.status === 'pending_manager', `peer accept -> ${acc.status}, DB status=${row?.status}`, ['high', 'org_manager', `POST ${SW}/:id/respond`, 'Peer accepts', '200 and pending_manager', `HTTP ${acc.status}, ${row?.status}`, JSON.stringify(acc.body).slice(0, 200), 'respond() transition pending_peer -> pending_manager.']);
  const acc2 = await post(A.peer, `${SW}/${L1}/respond`, { accept: true });
  check(acc2.status === 409, `peer answers twice -> ${acc2.status}`, ['medium', 'org_manager', `POST ${SW}/:id/respond`, 'Answer an already-answered swap', '409', `HTTP ${acc2.status}`, '', 'Status guard.']);

  // Queue visibility
  const qApp = (await req(A.approver, 'GET', `${SW}/queue`)).body?.data ?? [];
  check(qApp.some((s) => s.id === L1), 'queue (assigned approver) lists it');
  const qReq = await req(A.requester, 'GET', `${SW}/queue`);
  act('fitness_trainer', AREA, 'open the approval queue without swap.approve', 'GET', `${SW}/queue`, qReq, { expected: 'denied' });
  check(qReq.status === 403, `queue as requester (no swap.approve) -> ${qReq.status}`, ['high', 'fitness_trainer', `GET ${SW}/queue`, 'Queue without capability', '403', `HTTP ${qReq.status}`, '', 'requireCapability(HR_ATTENDANCE_SWAP_APPROVE).']);
  const qPeer = await req(A.peer, 'GET', `${SW}/queue`);
  check(!(qPeer.body?.data ?? []).some((s) => s.id === L1), 'queue (peer, holds swap.approve but is not the approver) does not list it', ['high', 'org_manager', `GET ${SW}/queue`, 'Queue scope', 'only swaps assigned to me', 'listed my own swap', '', 'manager_id = actor filter.']);
  for (const [who, nm] of [[A.msqTa, 'other tenant'], [A.otherBranch, 'other branch'], [A.tadmin, 'tenant_admin other org']].filter(([w]) => w)) {
    const l = await req(who, 'GET', `${SW}/queue`);
    check(!(Array.isArray(l.body?.data) && l.body.data.some((s) => s.id === L1)), `queue (${nm}) does not list it`, ['critical', who.key, `GET ${SW}/queue`, `Queue as ${nm}`, 'org-fenced', 'saw the swap', '', 'Fence by org in listQueue.']);
  }

  // Participant cannot decide own swap (peer holds swap.approve)
  const own = await post(A.peer, `${SW}/${L1}/approve`, {});
  act('org_manager', AREA, 'the peer (holds swap.approve) approves the swap they are part of', 'POST', `${SW}/:id/approve`, own, { verified: swapRow(L1)?.status === 'pending_manager', expected: 'denied' });
  check(own.status === 403 && swapRow(L1)?.status === 'pending_manager', `participant approves own swap -> ${own.status}`, ['critical', 'org_manager', `POST ${SW}/:id/approve`, 'Participant decides their own swap', '403 "cannot decide your own swap"', `HTTP ${own.status}, status=${swapRow(L1)?.status}`, JSON.stringify(own.body).slice(0, 200), 'decide(): requester/peer guard.']);
  const reqNoComment = await post(A.approver, `${SW}/${L1}/reject`, {});
  check(reqNoComment.status === 400 || reqNoComment.status === 422, `reject without a comment -> ${reqNoComment.status}`, ['medium', 'fitness_manager', `POST ${SW}/:id/reject`, 'Reject needs a comment', '400', `HTTP ${reqNoComment.status}`, '', 'rejectShiftSwapSchema.']);
  check(swapRow(L1)?.status === 'pending_manager', 'DB: comment-less reject changed nothing');

  // Roster BEFORE approval, then approve
  const rosterOf = async (who, from) => (await req(who, 'GET', '/hr/attendance/roster', undefined, from ? { from } : undefined));
  const dayShift = (r, uid, day) => r.body?.data?.people?.find((p) => p.user_id === uid)?.days?.find((d) => d.date === day)?.shift_name ?? null;
  const r0 = await rosterOf(A.requester, d1);
  check(dayShift(r0, reqId, d1) === a.name && dayShift(r0, peerId, d1) === b.name, `roster before: requester=${dayShift(r0, reqId, d1)} peer=${dayShift(r0, peerId, d1)}`, ['high', 'fitness_trainer', 'GET /hr/attendance/roster', 'Roster before approval', 'A / B', `${dayShift(r0, reqId, d1)} / ${dayShift(r0, peerId, d1)}`, '', 'getRoster joins shift_assignments.']);
  const ap = await post(A.approver, `${SW}/${L1}/approve`, { comment: 'E2E ok' });
  guard('fitness_manager', 'approve', ap);
  row = swapRow(L1);
  const rShift = shiftOn(reqId, d1), pShift = shiftOn(peerId, d1);
  const prevR = shiftOn(reqId, addDays(d1, -1)), nextR = shiftOn(reqId, addDays(d1, 1)), nextP = shiftOn(peerId, addDays(d1, 1));
  const covers = coverCount(reqId, d1) + coverCount(peerId, d1);
  const rewrote = rShift === b.name && pShift === a.name && prevR === a.name && nextR === a.name && nextP === b.name && covers === 2;
  act('fitness_manager', AREA, 'approve a peer-accepted swap (assigned approver)', 'POST', `${SW}/:id/approve`, ap, { verified: rewrote && row?.status === 'approved', expected: 'allowed' });
  check(ap.status === 200 && row?.status === 'approved' && row.acted_by === fx.approver.id, `approve -> ${ap.status}, DB status=${row?.status}`, ['high', 'fitness_manager', `POST ${SW}/:id/approve`, 'Assigned approver approves', '200, status approved, acted_by = approver', `HTTP ${ap.status}, ${JSON.stringify(row)}`, JSON.stringify(ap.body).slice(0, 200), 'decide() approve branch.']);
  check(rewrote, `DB roster rewrite: requester d1=${rShift} (want B), peer d1=${pShift} (want A), requester d-1=${prevR}/d+1=${nextR} (want A), peer d+1=${nextP} (want B), covering rows=${covers} (want 2)`,
    ['critical', 'fitness_manager', `POST ${SW}/:id/approve`, 'Approved swap must exchange exactly the swap day in hr.shift_assignments', 'one-day carve with continuation on both people', `req d1=${rShift} peer d1=${pShift} prev=${prevR} next=${nextR} peerNext=${nextP} rows=${covers}`, JSON.stringify(row), 'planSplit/decide: shrink-then-insert order and the continuation row.']);
  const r1 = await rosterOf(A.requester, d1);
  check(dayShift(r1, reqId, d1) === b.name && dayShift(r1, peerId, d1) === a.name, 'GET /roster reflects the swap for the requester', ['high', 'fitness_trainer', 'GET /hr/attendance/roster', 'Roster after approval', 'B / A', `${dayShift(r1, reqId, d1)} / ${dayShift(r1, peerId, d1)}`, '', 'Roster reads shift_assignments live.']);
  for (const [op, body, label] of [['approve', {}, 'approve again'], ['reject', { comment: 'E2E late' }, 'reject after approval'], ['cancel', undefined, 'cancel after approval']]) {
    const who = op === 'cancel' ? A.requester : A.approver;
    const r = await post(who, `${SW}/${L1}/${op}`, body);
    guard(who.key, label, r);
    check(r.status === 409 && swapRow(L1)?.status === 'approved', `${label} -> ${r.status}`, ['high', who.key, `POST ${SW}/:id/${op}`, label, '409, still approved', `HTTP ${r.status}, ${swapRow(L1)?.status}`, '', 'A decided swap is terminal.']);
  }
  const auditN = async (action, id) => Number(scalar(`SELECT COUNT(*) FROM audit.activities WHERE action_type=${lit(action)} AND meta::text LIKE ${lit(`%${id}%`)}`));
  await sleep(1500);
  for (const act_ of ['shift_swap_requested', 'shift_swap_accepted', 'shift_swap_approved']) {
    const n = await auditN(act_, L1);
    check(n >= 1, `audit row ${act_} written (${n})`, ['low', 'multiple', 'audit.activities', `Audit ${act_}`, '>= 1 row', `${n}`, L1, 'logActivity is fire-and-forget; check the audit writer.']);
  }

  // ── 3. Reject path ──────────────────────────────────────────────────────────
  console.log('\n[3] reject leaves the roster alone');
  const L2 = (await mk(d2, 'L2')).body?.data?.id; swapIds.push(L2);
  await post(A.peer, `${SW}/${L2}/respond`, { accept: true });
  const beforeShift = [shiftOn(reqId, d2), shiftOn(peerId, d2)];
  const rj = await post(A.approver, `${SW}/${L2}/reject`, { comment: 'E2E not this week' });
  row = swapRow(L2);
  act('fitness_manager', AREA, 'reject a swap with a comment', 'POST', `${SW}/:id/reject`, rj, { verified: row?.status === 'rejected', expected: 'allowed' });
  check(rj.status === 200 && row?.status === 'rejected' && row.approver_comment === 'E2E not this week', `reject -> ${rj.status}, status=${row?.status}, comment kept=${row?.approver_comment}`, ['high', 'fitness_manager', `POST ${SW}/:id/reject`, 'Reject a pending swap', '200, rejected, comment stored', JSON.stringify(row), '', 'decide() reject branch.']);
  check(shiftOn(reqId, d2) === beforeShift[0] && shiftOn(peerId, d2) === beforeShift[1], 'DB: reject did NOT change either roster', ['critical', 'fitness_manager', `POST ${SW}/:id/reject`, 'Reject must not touch assignments', 'unchanged', `${shiftOn(reqId, d2)}/${shiftOn(peerId, d2)}`, JSON.stringify(beforeShift), 'Only the approve branch may write shift_assignments.']);
  const ra = await post(A.approver, `${SW}/${L2}/approve`, {});
  check(ra.status === 409, `approve after reject -> ${ra.status}`, ['high', 'fitness_manager', `POST ${SW}/:id/approve`, 'Approve a rejected swap', '409', `HTTP ${ra.status}`, '', 'Status guard.']);

  // ── 4. Decline + cancel paths ───────────────────────────────────────────────
  console.log('\n[4] decline and cancel');
  const L3 = (await mk(d3, 'L3')).body?.data?.id; swapIds.push(L3);
  const dc = await post(A.peer, `${SW}/${L3}/respond`, { accept: false });
  check(dc.status === 200 && swapRow(L3)?.status === 'declined', `peer declines -> ${dc.status}, ${swapRow(L3)?.status}`, ['high', 'org_manager', `POST ${SW}/:id/respond`, 'Peer declines', 'declined', `${swapRow(L3)?.status}`, '', 'respond(accept=false).']);
  act('org_manager', AREA, 'peer declines the swap', 'POST', `${SW}/:id/respond`, dc, { verified: swapRow(L3)?.status === 'declined', expected: 'allowed' });
  const L4 = (await mk(d3, 'L4')).body?.data?.id; swapIds.push(L4);
  check(!!L4, 'a declined swap frees the day for a new request');
  const cn = await post(A.requester, `${SW}/${L4}/cancel`);
  act('fitness_trainer', AREA, 'requester withdraws the swap', 'POST', `${SW}/:id/cancel`, cn, { verified: swapRow(L4)?.status === 'cancelled', expected: 'allowed' });
  check(cn.status === 200 && swapRow(L4)?.status === 'cancelled', `requester cancels -> ${cn.status}, ${swapRow(L4)?.status}`, ['high', 'fitness_trainer', `POST ${SW}/:id/cancel`, 'Requester withdraws', 'cancelled', `${swapRow(L4)?.status}`, '', 'cancel().']);
  const late = await post(A.peer, `${SW}/${L4}/respond`, { accept: true });
  check(late.status === 409, `peer answers a withdrawn swap -> ${late.status}`, ['medium', 'org_manager', `POST ${SW}/:id/respond`, 'Answer a cancelled swap', '409', `HTTP ${late.status}`, '', 'Status guard.']);

  // ── 5. Races ────────────────────────────────────────────────────────────────
  console.log('\n[5] simultaneous actors');
  // 5a two deciders approve the SAME swap at the same instant
  const L5 = (await mk(d4, 'L5')).body?.data?.id; swapIds.push(L5);
  await post(A.peer, `${SW}/${L5}/respond`, { accept: true });
  const res5 = await simultaneously([() => post(A.approver, `${SW}/${L5}/approve`, {}), () => post(A.approver2, `${SW}/${L5}/approve`, {})]);
  const st5 = res5.map((r) => r.status ?? 'ERR').sort();
  const wins5 = res5.filter((r) => r.status === 200).length;
  const fx5 = [coverCount(reqId, d4), coverCount(peerId, d4)];
  act('fitness_manager x2', AREA, 'two approver sessions approve the same swap simultaneously', 'POST', `${SW}/:id/approve`, { status: st5.join('/') }, { verified: wins5 === 1 && fx5[0] === 1 && fx5[1] === 1, expected: 'one 200, one 409' });
  check(wins5 === 1 && st5.includes(409) && !st5.some((s) => s >= 500), `double-approve -> ${st5.join('/')}`, ['high', 'fitness_manager', `POST ${SW}/:id/approve`, 'Two approvers approve the same swap at once', 'exactly one 200, the other 409, never a 5xx', st5.join('/'), JSON.stringify(res5).slice(0, 300), 'loadSwap uses FOR UPDATE; a 5xx here means the carve/insert collided with excl_shift_assignments_no_overlap.']);
  check(fx5[0] === 1 && fx5[1] === 1 && shiftOn(reqId, d4) === b.name && shiftOn(peerId, d4) === a.name, `DB: exactly one assignment covers d4 for each person, swapped (${fx5}; ${shiftOn(reqId, d4)}/${shiftOn(peerId, d4)})`, ['critical', 'fitness_manager', `POST ${SW}/:id/approve`, 'Double-approve must apply the swap once', 'one covering row per person, shifts exchanged once (a double apply swaps back)', `rows=${fx5} req=${shiftOn(reqId, d4)} peer=${shiftOn(peerId, d4)}`, '', 'Serialise decide() per swap.']);
  // 5b approve vs reject at the same instant
  const L6 = (await mk(d5, 'L6')).body?.data?.id; swapIds.push(L6);
  await post(A.peer, `${SW}/${L6}/respond`, { accept: true });
  const res6 = await simultaneously([() => post(A.approver, `${SW}/${L6}/approve`, {}), () => post(A.approver2, `${SW}/${L6}/reject`, { comment: 'E2E race reject' })]);
  const st6 = res6.map((r) => r.status ?? 'ERR');
  const final6 = swapRow(L6)?.status;
  const swapped6 = shiftOn(reqId, d5) === b.name;
  act('fitness_manager x2', AREA, 'one approves while the other rejects the same swap', 'POST', `${SW}/:id/approve|reject`, { status: st6.join('/') }, { verified: (final6 === 'approved') === swapped6, expected: 'one winner' });
  check(st6.filter((s) => s === 200).length === 1 && !st6.some((s) => s >= 500) && (final6 === 'approved') === swapped6, `approve||reject -> ${st6.join('/')}, final=${final6}, roster swapped=${swapped6}`, ['high', 'fitness_manager', `POST ${SW}/:id/(approve|reject)`, 'Approve and reject at once', 'one winner; status and roster agree', `${st6.join('/')} final=${final6} swapped=${swapped6}`, '', 'FOR UPDATE row lock + status check inside the same transaction.']);
  // 5c requester cancels while the peer accepts
  const L7 = (await mk(d6, 'L7')).body?.data?.id; swapIds.push(L7);
  const res7 = await simultaneously([() => post(A.requester, `${SW}/${L7}/cancel`), () => post(A.peer, `${SW}/${L7}/respond`, { accept: true })]);
  const st7 = res7.map((r) => r.status ?? 'ERR');
  const f7 = swapRow(L7)?.status;
  check(!st7.some((s) => s >= 500) && ['cancelled', 'pending_manager'].includes(f7), `cancel||accept -> ${st7.join('/')}, final=${f7}`, ['high', 'fitness_trainer', `POST ${SW}/:id/(cancel|respond)`, 'Withdraw and accept at once', 'no 5xx; a consistent final status', `${st7.join('/')} final=${f7}`, '', 'Row lock.']);
  // 5d opposite requests on the same day from both people
  const d7 = weekdays(fx.orgId, 8, { ahead: 3, gap: 3 })[7];
  const res8 = await simultaneously([() => mk(d7, 'L8a'), () => post(A.peer, SW, { peer_id: reqId, swap_date: d7, reason: `E2E-swap-L8b-${stamp}` })]);
  for (const r of res8) if (r.body?.data?.id) swapIds.push(r.body.data.id);
  const st8 = res8.map((r) => r.status ?? 'ERR').sort();
  const open8 = Number(scalar(`SELECT COUNT(*) FROM hr.shift_swap_requests WHERE swap_date=${lit(d7)} AND status IN ('pending_peer','pending_manager') AND NOT is_deleted AND reason LIKE ${lit(`E2E-swap-L8%${stamp}`)}`));
  act('fitness_trainer + org_manager', AREA, 'both people request a swap with each other for the same day at the same instant', 'POST', SW, { status: st8.join('/') }, { verified: open8 === 1, expected: 'one 201, one 409' });
  check(open8 === 1 && !st8.some((s) => s >= 500), `mutual simultaneous requests -> ${st8.join('/')}, open rows=${open8}`, ['high', 'fitness_trainer', `POST ${SW}`, 'Mutual simultaneous requests', 'exactly one open swap (201 + 409), never a 5xx', `${st8.join('/')} rows=${open8}`, '', 'The clash SELECT is not atomic; the 23505 from uix_shift_swap_requests_open_* must map to ConflictError (it does) — a 5xx means another constraint leaked.']);

  // ── 6. Roster scope ────────────────────────────────────────────────────────
  console.log('\n[6] roster visibility scope');
  const orgPeople = Number(scalar(`SELECT COUNT(*) FROM hr.employee_profiles ep JOIN iam.users u ON u.id=ep.user_id WHERE ep.org_id=${lit(fx.orgId)} AND NOT ep.is_deleted AND ep.is_active AND u.is_active`));
  const rosterOfReq = await rosterOf(A.requester);
  const team = rosterOfReq.body?.data?.people ?? [];
  const teamOk = team.every((p) => {
    const m = scalar(`SELECT manager_id::text FROM iam.users WHERE id=${lit(p.user_id)}`);
    return p.user_id === reqId || m === reqId || m === fx.approver.id;
  });
  act('fitness_trainer', AREA, 'open the team roster', 'GET', '/hr/attendance/roster', rosterOfReq, { verified: teamOk, expected: 'own team only' });
  check(rosterOfReq.status === 200 && teamOk && team.length < orgPeople, `trainer roster = own team only (${team.length} of ${orgPeople} people in the branch)`, ['high', 'fitness_trainer', 'GET /hr/attendance/roster', 'Roster scope for a non-admin', 'self + direct reports + peers under the same manager', `${team.length} people, in-team=${teamOk}`, '', 'scope clause in getRoster.']);
  const rosterFm = await rosterOf(A.approver);
  check((rosterFm.body?.data?.people ?? []).length >= team.length && (rosterFm.body?.data?.people ?? []).length <= orgPeople, `approver (hr.attendance.admin) roster = branch-wide (${(rosterFm.body?.data?.people ?? []).length}/${orgPeople})`);
  for (const [who, nm] of [[A.msqTa, 'other tenant admin'], [A.msqOa, 'other tenant org admin']].filter(([w]) => w)) {
    const rr = await rosterOf(who);
    const names = (rr.body?.data?.people ?? []).map((p) => p.user_id);
    const leakedPeople = names.filter((id) => [reqId, peerId, fx.approver.id].includes(id));
    const foreignTenant = names.filter((id) => scalar(`SELECT o.tenant_id::text FROM hr.employee_profiles ep JOIN entity.organizations o ON o.id=ep.org_id WHERE ep.user_id=${lit(id)} LIMIT 1`) !== who.me.tenant_id);
    check(foreignTenant.length === 0, `roster as ${nm}: every person belongs to the caller's own tenant (${names.length - foreignTenant.length}/${names.length})`, ['critical', who.key, 'GET /hr/attendance/roster', 'Cross-tenant roster', 'only my tenant', `${foreignTenant.length} foreign people`, foreignTenant.slice(0, 3).join(','), 'Org/tenant fence in getRoster.']);
    check(leakedPeople.length === 0, `roster as ${nm}: ${rr.status}, ${names.length} people, none of ours`, ['critical', who.key, 'GET /hr/attendance/roster', 'Cross-tenant roster', 'no Fitclass people', `${leakedPeople.length} leaked`, '', 'Org fence in getRoster.']);
  }
  const badFrom = await rosterOf(A.requester, 'yesterday');
  check(badFrom.status === 400 || badFrom.status === 422, `roster ?from=yesterday -> ${badFrom.status}`, ['low', 'fitness_trainer', 'GET /hr/attendance/roster', 'Bad from date', '400', `HTTP ${badFrom.status}`, '', 'rosterQuerySchema.']);
} finally {
  const leftOpen = swapIds.length;
  if (fx) teardownFixtures(fx);
  const stray = Number(scalar(`SELECT COUNT(*) FROM hr.shift_swap_requests WHERE reason LIKE 'E2E-swap-%'`) ?? 0);
  console.log(`\ncleanup: ${leftOpen} swap(s) created, ${stray} E2E swap rows remaining after restore; roster/manager restored from snapshot.`);
  await closeActors(A);
}
console.log(`hr-swap-desk: ${findingCount()} finding(s).`);
