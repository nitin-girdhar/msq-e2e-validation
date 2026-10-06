// Leave encashment (/hr/leave/encashments*): request, list, queue, approve, reject, cancel.
//
// Model (leave.repository.ts, schema 1.64.0): an employee asks to cash out unused days of a leave type whose
// effective policy is `encashable` (cap `max_encash_days`, never more than balance minus other open
// requests). APPROVAL appends a NEGATIVE 'encashment' row to hr.leave_ledger and re-checks policy + balance at
// that moment; REJECT / CANCEL move nothing. One open request per leave type (partial unique index).
// This suite seeds its own E2E policy (casual, encashable, max 3) and balance so it owns the rules it asserts.
//
//   1. request: encashable only, <= max_encash_days, <= balance, half-day steps, validation, 1 open per type
//   2. queue / own list: capability-gated, org-scoped, no tenant leak
//   3. approve / reject role matrices (capability + hr.can_approve_leave authority), ledger/balance verified
//   4. approve re-check (balance spent / policy switched off after the request), self-approval, terminal
//      states, cancel after decision, IDOR across users and tenants, malformed ids
//   5. races: two approvers, approve vs reject, approve vs cancel -> one winner, one ledger row, no 5xx
//   6. capability toggle (tenant override restored in finally): API denies AND the UI hides
//   7. UI: Encash leave dialog (offers only encashable types), my requests (Withdraw), approver section
//
//   node suites/hr/leave-encashment.mjs [api|ui]
import { openAs } from '../../lib.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { setOverride, restoreAll, waitForSessionCapability } from '../../capability.mjs';
import { dbReachable } from '../../db.mjs';
import * as K from './_leave-kit.mjs';
const { HR, CAP, actor, apiGet, apiPost, scalar, rows, q, lit, simultaneously, ALL_ROLES } = K;

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const mode = (process.argv[2] || 'all').toLowerCase();
const doApi = mode === 'all' || mode === 'api', doUi = mode === 'all' || mode === 'ui';
const fail = K.makeFail('Leave - encashment');
const world = K.resolveWorld();
const { stamp } = K;
const MARK = `E2E-encash-${stamp}`;
const typeId = K.leaveTypeId(world.tenantId, 'casual');
const sickId = K.leaveTypeId(world.tenantId, 'sick');
const j = K.j;
const idOf = (b) => b?.data?.id ?? null;
const enRow = (id) => rows(`SELECT status, days::text, approver_id::text, acted_by::text, approver_comment, ledger_entry_id::text, user_id::text, reason
   FROM hr.leave_encashment_requests WHERE id=${lit(id)}`, ['status', 'days', 'approver', 'acted_by', 'comment', 'ledger', 'user', 'reason'])[0] ?? null;
const ledgerFor = (id) => rows(`SELECT l.entry_type, l.amount::text, l.leave_type_id::text, l.note, l.effective_date::text FROM hr.leave_encashment_requests e
   JOIN hr.leave_ledger l ON l.id=e.ledger_entry_id WHERE e.id=${lit(id)}`, ['type', 'amount', 'lt', 'note', 'eff'])[0] ?? null;
const encashRows = (userId, since) => Number(scalar(`SELECT COUNT(*) FROM hr.leave_ledger WHERE user_id=${lit(userId)} AND leave_type_id=${lit(typeId)} AND entry_type='encashment' AND created_at >= ${lit(since)}`) ?? 0);
const openReq = (userId) => Number(scalar(`SELECT COUNT(*) FROM hr.leave_encashment_requests WHERE user_id=${lit(userId)} AND leave_type_id=${lit(typeId)} AND status='pending' AND NOT is_deleted`));
const clearOpen = (userId) => { for (const id of rows(`SELECT id FROM hr.leave_encashment_requests WHERE user_id=${lit(userId)} AND leave_type_id=${lit(typeId)} AND status='pending' AND NOT is_deleted AND reason LIKE ${lit(`${MARK}%`)}`, ['id']).map((r) => r.id)) K.purgeEncashment(id); };

const emp = await actor(world.empKey);
const appr = await actor(world.apprKey);
let sessions = {};
const dbReq = (over = {}) => {
  // one open request per (user, type): free the slot first when a previous fixture is still pending
  const uid = over.userId ?? world.empId;
  clearOpen(uid);
  return K.insertEncashment({ userId: uid, orgId: world.orgId, typeId, days: 1, approverId: world.apprId, reason: `${MARK}-db`, ...over });
};

try {
  K.seedPolicy(world, 'casual', { encashable: true, maxEncash: 3, maxConsecutive: 5, docAfter: null, levels: 1, sla: 37 });
  K.seedBalance(world.empId, world.orgId, typeId, 10, `E2E-seed-${MARK}`);
  K.seedBalance(world.apprId, world.orgId, typeId, 10, `E2E-seed-appr-${MARK}`);
  sessions = await K.allSessions();
  console.log(`world: employee=${world.empKey} approver=${world.apprKey}; balance casual=${K.balanceOf(world.empId, typeId)}; sessions ${Object.keys(sessions).length}/${ALL_ROLES.length}`);
  const create = (a, body) => apiPost(a, `${HR}/api/hr/leave/encashments`, body);

  if (doApi) {
    // ── 1. request ──────────────────────────────────────────────────────────────────
    console.log('\n[1] request');
    const c1 = await create(emp, { leave_type_name: 'casual', days: 2, reason: `${MARK}-create` });
    const c1id = K.trackEncashment(idOf(c1.body));
    const r1 = c1id ? enRow(c1id) : null;
    K.journal(world.empKey, 'Leave dashboard', 'request encashment of 2 casual days', 'POST', '/hr/leave/encashments', c1.status, r1?.status === 'pending', '201 pending request');
    if (c1.status !== 201 || !r1 || r1.status !== 'pending' || r1.days !== '2.00' || r1.user !== world.empId || r1.approver !== world.apprId) {
      fail('high', world.empKey, 'Request encashment of 2 casual days (encashable, max 3, balance 10)', '201; pending row owned by the caller, approver = manager', `HTTP ${c1.status}; ${j(r1)}`, j(c1.body), 'createEncashment + checkEncashment (encashment.ts).');
    }
    const mine = await apiGet(emp, `${HR}/api/hr/leave/encashments`);
    if (!(mine.body?.data ?? []).some((e) => e.id === c1id) || (mine.body?.data ?? []).some((e) => e.user_id !== world.empId)) fail('high', world.empKey, 'My encashment list', 'My request, and only mine', `HTTP ${mine.status}; foreign=${(mine.body?.data ?? []).filter((e) => e.user_id !== world.empId).length}`, j(mine.body?.data?.slice?.(0, 2)), 'listOwnEncashments filters user_id.');
    const second = await create(emp, { leave_type_name: 'casual', days: 1, reason: `${MARK}-second` });
    if (idOf(second.body)) K.trackEncashment(idOf(second.body));
    K.journal(world.empKey, 'Leave dashboard', 'second open request for the same leave type', 'POST', '/hr/leave/encashments', second.status, null, '409 or 400');
    if (second.status < 400 || second.status >= 500) fail(second.status >= 500 ? 'high' : 'high', world.empKey, 'Second open encashment for the same leave type', '409 "already have an open encashment request" (or 400 for exceeding balance)', `HTTP ${second.status}`, j(second.body), '23505 on the partial unique index -> ConflictError.');
    // free the slot (cancel) and run the rule table
    await apiPost(emp, `${HR}/api/hr/leave/encashments/${c1id}/cancel`, {});
    const rules = [
      ['a leave type whose policy is not encashable (sick)', { leave_type_name: 'sick', days: 1 }, 400],
      ['more than max_encash_days (4 > 3)', { leave_type_name: 'casual', days: 4 }, 400],
      ['more than the balance', { leave_type_name: 'casual', days: 3, __balance: 2 }, 400],
      ['a quarter day', { leave_type_name: 'casual', days: 1.25 }, 400],
      ['zero days', { leave_type_name: 'casual', days: 0 }, 400],
      ['negative days', { leave_type_name: 'casual', days: -1 }, 400],
      ['366 days', { leave_type_name: 'casual', days: 366 }, 400],
      ['days as a string', { leave_type_name: 'casual', days: '2' }, 400],
      ['an unknown leave type', { leave_type_name: 'no_such_type', days: 1 }, 400],
      ['a 501-char note', { leave_type_name: 'casual', days: 1, reason: 'r'.repeat(501) }, 400],
      ['no body fields', {}, 400],
    ];
    for (const [label, body0, want] of rules) {
      const body = { ...body0 }; let undo = null;
      if (body.__balance != null) { // temporarily lower the balance so days > balance
        const need = K.balanceOf(world.empId, typeId) - body.__balance;
        const note = `E2E-lower-${MARK}`; K.seedBalance(world.empId, world.orgId, typeId, -need, note);
        undo = () => q(`DELETE FROM hr.leave_ledger WHERE note=${lit(note)}`); delete body.__balance;
      }
      try {
        const r = await create(emp, body);
        if (idOf(r.body)) K.trackEncashment(idOf(r.body));
        K.journal(world.empKey, 'Leave dashboard', `request encashment: ${label}`, 'POST', '/hr/leave/encashments', r.status, null, String(want));
        if (![400, 422].includes(r.status)) fail('high', world.empKey, `Encashment request for ${label}`, `HTTP 400/422 with a clear reason`, `HTTP ${r.status}`, j(r.body), 'checkEncashment / createEncashmentSchema.');
      } finally { undo?.(); }
    }
    // identity cannot be client supplied
    const forge = await create(emp, { leave_type_name: 'casual', days: 1, reason: `${MARK}-forge`, user_id: world.apprId, org_id: world.noidaOrgId, status: 'approved', approver_id: world.empId });
    const forgeId = K.trackEncashment(idOf(forge.body));
    const fr = forgeId ? enRow(forgeId) : null;
    if (fr && (fr.user !== world.empId || fr.status !== 'pending' || fr.approver === world.empId)) fail('critical', world.empKey, 'Client-supplied identity / status on an encashment request', 'Taken from the session / resolver', j(fr), j(forge.body), 'Ignore body keys other than the schema.');
    if (forgeId) await apiPost(emp, `${HR}/api/hr/leave/encashments/${forgeId}/cancel`, {});

    // matrix: create (tolerant - other branches have no encashable policy / balance)
    console.log('  capability matrix: request encashment as every login');
    clearOpen(world.empId);
    await K.capabilityGrade({
      sessions, capKey: CAP.EN_REQ, area: 'Leave dashboard', tab: 'Encashment requests', action: 'request leave encashment', endpoint: 'POST /hr/leave/encashments', fail,
      act: (a, role) => create(a, { leave_type_name: 'casual', days: 1, reason: `${MARK}-matrix-${role}` }),
      persisted: (role) => Number(scalar(`SELECT COUNT(*) FROM hr.leave_encashment_requests WHERE reason=${lit(`${MARK}-matrix-${role}`)}`)) > 0,
      cleanup: () => { for (const id of rows(`SELECT id FROM hr.leave_encashment_requests WHERE reason LIKE ${lit(`${MARK}-matrix-%`)}`, ['id']).map((r) => r.id)) K.purgeEncashment(id); },
    });

    // ── 2. queue ─────────────────────────────────────────────────────────────────────
    console.log('\n[2] queue');
    const probe = dbReq({ reason: `${MARK}-queue` });
    await runRoleMatrix({ tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'read the encashment approval queue', endpoint: 'GET /hr/leave/encashments/queue', capability: CAP.EN_APP, roles: ALL_ROLES,
      act: (a) => apiGet(a, `${HR}/api/hr/leave/encashments/queue?status=pending`) });
    for (const key of ALL_ROLES) {
      const s = sessions[key]; if (!s || !s.caps.has(CAP.EN_APP)) continue;
      const a = key === world.apprKey ? appr : await actor(key).catch(() => null); if (!a) continue;
      try {
        const r = await apiGet(a, `${HR}/api/hr/leave/encashments/queue?status=pending`);
        const list = r.body?.data ?? [];
        const foreign = list.filter((e) => scalar(`SELECT org_id FROM hr.leave_encashment_requests WHERE id=${lit(e.id)}`) !== s.orgId);
        const sees = list.some((e) => e.id === probe), mayAll = s.caps.has(CAP.ADMIN);
        K.journal(key, 'Leave approvals', 'encashment queue scope', 'GET', '/hr/leave/encashments/queue', r.status, foreign.length === 0, 'own org only');
        if (foreign.length) fail('critical', key, 'Encashment queue returns requests from another branch / tenant', 'Only the active org', `${foreign.length} foreign (e.g. ${foreign[0].id})`, j(foreign[0]), 'listEncashmentQueue WHERE e.org_id = ctx.org_id.');
        if (s.orgId === world.orgId && s.userId !== world.apprId && !mayAll && sees) fail('high', key, 'Queue exposes a request the caller is neither assigned to nor over', 'Assigned approver, managers, hr.leave.admin only', 'sees the probe', probe, 'Scope clause.');
        if (s.userId === world.apprId && !sees) fail('high', key, 'Assigned approver does not see the request', 'Listed', 'missing', probe, 'approver_id = ctx.user_id.');
      } finally { if (a !== appr) await a.close(); }
    }
    const bq = await apiGet(appr, `${HR}/api/hr/leave/encashments/queue?status=bogus`);
    if (![400, 422].includes(bq.status)) fail(bq.status >= 500 ? 'high' : 'low', world.apprKey, 'Encashment queue with an unknown status', '400', `HTTP ${bq.status}`, j(bq.body), 'listCompOffQueueSchema enum.');
    K.purgeEncashment(probe);

    // ── 3. approve / reject matrices ─────────────────────────────────────────────────
    console.log('\n[3] decisions');
    const allow = K.decisionAllowList(world, sessions, CAP.EN_APP, world.apprId);
    console.log(`  authority (encashment.approve + assigned/admin + can_approve_leave): ${allow.join(', ') || 'none'}`);
    let cur = null;
    await runRoleMatrix({
      tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'approve an encashment request', endpoint: 'POST /hr/leave/encashments/:id/approve', allow, roles: ALL_ROLES,
      act: (a) => { cur = dbReq({ reason: `${MARK}-approve` }); return apiPost(a, `${HR}/api/hr/leave/encashments/${cur}/approve`, { comment: 'E2E ok' }); },
      verify: () => { const e = enRow(cur), l = ledgerFor(cur); return e?.status === 'approved' && l?.type === 'encashment' && Number(l.amount) === -1 && l.lt === typeId; },
      cleanup: () => K.purgeEncashment(cur),
    });
    await runRoleMatrix({
      tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'reject an encashment request', endpoint: 'POST /hr/leave/encashments/:id/reject', allow, roles: ALL_ROLES,
      act: (a) => { cur = dbReq({ reason: `${MARK}-reject` }); return apiPost(a, `${HR}/api/hr/leave/encashments/${cur}/reject`, { comment: 'E2E no' }); },
      verify: () => { const e = enRow(cur); return e?.status === 'rejected' && !e.ledger && e.comment === 'E2E no'; },
      cleanup: () => K.purgeEncashment(cur),
    });
    await runRoleMatrix({
      tool: 'hr', area: 'Leave dashboard', tab: 'Encashment requests', action: 'withdraw the employee\'s pending encashment request', endpoint: 'POST /hr/leave/encashments/:id/cancel', allow: [world.empKey], roles: ALL_ROLES,
      act: (a) => { cur = dbReq({ reason: `${MARK}-cancel` }); return apiPost(a, `${HR}/api/hr/leave/encashments/${cur}/cancel`, {}); },
      verify: () => enRow(cur)?.status === 'cancelled' && !enRow(cur).ledger,
      cleanup: () => K.purgeEncashment(cur),
    });
    // exact ledger / balance effect on the real path
    {
      const id = dbReq({ days: 2.5, reason: `${MARK}-ledger` });
      const before = K.balanceOf(world.empId, typeId);
      const r = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/approve`, { comment: 'cash it' });
      const after = K.balanceOf(world.empId, typeId), e = enRow(id), l = ledgerFor(id);
      K.journal(world.apprKey, 'Leave approvals', 'approve 2.5 encashed days: negative ledger row', 'POST', '/hr/leave/encashments/:id/approve', r.status, Math.abs(before - after - 2.5) < 0.001, 'balance -2.5');
      if (r.status !== 200 || Math.abs(before - after - 2.5) > 0.001 || l?.type !== 'encashment' || Number(l.amount) !== -2.5 || e.acted_by !== world.apprId || l.eff !== K.iso(new Date())) fail('high', world.apprKey, 'Approving an encashment debits the balance exactly once', "balance -2.5; one 'encashment' ledger row of -2.5 dated today; acted_by approver", `HTTP ${r.status}; balance ${before}->${after}; ${j({ e, l })}`, j(r.body), 'decideEncashment approve branch.');
      const again = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/approve`, {});
      const flip = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/reject`, { comment: 'flip' });
      const afterAgain = K.balanceOf(world.empId, typeId);
      if (again.status !== 409 || flip.status !== 409 || Math.abs(afterAgain - after) > 0.001 || enRow(id).status !== 'approved') fail('high', world.apprKey, 'Deciding an already approved encashment', '409; status and balance unchanged', `approve=${again.status} reject=${flip.status}; balance ${after}->${afterAgain}`, j(again.body), 'ConflictError when status !== pending.');
      const cancel = await apiPost(emp, `${HR}/api/hr/leave/encashments/${id}/cancel`, {});
      if (cancel.status < 400 || cancel.status >= 500 || enRow(id).status !== 'approved' || Math.abs(K.balanceOf(world.empId, typeId) - after) > 0.001) fail(cancel.status >= 500 ? 'high' : 'medium', world.empKey, 'Cancel an APPROVED encashment', 'Refused (404 "No pending encashment request"); the debit stays', `HTTP ${cancel.status}; status ${enRow(id).status}`, j(cancel.body), 'cancel applies to pending only.');
      K.journal(world.empKey, 'Leave dashboard', 'withdraw an APPROVED encashment', 'POST', '/hr/leave/encashments/:id/cancel', cancel.status, enRow(id).status === 'approved', 'refused');
      const rj = dbReq({ reason: `${MARK}-term` });
      await apiPost(appr, `${HR}/api/hr/leave/encashments/${rj}/reject`, { comment: 'no' });
      const back = await apiPost(appr, `${HR}/api/hr/leave/encashments/${rj}/approve`, {});
      if (back.status !== 409 || enRow(rj).status !== 'rejected') fail('high', world.apprKey, 'A rejected encashment can be approved afterwards', '409; stays rejected', `HTTP ${back.status}; ${enRow(rj).status}`, j(back.body), 'Terminal states.');
    }
    // approve re-check: balance spent after the request, policy switched off after the request
    {
      const id = dbReq({ days: 3, reason: `${MARK}-recheck` });
      const note = `E2E-spend-${MARK}`; K.seedBalance(world.empId, world.orgId, typeId, -(K.balanceOf(world.empId, typeId) - 1), note);
      const r = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/approve`, {});
      const st = enRow(id)?.status; const neg = K.balanceOf(world.empId, typeId);
      K.journal(world.apprKey, 'Leave approvals', 'approve after the balance was spent', 'POST', '/hr/leave/encashments/:id/approve', r.status, st === 'pending' && neg >= 0, '409, balance never negative');
      if (st !== 'pending' || r.status !== 409 || neg < 0) fail('critical', world.apprKey, 'Approving an encashment larger than the CURRENT balance', '409 "can no longer be approved"; balance never goes negative', `HTTP ${r.status}; status=${st}; balance=${neg}`, j(r.body), 'decideEncashment re-checks checkEncashment against today\'s balance.');
      q(`DELETE FROM hr.leave_ledger WHERE note=${lit(note)}`);
      K.purgeEncashment(id);
      // policy no longer encashable
      const id2 = dbReq({ days: 1, reason: `${MARK}-nopolicy` });
      q(`UPDATE hr.leave_policies SET encashable=false WHERE org_id=${lit(world.orgId)} AND tenant_id=${lit(world.tenantId)} AND sla_hours=37 AND leave_type_id=${lit(typeId)}`);
      const r2 = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id2}/approve`, {});
      q(`UPDATE hr.leave_policies SET encashable=true WHERE org_id=${lit(world.orgId)} AND tenant_id=${lit(world.tenantId)} AND sla_hours=37 AND leave_type_id=${lit(typeId)}`);
      if (r2.status !== 409 || enRow(id2).status !== 'pending') fail('high', world.apprKey, 'Approving after the policy stopped allowing encashment', '409 "can no longer be approved: That leave type cannot be encashed"', `HTTP ${r2.status}; status=${enRow(id2).status}`, j(r2.body), 'Re-check policy at approval.');
      K.purgeEncashment(id2);
    }
    // reject needs a comment
    {
      const id = dbReq({ reason: `${MARK}-comment` });
      const a1 = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/reject`, {});
      const a2 = await apiPost(appr, `${HR}/api/hr/leave/encashments/${id}/reject`, { comment: '  ' });
      if (![400, 422].includes(a1.status) || ![400, 422].includes(a2.status) || enRow(id).status !== 'pending') fail('medium', world.apprKey, 'Reject an encashment without a comment', '400; stays pending', `${a1.status}/${a2.status}; ${enRow(id).status}`, j(a1.body), 'rejectCompOffSchema requires a non-blank comment.');
      K.purgeEncashment(id);
    }
    // self approval
    {
      const mineId = K.insertEncashment({ userId: world.apprId, orgId: world.orgId, typeId, days: 1, approverId: world.apprId, reason: `${MARK}-self` });
      const r1 = await apiPost(appr, `${HR}/api/hr/leave/encashments/${mineId}/approve`, { comment: 'me' });
      const r2 = await apiPost(appr, `${HR}/api/hr/leave/encashments/${mineId}/reject`, { comment: 'me' });
      const st = enRow(mineId)?.status;
      K.journal(world.apprKey, 'Leave approvals', 'approve / reject my OWN encashment request', 'POST', '/hr/leave/encashments/:id/approve', `${r1.status}/${r2.status}`, st === 'pending', '403');
      if (st !== 'pending' || r1.status === 200 || r2.status === 200) fail('critical', world.apprKey, 'Self-approval of an encashment request', '403; stays pending; no debit', `approve=${r1.status} reject=${r2.status} status=${st}`, j(r1.body), 'canApproveLeave() must stay on every decision path.');
      K.purgeEncashment(mineId);
    }
    // malformed / unknown ids
    for (const p of ['not-a-uuid', '019fffff-ffff-7fff-8fff-ffffffffffff']) {
      for (const [verb, body, who] of [['approve', {}, appr], ['reject', { comment: 'x' }, appr], ['cancel', {}, emp]]) {
        const r = await apiPost(who, `${HR}/api/hr/leave/encashments/${p}/${verb}`, body);
        K.journal(who === emp ? world.empKey : world.apprKey, 'Leave approvals', `encashment ${verb} with id '${p}'`, 'POST', `/hr/leave/encashments/:id/${verb}`, r.status, null, '404/400');
        if (r.status >= 500) fail('medium', who === emp ? world.empKey : world.apprKey, `encashment ${verb} with ${p === 'not-a-uuid' ? 'a malformed id' : 'an unknown id'}`, '404 (or 400) - never a 5xx', `HTTP ${r.status}`, j(r.body), `leave.router.ts /leave/encashments/:id/${verb} has no params schema; the uuid compare in decideEncashment/cancelEncashment raises PG 22P02 -> 500. Validate params.id as uuid.`);
      }
    }

    // ── 5. races ──────────────────────────────────────────────────────────────────────
    console.log('\n[5] races');
    const other = allow.find((k) => k !== world.apprKey && k !== world.empKey);
    const otherA = other ? await actor(other) : null;
    try {
      const raceOf = async (label, a, b, coherentOf) => {
        const id = dbReq({ reason: `${MARK}-race` });
        const t0 = new Date(Date.now() - 1000).toISOString();
        const res = await simultaneously([() => a(id), () => b(id)]);
        const st = res.map((r) => r?.status), e = enRow(id), n = encashRows(world.empId, t0);
        const coherent = coherentOf(st, e, n);
        K.journal(`${world.apprKey}+${other ?? world.apprKey}`, 'Leave approvals', label, 'POST', 'encashments/:id/*', st.join('/'), coherent, 'exactly one winner');
        console.log(`  ${label}: ${st.join('/')} final=${e.status} ledger=${n}`);
        if (!coherent || st.some((s) => s >= 500)) fail(n > 1 ? 'critical' : 'high', `${world.apprKey}+${other ?? world.apprKey}`, label, 'One winner; status, ledger and balance agree; the loser gets 409/404; no 5xx', `statuses=${st}; final=${e.status}; encashment ledger rows=${n}`, j(res.map((r) => r?.body)), 'decideEncashment: SELECT ... FOR UPDATE before the status read; cancelEncashment UPDATE ... WHERE status=pending.');
        K.purgeEncashment(id);
      };
      const ap = (a) => (id) => apiPost(a, `${HR}/api/hr/leave/encashments/${id}/approve`, {});
      const rj = (a) => (id) => apiPost(a, `${HR}/api/hr/leave/encashments/${id}/reject`, { comment: 'R' });
      const cn = (id) => apiPost(emp, `${HR}/api/hr/leave/encashments/${id}/cancel`, {});
      for (let i = 0; i < 2; i++) await raceOf('two approvers approve the same encashment simultaneously', ap(appr), ap(otherA ?? appr), (st, e, n) => st.filter((s) => s === 200).length === 1 && e.status === 'approved' && n === 1);
      for (let i = 0; i < 2; i++) await raceOf('approve vs reject of the same encashment simultaneously', ap(appr), rj(otherA ?? appr), (st, e, n) => st.filter((s) => s === 200).length === 1 && ((e.status === 'approved' && n === 1) || (e.status === 'rejected' && n === 0)));
      for (let i = 0; i < 2; i++) await raceOf('approve vs the owner\'s withdraw simultaneously', ap(appr), cn, (st, e, n) => (e.status === 'approved' && n === 1 && st[0] === 200 && st[1] >= 400) || (e.status === 'cancelled' && n === 0 && st[1] === 200 && st[0] >= 400));
      await raceOf('double-click approve (same approver twice)', ap(appr), ap(appr), (st, e, n) => st.filter((s) => s === 200).length === 1 && n === 1);
    } finally { await otherA?.close(); }
    if (world.xKey) {
      const xa = await actor(world.xKey); const id = dbReq({ reason: `${MARK}-xt` });
      try {
        const rs = [await apiPost(xa, `${HR}/api/hr/leave/encashments/${id}/approve`, {}), await apiPost(xa, `${HR}/api/hr/leave/encashments/${id}/reject`, { comment: 'x' }), await apiPost(xa, `${HR}/api/hr/leave/encashments/${id}/cancel`, {})];
        K.journal(world.xKey, 'Leave approvals', 'tenant B approves / rejects / cancels a tenant A encashment', 'POST', '/hr/leave/encashments/:id/*', rs.map((r) => r.status).join('/'), enRow(id).status === 'pending', 'denied, untouched');
        if (enRow(id).status !== 'pending' || rs.some((r) => r.status < 400 || r.status >= 500)) fail(enRow(id).status !== 'pending' ? 'critical' : 'high', world.xKey, 'Cross-tenant decision on an encashment request', '403/404; untouched', `statuses=${rs.map((r) => r.status)} final=${enRow(id).status}`, j(rs[0].body), 'org_id check in decideEncashment.');
      } finally { await xa.close(); K.purgeEncashment(id); }
    }

    // ── 6. capability toggle ──────────────────────────────────────────────────────────
    console.log('\n[6] capability toggle');
    const flip = async (key, roleName, cap, probeFn) => {
      setOverride(world.tenantId, roleName, cap, false);
      try {
        const a = await actor(key); try { await waitForSessionCapability(a, cap, false); } finally { await a.close(); }
        await new Promise((r) => setTimeout(r, 1500));
        await probeFn(false);
      } finally { restoreAll(); }
      const a = await actor(key); try { await waitForSessionCapability(a, cap, true); } finally { await a.close(); }
      await new Promise((r) => setTimeout(r, 1500));
      await probeFn(true);
    };
    await flip(world.empKey, 'fitness_trainer', CAP.EN_REQ, async (on) => {
      const a = await actor(world.empKey); clearOpen(world.empId);
      try {
        const r = await create(a, { leave_type_name: 'casual', days: 1, reason: `${MARK}-toggle` });
        if (idOf(r.body)) K.trackEncashment(idOf(r.body));
        const c = await apiPost(a, `${HR}/api/hr/leave/encashments/019fffff-ffff-7fff-8fff-ffffffffffff/cancel`, {});
        K.journal(world.empKey, 'Leave dashboard', `hr.leave.encashment.request ${on ? 'restored' : 'revoked'}: request`, 'POST', '/hr/leave/encashments', r.status, on ? r.status === 201 : r.status === 403, on ? 'allowed' : 'denied');
        if (!on && (r.status !== 403 || c.status !== 403)) fail('high', world.empKey, 'hr.leave.encashment.request revoked but requesting / withdrawing still works', '403 on both', `request=${r.status} cancel=${c.status}`, j(r.body), 'requireCapability(HR_LEAVE_ENCASHMENT_REQUEST).');
        if (on && r.status !== 201) fail('high', world.empKey, 'hr.leave.encashment.request restored but requesting fails', '201', `HTTP ${r.status}`, j(r.body), 'Capability cache.');
        if (idOf(r.body)) { await apiPost(a, `${HR}/api/hr/leave/encashments/${idOf(r.body)}/cancel`, {}); }
      } finally { await a.close(); }
    });
    await flip(world.apprKey, 'fitness_manager', CAP.EN_APP, async (on) => {
      const a = await actor(world.apprKey);
      try {
        const id = dbReq({ reason: `${MARK}-toggle2` });
        const qr = await apiGet(a, `${HR}/api/hr/leave/encashments/queue`);
        const ar = await apiPost(a, `${HR}/api/hr/leave/encashments/${id}/approve`, {});
        const st = enRow(id).status;
        K.journal(world.apprKey, 'Leave approvals', `hr.leave.encashment.approve ${on ? 'restored' : 'revoked'}: queue + approve`, 'GET/POST', 'queue | approve', `${qr.status}/${ar.status}`, on ? st === 'approved' : st === 'pending', on ? 'allowed' : 'denied');
        if (!on && (qr.status !== 403 || ar.status !== 403 || st !== 'pending')) fail('high', world.apprKey, 'hr.leave.encashment.approve revoked but the queue / approve still work', '403 on both; pending', `queue=${qr.status} approve=${ar.status} status=${st}`, j(ar.body), 'The capability must beat the assigned-approver shortcut.');
        if (on && (qr.status !== 200 || st !== 'approved')) fail('high', world.apprKey, 'hr.leave.encashment.approve restored but approve fails', '200 + approved', `queue=${qr.status} status=${st}`, j(ar.body), 'Capability cache.');
        K.purgeEncashment(id);
      } finally { await a.close(); }
    });
  }

  // ═════════════ UI ═════════════
  if (doUi) {
    console.log('\n[UI] employee: Encash leave dialog');
    clearOpen(world.empId);
    const upId = (reason) => scalar(`SELECT id FROM hr.leave_encashment_requests WHERE reason=${lit(reason)} AND NOT is_deleted LIMIT 1`);
    {
      const { browser, page, log } = await openAs(world.empKey);
      try {
        await page.goto(`${HR}/leave`, { waitUntil: 'domcontentloaded' }); await K.settle(page, 2000);
        const btn = page.getByRole('button', { name: 'Encash leave', exact: true });
        if (!(await btn.count())) fail('high', world.empKey, 'Encash leave button for a holder of hr.leave.encashment.request', 'Visible in the header', `url=${page.url()}`, '', 'LeaveDashboardShell canEncash.');
        else {
          await btn.click(); await page.waitForTimeout(900);
          const opts = await page.locator('#en-type option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
          console.log(`  encashable types offered: ${opts.map((o) => o.v || '(choose)').join(', ')}`);
          K.journal(world.empKey, 'Leave dashboard', 'Encash dialog: leave type dropdown options', 'UI', '#en-type', null, opts.some((o) => o.v === 'casual') && !opts.some((o) => o.v === 'sick'), 'only encashable types');
          if (!opts.some((o) => o.v === 'casual')) fail('high', world.empKey, 'Encash dialog offers the encashable leave type', 'casual (encashable policy seeded) listed', j(opts), '', 'EncashRequestModal filters policy-summary by encashable.');
          if (opts.some((o) => o.v === 'sick')) fail('medium', world.empKey, 'Encash dialog offers a leave type that cannot be encashed', 'sick absent', j(opts), '', 'Filter on p.encashable.');
          for (const o of opts) await page.selectOption('#en-type', o.v); // every option
          // validation + server refusal (days above the cap)
          await page.selectOption('#en-type', ''); await page.getByRole('button', { name: 'Submit request' }).click(); await page.waitForTimeout(300);
          const v1 = await page.getByText('Pick a leave type and the number of days.').count();
          await page.selectOption('#en-type', 'casual'); await page.fill('#en-days', '4');
          const bad = await K.withResponse(page, (m, u) => m === 'POST' && /hr\/leave\/encashments$/.test(u), () => page.getByRole('button', { name: 'Submit request' }).click());
          await page.waitForTimeout(500);
          const alerts = await page.locator('[role=alert]').allInnerTexts();
          K.journal(world.empKey, 'Leave dashboard', 'Encash dialog: client validation + server cap message', 'UI', 'Submit request', bad.status, !!v1 && [400, 422].includes(bad.status) && alerts.some((t) => /at most/i.test(t)), 'messages shown');
          if (!v1 || ![400, 422].includes(bad.status) || !alerts.some((t) => /at most 3/i.test(t))) fail('medium', world.empKey, 'Encash dialog explains refusals', '"Pick a leave type..." then "At most 3 days can be encashed at a time"', `client=${v1} HTTP ${bad.status}; alerts=${j(alerts)}`, '', 'EncashRequestModal.submit.');
          await page.fill('#en-days', '2'); await page.fill('#en-reason', `${MARK}-ui-claim`);
          const ok = await K.withResponse(page, (m, u) => m === 'POST' && /hr\/leave\/encashments$/.test(u), () => page.getByRole('button', { name: 'Submit request' }).click());
          await K.settle(page, 1200);
          const id = upId(`${MARK}-ui-claim`); if (id) K.trackEncashment(id);
          const e = id ? enRow(id) : null;
          K.journal(world.empKey, 'Leave dashboard', 'Encash 2 casual days through the dialog', 'UI', 'Submit request', ok.status, e?.status === 'pending' && e.days === '2.00', '201 pending row');
          if (ok.status !== 201 || !e || e.status !== 'pending' || e.days !== '2.00') fail('high', world.empKey, 'Submit an encashment request through the browser', '201; pending row of 2 days', `HTTP ${ok.status}; ${j(e)}`, '', 'EncashRequestModal -> POST /hr/leave/encashments.');
          if (!(await page.getByText('Encashment request submitted for approval').count())) fail('low', world.empKey, 'Success notice after an encashment request', '"Encashment request submitted for approval."', 'none', '', 'Dashboard notice.');
          // section list + Withdraw
          const item = page.locator('li', { hasText: 'Casual Leave' }).filter({ hasText: '2 days' }).first();
          if (await item.count()) {
            const w = await K.withResponse(page, (m, u) => m === 'POST' && /encashments\/.*\/cancel$/.test(u), () => item.getByRole('button', { name: 'Withdraw' }).click());
            await K.settle(page, 900);
            K.journal(world.empKey, 'Leave dashboard', 'Withdraw a pending encashment from My requests', 'UI', 'Withdraw', w.status, enRow(id)?.status === 'cancelled', 'cancelled');
            if (w.status !== 200 || enRow(id)?.status !== 'cancelled') fail('high', world.empKey, 'Withdraw my pending encashment request', '200; cancelled in Postgres', `HTTP ${w.status}; ${enRow(id)?.status}`, '', 'MyEncashments -> cancel.');
          } else fail('medium', world.empKey, 'My encashment requests section lists the request', 'Row "Casual Leave - 2 days"', 'not listed', '', 'MyEncashments.');
          // leave a pending one for the approver (the employee asks again)
          await btn.click(); await page.waitForTimeout(700);
          await page.selectOption('#en-type', 'casual'); await page.fill('#en-days', '1'); await page.fill('#en-reason', `${MARK}-ui-approve`);
          await K.withResponse(page, (m, u) => m === 'POST' && /hr\/leave\/encashments$/.test(u), () => page.getByRole('button', { name: 'Submit request' }).click());
          await K.settle(page, 900);
          const aid = upId(`${MARK}-ui-approve`); if (aid) K.trackEncashment(aid);
          // Cancel button of the dialog closes without sending
          await btn.click(); await page.waitForTimeout(500); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.waitForTimeout(300);
        }
        K.reportUiLog(fail, world.empKey, 'Leave dashboard (encashment)', log, [/hr\/leave\/encashments$/, /\/hr\/employees/, /hr\/documents\/settings/]);
      } finally { await browser.close(); }
    }
    console.log('\n[UI] approver: encashment queue');
    {
      const approveId = upId(`${MARK}-ui-approve`);
      // a second request to reject: the unique index allows one open per user+type, so raise it as another user
      const rejId = K.insertEncashment({ userId: world.rep2Id ?? world.apprId, orgId: world.orgId, typeId, days: 1, approverId: world.apprId, reason: `${MARK}-ui-reject` });
      const { browser, page, log } = await openAs(world.apprKey);
      try {
        await page.goto(`${HR}/leave/approvals`, { waitUntil: 'domcontentloaded' }); await K.settle(page, 2000);
        const tab = page.getByRole('tab', { name: /Comp-off & encashment/ });
        if (!(await tab.count())) fail('high', world.apprKey, 'Comp-off & encashment tab for a holder of hr.leave.encashment.approve', 'Visible', 'missing', page.url(), 'LeaveApprovalsShell showClaims.');
        else {
          await tab.click(); await K.settle(page, 1200);
          const ap = page.locator('li', { hasText: `${MARK}-ui-approve` }).first();
          const rj = page.locator('li', { hasText: `${MARK}-ui-reject` }).first();
          if (!(await ap.count())) fail('high', world.apprKey, 'Encashment queue lists the employee\'s request', 'Card with the E2E note', 'missing', '', 'encashments.queue(pending).');
          else {
            const before = K.balanceOf(world.empId, typeId);
            await ap.getByRole('button', { name: 'Approve' }).click(); await page.waitForTimeout(500);
            const w = await K.withResponse(page, (m, u) => m === 'POST' && /encashments\/.*\/approve$/.test(u), () => page.getByRole('button', { name: 'Approve', exact: true }).last().click());
            await K.settle(page, 900);
            const e = enRow(approveId), after = K.balanceOf(world.empId, typeId);
            K.journal(world.apprKey, 'Leave approvals', 'Approve an encashment (UI): ledger debit', 'UI', 'Approve', w.status, e?.status === 'approved' && Math.abs(before - after - 1) < 0.001, 'approved, balance -1');
            if (w.status !== 200 || e?.status !== 'approved' || Math.abs(before - after - 1) > 0.001) fail('high', world.apprKey, 'Approve an encashment from the queue', '200; approved; balance -1', `HTTP ${w.status}; ${e?.status}; balance ${before}->${after}`, '', 'EncashmentQueue -> approve.');
          }
          if (await rj.count()) {
            await rj.getByRole('button', { name: 'Reject' }).click(); await page.waitForTimeout(500);
            await page.getByRole('button', { name: 'Reject', exact: true }).last().click(); await page.waitForTimeout(500);
            const needs = await page.getByText('A comment is required when rejecting.').count();
            await page.fill('#eq-c', 'E2E ui reject');
            const w = await K.withResponse(page, (m, u) => m === 'POST' && /encashments\/.*\/reject$/.test(u), () => page.getByRole('button', { name: 'Reject', exact: true }).last().click());
            await K.settle(page, 900);
            const e = enRow(rejId);
            K.journal(world.apprKey, 'Leave approvals', 'Reject an encashment (UI, comment required)', 'UI', 'Reject', w.status, e?.status === 'rejected' && !e.ledger, 'rejected, no ledger');
            if (!needs || w.status !== 200 || e?.status !== 'rejected' || e.ledger) fail('high', world.apprKey, 'Reject an encashment from the queue', 'Comment required first; 200; rejected; no debit', `needs=${needs} HTTP ${w.status}; ${j(e)}`, '', 'EncashmentQueue.submit.');
          } else fail('medium', world.apprKey, 'Encashment queue lists a colleague\'s request', 'Card present', 'missing', '', 'Queue scope.');
        }
        K.reportUiLog(fail, world.apprKey, 'Leave approvals (encashment)', log, [/encashments\/.*\/(approve|reject)/]);
      } finally { await browser.close(); }
    }
    console.log('\n[UI] capability off -> hidden');
    const uiProbe = async (key, roleName, cap, url, check) => {
      setOverride(world.tenantId, roleName, cap, false);
      let off, on;
      try {
        const a = await actor(key); try { await waitForSessionCapability(a, cap, false); } finally { await a.close(); }
        await new Promise((r) => setTimeout(r, 1500));
        { const o = await openAs(key); try { await o.page.goto(url, { waitUntil: 'domcontentloaded' }); await K.settle(o.page, 2000); off = await check(o.page); } finally { await o.browser.close(); } }
      } finally { restoreAll(); }
      { const a = await actor(key); try { await waitForSessionCapability(a, cap, true); } finally { await a.close(); } }
      await new Promise((r) => setTimeout(r, 1500));
      { const o = await openAs(key); try { await o.page.goto(url, { waitUntil: 'domcontentloaded' }); await K.settle(o.page, 2000); on = await check(o.page); } finally { await o.browser.close(); } }
      return { off, on };
    };
    const u1 = await uiProbe(world.empKey, 'fitness_trainer', CAP.EN_REQ, `${HR}/leave`, async (p) => ({
      button: await p.getByRole('button', { name: 'Encash leave', exact: true }).count(), section: await p.getByText('Encashment requests', { exact: true }).count() }));
    K.journal(world.empKey, 'Leave dashboard', 'encashment.request revoked -> Encash button + section hidden', 'UI', 'Encash leave', null, u1.off.button === 0 && u1.off.section === 0, 'hidden');
    if (u1.off.button || u1.off.section) fail('medium', world.empKey, 'Encashment controls stay visible after hr.leave.encashment.request is revoked', 'Button and section hidden', j(u1.off), j(u1.off), 'LeaveDashboardShell canEncash.');
    if (!u1.on.button) fail('high', world.empKey, 'Encash button not back after restore', 'visible', j(u1.on), '', 'Capability cache.');
    const u2 = await uiProbe(world.apprKey, 'fitness_manager', CAP.EN_APP, `${HR}/leave/approvals`, async (p) => {
      const t = p.getByRole('tab', { name: /Comp-off & encashment/ });
      let section = 0;
      if (await t.count()) { await t.click(); await K.settle(p, 900); section = await p.getByText('Encashment requests', { exact: true }).count(); }
      return { tab: await t.count(), section };
    });
    K.journal(world.apprKey, 'Leave approvals', 'encashment.approve revoked -> Encashment section hidden', 'UI', 'Encashment requests', null, u2.off.section === 0, 'hidden');
    if (u2.off.section) fail('medium', world.apprKey, 'Encashment queue visible after hr.leave.encashment.approve is revoked', 'Section hidden', j(u2.off), j(u2.off), 'LeaveApprovalsShell can(actor, HR_LEAVE_ENCASHMENT_APPROVE).');
    if (!u2.on.section) fail('high', world.apprKey, 'Encashment queue not back after restore', 'visible', j(u2.on), '', 'Capability cache.');
  }
} finally {
  restoreAll();
  await emp.close(); await appr.close();
  K.runCleanup();
  q(`DELETE FROM hr.leave_encashment_requests WHERE reason LIKE ${lit(`${MARK}%`)}`);
  console.log(`\n${fail.count()} finding(s) recorded to results/findings-hr.json`);
}
