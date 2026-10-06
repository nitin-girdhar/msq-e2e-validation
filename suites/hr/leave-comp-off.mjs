// Comp-off (/hr/leave/comp-off*): create, list, queue, approve, reject, cancel - full lifecycle.
//
// Money model under test (leave.repository.ts, schema 1.62+): an APPROVED claim appends ONE positive
// 'adjustment' row ("Comp-off credit") to hr.leave_ledger for the tenant's comp_off type and stamps
// expires_on = today + 90; a REJECTED or CANCELLED claim moves no balance. Every claim below is verified in
// Postgres (status, ledger row, balance delta), and the role matrices are graded on live capabilities AND
// the platform's own authority rule (hr.can_approve_leave queried in Postgres), never on role names.
//
//   1. create: server rules (weekly off / holiday only, not future, <= 60 days back, 0.5|1 day, reason,
//      one open claim per day) + a role matrix on hr.leave.comp_off.request
//   2. queue / own list: capability-gated, org-scoped, no tenant leak
//   3. approve / reject: role matrix graded by capability + authority, ledger / balance / expiry verified
//   4. self-approval, approve-after-decision, cancel-after-decision, IDOR (other user's claim, other tenant)
//   5. races: two approvers, approve vs reject, approve vs the owner's cancel -> exactly one winner, no 5xx
//   6. malformed ids -> clean 4xx
//   7. capability toggle (tenant-scoped override, restored in finally): API denies AND the UI hides
//   8. UI: Claim comp-off dialog (validation, full/half day, submit), my claims list (Cancel), approver
//      tab (Reject needs a comment, Approve credits), verified in Postgres
//
//   node suites/hr/leave-comp-off.mjs [api|ui]
import { openAs } from '../../lib.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { setOverride, restoreAll, waitForSessionCapability } from '../../capability.mjs';
import { dbReachable } from '../../db.mjs';
import * as K from './_leave-kit.mjs';
const { HR, CAP, actor, apiGet, apiPost, scalar, rows, q, lit, simultaneously, ALL_ROLES } = K;

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const mode = (process.argv[2] || 'all').toLowerCase();
const doApi = mode === 'all' || mode === 'api', doUi = mode === 'all' || mode === 'ui';
const fail = K.makeFail('Leave - comp-off');
const world = K.resolveWorld();
const { stamp } = K;
const MARK = `E2E-compoff-${stamp}`;
const coType = K.leaveTypeId(world.tenantId, 'comp_off');
if (!coType) { console.log('tenant has no comp_off leave type - aborting'); process.exit(0); }

const claimRow = (id) => rows(`SELECT status, days::text, approver_id::text, acted_by::text, approver_comment, ledger_entry_id::text, expires_on::text, user_id::text
   FROM hr.comp_off_claims WHERE id=${lit(id)}`, ['status', 'days', 'approver', 'acted_by', 'comment', 'ledger', 'expires', 'user'])[0] ?? null;
const ledgerFor = (id) => rows(`SELECT l.entry_type, l.amount::text, l.leave_type_id::text, l.user_id::text, l.note FROM hr.comp_off_claims c
   JOIN hr.leave_ledger l ON l.id=c.ledger_entry_id WHERE c.id=${lit(id)}`, ['type', 'amount', 'lt', 'user', 'note'])[0] ?? null;
const creditRows = (userId, since) => Number(scalar(`SELECT COUNT(*) FROM hr.leave_ledger WHERE user_id=${lit(userId)} AND leave_type_id=${lit(coType)} AND note='Comp-off credit' AND created_at >= ${lit(since)}`) ?? 0);
const claimsOf = (userId) => new Set(rows(`SELECT worked_date::text FROM hr.comp_off_claims WHERE user_id=${lit(userId)} AND status IN ('pending','approved') AND NOT is_deleted`, ['d']).map((r) => r.d));
const homeOrgOf = (userId) => scalar(`SELECT org_id FROM iam.users WHERE id=${lit(userId)}`);
const idOf = (b) => b?.data?.id ?? null;
const j = K.j;
let oldDay = 150; // DB-inserted claims use dates the API would refuse; unique per (user, date)
const nextOld = () => K.iso(K.addDays(-(oldDay++)));
const empPattern = K.weeklyOffOf(world.empId);
console.log(`world: employee=${world.empKey} (weekly off ${JSON.stringify(empPattern)}) approver=${world.apprKey} comp_off type=${coType}`);

const emp = await actor(world.empKey);
const appr = await actor(world.apprKey);
let sessions = {};
const dbClaim = (over = {}) => K.insertClaim({ userId: world.empId, orgId: world.orgId, date: nextOld(), days: 1, approverId: world.apprId, reason: `${MARK}-db`, ...over });

try {
  sessions = await K.allSessions();
  console.log(`sessions: ${Object.keys(sessions).length}/${ALL_ROLES.length}`);
  // an extra comp-off type can be switched off per tenant: record how this tenant is configured
  const typeActive = scalar(`SELECT is_active FROM hr.leave_types WHERE id=${lit(coType)}`);
  console.log(`comp_off type active=${typeActive}`);

  if (doApi) {
    // ── 1. create + rules ────────────────────────────────────────────────────────
    console.log('\n[1] create');
    const taken = claimsOf(world.empId);
    const dayA = K.recentOffDay(empPattern, taken);
    const dayB = K.recentOffDay(empPattern, taken, { skip: 1 });
    const create = (a, body) => apiPost(a, `${HR}/api/hr/leave/comp-off`, body);
    const c1 = await create(emp, { worked_date: dayA, days: 1, reason: `${MARK}-create` });
    const c1id = K.trackClaim(idOf(c1.body));
    const r1 = c1id ? claimRow(c1id) : null;
    K.journal(world.empKey, 'Leave dashboard', 'claim comp-off for a weekly-off day', 'POST', '/hr/leave/comp-off', c1.status, r1?.status === 'pending', '201 pending claim');
    if (c1.status !== 201 || !r1 || r1.status !== 'pending' || r1.days !== '1.0' || r1.user !== world.empId || r1.approver !== world.apprId) {
      fail('high', world.empKey, `Claim comp-off for ${dayA} (a weekly off)`, '201; pending row owned by the caller, approver = reporting-line manager, days 1', `HTTP ${c1.status}; ${j(r1)}`, j(c1.body), 'createCompOffClaim (leave.repository.ts) INSERT + resolveApprovers.');
    }
    const mine = await apiGet(emp, `${HR}/api/hr/leave/comp-off`);
    if (!(mine.body?.data ?? []).some((c) => c.id === c1id) || (mine.body?.data ?? []).some((c) => c.user_id !== world.empId)) fail('high', world.empKey, 'My comp-off list', 'Contains my claim and ONLY my claims', `HTTP ${mine.status}; foreign rows=${(mine.body?.data ?? []).filter((c) => c.user_id !== world.empId).length}`, j(mine.body?.data?.slice?.(0, 2)), 'listOwnCompOffClaims filters user_id.');
    const dup = await create(emp, { worked_date: dayA, days: 0.5, reason: `${MARK}-dup` });
    K.journal(world.empKey, 'Leave dashboard', 'second open claim for the same day', 'POST', '/hr/leave/comp-off', dup.status, null, '409');
    if (idOf(dup.body)) K.trackClaim(idOf(dup.body));
    if (dup.status !== 409) fail(dup.status >= 500 ? 'high' : 'medium', world.empKey, 'Duplicate open claim for the same day', '409 "already have a comp-off claim"', `HTTP ${dup.status}`, j(dup.body), 'Map the 23505 on uix_comp_off_claims_open to ConflictError.');
    const workday = K.weekday(-5); const wdPast = (() => { let d = K.addDays(-5); while (empPattern.includes(d.getUTCDay())) d = K.addDays(-1, d); return K.iso(d); })();
    void workday;
    const rules = [
      ['a rostered working day', { worked_date: wdPast, days: 1, reason: 'x' }, 400],
      ['a future date', { worked_date: K.iso(K.addDays(2)), days: 1, reason: 'x' }, 400],
      ['a day older than 60 days', { worked_date: K.iso(K.addDays(-70)), days: 1, reason: 'x' }, 400],
      ['2 days', { worked_date: dayB, days: 2, reason: 'x' }, 400],
      ['0 days', { worked_date: dayB, days: 0, reason: 'x' }, 400],
      ['a blank reason', { worked_date: dayB, days: 1, reason: '   ' }, 400],
      ['a 501-char reason', { worked_date: dayB, days: 1, reason: 'r'.repeat(501) }, 400],
      ['a malformed date', { worked_date: '2026-13-45', days: 1, reason: 'x' }, 400],
      ['no body fields', {}, 400],
    ];
    for (const [label, body, want] of rules) {
      const r = await create(emp, body);
      if (idOf(r.body)) K.trackClaim(idOf(r.body));
      K.journal(world.empKey, 'Leave dashboard', `claim comp-off for ${label}`, 'POST', '/hr/leave/comp-off', r.status, null, String(want));
      if (![400, 422].includes(r.status)) fail('high', world.empKey, `Comp-off claim for ${label}`, `HTTP 400/422 with a clear reason`, `HTTP ${r.status}`, j(r.body), 'checkClaimDate / createCompOffClaimSchema (comp-off.ts).');
    }
    const half = await create(emp, { worked_date: dayB, days: 0.5, reason: `${MARK}-half` });
    const halfId = K.trackClaim(idOf(half.body));
    if (half.status !== 201 || claimRow(halfId)?.days !== '0.5') fail('medium', world.empKey, 'Half-day comp-off claim', '201 with days 0.5', `HTTP ${half.status}; ${j(claimRow(halfId))}`, j(half.body), 'chk_comp_off_claims_days allows 0.5 and 1.');
    // identity cannot be supplied by the client
    const forge = await create(emp, { worked_date: K.recentOffDay(empPattern, claimsOf(world.empId)), days: 1, reason: `${MARK}-forge`, user_id: world.apprId, org_id: world.noidaOrgId, approver_id: world.empId, status: 'approved' });
    const forgeId = K.trackClaim(idOf(forge.body));
    const fr = forgeId ? claimRow(forgeId) : null;
    K.journal(world.empKey, 'Leave dashboard', 'claim with client-supplied user_id/org_id/status/approver_id', 'POST', '/hr/leave/comp-off', forge.status, fr?.user === world.empId, 'identity from the session only');
    if (fr && (fr.user !== world.empId || fr.status !== 'pending' || fr.approver === world.empId)) fail('critical', world.empKey, 'Client-supplied identity / status on a comp-off claim', 'user_id, org_id, approver and status come from the session / resolver, never the body', j(fr), j(forge.body), 'Strip unknown keys; zod object is non-strict but the repository must ignore them (it does) - this means a different insert path.');

    // role matrix: create
    console.log('  role matrix: create a claim as every login');
    const keysHome = Object.fromEntries(ALL_ROLES.map((k) => [k, (() => { const e = K.emailOfKey(k); return e ? scalar(`SELECT id FROM iam.users WHERE email=${lit(e.toLowerCase())}`) : null; })()]));
    const offHome = ALL_ROLES.filter((k) => sessions[k] && keysHome[k] && sessions[k].orgId !== homeOrgOf(keysHome[k]));
    if (offHome.length) console.log(`  (not graded - session is on a branch other than home, claims are home-branch only: ${offHome.join(', ')})`);
    await runRoleMatrix({
      tool: 'hr', area: 'Leave dashboard', tab: 'Comp-off claims', action: 'claim comp-off', endpoint: 'POST /hr/leave/comp-off', capability: CAP.CO_REQ, observe: ['super_admin', ...offHome], roles: ALL_ROLES,
      act: async (a, role) => {
        const uid = keysHome[role]; const pat = uid ? K.weeklyOffOf(uid) : [0, 6];
        const date = K.recentOffDay(pat, uid ? claimsOf(uid) : new Set());
        return create(a, { worked_date: date, days: 1, reason: `${MARK}-matrix-${role}` });
      },
      verify: (role) => Number(scalar(`SELECT COUNT(*) FROM hr.comp_off_claims WHERE reason=${lit(`${MARK}-matrix-${role}`)}`)) === 1,
      cleanup: () => { for (const id of rows(`SELECT id FROM hr.comp_off_claims WHERE reason LIKE ${lit(`${MARK}-matrix-%`)}`, ['id']).map((r) => r.id)) K.purgeClaim(id); },
    });

    // ── 2. queue + own list ───────────────────────────────────────────────────────────
    console.log('\n[2] queue');
    const probe = dbClaim({ reason: `${MARK}-queue` });
    await runRoleMatrix({ tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'read the comp-off approval queue', endpoint: 'GET /hr/leave/comp-off/queue', capability: CAP.CO_APP, roles: ALL_ROLES,
      act: (a) => apiGet(a, `${HR}/api/hr/leave/comp-off/queue?status=pending`) });
    for (const key of ALL_ROLES) {
      const s = sessions[key]; if (!s || !s.caps.has(CAP.CO_APP)) continue;
      const a = key === world.apprKey ? appr : await actor(key).catch(() => null); if (!a) continue;
      try {
        const r = await apiGet(a, `${HR}/api/hr/leave/comp-off/queue?status=pending`);
        const list = r.body?.data ?? [];
        const foreign = list.filter((c) => scalar(`SELECT org_id FROM hr.comp_off_claims WHERE id=${lit(c.id)}`) !== s.orgId);
        const sees = list.some((c) => c.id === probe);
        const mayAll = s.caps.has(CAP.ADMIN);
        K.journal(key, 'Leave approvals', 'queue scope', 'GET', '/hr/leave/comp-off/queue', r.status, foreign.length === 0, 'own org only');
        if (foreign.length) fail('critical', key, 'Comp-off queue returns claims from another branch / tenant', 'Only claims of the active org', `${foreign.length} foreign claim(s) e.g. ${foreign[0].id}`, j(foreign[0]), 'listCompOffForApproval WHERE c.org_id = ctx.org_id (it does) - the session org differs from the row.');
        if (s.orgId === world.orgId && s.userId !== world.apprId && !mayAll && sees) fail('high', key, 'Queue exposes a claim the caller is neither assigned to nor over', 'Only assigned approver, their managers, or hr.leave.admin see it', 'sees the probe claim', probe, 'Scope clause: approver_id = me OR in my team (vw_user_team_members).');
        if (s.userId === world.apprId && !sees) fail('high', key, 'Assigned approver does not see the claim', 'Claim listed', 'missing', probe, 'approver_id = ctx.user_id branch.');
      } finally { if (a !== appr) await a.close(); }
    }
    for (const bad of ['bogus', '']) {
      const r = await apiGet(appr, `${HR}/api/hr/leave/comp-off/queue?status=${bad}`);
      if (bad === 'bogus' && ![400, 422].includes(r.status)) fail(r.status >= 500 ? 'high' : 'low', world.apprKey, 'Queue with an unknown status', '400', `HTTP ${r.status}`, j(r.body), 'listCompOffQueueSchema enum.');
    }
    K.purgeClaim(probe);

    // ── 3. approve / reject matrices ─────────────────────────────────────────────────
    console.log('\n[3] decisions');
    const allowApprove = K.decisionAllowList(world, sessions, CAP.CO_APP, world.apprId);
    console.log(`  authority (comp_off.approve + assigned/admin + can_approve_leave): ${allowApprove.join(', ') || 'none'}`);
    let cur = null; const startAt = new Date(Date.now() - 2000).toISOString();
    await runRoleMatrix({
      tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'approve a comp-off claim', endpoint: 'POST /hr/leave/comp-off/:id/approve', allow: allowApprove, roles: ALL_ROLES,
      act: (a) => { cur = dbClaim({ reason: `${MARK}-approve` }); return apiPost(a, `${HR}/api/hr/leave/comp-off/${cur}/approve`, { comment: 'E2E ok' }); },
      verify: () => { const c = claimRow(cur), l = ledgerFor(cur); return c?.status === 'approved' && l?.type === 'adjustment' && Number(l.amount) === 1 && l.lt === coType && l.note === 'Comp-off credit'; },
      cleanup: () => K.purgeClaim(cur),
    });
    await runRoleMatrix({
      tool: 'hr', area: 'Leave approvals', tab: 'Comp-off & encashment', action: 'reject a comp-off claim', endpoint: 'POST /hr/leave/comp-off/:id/reject', allow: allowApprove, roles: ALL_ROLES,
      act: (a) => { cur = dbClaim({ reason: `${MARK}-reject` }); return apiPost(a, `${HR}/api/hr/leave/comp-off/${cur}/reject`, { comment: 'E2E no' }); },
      verify: () => { const c = claimRow(cur); return c?.status === 'rejected' && !c.ledger && c.comment === 'E2E no'; },
      cleanup: () => K.purgeClaim(cur),
    });

    // ledger / balance / expiry on the real path (assigned approver)
    {
      const cid = dbClaim({ days: 0.5, reason: `${MARK}-ledger` });
      const before = K.balanceOf(world.empId, coType);
      const r = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, { comment: 'credit it' });
      const after = K.balanceOf(world.empId, coType), c = claimRow(cid), l = ledgerFor(cid);
      const expect90 = K.iso(K.addDays(90));
      K.journal(world.apprKey, 'Leave approvals', 'approve a half-day comp-off: ledger credit + expiry', 'POST', '/hr/leave/comp-off/:id/approve', r.status, Math.abs(after - before - 0.5) < 0.001, 'balance +0.5, expires +90d');
      if (r.status !== 200 || Math.abs(after - before - 0.5) > 0.001 || !l || c.expires !== expect90 || c.acted_by !== world.apprId) fail('high', world.apprKey, 'Approving a half-day comp-off credits the balance exactly once', `balance +0.5, one 'adjustment' ledger row, expires_on ${expect90}, acted_by approver`, `HTTP ${r.status}; balance ${before}->${after}; ${j({ c, l })}`, j(r.body), 'decideCompOffClaim approve branch.');
      const again = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {});
      const again2 = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/reject`, { comment: 'flip' });
      const after2 = K.balanceOf(world.empId, coType);
      if (again.status !== 409 || again2.status !== 409 || claimRow(cid).status !== 'approved' || Math.abs(after2 - after) > 0.001) fail('high', world.apprKey, 'Deciding an already approved claim', '409 "Claim is already approved"; status and balance unchanged', `approve=${again.status} reject=${again2.status} status=${claimRow(cid).status} balance ${after}->${after2}`, j(again.body), 'ConflictError when status !== pending.');
      const cancelAfter = await apiPost(emp, `${HR}/api/hr/leave/comp-off/${cid}/cancel`, {});
      K.journal(world.empKey, 'Leave dashboard', 'cancel an APPROVED comp-off claim', 'POST', '/hr/leave/comp-off/:id/cancel', cancelAfter.status, claimRow(cid).status === 'approved', '404, nothing changes');
      if (cancelAfter.status < 400 || cancelAfter.status >= 500 || claimRow(cid).status !== 'approved' || Math.abs(K.balanceOf(world.empId, coType) - after) > 0.001) fail(cancelAfter.status >= 500 ? 'high' : 'medium', world.empKey, 'Cancel after approval', 'Refused (404 "No pending comp-off claim"); credit stays', `HTTP ${cancelAfter.status}; status ${claimRow(cid).status}`, j(cancelAfter.body), 'cancel only applies to pending claims.');
      // rejected / cancelled stay terminal
      const rj = dbClaim({ reason: `${MARK}-term` });
      await apiPost(appr, `${HR}/api/hr/leave/comp-off/${rj}/reject`, { comment: 'no' });
      const back = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${rj}/approve`, {});
      const bc = await apiPost(emp, `${HR}/api/hr/leave/comp-off/${rj}/cancel`, {});
      if (back.status !== 409 || claimRow(rj).status !== 'rejected' || bc.status < 400) fail('high', world.apprKey, 'A rejected claim can be resurrected', 'Stays rejected (409 / 404)', `approve=${back.status} cancel=${bc.status} status=${claimRow(rj).status}`, j(back.body), 'Terminal states.');
    }
    // reject needs a comment; approve comment optional; bad comment type
    {
      const cid = dbClaim({ reason: `${MARK}-comment` });
      const nc = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/reject`, {});
      const nb = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/reject`, { comment: '   ' });
      if (![400, 422].includes(nc.status) || ![400, 422].includes(nb.status) || claimRow(cid).status !== 'pending') fail('medium', world.apprKey, 'Reject without a comment', '400 and the claim stays pending', `${nc.status}/${nb.status}; status ${claimRow(cid).status}`, j(nc.body), 'rejectCompOffSchema requires a non-blank comment.');
      const huge = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, { comment: 'c'.repeat(1001) });
      if (![400, 422].includes(huge.status)) fail('low', world.apprKey, 'Approve comment over 1000 chars', '400', `HTTP ${huge.status}`, j(huge.body), 'decideCompOffSchema max(1000).');
    }

    // self approval
    {
      const mine = K.insertClaim({ userId: world.apprId, orgId: world.orgId, date: nextOld(), days: 1, approverId: world.apprId, reason: `${MARK}-self` });
      const r1 = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${mine}/approve`, { comment: 'me' });
      const r2 = await apiPost(appr, `${HR}/api/hr/leave/comp-off/${mine}/reject`, { comment: 'me' });
      const st = claimRow(mine)?.status;
      K.journal(world.apprKey, 'Leave approvals', 'approve / reject my OWN comp-off claim (assigned to myself)', 'POST', '/hr/leave/comp-off/:id/approve', `${r1.status}/${r2.status}`, st === 'pending', '403');
      if (st !== 'pending' || r1.status === 200 || r2.status === 200) fail('critical', world.apprKey, 'Self-approval of a comp-off claim', '403 - hr.can_approve_leave is FALSE when approver = requester; claim stays pending, no credit', `approve=${r1.status} reject=${r2.status} status=${st}`, j(r1.body), 'decideCompOffClaim must keep the canApproveLeave() check on every path.');
    }
    // IDOR: cancel matrix - only the owner may withdraw
    await runRoleMatrix({
      tool: 'hr', area: 'Leave dashboard', tab: 'Comp-off claims', action: 'cancel the employee\'s pending comp-off claim', endpoint: 'POST /hr/leave/comp-off/:id/cancel', allow: [world.empKey], roles: ALL_ROLES,
      act: (a) => { cur = dbClaim({ reason: `${MARK}-cancel` }); return apiPost(a, `${HR}/api/hr/leave/comp-off/${cur}/cancel`, {}); },
      verify: () => claimRow(cur)?.status === 'cancelled' && !claimRow(cur).ledger,
      cleanup: () => K.purgeClaim(cur),
    });
    // malformed / unknown ids
    for (const p of ['not-a-uuid', '019fffff-ffff-7fff-8fff-ffffffffffff']) {
      for (const [verb, body, actorH] of [['approve', {}, appr], ['reject', { comment: 'x' }, appr], ['cancel', {}, emp]]) {
        const r = await apiPost(actorH, `${HR}/api/hr/leave/comp-off/${p}/${verb}`, body);
        K.journal(actorH === emp ? world.empKey : world.apprKey, 'Leave approvals', `${verb} with id '${p}'`, 'POST', `/hr/leave/comp-off/:id/${verb}`, r.status, null, '404/400');
        if (r.status >= 500) fail('medium', actorH === emp ? world.empKey : world.apprKey, `comp-off ${verb} with ${p === 'not-a-uuid' ? 'a malformed id' : 'an unknown id'}`, '404 (or 400) - never a 5xx', `HTTP ${r.status}`, j(r.body), `leave.router.ts has no params schema on /leave/comp-off/:id/${verb}; the uuid column compared with a raw string raises PG 22P02 -> 500 (repository decideCompOffClaim/cancelCompOffClaim). Validate params.id as uuid.`);
      }
    }

    // ── 5. races ──────────────────────────────────────────────────────────────────────
    console.log('\n[5] races');
    const other = allowApprove.find((k) => k !== world.apprKey && k !== world.empKey);
    const otherA = other ? await actor(other) : null;
    try {
      for (let i = 0; i < 3; i++) {
        const cid = dbClaim({ reason: `${MARK}-race2-${i}` });
        const t0 = new Date(Date.now() - 1000).toISOString();
        const res = await simultaneously([
          () => apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, { comment: 'A' }),
          () => apiPost(otherA ?? appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, { comment: 'B' }),
        ]);
        const st = res.map((r) => r?.status), ok = st.filter((s) => s === 200).length;
        const credits = Number(scalar(`SELECT COUNT(*) FROM hr.leave_ledger WHERE id=(SELECT ledger_entry_id FROM hr.comp_off_claims WHERE id=${lit(cid)})`));
        const strays = creditRows(world.empId, t0);
        K.journal(`${world.apprKey}+${other ?? world.apprKey}`, 'Leave approvals', 'two approvers approve the same claim simultaneously', 'POST', '/hr/leave/comp-off/:id/approve', st.join('/'), ok === 1 && strays === 1, 'exactly one winner');
        console.log(`  approve x2 #${i}: ${st.join('/')} credits=${strays}`);
        if (ok !== 1 || strays !== 1 || st.some((s) => s >= 500) || credits !== 1) fail(strays > 1 ? 'critical' : 'high', `${world.apprKey}+${other ?? world.apprKey}`, 'Two approvers decide the same comp-off claim at the same instant', 'Exactly one 200, the other 409; exactly ONE ledger credit; no 5xx', `statuses=${st}; credit rows since start=${strays}`, j(res.map((r) => r?.body)), 'decideCompOffClaim holds SELECT ... FOR UPDATE; check the lock is taken before the status read and that serviceTx is not READ COMMITTED with a stale snapshot.');
        K.purgeClaim(cid);
      }
      // approve vs reject
      for (let i = 0; i < 2; i++) {
        const cid = dbClaim({ reason: `${MARK}-race-ar-${i}` });
        const t0 = new Date(Date.now() - 1000).toISOString();
        const res = await simultaneously([
          () => apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {}),
          () => apiPost(otherA ?? appr, `${HR}/api/hr/leave/comp-off/${cid}/reject`, { comment: 'R' }),
        ]);
        const c = claimRow(cid), credits = creditRows(world.empId, t0), st = res.map((r) => r?.status);
        const coherent = (c.status === 'approved' && credits === 1 && c.ledger) || (c.status === 'rejected' && credits === 0 && !c.ledger);
        K.journal(world.apprKey, 'Leave approvals', 'approve vs reject of the same claim simultaneously', 'POST', 'approve | reject', st.join('/'), coherent, 'one coherent outcome');
        if (!coherent || st.filter((s) => s === 200).length !== 1 || st.some((s) => s >= 500)) fail('critical', world.apprKey, 'Approve and reject race on one comp-off claim', 'One decision wins; status, ledger and balance agree', `statuses=${st}; final=${c.status}; credit rows=${credits}`, j(c), 'FOR UPDATE in decideCompOffClaim.');
        K.purgeClaim(cid);
      }
      // approve vs the owner's cancel
      for (let i = 0; i < 2; i++) {
        const cid = dbClaim({ reason: `${MARK}-race-ac-${i}` });
        const t0 = new Date(Date.now() - 1000).toISOString();
        const res = await simultaneously([
          () => apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {}),
          () => apiPost(emp, `${HR}/api/hr/leave/comp-off/${cid}/cancel`, {}),
        ]);
        const c = claimRow(cid), credits = creditRows(world.empId, t0), st = res.map((r) => r?.status);
        const coherent = (c.status === 'approved' && credits === 1 && st[0] === 200 && st[1] >= 400) || (c.status === 'cancelled' && credits === 0 && st[1] === 200 && st[0] >= 400);
        K.journal(world.apprKey, 'Leave approvals', 'approve vs owner cancel simultaneously', 'POST', 'approve | cancel', st.join('/'), coherent, 'one coherent outcome');
        if (!coherent || st.some((s) => s >= 500)) fail('critical', world.apprKey, 'Approve and cancel race on one comp-off claim', 'Either approved+credited (cancel 404) or cancelled with no credit (approve 409) - never both', `statuses=${st}; final=${c.status}; credit rows=${credits}`, j(c), 'cancelCompOffClaim UPDATE ... WHERE status=pending must serialise with the FOR UPDATE in decideCompOffClaim.');
        K.purgeClaim(cid);
      }
      // double click
      {
        const cid = dbClaim({ reason: `${MARK}-dbl` });
        const t0 = new Date(Date.now() - 1000).toISOString();
        const res = await simultaneously([() => apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {}), () => apiPost(appr, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {})]);
        const st = res.map((r) => r?.status);
        if (creditRows(world.empId, t0) !== 1 || st.some((s) => s >= 500)) fail('critical', world.apprKey, 'Double-click approve credits twice', 'One credit', `statuses=${st} credits=${creditRows(world.empId, t0)}`, '', 'FOR UPDATE.');
        K.purgeClaim(cid);
      }
    } finally { await otherA?.close(); }

    // cross tenant (tenant B) acts on tenant A claim: covered by the matrices; direct statement for the report
    if (world.xKey) {
      const xa = await actor(world.xKey); const cid = dbClaim({ reason: `${MARK}-xt` });
      try {
        const rs = [await apiPost(xa, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {}), await apiPost(xa, `${HR}/api/hr/leave/comp-off/${cid}/reject`, { comment: 'x' }), await apiPost(xa, `${HR}/api/hr/leave/comp-off/${cid}/cancel`, {})];
        K.journal(world.xKey, 'Leave approvals', 'tenant B approves / rejects / cancels a tenant A claim', 'POST', '/hr/leave/comp-off/:id/*', rs.map((r) => r.status).join('/'), claimRow(cid).status === 'pending', 'denied, claim untouched');
        if (claimRow(cid).status !== 'pending' || rs.some((r) => r.status < 400 || r.status >= 500)) fail(claimRow(cid).status !== 'pending' ? 'critical' : 'high', world.xKey, 'Cross-tenant decision on a comp-off claim', '403/404 and the claim untouched', `statuses=${rs.map((r) => r.status)} final=${claimRow(cid).status}`, j(rs[0].body), 'org_id check in decideCompOffClaim.');
      } finally { await xa.close(); K.purgeClaim(cid); }
    }

    // ── 7. capability toggle ──────────────────────────────────────────────────────────
    console.log('\n[7] capability toggle');
    const flip = async (key, roleName, cap, probe) => {
      setOverride(world.tenantId, roleName, cap, false);
      try {
        const a = await actor(key); try { await waitForSessionCapability(a, cap, false); } finally { await a.close(); }
        await new Promise((r) => setTimeout(r, 1500));
        await probe(false);
      } finally { restoreAll(); }
      const a = await actor(key); try { await waitForSessionCapability(a, cap, true); } finally { await a.close(); }
      await new Promise((r) => setTimeout(r, 1500));
      await probe(true);
    };
    await flip(world.empKey, 'fitness_trainer', CAP.CO_REQ, async (on) => {
      const a = await actor(world.empKey);
      try {
        const d = K.recentOffDay(empPattern, claimsOf(world.empId));
        const r = await apiPost(a, `${HR}/api/hr/leave/comp-off`, { worked_date: d, days: 1, reason: `${MARK}-toggle` });
        if (idOf(r.body)) K.trackClaim(idOf(r.body));
        K.journal(world.empKey, 'Leave dashboard', `hr.leave.comp_off.request ${on ? 'restored' : 'revoked'}: claim`, 'POST', '/hr/leave/comp-off', r.status, on ? r.status === 201 : r.status === 403, on ? 'allowed' : 'denied');
        if (!on && r.status !== 403) fail('high', world.empKey, 'hr.leave.comp_off.request revoked but claiming still works', '403', `HTTP ${r.status}`, j(r.body), 'requireCapability(HR_LEAVE_COMP_OFF_REQUEST).');
        if (on && r.status !== 201) fail('high', world.empKey, 'hr.leave.comp_off.request restored but claiming fails', '201', `HTTP ${r.status}`, j(r.body), 'Capability cache.');
        if (!on) { const c = await apiPost(a, `${HR}/api/hr/leave/comp-off/019fffff-ffff-7fff-8fff-ffffffffffff/cancel`, {}); if (c.status !== 403) fail('medium', world.empKey, 'comp-off cancel with the capability revoked', '403', `HTTP ${c.status}`, j(c.body), 'cancel route is gated on the request capability.'); }
      } finally { await a.close(); }
    });
    await flip(world.apprKey, 'fitness_manager', CAP.CO_APP, async (on) => {
      const a = await actor(world.apprKey);
      try {
        const cid = dbClaim({ reason: `${MARK}-toggle2` });
        const qr = await apiGet(a, `${HR}/api/hr/leave/comp-off/queue`);
        const ar = await apiPost(a, `${HR}/api/hr/leave/comp-off/${cid}/approve`, {});
        const st = claimRow(cid).status;
        K.journal(world.apprKey, 'Leave approvals', `hr.leave.comp_off.approve ${on ? 'restored' : 'revoked'}: queue + approve`, 'GET/POST', 'queue | approve', `${qr.status}/${ar.status}`, on ? st === 'approved' : st === 'pending', on ? 'allowed' : 'denied');
        if (!on && (qr.status !== 403 || ar.status !== 403 || st !== 'pending')) fail('high', world.apprKey, 'hr.leave.comp_off.approve revoked but the queue / approve still work', '403 on both; claim pending', `queue=${qr.status} approve=${ar.status} status=${st}`, j(ar.body), 'requireCapability(HR_LEAVE_COMP_OFF_APPROVE) - the capability must beat the "assigned approver" shortcut.');
        if (on && (qr.status !== 200 || st !== 'approved')) fail('high', world.apprKey, 'hr.leave.comp_off.approve restored but it does not work', '200 + approved', `queue=${qr.status} status=${st}`, j(ar.body), 'Capability cache.');
        K.purgeClaim(cid);
      } finally { await a.close(); }
    });
  }

  // ═════════════ UI ═════════════
  if (doUi) {
    console.log('\n[UI] employee: Claim comp-off dialog');
    const taken = claimsOf(world.empId);
    const uiDays = [K.recentOffDay(empPattern, taken), K.recentOffDay(empPattern, taken, { skip: 1 }), K.recentOffDay(empPattern, taken, { skip: 2 })];
    const wdPast = (() => { let d = K.addDays(-4); while (empPattern.includes(d.getUTCDay())) d = K.addDays(-1, d); return K.iso(d); })();
    // claims for the approver tab, inserted up front so the employee page lists them too
    const forReject = K.insertClaim({ userId: world.empId, orgId: world.orgId, date: nextOld(), days: 1, approverId: world.apprId, reason: `${MARK}-ui-reject` });
    const forApprove = K.insertClaim({ userId: world.empId, orgId: world.orgId, date: nextOld(), days: 1, approverId: world.apprId, reason: `${MARK}-ui-approve` });
    const forCancel = K.insertClaim({ userId: world.empId, orgId: world.orgId, date: nextOld(), days: 0.5, approverId: world.apprId, reason: `${MARK}-ui-cancel` });
    {
      const { browser, page, log } = await openAs(world.empKey);
      try {
        await page.goto(`${HR}/leave`, { waitUntil: 'domcontentloaded' }); await K.settle(page, 2000);
        const btn = page.getByRole('button', { name: 'Claim comp-off', exact: true });
        if (!(await btn.count())) fail('high', world.empKey, 'Claim comp-off button for a holder of hr.leave.comp_off.request', 'Visible in the page header', `url=${page.url()}`, '', 'LeaveDashboardShell canClaimCompOff.');
        else {
          await btn.click(); await page.waitForTimeout(600);
          // validation: nothing filled; then reason missing
          await page.getByRole('button', { name: 'Submit claim' }).click(); await page.waitForTimeout(300);
          const e1 = await page.getByText('Pick the day you worked.').count();
          await page.fill('#co-date', uiDays[0]);
          await page.getByRole('button', { name: 'Submit claim' }).click(); await page.waitForTimeout(300);
          const e2 = await page.getByText('Say what you worked on.').count();
          K.journal(world.empKey, 'Leave dashboard', 'Claim comp-off dialog client validation', 'UI', 'Submit claim', null, !!e1 && !!e2, 'both messages shown');
          if (!e1 || !e2) fail('low', world.empKey, 'Claim dialog validation messages', '"Pick the day you worked." then "Say what you worked on."', `date-msg=${e1} reason-msg=${e2}`, '', 'CompOffClaimModal.submit.');
          // server refusal for a working day is shown to the user
          await page.fill('#co-date', wdPast); await page.fill('#co-reason', `${MARK}-ui-bad`);
          const bad = await K.withResponse(page, (m, u) => m === 'POST' && /hr\/leave\/comp-off$/.test(u), () => page.getByRole('button', { name: 'Submit claim' }).click());
          await page.waitForTimeout(500);
          const shown = await page.locator('[role=alert]').allInnerTexts();
          K.journal(world.empKey, 'Leave dashboard', 'claim for a working day -> server reason shown', 'UI', 'Submit claim', bad.status, [400, 422].includes(bad.status) && shown.some((t) => /weekly off|holiday/i.test(t)), '400 + readable message');
          if (![400, 422].includes(bad.status) || !shown.some((t) => /weekly off|holiday/i.test(t))) fail('medium', world.empKey, 'Server refusal is explained in the dialog', 'HTTP 400 and the "weekly off or a holiday" message', `HTTP ${bad.status}; alerts=${j(shown)}`, '', 'Surface the API error message.');
          // success: half day via the radio label
          await page.fill('#co-date', uiDays[0]);
          await page.locator('label', { hasText: 'Half day' }).click();
          await page.fill('#co-reason', `${MARK}-ui-claim`);
          const ok = await K.withResponse(page, (m, u) => m === 'POST' && /hr\/leave\/comp-off$/.test(u), () => page.getByRole('button', { name: 'Submit claim' }).click());
          await K.settle(page, 1200);
          const id = scalar(`SELECT id FROM hr.comp_off_claims WHERE reason=${lit(`${MARK}-ui-claim`)} AND user_id=${lit(world.empId)} LIMIT 1`);
          if (id) K.trackClaim(id);
          const rr = id ? claimRow(id) : null;
          K.journal(world.empKey, 'Leave dashboard', 'Claim comp-off (half day) through the dialog', 'UI', 'Submit claim', ok.status, rr?.status === 'pending' && rr.days === '0.5', '201 pending half-day row');
          if (ok.status !== 201 || !rr || rr.status !== 'pending' || rr.days !== '0.5') fail('high', world.empKey, 'Submit a comp-off claim through the browser', '201; pending row, 0.5 days', `HTTP ${ok.status}; ${j(rr)}`, '', 'CompOffClaimModal -> POST /hr/leave/comp-off.');
          if (!(await page.getByText('Comp-off claim submitted for approval').count())) fail('low', world.empKey, 'Success notice after a claim', '"Comp-off claim submitted for approval."', 'none', '', 'Dashboard notice.');
          // open and Cancel the dialog without sending
          await btn.click(); await page.waitForTimeout(400); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.waitForTimeout(300);
          // my claims list
          const item = page.locator('li', { hasText: `${MARK}-ui-cancel` }).first();
          if (await item.count()) {
            const w = await K.withResponse(page, (m, u) => m === 'POST' && /comp-off\/.*\/cancel$/.test(u), () => item.getByRole('button', { name: 'Cancel' }).click());
            await K.settle(page, 900);
            K.journal(world.empKey, 'Leave dashboard', 'Cancel a pending comp-off claim from My claims', 'UI', 'Cancel', w.status, claimRow(forCancel)?.status === 'cancelled', 'cancelled');
            if (w.status !== 200 || claimRow(forCancel)?.status !== 'cancelled') fail('high', world.empKey, 'Cancel my pending comp-off claim', '200 and status cancelled in Postgres', `HTTP ${w.status}; status=${claimRow(forCancel)?.status}`, '', 'MyCompOffList -> comp-off cancel.');
          } else fail('medium', world.empKey, 'My comp-off claims list shows the claim', 'Row with the claim reason', 'not listed', '', 'MyCompOffList.');
        }
        K.reportUiLog(fail, world.empKey, 'Leave dashboard (comp-off)', log, [/hr\/leave\/comp-off$/, /\/hr\/employees/, /hr\/documents\/settings/]);
      } finally { await browser.close(); }
    }

    console.log('\n[UI] approver: comp-off queue');
    {
      const { browser, page, log } = await openAs(world.apprKey);
      try {
        await page.goto(`${HR}/leave/approvals`, { waitUntil: 'domcontentloaded' }); await K.settle(page, 2000);
        const tab = page.getByRole('tab', { name: /Comp-off & encashment/ });
        if (!(await tab.count())) fail('high', world.apprKey, 'Comp-off & encashment tab for a holder of hr.leave.comp_off.approve', 'Visible', 'tab missing', page.url(), 'LeaveApprovalsShell showClaims.');
        else {
          await tab.click(); await K.settle(page, 1200);
          const rj = page.locator('li', { hasText: `${MARK}-ui-reject` }).first();
          const ap = page.locator('li', { hasText: `${MARK}-ui-approve` }).first();
          if (!(await rj.count()) || !(await ap.count())) fail('high', world.apprKey, 'Comp-off queue lists the claims assigned to the approver', 'Both E2E claims listed', `reject=${await rj.count()} approve=${await ap.count()}`, '', 'compOff.queue(pending).');
          else {
            await rj.getByRole('button', { name: 'Reject' }).click(); await page.waitForTimeout(500);
            await page.getByRole('button', { name: 'Reject', exact: true }).last().click(); await page.waitForTimeout(400);
            const needs = await page.getByText('A comment is required when rejecting.').count();
            await page.fill('#cq-comment', 'E2E ui reject');
            const w = await K.withResponse(page, (m, u) => m === 'POST' && /comp-off\/.*\/reject$/.test(u), () => page.getByRole('button', { name: 'Reject', exact: true }).last().click());
            await K.settle(page, 900);
            const c = claimRow(forReject);
            K.journal(world.apprKey, 'Leave approvals', 'Reject a comp-off claim (UI, comment required)', 'UI', 'Reject', w.status, c?.status === 'rejected' && !c.ledger, 'rejected, no credit');
            if (!needs || w.status !== 200 || c?.status !== 'rejected' || c.ledger) fail('high', world.apprKey, 'Reject a comp-off claim from the queue', 'Comment required first; 200; rejected; no ledger', `needsComment=${needs} HTTP ${w.status}; ${j(c)}`, '', 'CompOffQueue DecisionModal.');
            const before = K.balanceOf(world.empId, coType);
            const ap2 = page.locator('li', { hasText: `${MARK}-ui-approve` }).first();
            await ap2.getByRole('button', { name: 'Approve' }).click(); await page.waitForTimeout(500);
            const w2 = await K.withResponse(page, (m, u) => m === 'POST' && /comp-off\/.*\/approve$/.test(u), () => page.getByRole('button', { name: 'Approve', exact: true }).last().click());
            await K.settle(page, 900);
            const c2 = claimRow(forApprove), after = K.balanceOf(world.empId, coType);
            K.journal(world.apprKey, 'Leave approvals', 'Approve a comp-off claim (UI): credit', 'UI', 'Approve', w2.status, c2?.status === 'approved' && Math.abs(after - before - 1) < 0.001, 'approved, +1 balance');
            if (w2.status !== 200 || c2?.status !== 'approved' || Math.abs(after - before - 1) > 0.001 || !c2.expires) fail('high', world.apprKey, 'Approve a comp-off claim from the queue', '200; approved; balance +1; expires_on set', `HTTP ${w2.status}; ${j(c2)}; balance ${before}->${after}`, '', 'CompOffQueue -> approve.');
          }
        }
        K.reportUiLog(fail, world.apprKey, 'Leave approvals (comp-off)', log, [/comp-off\/.*\/(approve|reject)/]);
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
    const u1 = await uiProbe(world.empKey, 'fitness_trainer', CAP.CO_REQ, `${HR}/leave`, async (p) => ({
      button: await p.getByRole('button', { name: 'Claim comp-off', exact: true }).count(), section: await p.getByText('Comp-off claims', { exact: true }).count() }));
    K.journal(world.empKey, 'Leave dashboard', 'comp_off.request revoked -> Claim button + My claims section hidden', 'UI', 'Claim comp-off', null, u1.off.button === 0 && u1.off.section === 0, 'hidden');
    if (u1.off.button || u1.off.section) fail('medium', world.empKey, 'Comp-off controls stay visible after hr.leave.comp_off.request is revoked', 'Button and section hidden', j(u1.off), j(u1.off), 'LeaveDashboardShell canClaimCompOff.');
    if (!u1.on.button) fail('high', world.empKey, 'Comp-off button not back after restore', 'visible', j(u1.on), '', 'Capability cache.');
    const u2 = await uiProbe(world.apprKey, 'fitness_manager', CAP.CO_APP, `${HR}/leave/approvals`, async (p) => {
      const t = p.getByRole('tab', { name: /Comp-off & encashment/ });
      let section = 0;
      if (await t.count()) { await t.click(); await K.settle(p, 900); section = await p.getByText('Comp-off claims', { exact: true }).count(); }
      return { tab: await t.count(), section };
    });
    K.journal(world.apprKey, 'Leave approvals', 'comp_off.approve revoked -> Comp-off section hidden', 'UI', 'Comp-off claims', null, u2.off.section === 0, 'hidden');
    if (u2.off.section) fail('medium', world.apprKey, 'Comp-off queue visible after hr.leave.comp_off.approve is revoked', 'Section hidden (the tab may remain for encashment)', j(u2.off), j(u2.off), 'LeaveApprovalsShell can(actor, HR_LEAVE_COMP_OFF_APPROVE).');
    if (!u2.on.section) fail('high', world.apprKey, 'Comp-off queue not back after restore', 'visible', j(u2.on), '', 'Capability cache.');
  }
} finally {
  restoreAll();
  await emp.close(); await appr.close();
  K.runCleanup();
  q(`DELETE FROM hr.comp_off_claims WHERE reason LIKE ${lit(`${MARK}%`)}`); // belt and braces for rows a crash left behind
  console.log(`\n${fail.count()} finding(s) recorded to results/findings-hr.json`);
}
