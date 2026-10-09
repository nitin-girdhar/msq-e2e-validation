// Leave apply page v2 (schema 1.67.0) + request-info + bulk-decision + policy-summary.
//
// What is new since the last pass and what this proves (every claim is checked in Postgres, every role is
// graded on its LIVE capabilities from /auth/me, nothing is hidden):
//
//   1. request_no / handover / attachment persisted on apply; request_no distinct and increasing.
//   2. POST /hr/leave/attachments: type comes from the BYTES (spoofed names, html/svg/exe refused), size
//      limit enforced, oversize and malformed bodies are clean 4xx, capability-gated (hr.leave.request.create).
//   3. GET /hr/leave/requests/:id/attachment IDOR: requester / assigned approver / hr.leave.view.org|tenant
//      holders may open it, nobody else - not a colleague with no HR caps, not another branch of the same
//      tenant, not another tenant. Graded per login. Malformed ids must be a 4xx, not a 500.
//   4. Attachment token forgery on apply/edit: another user's token, '..' traversal, a key that does not exist.
//   5. Handover rules: self, other tenant, unknown, valid colleague.
//   6. policy-summary: projection only (no accrual / approval depth), matches the DB, never another tenant's.
//   7. request-info: only someone who may decide; request stays pending; editing clears the question.
//   8. bulk-decision: mixed ids (own-org, other-tenant, other-org, random, self, already decided, duplicate),
//      per-id result with no existence oracle, DB verified, double-decision race (bulk vs single).
//   9. Capability toggling (setOverride, journalled, restored in finally): revoke -> API denies AND the
//      UI control/page hides; restore -> works again.
//  10. UI (Playwright): fill + submit the apply form with a file and handover, status filter options, Leave
//      policy modal, View / Edit / Cancel, draft save/resume; approver page Ask / Review / chips / tabs / bulk.
//
//   node suites/hr/leave-apply-v2.mjs            # everything
//   node suites/hr/leave-apply-v2.mjs api        # API only (no browser)
//   node suites/hr/leave-apply-v2.mjs ui         # UI only
import { openAs } from '../../lib.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { setOverride, restoreAll, tenantIdForOrg, waitForSessionCapability } from '../../capability.mjs';
import { dbReachable } from '../../db.mjs';
import * as K from './_leave-kit.mjs';
const { HR, GATEWAY, CAP, actor, apiGet, apiPost, apiPatch, scalar, rows, q, lit, simultaneously, ALL_ROLES } = K;

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const mode = (process.argv[2] || 'all').toLowerCase();
const doApi = mode === 'all' || mode === 'api', doUi = mode === 'all' || mode === 'ui';
const fail = K.makeFail('Leave apply v2 / bulk decision');
const world = K.resolveWorld();
const { stamp } = K;
const MARK = `E2E-apply2-${stamp}`;
const typeId = K.leaveTypeId(world.tenantId, 'casual');
const b64 = (buf) => buf.toString('base64');
let slot = 60; // distinct weekday windows, one per request, far enough out for any notice rule
const used = new Set();
const nextDay = () => { let d; do { d = K.weekday((slot += 3)); } while (used.has(d)); used.add(d); return d; };
const idOf = (b) => b?.data?.id ?? null;

async function applyAs(a, over = {}) {
  const d = over.date ?? nextDay();
  return apiPost(a, `${HR}/api/hr/leave/requests`, {
    leave_type_name: 'casual', start_date: d, end_date: over.end ?? d, reason: over.reason ?? `${MARK}-${slot}`, ...over.body,
  });
}
const newPending = async (a, over) => { const r = await applyAs(a, over); const id = idOf(r.body); if (id) K.trackLeave(id); return { r, id }; };
const row = (id) => rows(`SELECT request_no::text, handover_user_id::text, attachment_key, attachment_name, attachment_mime, attachment_size::text,
   info_requested_at::text, info_request_note FROM hr.leave_requests WHERE id=${lit(id)}`,
  ['no', 'handover', 'key', 'name', 'mime', 'size', 'info_at', 'info_note'])[0] ?? null;
const ledgerRows = (id) => Number(scalar(`SELECT COUNT(*) FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`) ?? 0);

let sessions = {};
const emp = await actor(world.empKey);
const appr = await actor(world.apprKey);
let rep2 = null; try { if (world.rep2Key) rep2 = await actor(world.rep2Key); } catch { /* optional */ }
const cleanupActors = async () => { for (const a of [emp, appr, rep2]) { try { await a?.close(); } catch { /* closed */ } } };

try {
  console.log(`world: employee=${world.empKey} approver=${world.apprKey} org=${world.orgId} tenant=${world.tenantId}`);
  K.seedPolicy(world, 'casual', { maxConsecutive: 5, docAfter: 2, levels: 1, sla: 37 });
  K.seedBalance(world.empId, world.orgId, typeId, 40, `E2E-seed-${MARK}`);
  K.seedBalance(world.apprId, world.orgId, typeId, 10, `E2E-seed-appr-${MARK}`);
  sessions = await K.allSessions();
  console.log(`sessions resolved for ${Object.keys(sessions).length}/${ALL_ROLES.length} logins`);
  const needApplyHeadroom = () => K.balanceOf(world.empId, typeId);
  void needApplyHeadroom;

  if (doApi) {
    // ── 1. upload: happy path, type from bytes ─────────────────────────────────────
    console.log('\n[1] attachment upload');
    const up = await apiPost(emp, `${HR}/api/hr/leave/attachments`, { file_name: 'medical.png', data_base64: b64(K.PNG_1x1) });
    const tok = up.body?.data?.token;
    K.journal(world.empKey, 'Apply leave', 'upload a supporting document (PNG)', 'POST', '/hr/leave/attachments', up.status, !!tok, '201 + owner-bound token');
    if (up.status !== 201 || !tok?.startsWith(`${world.tenantId}/${world.orgId}/${world.empId}/leave/`) || up.body.data.mime !== 'image/png' || up.body.data.size !== K.PNG_1x1.length) {
      fail('high', world.empKey, 'Upload a valid PNG', '201 with token <tenant>/<org>/<user>/leave/<uuid>.png, mime image/png, exact size', `HTTP ${up.status}`, K.j(up.body), 'Fix leave-attachments.router.ts upload response.');
    }
    const spoof = async (name, bytes, label, expectOk = false) => {
      const r = await apiPost(emp, `${HR}/api/hr/leave/attachments`, { file_name: name, data_base64: b64(bytes) });
      K.journal(world.empKey, 'Apply leave', `upload ${label}`, 'POST', '/hr/leave/attachments', r.status, null, expectOk ? '201' : '400');
      if (!expectOk && !(r.status >= 400 && r.status < 500)) fail(r.status >= 500 ? 'high' : 'high', world.empKey, `Upload ${label}`,
        'A clean 4xx: only PDF/JPG/PNG/WebP, decided from the bytes', `HTTP ${r.status}`, K.j(r.body), 'sniffDocument must reject everything but the four types; map errors to BadRequestError.');
      return r;
    };
    await spoof('evil.png', Buffer.from('<html><script>alert(1)</script></html>'), 'html named .png');
    await spoof('logo.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'svg named .png');
    await spoof('report.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]), 'exe named .pdf');
    await spoof('notes.txt', Buffer.from('just text, long enough to be a file'), 'plain text');
    await spoof('zero.png', Buffer.alloc(16, 0), 'null bytes');
    const spoofOk = await spoof('payload.exe', K.PNG_1x1, 'PNG named .exe (type comes from the bytes)', true);
    if (spoofOk.status === 201 && spoofOk.body?.data?.mime !== 'image/png') fail('medium', world.empKey, 'Spoofed file name', 'mime derived from the bytes (image/png)', K.j(spoofOk.body), K.j(spoofOk.body), 'Never echo the client content-type.');
    const pdfUp = await spoof('doc.pdf', K.PDF_MIN, 'a minimal PDF', true);
    if (pdfUp.status !== 201) fail('high', world.empKey, 'Upload a PDF', '201', `HTTP ${pdfUp.status}`, K.j(pdfUp.body), 'Accept %PDF- documents.');
    const limit = Number(scalar(`SELECT COALESCE((SELECT max_bytes FROM hr.document_settings WHERE org_id=${lit(world.orgId)} AND NOT is_deleted),3145728)`));
    const big = Buffer.concat([K.PNG_1x1, Buffer.alloc(limit + 1 - K.PNG_1x1.length, 7)]);
    const over = await spoof('big.png', big, `a file of limit+1 bytes (${limit + 1})`);
    if (over.status === 400 && !/limit/i.test(JSON.stringify(over.body))) fail('low', world.empKey, 'Over-limit message', 'Says the MB limit', K.j(over.body), K.j(over.body), 'Keep the "over the N MB limit" message.');
    const huge = await apiPost(emp, `${HR}/api/hr/leave/attachments`, { file_name: 'huge.png', data_base64: 'A'.repeat(6_000_000) });
    K.journal(world.empKey, 'Apply leave', 'upload a 6 MB base64 body', 'POST', '/hr/leave/attachments', huge.status, null, '4xx');
    if (!(huge.status >= 400 && huge.status < 500)) fail('high', world.empKey, 'Upload far past the body limit', 'A clean 400/413', `HTTP ${huge.status}`, K.j(huge.body), 'Return 413/400 from the body-limit / schema, never 5xx.');
    for (const [label, body] of [['missing file_name', { data_base64: b64(K.PNG_1x1) }], ['missing data', { file_name: 'a.png' }], ['non-base64 junk', { file_name: 'a.png', data_base64: '%%%%%%%%%%%%' }]]) {
      const r = await apiPost(emp, `${HR}/api/hr/leave/attachments`, body);
      K.journal(world.empKey, 'Apply leave', `upload ${label}`, 'POST', '/hr/leave/attachments', r.status, null, '4xx');
      if (!(r.status >= 400 && r.status < 500)) fail('high', world.empKey, `Upload with ${label}`, 'A clean 4xx', `HTTP ${r.status}`, K.j(r.body), 'Validate the body (zod) and map decode failures to 400.');
    }

    // ── 2. apply v2: request_no, handover, attachment ──────────────────────────────
    console.log('\n[2] apply v2 persistence');
    const d1 = nextDay();
    const a1 = await applyAs(emp, { date: d1, body: world.rep2Id ? { handover_user_id: world.rep2Id, attachment_token: tok, attachment_name: 'medical.png' } : { attachment_token: tok, attachment_name: 'medical.png' } });
    const id1 = K.trackLeave(idOf(a1.body));
    const r1 = id1 ? row(id1) : null;
    K.journal(world.empKey, 'Apply leave', 'apply with handover + attachment', 'POST', '/hr/leave/requests', a1.status, !!r1?.key, '201 and request_no/handover/attachment stored');
    if (a1.status !== 201 || !r1 || !r1.no || r1.key !== tok || r1.mime !== 'image/png' || Number(r1.size) !== K.PNG_1x1.length || (world.rep2Id && r1.handover !== world.rep2Id)) {
      fail('high', world.empKey, 'Apply with a handover colleague and an attachment', 'Row stores request_no, handover_user_id, attachment key/name/mime/size', `HTTP ${a1.status}; row=${K.j(r1)}`, K.j(a1.body),
        'applyLeave must persist handover_user_id and the resolved attachment metadata (leave.repository.ts applyLeave INSERT).');
    }
    const a2 = await newPending(emp);
    const r2 = a2.id ? row(a2.id) : null;
    if (r1?.no && r2?.no && !(BigInt(r2.no) > BigInt(r1.no))) fail('medium', world.empKey, 'request_no is allocated from the sequence', 'Strictly increasing, unique', `first=${r1.no} second=${r2.no}`, K.j({ r1, r2 }), 'Use hr.leave_request_no_seq (nextval) for every insert.');
    const list = await apiGet(emp, `${HR}/api/hr/leave/requests?limit=100`);
    const inList = (list.body?.data ?? []).find((x) => x.id === id1);
    if (!inList || String(inList.request_no) !== r1?.no || inList.attachment_name !== 'medical.png') fail('medium', world.empKey, 'My requests list exposes request_no and attachment_name', 'The list row carries request_no + attachment_name + handover_name (the table renders LV-<no> and the clip link)', K.j(inList ?? 'row missing'), K.j(inList), 'Add the columns to the listOwnRequests SELECT.');
    const det = await apiGet(emp, `${HR}/api/hr/leave/requests/${id1}`);
    if (det.status !== 200 || det.body?.data?.request_no == null) fail('low', world.empKey, 'Request detail returns request_no', 'GET /leave/requests/:id includes request_no', `HTTP ${det.status}; has request_no=${det.body?.data?.request_no != null}`, K.j(det.body?.data && Object.keys(det.body.data)), 'Select request_no in getOwnRequestDetail.');

    // ── 3. attachment download + IDOR ───────────────────────────────────────────────
    console.log('\n[3] attachment download / IDOR');
    const dl = await emp.request.get(`${HR}/api/hr/leave/requests/${id1}/attachment`, { failOnStatusCode: false });
    const bytes = dl.status() === 200 ? await dl.body() : null;
    const h = dl.headers();
    K.journal(world.empKey, 'Apply leave', 'open own attachment', 'GET', '/hr/leave/requests/:id/attachment', dl.status(), !!bytes && bytes.equals(K.PNG_1x1), '200 identical bytes');
    if (dl.status() !== 200 || !bytes?.equals(K.PNG_1x1)) fail('high', world.empKey, 'Download my own attachment', '200 and the exact uploaded bytes', `HTTP ${dl.status()}`, `len=${bytes?.length}`, 'Return the stored bytes.');
    if (dl.status() === 200 && (h['x-content-type-options'] !== 'nosniff' || !/no-store/.test(h['cache-control'] ?? '') || h['content-type'] !== 'image/png')) {
      fail('medium', world.empKey, 'Attachment response hardening', 'nosniff + Cache-Control: no-store + exact Content-Type', K.j({ ct: h['content-type'], nosniff: h['x-content-type-options'], cc: h['cache-control'] }), K.j(h), 'hr-service sets Cache-Control: private, no-store (leave-attachments.router.ts:57) but the gateway route (api-gateway/src/server.ts:1261 GET /hr/leave/requests/:id/attachment) does not list it in forwardResponseHeaders (compare server.ts:698/704), so it never reaches the browser. Add { forwardResponseHeaders: ["cache-control"] } to proxyTo for that route.');
    }
    // who may open it: requester, assigned approver, hr.leave.view.org|tenant in the SAME org.
    for (const key of ALL_ROLES) {
      const s = sessions[key]; if (!s) continue;
      const a = key === world.empKey ? emp : key === world.apprKey ? appr : await actor(key).catch(() => null);
      if (!a) continue;
      try {
        const r = await a.request.get(`${HR}/api/hr/leave/requests/${id1}/attachment`, { failOnStatusCode: false });
        const mayOpen = s.userId === world.empId || s.userId === world.apprId
          || (s.orgId === world.orgId && (s.caps.has('hr.leave.view.org') || s.caps.has('hr.leave.view.tenant')));
        const opened = r.status() === 200;
        K.journal(key, 'Apply leave', 'open the attachment of another user\'s request', 'GET', '/hr/leave/requests/:id/attachment', r.status(), opened, mayOpen ? 'allowed' : 'denied');
        if (opened && !mayOpen) fail(sessions[key].tenantId !== world.tenantId ? 'critical' : 'high', key, 'Open another user\'s leave attachment (IDOR)', 'Only the requester, an approver on the chain, or hr.leave.view.org/tenant in that branch', `HTTP 200 (${key} session org=${s.orgName})`, `${key} caps view.org=${s.caps.has('hr.leave.view.org')}`, 'Bind the attachment read to requester / approver / capability + org exactly as the query does; add a regression test.');
        if (!opened && mayOpen) fail(s.caps.has('hr.leave.view.tenant') && s.orgId !== world.orgId ? 'low' : 'medium', key, 'Legitimate viewer cannot open the attachment', 'Requester / approver / view.org holder get 200', `HTTP ${r.status()}`, `session org ${s.orgName} vs request org`, 'Check leave-attachments.router.ts allowed expression.');
        if (r.status() >= 500) fail('high', key, 'Attachment read as a non-owner', 'Clean 404', `HTTP ${r.status()}`, '', 'Map errors to NotFoundError.');
      } finally { if (a !== emp && a !== appr) await a.close(); }
    }
    // tenant_admin (view.tenant) acts in Head Office: record whether a tenant-wide viewer can open a branch attachment
    for (const [label, path] of [['malformed id', 'not-a-uuid'], ['unknown id', '019fffff-ffff-7fff-8fff-ffffffffffff']]) {
      const r = await emp.request.get(`${HR}/api/hr/leave/requests/${path}/attachment`, { failOnStatusCode: false });
      K.journal(world.empKey, 'Apply leave', `open attachment with ${label}`, 'GET', '/hr/leave/requests/:id/attachment', r.status(), null, '404');
      if (r.status() !== 404) fail(r.status() >= 500 ? 'medium' : 'low', world.empKey, `Attachment route with a ${label}`, '404 (or 400) - never a 5xx', `HTTP ${r.status()}`,
        `GET /hr/leave/requests/${path}/attachment`, 'leave-attachments.router.ts:36 compares lr.id = ${id} with an unvalidated string; a non-uuid raises PG 22P02 -> 500. Validate params.id as a uuid (or catch and NotFound) before the query.');
    }
    const noAtt = await emp.request.get(`${HR}/api/hr/leave/requests/${a2.id}/attachment`, { failOnStatusCode: false });
    if (noAtt.status() !== 404) fail('low', world.empKey, 'Attachment of a request that has none', '404', `HTTP ${noAtt.status()}`, '', 'NotFoundError when attachment_key is null.');

    // ── 4. token forgery on apply / edit ───────────────────────────────────────────
    console.log('\n[4] attachment token forgery');
    const apprUp = await apiPost(appr, `${HR}/api/hr/leave/attachments`, { file_name: 'theirs.png', data_base64: b64(K.PNG_1x1) });
    const apprTok = apprUp.body?.data?.token;
    const forged = [
      ['another user\'s token', apprTok],
      ['own folder + .. into another user\'s', `leave/${world.orgId}/${world.empId}/../${world.apprId}/${apprTok?.split('/').pop()}`],
      ['own prefix, file does not exist', `leave/${world.orgId}/${world.empId}/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.png`],
      ['a key outside leave/ (photo store)', `attendance/${world.orgId}/${world.empId}/x.png`],
      ['other tenant folder', `leave/${world.otherTenantId}/${world.empId}/x.png`],
    ];
    for (const [label, token] of forged) {
      if (!token) continue;
      const r = await applyAs(emp, { body: { attachment_token: token, attachment_name: 'forged.png' } });
      if (idOf(r.body)) K.trackLeave(idOf(r.body));
      K.journal(world.empKey, 'Apply leave', `apply with forged token: ${label}`, 'POST', '/hr/leave/requests', r.status, null, '400');
      if (r.status >= 200 && r.status < 300) fail('critical', world.empKey, `Apply with a forged attachment token (${label})`, '400 "does not belong to you" / "could not be found"', `HTTP ${r.status} - request created`, K.j(r.body), 'resolveAttachment must keep the startsWith(leave/<org>/<user>/) + no ".." + existence checks.');
      else if (r.status >= 500) fail('high', world.empKey, `Forged attachment token (${label})`, 'Clean 400', `HTTP ${r.status}`, K.j(r.body), 'Map storage errors to BadRequestError.');
    }
    // PATCH (edit) with a forged token
    if (id1 && apprTok) {
      const p = await apiPatch(emp, `${HR}/api/hr/leave/requests/${id1}`, { leave_type_name: 'casual', start_date: d1, end_date: d1, attachment_token: apprTok, attachment_name: 'x.png' });
      K.journal(world.empKey, 'Apply leave', 'edit request with another user\'s attachment token', 'PATCH', '/hr/leave/requests/:id', p.status, row(id1)?.key === apprTok, '400');
      if (p.status < 400 || row(id1)?.key === apprTok) fail('critical', world.empKey, 'Edit a request to point at another user\'s attachment', '400; attachment unchanged', `HTTP ${p.status}; key now ${row(id1)?.key}`, K.j(p.body), 'updateLeaveRequest must call resolveAttachment through validateRequestInput (it does for apply) - confirm the edit path.');
    }

    // ── 5. handover rules ──────────────────────────────────────────────────────────
    console.log('\n[5] handover');
    const otherEmpId = world.xEmpKey ? K.scalar(`SELECT id FROM iam.users WHERE email=${lit(K.emailOfKey(world.xEmpKey))}`) : null;
    const noidaUserId = world.noidaKey ? scalar(`SELECT id FROM iam.users WHERE email=${lit(K.roleMeta(world.noidaKey).email)}`) : null;
    for (const [label, hid] of [['yourself', world.empId], ['a colleague of another tenant', otherEmpId], ['a colleague of another branch', noidaUserId], ['an unknown user', '019fffff-ffff-7fff-8fff-ffffffffffff']]) {
      if (!hid) continue;
      const r = await applyAs(emp, { body: { handover_user_id: hid } });
      if (idOf(r.body)) K.trackLeave(idOf(r.body));
      K.journal(world.empKey, 'Apply leave', `handover to ${label}`, 'POST', '/hr/leave/requests', r.status, null, '400');
      if (r.status < 400) fail('high', world.empKey, `Handover to ${label}`, '400 "not an active employee of your branch"', `HTTP ${r.status} - accepted`, K.j(r.body), 'assertHandover must require an active employee_profiles row in the requester\'s org.');
      else if (r.status >= 500) fail('high', world.empKey, `Handover to ${label}`, 'Clean 400', `HTTP ${r.status}`, K.j(r.body), 'Map to BadRequestError.');
    }
    const badUuid = await applyAs(emp, { body: { handover_user_id: 'not-a-uuid' } });
    if (![400, 422].includes(badUuid.status)) fail('low', world.empKey, 'Handover id that is not a uuid', '400 from the zod schema', `HTTP ${badUuid.status}`, K.j(badUuid.body), 'applyLeaveRequestSchema validates handover_user_id as uuid.');

    // ── 6. business rules around the v2 fields ──────────────────────────────────────
    console.log('\n[6] document / consecutive-day / overlap rules');
    // three working days > docAfter(2) -> document required
    const base = (() => { let b; let m; do { b = K.weekday((slot += 7)); const dd = new Date(b + 'T00:00:00Z'); while (dd.getUTCDay() !== 1) dd.setUTCDate(dd.getUTCDate() + 1); m = K.iso(dd); } while ([0, 1, 2].some((i) => used.has(K.iso(K.addDays(i, new Date(m + 'T00:00:00Z')))))); for (let i = 0; i < 3; i++) used.add(K.iso(K.addDays(i, new Date(m + 'T00:00:00Z')))); return m; })(); // a Mon..Fri; make the window Mon-Wed by walking back to Monday
    const monday = (() => { const d = new Date(base + 'T00:00:00Z'); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; })();
    const mon = K.iso(monday), wed = K.iso(K.addDays(2, monday));
    const noDoc = await applyAs(emp, { date: mon, end: wed });
    if (idOf(noDoc.body)) K.trackLeave(idOf(noDoc.body));
    K.journal(world.empKey, 'Apply leave', '3 working days without a document (policy: > 2)', 'POST', '/hr/leave/requests', noDoc.status, null, '400');
    if (noDoc.status < 400) fail('high', world.empKey, 'Leave longer than the document threshold without a document', '400 "A supporting document is required"', `HTTP ${noDoc.status}`, K.j(noDoc.body), 'validateRequestInput must enforce requires_document_after_days.');
    const withDoc = await applyAs(emp, { date: mon, end: wed, body: { attachment_token: tok, attachment_name: 'medical.png' } });
    const wdId = K.trackLeave(idOf(withDoc.body));
    K.journal(world.empKey, 'Apply leave', '3 working days WITH an uploaded document', 'POST', '/hr/leave/requests', withDoc.status, !!wdId, '201');
    if (withDoc.status !== 201) fail('high', world.empKey, 'Leave over the document threshold with a valid attachment', '201', `HTTP ${withDoc.status}`, K.j(withDoc.body), 'attachment_token must satisfy the document rule.');
    const tooLong = await applyAs(emp, { date: K.weekday(slot += 14), end: K.iso(K.addDays(9, new Date(K.weekday(slot)))) });
    if (idOf(tooLong.body)) K.trackLeave(idOf(tooLong.body));
    if (tooLong.status < 400) fail('high', world.empKey, 'Leave longer than max_consecutive_days', '400', `HTTP ${tooLong.status}`, K.j(tooLong.body), 'Enforce max_consecutive_days.');
    if (wdId) {
      const ov = await applyAs(emp, { date: wed });
      if (idOf(ov.body)) K.trackLeave(idOf(ov.body));
      if (ov.status !== 409) fail(ov.status >= 500 ? 'high' : 'medium', world.empKey, 'Overlapping request', '409 Conflict', `HTTP ${ov.status}`, K.j(ov.body), 'Overlap guard returns ConflictError.');
    }
    const pv = await apiGet(emp, `${HR}/api/hr/leave/requests/preview?leave_type_name=casual&start_date=${mon}&end_date=${wed}`);
    if (pv.status !== 200 || Number(pv.body?.data?.days_count) !== 3) fail('medium', world.empKey, 'Preview the working days', 'days_count 3 for Mon-Wed', `HTTP ${pv.status} ${K.j(pv.body?.data)}`, K.j(pv.body), 'previewLeave uses computeLeaveDays.');
    else if (!(pv.body.data.requires_document_after_days === 2)) fail('low', world.empKey, 'Preview exposes the document threshold', 'requires_document_after_days: 2', K.j(pv.body.data), K.j(pv.body.data), 'The apply form needs it to ask for the file.');

    // ── 7. policy-summary ───────────────────────────────────────────────────────────
    console.log('\n[7] policy-summary');
    const ps = await apiGet(emp, `${HR}/api/hr/leave/policy-summary`);
    const cas = (ps.body?.data ?? []).find((p) => p.leave_type_name === 'casual');
    const allowedKeys = new Set(['leave_type_name', 'leave_type_label', 'is_paid', 'max_consecutive_days', 'min_notice_days', 'allow_half_day', 'requires_document_after_days', 'carry_forward', 'encashable', 'max_encash_days', 'sla_hours']);
    const extra = cas ? Object.keys(cas).filter((k) => !allowedKeys.has(k)) : [];
    K.journal(world.empKey, 'Leave policy', 'read the employee-safe policy summary', 'GET', '/hr/leave/policy-summary', ps.status, !!cas, 'projection only');
    if (!cas || cas.max_consecutive_days !== 5 || cas.requires_document_after_days !== 2 || cas.sla_hours !== 37) fail('high', world.empKey, 'policy-summary reflects the effective policy', 'casual: max 5 consecutive, document after 2, sla 37 (the org policy just seeded)', K.j(cas), K.j(ps.body), 'getPolicySummary must prefer the org-specific latest applicable_from.');
    if (extra.length) fail('high', world.empKey, 'policy-summary leaks admin-only policy fields', 'Only the employee projection (no accrual, max_balance, approval_levels)', `extra keys: ${extra.join(',')}`, K.j(cas), 'Keep getPolicySummary a narrow SELECT.');
    await runRoleMatrix({ tool: 'hr', area: 'Leave policy', action: 'read policy summary', endpoint: 'GET /hr/leave/policy-summary', capability: CAP.VIEW, roles: ALL_ROLES,
      act: (a) => apiGet(a, `${HR}/api/hr/leave/policy-summary`) });
    if (world.xEmpKey) {
      const xa = await actor(world.xEmpKey);
      try {
        const xr = await apiGet(xa, `${HR}/api/hr/leave/policy-summary`);
        const leak = (xr.body?.data ?? []).some((p) => p.sla_hours === 37);
        K.journal(world.xEmpKey, 'Leave policy', 'tenant B reads policy-summary (tenant A seeded sla=37)', 'GET', '/hr/leave/policy-summary', xr.status, !leak, 'no tenant A rows');
        if (leak) fail('critical', world.xEmpKey, 'Cross-tenant policy leak via policy-summary', 'Only the caller\'s own tenant policies', 'Tenant B sees the tenant A policy (sla_hours 37)', K.j(xr.body), 'Filter lt.tenant_id AND p.tenant_id by ctx.tenant_id (it does) - check RLS on hr.leave_policies.');
      } finally { await xa.close(); }
    }

    // ── 8. request-info ─────────────────────────────────────────────────────────────
    console.log('\n[8] request-info');
    const ri = await newPending(emp);
    const riId = ri.id;
    if (riId) {
      const roleOf = (k) => k;
      const allowAsk = K.decisionAllowList(world, sessions, CAP.APPROVE, world.apprId);
      console.log(`  authority for request-info (assigned=${world.apprKey}): ${allowAsk.join(', ') || 'none'}`);
      await runRoleMatrix({
        tool: 'hr', area: 'Leave approvals', tab: 'Queue', action: 'ask the requester for more information', endpoint: `POST /hr/leave/requests/:id/request-info`,
        allow: allowAsk, roles: ALL_ROLES,
        act: (a, role) => apiPost(a, `${HR}/api/hr/leave/requests/${riId}/request-info`, { comment: `E2E-ask-${roleOf(role)}-${stamp}` }),
        verify: (role) => row(riId)?.info_note === `E2E-ask-${roleOf(role)}-${stamp}`,
        cleanup: () => q(`UPDATE hr.leave_requests SET info_requested_at=NULL, info_request_note=NULL WHERE id=${lit(riId)}`),
      });
      const st = K.statusOfLeave(riId);
      if (st !== 'pending') fail('high', world.apprKey, 'Asking for information changes the status', 'Request stays pending', `status=${st}`, riId, 'requestLeaveInfo must not touch status_id.');
      const empAsk = await apiPost(emp, `${HR}/api/hr/leave/requests/${riId}/request-info`, { comment: 'self ask' });
      if (empAsk.status !== 403) fail('high', world.empKey, 'Requester asks themselves for information', '403', `HTTP ${empAsk.status}`, K.j(empAsk.body), 'request-info is gated on hr.leave.approve + approver authority.');
      const blank = await apiPost(appr, `${HR}/api/hr/leave/requests/${riId}/request-info`, { comment: '   ' });
      if (![400, 422].includes(blank.status)) fail('low', world.apprKey, 'Empty question', '400', `HTTP ${blank.status}`, K.j(blank.body), 'requestLeaveInfoSchema trims and requires 1 char.');
      const ask = await apiPost(appr, `${HR}/api/hr/leave/requests/${riId}/request-info`, { comment: `E2E-question-${stamp}` });
      const asked = row(riId);
      K.journal(world.apprKey, 'Leave approvals', 'ask for more information (kept)', 'POST', '/hr/leave/requests/:id/request-info', ask.status, !!asked?.info_at, '200, question stored');
      if (ask.status !== 200 || !asked?.info_at || asked.info_note !== `E2E-question-${stamp}`) fail('high', world.apprKey, 'Assigned approver asks for information', '200; info_requested_at + note set in Postgres', `HTTP ${ask.status}; ${K.j(asked)}`, K.j(ask.body), 'requestLeaveInfo UPDATE.');
      const mine = (await apiGet(emp, `${HR}/api/hr/leave/requests?limit=100`)).body?.data?.find((x) => x.id === riId);
      if (!mine?.info_request_note) fail('medium', world.empKey, 'Requester sees the approver\'s question', 'info_request_note on my request list row', K.j(mine), K.j(mine), 'Select info_requested_at / info_request_note in listOwnRequests.');
      for (const p of ['not-a-uuid', '019fffff-ffff-7fff-8fff-ffffffffffff']) {
        const r = await apiPost(appr, `${HR}/api/hr/leave/requests/${p}/request-info`, { comment: 'x' });
        if (r.status >= 500) fail('medium', world.apprKey, `request-info with id '${p}'`, '404/400', `HTTP ${r.status}`, K.j(r.body), 'loadRequestForAction compares id::uuid to a raw string; validate params.id (uuid) in the router (leave.router.ts request-info route has no params schema).');
      }
      // editing clears the question
      const editDay = nextDay();
      const pe = await apiPatch(emp, `${HR}/api/hr/leave/requests/${riId}`, { leave_type_name: 'casual', start_date: editDay, end_date: editDay, reason: `${MARK}-edited` });
      const cleared = row(riId);
      K.journal(world.empKey, 'Leave dashboard', 'answer the question by editing the request', 'PATCH', '/hr/leave/requests/:id', pe.status, cleared && !cleared.info_at, 'question cleared');
      if (pe.status < 300 && cleared?.info_at) fail('medium', world.empKey, 'Editing the request clears the approver\'s question', 'info_requested_at/info_request_note NULL after the requester edits', K.j(cleared), K.j(pe.body), 'updateLeaveRequest must null info_requested_at, info_request_note.');
      // after a decision the question is refused
      const dec = await apiPost(appr, `${HR}/api/hr/leave/requests/${riId}/reject`, { comment: `E2E-reject-${stamp}` });
      const late = await apiPost(appr, `${HR}/api/hr/leave/requests/${riId}/request-info`, { comment: 'too late' });
      if (dec.status === 200 && late.status !== 409) fail('medium', world.apprKey, 'Ask for information on a decided request', '409', `HTTP ${late.status}`, K.j(late.body), 'requestLeaveInfo checks status_name === pending.');
    }

    // ── 9. bulk-decision ────────────────────────────────────────────────────────────
    console.log('\n[9] bulk-decision');
    const foreign = []; // rows inserted straight into Postgres for other tenant / other branch people
    const insertForeign = (userEmail, tenantId, orgId, tag) => {
      const uid = scalar(`SELECT id FROM iam.users WHERE email=${lit(userEmail.toLowerCase())}`);
      const lt = K.leaveTypeId(tenantId, 'casual');
      const sid = scalar(`SELECT id FROM hr.leave_request_statuses WHERE tenant_id=${lit(tenantId)} AND name='pending'`);
      if (!uid || !lt || !sid) return null;
      const dd = nextDay();
      const id = scalar(`INSERT INTO hr.leave_requests (user_id, org_id, leave_type_id, start_date, end_date, days_count, reason, status_id, created_by)
         VALUES (${lit(uid)}, ${lit(orgId)}, ${lit(lt)}, ${lit(dd)}, ${lit(dd)}, 1, ${lit(`${MARK}-foreign-${tag}`)}, ${lit(sid)}, ${lit(uid)}) RETURNING id`);
      foreign.push(id); K.trackLeave(id); return id;
    };
    const xId = world.xEmpKey ? insertForeign(K.emailOfKey(world.xEmpKey), world.otherTenantId, scalar(`SELECT org_id FROM iam.users WHERE email=${lit(K.emailOfKey(world.xEmpKey).toLowerCase())}`), 'tenantB') : null;
    const nId = world.noidaKey ? insertForeign(K.roleMeta(world.noidaKey).email, world.tenantId, world.noidaOrgId, 'noida') : null;
    const R = []; for (let i = 0; R.length < 5 && i < 10; i++) { const x = await newPending(emp); if (x.id) R.push(x.id); else console.log(`  (fixture request ${i} refused: HTTP ${x.r.status} ${JSON.stringify(x.r.body).slice(0, 160)})`); }
    const apprOwn = await newPending(appr, { reason: `${MARK}-approver-own` });
    const done = R.pop(); // decided up front
    const pre = await apiPost(appr, `${HR}/api/hr/leave/requests/${done}/approve`, { comment: 'pre' });
    const [A1, A2, A3, A4] = R;
    const unknown = '019fffff-ffff-7fff-8fff-fffffffffff0';
    const bulk = await apiPost(appr, `${HR}/api/hr/leave/requests/bulk-decision`, {
      request_ids: [A1, A2, xId, nId, unknown, apprOwn.id, done, A1].filter(Boolean), decision: 'approve', comment: `E2E-bulk-${stamp}` });
    const res = Object.fromEntries((bulk.body?.data?.results ?? []).map((x) => [x.request_id, x]));
    K.journal(world.apprKey, 'Leave approvals', 'bulk approve mixed ids', 'POST', '/hr/leave/requests/bulk-decision', bulk.status, null, '200 per-id outcomes');
    console.log(`  bulk: http=${bulk.status} ${K.j(bulk.body?.data && { requested: bulk.body.data.requested, succeeded: bulk.body.data.succeeded, failed: bulk.body.data.failed })}`);
    if (bulk.status !== 200) fail('high', world.apprKey, 'Bulk approve with a mixed id list', '200 with a per-id result (ids it may not decide are reported, not thrown)', `HTTP ${bulk.status}`, K.j(bulk.body), 'bulkDecideLeave catches AppError per id.');
    else {
      if (bulk.body.data.requested !== new Set([A1, A2, xId, nId, unknown, apprOwn.id, done].filter(Boolean)).size) fail('low', world.apprKey, 'Bulk decision de-duplicates ids', 'requested == distinct ids', `requested=${bulk.body.data.requested}`, K.j(bulk.body.data), 'Set() the ids.');
      for (const id of [A1, A2]) if (K.statusOfLeave(id) !== 'approved' || ledgerRows(id) !== 1) fail('high', world.apprKey, 'Bulk approve decides the requests it may decide', 'approved + exactly one consumption ledger row', `status=${K.statusOfLeave(id)} ledgerRows=${ledgerRows(id)}`, id, 'Each id goes through approveLeave().');
      for (const [label, id] of [['other-tenant', xId], ['other-branch', nId]].filter(([, i]) => i)) {
        if (K.statusOfLeave(id) !== 'pending' || ledgerRows(id) > 0) fail('critical', world.apprKey, `Bulk approve touched a ${label} request`, 'Untouched (not found / not authorised) - cross-tenant/branch writes are impossible', `status=${K.statusOfLeave(id)} ledger=${ledgerRows(id)}`, id, 'approveLeave must keep req.org_id === ctx.org_id.');
        if (res[id]?.ok) fail('critical', world.apprKey, `Bulk approve reported success for a ${label} id`, 'ok:false', K.j(res[id]), K.j(res[id]), 'See above.');
      }
      if (xId && res[xId] && res[unknown] && res[xId].error !== res[unknown].error) fail('medium', world.apprKey, 'Bulk decision existence oracle', 'A foreign id and a random id give the SAME error text', `foreign="${res[xId].error}" random="${res[unknown].error}"`, K.j({ x: res[xId], u: res[unknown] }), 'Return the identical NotFound for both (the code comment promises "a foreign id leaks nothing but its absence").');
      if (nId && res[nId] && res[unknown] && res[nId].error !== res[unknown].error) fail('low', world.apprKey, 'Bulk decision tells another branch\'s request from a missing one', 'Same error text', `other-branch="${res[nId].error}" random="${res[unknown].error}"`, K.j(res[nId]), 'Same NotFound for both.');
      if (K.statusOfLeave(apprOwn.id) !== 'pending' || res[apprOwn.id]?.ok) fail('critical', world.apprKey, 'Self-approval through bulk-decision', 'The approver\'s own request is never approved by themselves (hr.can_approve_leave)', `status=${K.statusOfLeave(apprOwn.id)} ${K.j(res[apprOwn.id])}`, apprOwn.id, 'The single path blocks it; bulk must keep delegating to approveLeave.');
      if (res[done]?.ok || !/already|approved/i.test(res[done]?.error ?? '')) fail('medium', world.apprKey, 'Bulk approve of an already decided request', 'ok:false "Request is already approved"', K.j(res[done]), K.j(res[done]), 'Keep the ConflictError.');
      if (ledgerRows(done) !== 1) fail('high', world.apprKey, 'Already decided request was debited again', 'Exactly one consumption row', `rows=${ledgerRows(done)}`, done, 'Idempotency of approveLeave.');
    }
    // validation
    for (const [label, body, want] of [
      ['empty list', { request_ids: [], decision: 'approve' }, 400], ['101 ids', { request_ids: Array.from({ length: 101 }, () => unknown), decision: 'approve' }, 400],
      ['non-uuid id', { request_ids: ['nope'], decision: 'approve' }, 400], ['reject without comment', { request_ids: [A3], decision: 'reject' }, 400],
      ['bad decision', { request_ids: [A3], decision: 'maybe' }, 400]]) {
      const r = await apiPost(appr, `${HR}/api/hr/leave/requests/bulk-decision`, body);
      K.journal(world.apprKey, 'Leave approvals', `bulk-decision ${label}`, 'POST', '/hr/leave/requests/bulk-decision', r.status, null, String(want));
      if (![400, 422].includes(r.status)) fail(r.status >= 500 ? 'high' : 'medium', world.apprKey, `bulk-decision ${label}`, `HTTP 400/422`, `HTTP ${r.status}`, K.j(r.body), 'bulkLeaveDecisionSchema.');
    }
    if (K.statusOfLeave(A3) !== 'pending') fail('high', world.apprKey, 'A rejected validation still decided a request', 'pending', K.statusOfLeave(A3), A3, 'Validate before acting.');
    // capability / role matrix for bulk reject (comment required) - A3,A4 reused: only the allowed roles' calls may succeed; restore after each
    {
      const allowReject = K.decisionAllowList(world, sessions, CAP.REJECT, world.apprId);
      const pool = [];
      for (let i = 0; i < ALL_ROLES.length + 1; i++) { const x = await newPending(emp); if (x.id) pool.push(x.id); }
      let n = 0;
      await runRoleMatrix({
        tool: 'hr', area: 'Leave approvals', tab: 'Queue', action: 'bulk reject a pending request', endpoint: 'POST /hr/leave/requests/bulk-decision', allow: allowReject, roles: ALL_ROLES,
        act: async (a) => {
          const id = pool[n++];
          const r = await apiPost(a, `${HR}/api/hr/leave/requests/bulk-decision`, { request_ids: [id], decision: 'reject', comment: 'E2E-bulk-matrix' });
          // an outer 200 whose single result failed is a refusal, not a success
          if (r.status === 200 && r.body?.data?.succeeded === 0) return { status: 403, body: r.body };
          return r;
        },
        verify: () => K.statusOfLeave(pool[n - 1]) === 'rejected',
      });
    }
    // cross tenant bulk
    if (world.xKey && !(A3 && A4)) fail('high', 'harness', 'Cross-tenant bulk approve not exercised', 'four pending fixture requests', `pool=${JSON.stringify(R)}`, '', 'newPending produced fewer than 4 requests (policy/balance/notice window) - fix the fixture, not the product');
    if (world.xKey && A3 && A4) {
      const xa = await actor(world.xKey);
      try {
        const r = await apiPost(xa, `${HR}/api/hr/leave/requests/bulk-decision`, { request_ids: [A3, A4], decision: 'approve' });
        const changed = [A3, A4].some((i) => K.statusOfLeave(i) !== 'pending');
        K.journal(world.xKey, 'Leave approvals', 'tenant B bulk-approves tenant A requests', 'POST', '/hr/leave/requests/bulk-decision', r.status, !changed, 'denied / not found');
        if (changed || r.body?.data?.succeeded > 0) fail('critical', world.xKey, 'Cross-tenant bulk approve', 'No tenant A request changes', `statuses=${[A3, A4].map(K.statusOfLeave)}`, K.j(r.body), 'Org scoping in approveLeave.');
        if (r.status >= 500) fail('high', world.xKey, 'Cross-tenant bulk approve', '4xx or per-id failures', `HTTP ${r.status}`, K.j(r.body), '');
      } finally { await xa.close(); }
    }
    // race: bulk(A3) vs single approve(A3) at the same instant -> exactly one consumption row, no 5xx
    {
      const [x, y] = await simultaneously([
        () => apiPost(appr, `${HR}/api/hr/leave/requests/bulk-decision`, { request_ids: [A4], decision: 'approve' }),
        () => apiPost(appr, `${HR}/api/hr/leave/requests/${A4}/approve`, { comment: 'race' }),
      ]);
      const rows_ = ledgerRows(A4);
      K.journal(world.apprKey, 'Leave approvals', 'bulk approve vs single approve of the same request, simultaneously', 'POST', 'bulk-decision | /approve', `${x?.status}/${y?.status}`, rows_ === 1, 'exactly one decision');
      console.log(`  race bulk/single: ${x?.status}/${y?.status} ledgerRows=${rows_} status=${K.statusOfLeave(A4)}`);
      if (rows_ !== 1 || (x?.status ?? 0) >= 500 || (y?.status ?? 0) >= 500) {
        fail(rows_ > 1 ? 'critical' : 'high', world.apprKey, 'Two simultaneous approvals of one leave request (bulk + single)', 'Exactly one winner: one consumption ledger row, the loser gets a 409, no 5xx',
          `ledger consumption rows=${rows_}; http ${x?.status}/${y?.status}`, K.j({ x: x?.body, y: y?.body }),
          'leave.repository.ts approveLeave (loadRequestForAction, line ~448) reads the request WITHOUT FOR UPDATE, unlike decideCompOffClaim/decideEncashment. Lock the leave_requests row (or the pending approval row) FOR UPDATE and re-check status_name inside the same transaction; add a unique index on hr.leave_ledger(leave_request_id) WHERE entry_type=\'consumption\'.');
      }
    }
    // cancel after decision, twice, and someone else's
    {
      const c1 = await apiPost(emp, `${HR}/api/hr/leave/requests/${A1}/cancel`, { comment: 'plans changed' });
      const c2 = await apiPost(emp, `${HR}/api/hr/leave/requests/${A1}/cancel`, { comment: 'again' });
      const net = Number(scalar(`SELECT COALESCE(SUM(amount),0) FROM hr.leave_ledger WHERE leave_request_id=${lit(A1)}`));
      K.journal(world.empKey, 'Leave dashboard', 'cancel an approved leave, then cancel again', 'POST', '/hr/leave/requests/:id/cancel', `${c1.status}/${c2.status}`, Math.abs(net) < 0.001, 'credit returned once');
      if (c1.status === 200 && Math.abs(net) > 0.001) fail('high', world.empKey, 'Cancel an approved leave returns the days exactly once', 'ledger nets to 0', `net=${net}`, A1, 'cancelLeave appends one reversing credit.');
      if (c2.status < 400 || c2.status >= 500) fail(c2.status >= 500 ? 'high' : 'medium', world.empKey, 'Cancel an already cancelled leave', '4xx', `HTTP ${c2.status}`, K.j(c2.body), 'Idempotent refusal.');
      if (rep2) {
        const c3 = await apiPost(rep2, `${HR}/api/hr/leave/requests/${A2}/cancel`, {});
        if (c3.status < 400 || K.statusOfLeave(A2) === 'cancelled') fail('critical', world.rep2Key, 'Cancel another employee\'s leave', '403/404; unchanged', `HTTP ${c3.status}`, K.j(c3.body), 'cancelLeave must scope by user_id.');
      }
    }
  }

  // ── 10. capability toggle: API denies AND the UI hides; restore ─────────────────────
  if (doApi) {
    console.log('\n[10] capability toggle');
    const tenant = world.tenantId;
    const hasUiCap = async (key, cap, want) => { const a = await actor(key); try { return (await waitForSessionCapability(a, cap, want)).ok; } finally { await a.close(); } };
    const toggle = async (roleName, key, caps, label, probe) => {
      for (const c of caps) setOverride(tenant, roleName, c, false);
      try {
        const synced = await Promise.all(caps.map((c) => hasUiCap(key, c, false)));
        if (synced.includes(false)) { console.log(`  ${label}: session did not drop the capability in time`); }
        await new Promise((r) => setTimeout(r, 1500));
        await probe(false);
      } finally { restoreAll(); }
      await Promise.all(caps.map((c) => hasUiCap(key, c, true)));
      await new Promise((r) => setTimeout(r, 1500));
      await probe(true);
    };
    const probeApply = async (on) => {
      const a = await actor(world.empKey);
      try {
        const td = nextDay();
        const r = await apiPost(a, `${HR}/api/hr/leave/requests`, { leave_type_name: 'casual', start_date: td, end_date: td, reason: `${MARK}-toggle` });
        if (idOf(r.body)) K.trackLeave(idOf(r.body));
        const u = await apiPost(a, `${HR}/api/hr/leave/attachments`, { file_name: 'p.png', data_base64: b64(K.PNG_1x1) });
        const pv = await apiGet(a, `${HR}/api/hr/leave/requests/preview?leave_type_name=casual&start_date=${td}&end_date=${td}`);
        const ok = [r.status === 201, u.status === 201, pv.status === 200];
        K.journal(world.empKey, 'Apply leave', `capability hr.leave.request.create ${on ? 'restored' : 'revoked'}: apply/upload/preview`, 'POST', '/hr/leave/requests|attachments|preview', `${r.status}/${u.status}/${pv.status}`, on ? ok.every(Boolean) : ok.every((x) => !x), on ? 'allowed' : 'denied');
        if (!on && ok.some(Boolean)) fail('high', world.empKey, 'hr.leave.request.create revoked but the API still allows it', '403 on apply, upload and preview', `apply=${r.status} upload=${u.status} preview=${pv.status}`, K.j(r.body), 'Every apply-page endpoint is gated on the capability.');
        if (on && !ok.every(Boolean)) fail('high', world.empKey, 'hr.leave.request.create restored but the API still denies it', '2xx', `apply=${r.status} upload=${u.status} preview=${pv.status}`, K.j(r.body), 'Capability cache must follow the NOTIFY invalidation.');
      } finally { await a.close(); }
    };
    await toggle('fitness_trainer', world.empKey, [CAP.CREATE], 'apply', probeApply);
    const probeDecide = async (on) => {
      const a = await actor(world.apprKey);
      try {
        const x = await newPending(emp);
        const b = await apiPost(a, `${HR}/api/hr/leave/requests/bulk-decision`, { request_ids: [x.id], decision: 'approve' });
        const ap = await apiPost(a, `${HR}/api/hr/leave/requests/${x.id}/request-info`, { comment: 'toggle' });
        const st = K.statusOfLeave(x.id);
        K.journal(world.apprKey, 'Leave approvals', `capabilities approve+reject ${on ? 'restored' : 'revoked'}: bulk approve / request-info`, 'POST', 'bulk-decision | request-info', `${b.status}/${ap.status}`, on ? st === 'approved' : st === 'pending', on ? 'allowed' : 'denied');
        if (!on && (st !== 'pending' || ap.status < 400)) fail('high', world.apprKey, 'hr.leave.approve revoked but approval paths still work', '403 on bulk approve and request-info; request stays pending', `bulk=${b.status} ask=${ap.status} status=${st}`, K.j(b.body), 'Gate on the capability in the controller / router.');
        if (on && st !== 'approved') fail('high', world.apprKey, 'hr.leave.approve restored but bulk approve does not work', 'approved', `bulk=${b.status} status=${st}`, K.j(b.body), '');
      } finally { await a.close(); }
    };
    await toggle('fitness_manager', world.apprKey, [CAP.APPROVE, CAP.REJECT], 'approve/reject', probeDecide);
  }

  // ═════════════════════════ UI ═════════════════════════════════════════════════════
  if (doUi) {
    console.log('\n[UI] employee flow on /leave');
    const uiFail = fail;
    // pre-seed one pending request to Edit / View / Cancel and a few for the approver page
    const seedReq = await newPending(emp, { reason: `${MARK}-ui-seed` });
    const toAsk = await newPending(emp, { reason: `${MARK}-ui-ask` });
    const toBulk1 = await newPending(emp, { reason: `${MARK}-ui-bulk1` });
    const toBulk2 = await newPending(emp, { reason: `${MARK}-ui-bulk2` });
    const toReview = await newPending(emp, { reason: `${MARK}-ui-review` });
    {
      const { browser, page, log } = await openAs(world.empKey);
      try {
        await page.goto(`${HR}/leave`, { waitUntil: 'domcontentloaded' });
        await K.settle(page, 2000);
        const seen = async (sel, name) => { const n = await page.locator(sel).count(); K.journal(world.empKey, 'Leave dashboard', `control present: ${name}`, 'UI', name, null, n > 0, 'visible'); return n > 0; };
        const hasApply = await seen('#apply-leave', 'Apply for time off panel');
        if (!hasApply) uiFail('high', world.empKey, 'Apply panel missing for a user with hr.leave.request.create', 'The Apply for time off section renders', `landed on ${page.url()}`, page.url(), 'LeaveDashboardShell must render ApplyLeavePanel when canApply.');
        else {
          // header buttons: every one clickable where safe
          for (const label of ['Leave policy']) {
            const b = page.getByRole('button', { name: label, exact: true });
            if (await b.count()) { await b.click(); await page.waitForTimeout(800); const shown = await page.getByText('Leave policy').count(); K.journal(world.empKey, 'Leave dashboard', `open ${label}`, 'UI', label, null, shown > 0, 'modal opens'); if (!(await page.getByText(/Casual Leave/).count())) uiFail('medium', world.empKey, 'Leave policy modal lists the policies', 'Casual Leave (and Sick Leave) with their rules', 'No Casual Leave text', '', 'PolicySummaryModal renders policy-summary rows.'); await page.keyboard.press('Escape'); await page.waitForTimeout(400); if (await page.getByRole('heading', { name: 'Leave policy' }).count()) { const closeBtn = page.getByRole('button', { name: /close/i }).first(); if (await closeBtn.count()) await closeBtn.click(); } }
          }
          for (const label of ['Encash leave', 'Claim comp-off']) K.journal(world.empKey, 'Leave dashboard', `control present: ${label}`, 'UI', label, null, (await page.getByRole('button', { name: label, exact: true }).count()) > 0, 'visible for holders');

          // every leave-type button, half-day segment, handover option
          const typeBtns = page.locator('#apply-leave fieldset button[aria-pressed]');
          const nTypes = await typeBtns.count();
          console.log(`  leave type buttons: ${nTypes}`);
          for (let i = 0; i < nTypes; i++) { await typeBtns.nth(i).click(); await page.waitForTimeout(150); }
          await page.locator('#apply-leave fieldset button[aria-pressed]', { hasText: 'Casual' }).first().click();
          const d = nextDay();
          await page.fill('#al-start', d); await page.fill('#al-end', d);
          await page.waitForTimeout(1500);
          const prevText = await page.locator('#apply-leave').innerText();
          if (!/of working days/.test(prevText)) uiFail('medium', world.empKey, 'Live preview of working days', 'The panel shows "N of working days" after choosing type and dates', 'No preview text', prevText.slice(0, 300), 'ApplyLeavePanel calls /leave/requests/preview.');
          for (const lab of ['1st half', '2nd half', 'Full day']) { const hb = page.locator('#apply-leave button[aria-pressed]', { hasText: lab }); for (let i = 0; i < await hb.count(); i++) await hb.nth(i).click(); }
          const handoverSel = page.locator('#al-handover');
          if (await handoverSel.count()) {
            const opts = await handoverSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
            console.log(`  handover options: ${opts.length}`);
            for (const o of opts) { await handoverSel.selectOption(o.v); }
            const pick = opts.find((o) => o.v === world.rep2Id) ?? opts.find((o) => o.v);
            if (pick) await handoverSel.selectOption(pick.v);
            K.journal(world.empKey, 'Leave dashboard', 'handover dropdown: every option selected', 'UI', '#al-handover', null, opts.length > 1, 'options listed');
          } else {
            K.journal(world.empKey, 'Leave dashboard', 'handover dropdown not offered', 'UI', '#al-handover', null, false, 'visible to anyone who can apply');
            uiFail('low', world.empKey, 'Work-handover dropdown is not offered to a role that can apply', 'Every employee who can apply can name a covering colleague (the feature is the point of the page)', 'The field is hidden because GET /hr/employees is denied for this role (ApplyLeavePanel swallows the 403)', 'no #al-handover', 'Feed the colleague picker from an employee-safe endpoint (same-branch directory) instead of the admin employee list.');
          }
          const reason = `${MARK}-ui-apply`;
          await page.fill('#al-reason', reason);
          await page.setInputFiles('#al-file', { name: 'e2e-medical.png', mimeType: 'image/png', buffer: K.PNG_1x1 });
          // draft: save, reload, resume
          await page.getByRole('button', { name: 'Save draft' }).click();
          const draftNote = await page.getByText('Draft saved on this device').count();
          K.journal(world.empKey, 'Leave dashboard', 'Save draft', 'UI', 'Save draft', null, draftNote > 0, 'draft notice');
          await page.reload({ waitUntil: 'domcontentloaded' }); await K.settle(page, 1500);
          const resume = page.getByRole('button', { name: 'Resume saved draft' });
          if (await resume.count()) { await resume.click(); await page.waitForTimeout(500); K.journal(world.empKey, 'Leave dashboard', 'Resume saved draft', 'UI', 'Resume saved draft', null, (await page.inputValue('#al-reason')) === reason, 'form restored'); }
          else uiFail('medium', world.empKey, 'Resume saved draft', 'A "Resume saved draft" link after a reload', 'Not shown', '', 'ApplyLeavePanel reads the draft from localStorage.');
          await page.setInputFiles('#al-file', { name: 'e2e-medical.png', mimeType: 'image/png', buffer: K.PNG_1x1 });
          const dd = nextDay();
          await page.fill('#al-start', dd); await page.fill('#al-end', dd);
          await page.locator('#apply-leave fieldset button[aria-pressed]', { hasText: 'Casual' }).first().click();
          await page.waitForTimeout(800);
          const hasHandover = await handoverSel.count();
          const wait = Promise.all([
            page.waitForResponse((r) => r.request().method() === 'POST' && /\/hr\/leave\/attachments/.test(r.url()), { timeout: 20000 }).catch(() => null),
            page.waitForResponse((r) => r.request().method() === 'POST' && /\/hr\/leave\/requests$/.test(r.url()), { timeout: 20000 }).catch(() => null),
          ]);
          await page.getByRole('button', { name: 'Submit for approval' }).click();
          const [upR, apR] = await wait;
          await K.settle(page, 1500);
          const dbId = scalar(`SELECT id FROM hr.leave_requests WHERE reason=${lit(reason)} AND user_id=${lit(world.empId)} LIMIT 1`);
          if (dbId) K.trackLeave(dbId);
          const r = dbId ? row(dbId) : null;
          K.journal(world.empKey, 'Leave dashboard', 'fill + submit the apply form with a file', 'UI', 'Submit for approval', apR?.status() ?? null, !!r, '201 and a pending row');
          if (!upR || upR.status() !== 201 || !apR || apR.status() !== 201 || !r || !r.no || !r.key || r.name !== 'e2e-medical.png' || K.statusOfLeave(dbId) !== 'pending') {
            uiFail('high', world.empKey, 'Submit the apply form (type, dates, reason, file) through the browser', 'upload 201 -> apply 201 -> pending row with request_no and attachment', `upload=${upR?.status()} apply=${apR?.status()} row=${K.j(r)}`, page.url(), 'Check ApplyLeavePanel.submit and the two endpoints.');
          } else if (hasHandover && world.rep2Id && r.handover !== world.rep2Id) {
            uiFail('medium', world.empKey, 'Handover chosen in the UI is stored', `handover_user_id = ${world.rep2Id}`, `stored ${r.handover}`, K.j(r), 'ApplyLeavePanel sends handover_user_id.');
          }
          if (!(await page.getByText('Leave request submitted').count())) uiFail('low', world.empKey, 'Success notice after submit', 'A "Leave request submitted" banner', 'None shown', '', 'Alert tone success.');
          // history table: status filter - every option; row actions
          const filter = page.getByLabel('Filter by status');
          const filterOpts = await filter.locator('option').evaluateAll((os) => os.map((o) => o.value));
          for (const v of filterOpts) { await filter.selectOption(v); await page.waitForTimeout(700); }
          await filter.selectOption('');
          await page.waitForTimeout(800);
          const rowOf = page.locator('tr', { hasText: `${MARK}-ui-seed` }).first();
          if (await rowOf.count()) {
            await rowOf.getByRole('button', { name: 'View' }).click(); await page.waitForTimeout(900);
            const chain = await page.getByText('Approval chain').count();
            K.journal(world.empKey, 'Leave dashboard', 'View a request (detail modal)', 'UI', 'View', null, chain > 0, 'approval chain shown');
            if (!chain) uiFail('medium', world.empKey, 'View request detail', 'Modal with the approval chain', 'No chain', '', 'LeaveRequestDetailModal.');
            await page.keyboard.press('Escape'); await page.waitForTimeout(400);
            await rowOf.getByRole('button', { name: 'Edit' }).click(); await page.waitForTimeout(900);
            const editOpen = await page.getByText('Edit leave request').count();
            K.journal(world.empKey, 'Leave dashboard', 'Edit a pending request (modal opens, prefilled)', 'UI', 'Edit', null, editOpen > 0, 'edit modal');
            if (!editOpen) uiFail('medium', world.empKey, 'Edit pending request', 'Edit modal opens', 'No modal', '', 'ApplyLeaveModal editing mode.');
            else {
              await page.getByRole('dialog').locator('#al-reason').fill(`${MARK}-ui-seed-edited`);
              const w = page.waitForResponse((x) => x.request().method() === 'PATCH' && /\/hr\/leave\/requests\//.test(x.url()), { timeout: 15000 }).catch(() => null);
              await page.getByRole('button', { name: 'Save changes' }).click();
              const pr = await w;
              const edited = scalar(`SELECT reason FROM hr.leave_requests WHERE id=${lit(seedReq.id)}`);
              K.journal(world.empKey, 'Leave dashboard', 'Edit a pending request and Save changes', 'UI', 'Save changes', pr?.status() ?? null, edited === `${MARK}-ui-seed-edited`, 'reason updated');
              if (!pr || pr.status() >= 300 || edited !== `${MARK}-ui-seed-edited`) uiFail('high', world.empKey, 'Save an edited pending request', 'PATCH 200 and the new reason in Postgres', `PATCH ${pr?.status()} reason=${edited}`, '', 'ApplyLeaveModal -> PATCH /hr/leave/requests/:id.');
              await K.settle(page, 800);
            }
          } else uiFail('medium', world.empKey, 'Seed request listed in history', 'Row with the seeded reason', 'Not found', '', 'Status filter/list.');
          // the new request: attachment link, then Cancel it
          const newRow = page.locator('tr', { hasText: reason }).first();
          if (await newRow.count()) {
            const link = newRow.locator('a[href*="/attachment"]');
            if (await link.count()) {
              const href = await link.first().getAttribute('href');
              const resp = await page.request.get(new URL(href, page.url()).toString(), { failOnStatusCode: false });
              K.journal(world.empKey, 'Leave dashboard', 'open the attachment link', 'GET', href, resp.status(), resp.status() === 200, '200');
              if (resp.status() !== 200) uiFail('high', world.empKey, 'Open my attachment from the history table', '200', `HTTP ${resp.status()}`, href, 'The link must resolve through hr-web /api rewrite to the gateway.');
            } else uiFail('medium', world.empKey, 'Attachment link on my request', 'A paperclip link to the file', 'None', '', 'MyRequestsTable renders r.attachment_name.');
            await newRow.getByRole('button', { name: 'Cancel' }).click();
            await K.settle(page, 1200);
            const st = K.statusOfLeave(dbId);
            K.journal(world.empKey, 'Leave dashboard', 'Cancel my pending request', 'UI', 'Cancel', null, st === 'cancelled', 'cancelled');
            if (st !== 'cancelled') uiFail('high', world.empKey, 'Cancel a pending request from the table', 'status cancelled', `status=${st}`, '', 'MyRequestsTable -> POST /cancel.');
          }
        }
        K.reportUiLog(uiFail, world.empKey, 'Leave dashboard', log, [/\/hr\/employees/, /hr\/documents\/settings/]);
      } finally { await browser.close(); }
    }

    console.log('\n[UI] approver flow on /leave/approvals');
    {
      const { browser, page, log } = await openAs(world.apprKey);
      try {
        await page.goto(`${HR}/leave/approvals`, { waitUntil: 'domcontentloaded' });
        await K.settle(page, 2500);
        const cardOf = (marker) => page.locator('li', { hasText: marker }).first();
        const ask = cardOf(`${MARK}-ui-ask`);
        if (!(await ask.count())) fail('high', world.apprKey, 'Approvals queue lists a request assigned to the approver', 'The E2E request card appears', `url=${page.url()}`, '', 'LeaveApprovalsShell -> /leave/requests/team.');
        else {
          // Ask
          await ask.getByRole('button', { name: 'Ask' }).click(); await page.waitForTimeout(600);
          await page.fill('#ri-q', `E2E-ui-question-${stamp}`);
          const w = page.waitForResponse((x) => x.request().method() === 'POST' && /request-info/.test(x.url()), { timeout: 15000 }).catch(() => null);
          await page.getByRole('button', { name: 'Send question' }).click();
          const rr = await w; await K.settle(page, 800);
          const asked = row(toAsk.id);
          K.journal(world.apprKey, 'Leave approvals', 'Ask for more information (UI)', 'UI', 'Ask -> Send question', rr?.status() ?? null, asked?.info_note === `E2E-ui-question-${stamp}`, 'question stored');
          if (!rr || rr.status() >= 300 || asked?.info_note !== `E2E-ui-question-${stamp}`) fail('high', world.apprKey, 'Ask the requester a question from the queue', 'POST request-info 200 and the note in Postgres', `HTTP ${rr?.status()} note=${asked?.info_note}`, '', 'RequestInfoModal -> leaveExtras.requestInfo.');
          // empty question -> inline error, nothing sent
          const ask2 = cardOf(`${MARK}-ui-review`);
          await ask2.getByRole('button', { name: 'Ask' }).click(); await page.waitForTimeout(500);
          await page.getByRole('button', { name: 'Send question' }).click(); await page.waitForTimeout(400);
          if (!(await page.getByText('Write your question').count())) fail('low', world.apprKey, 'Empty question is refused in the dialog', '"Write your question."', 'No validation message', '', 'RequestInfoModal.');
          await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.waitForTimeout(400);
        }
        // filter chips (every one) and tabs (every one)
        const chips = page.locator('[aria-label="Filter the queue"] button');
        for (let i = 0; i < await chips.count(); i++) { await chips.nth(i).click(); await page.waitForTimeout(250); }
        await chips.first().click();
        for (const tabName of [/Comp-off & encashment/, /Team availability/, /^Approvals/]) {
          const t = page.getByRole('tab', { name: tabName });
          if (await t.count()) { await t.click(); await K.settle(page, 900); K.journal(world.apprKey, 'Leave approvals', `open tab ${tabName}`, 'UI', String(tabName), null, true, 'tab renders'); }
        }
        // select-all toggled on and straight off again (never decided: the queue holds real people's requests)
        const all = page.getByLabel(/Select all/);
        if (await all.count()) { await all.check(); await page.waitForTimeout(300); await all.uncheck(); }
        // targeted bulk: only our two E2E cards
        for (const m of ['ui-bulk1', 'ui-bulk2']) { const c = cardOf(`${MARK}-${m}`); if (await c.count()) await c.locator('input[type=checkbox]').check(); }
        const rejectBtn = page.getByRole('button', { name: 'Reject', exact: true }).first();
        if (await rejectBtn.count()) {
          await rejectBtn.click(); await page.waitForTimeout(500);
          await page.getByRole('button', { name: /^Reject 2$/ }).click(); await page.waitForTimeout(500);
          if (!(await page.getByText('A comment is required when rejecting').count())) fail('medium', world.apprKey, 'Bulk reject without a comment', 'Inline validation message', 'No message', '', 'BulkLeaveDecisionModal.');
          await page.fill('#bld-comment', 'E2E bulk reject');
          const w = page.waitForResponse((x) => x.request().method() === 'POST' && /bulk-decision/.test(x.url()), { timeout: 15000 }).catch(() => null);
          await page.getByRole('button', { name: /^Reject 2$/ }).click();
          const br = await w; await K.settle(page, 1200);
          const sts = [toBulk1.id, toBulk2.id].map(K.statusOfLeave);
          K.journal(world.apprKey, 'Leave approvals', 'Bulk reject two selected requests (UI)', 'UI', 'select -> Reject 2', br?.status() ?? null, sts.every((s) => s === 'rejected'), 'both rejected');
          if (!br || br.status() !== 200 || sts.some((s) => s !== 'rejected')) fail('high', world.apprKey, 'Bulk reject from the queue', '200 and both E2E requests rejected in Postgres', `HTTP ${br?.status()} statuses=${sts}`, K.j(br && (await br.json().catch(() => null))), 'BulkLeaveDecisionModal -> bulk-decision.');
        } else fail('medium', world.apprKey, 'Bulk bar appears after selecting cards', 'Reject/Approve buttons', 'Not shown', '', 'LeaveApprovalsShell selected.size > 0.');
        // Review -> Close, then Review -> Approve (single decision)
        const rv = cardOf(`${MARK}-ui-review`);
        if (await rv.count()) {
          await rv.getByRole('button', { name: 'Review' }).click(); await page.waitForTimeout(700);
          const hasModal = await page.getByText('Review leave request').count();
          await page.getByRole('button', { name: 'Close', exact: true }).first().click(); await page.waitForTimeout(400);
          await rv.getByRole('button', { name: 'Review' }).click(); await page.waitForTimeout(700);
          const w = page.waitForResponse((x) => x.request().method() === 'POST' && /\/approve$/.test(x.url()), { timeout: 15000 }).catch(() => null);
          await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
          const ar = await w; await K.settle(page, 1000);
          const st = K.statusOfLeave(toReview.id);
          K.journal(world.apprKey, 'Leave approvals', 'Review -> Approve (UI)', 'UI', 'Review -> Approve', ar?.status() ?? null, st === 'approved' && ledgerRows(toReview.id) === 1, 'approved + ledger debit');
          if (!hasModal || !ar || ar.status() !== 200 || st !== 'approved' || ledgerRows(toReview.id) !== 1) fail('high', world.apprKey, 'Approve a request through Review', 'POST /approve 200; status approved; one consumption row', `modal=${!!hasModal} HTTP ${ar?.status()} status=${st} ledger=${ledgerRows(toReview.id)}`, '', 'ApprovalDecisionModal -> leaveApi.approve.');
        }
        K.reportUiLog(fail, world.apprKey, 'Leave approvals', log, [/\/leave\/requests\/.*\/(approve|reject|request-info)/, /\/photo$/]);
      } finally { await browser.close(); }
    }

    // UI hides when the capability is revoked (apply panel; approvals tab) and returns on restore
    console.log('\n[UI] capability off -> control hidden');
    const uiProbe = async (key, roleName, caps, url, check) => {
      for (const c of caps) setOverride(world.tenantId, roleName, c, false);
      let offResult, onResult;
      try {
        const a = await actor(key); try { for (const c of caps) await waitForSessionCapability(a, c, false); } finally { await a.close(); }
        await new Promise((r) => setTimeout(r, 1500));
        { const o = await openAs(key); try { await o.page.goto(url, { waitUntil: 'domcontentloaded' }); await K.settle(o.page, 2000); offResult = await check(o.page); } finally { await o.browser.close(); } }
      } finally { restoreAll(); }
      { const a = await actor(key); try { for (const c of caps) await waitForSessionCapability(a, c, true); } finally { await a.close(); } }
      await new Promise((r) => setTimeout(r, 1500));
      { const o = await openAs(key); try { await o.page.goto(url, { waitUntil: 'domcontentloaded' }); await K.settle(o.page, 2000); onResult = await check(o.page); } finally { await o.browser.close(); } }
      return { offResult, onResult };
    };
    const applyUi = await uiProbe(world.empKey, 'fitness_trainer', [CAP.CREATE], `${HR}/leave`,
      async (p) => ({ panel: await p.locator('#apply-leave').count(), button: await p.getByRole('button', { name: 'Apply leave', exact: true }).count(), url: p.url() }));
    K.journal(world.empKey, 'Leave dashboard', 'hr.leave.request.create revoked -> Apply panel + button', 'UI', '#apply-leave', null, applyUi.offResult.panel === 0 && applyUi.offResult.button === 0, 'hidden');
    if (applyUi.offResult.panel || applyUi.offResult.button) fail('medium', world.empKey, 'Apply controls stay visible after hr.leave.request.create is revoked', 'Apply panel and "Apply leave" button hidden', K.j(applyUi.offResult), K.j(applyUi.offResult), 'LeaveDashboardShell gates both on can(actor, HR_LEAVE_REQUEST_CREATE) - the session cache or SSR may be stale.');
    if (!applyUi.onResult.panel || !applyUi.onResult.button) fail('high', world.empKey, 'Apply controls do not return after the capability is restored', 'Visible again', K.j(applyUi.onResult), K.j(applyUi.onResult), 'Capability cache invalidation.');
    const apprUi = await uiProbe(world.apprKey, 'fitness_manager', [CAP.APPROVE, CAP.REJECT], `${HR}/leave/approvals`,
      async (p) => ({ url: p.url(), heading: (await p.getByText('Leave Approvals').count()), tab: await p.getByRole('link', { name: 'Approvals', exact: true }).count() }));
    K.journal(world.apprKey, 'Leave approvals', 'approve+reject revoked -> page redirects, tab hidden', 'UI', '/leave/approvals', null, !/\/leave\/approvals/.test(apprUi.offResult.url), 'redirect to /leave');
    if (/\/leave\/approvals/.test(apprUi.offResult.url) && apprUi.offResult.heading) fail('high', world.apprKey, 'Approvals page reachable after approve/reject were revoked', 'Redirect to /leave (page guard on canDecideLeave)', K.j(apprUi.offResult), K.j(apprUi.offResult), 'leave/approvals/page.tsx canDecideLeave.');
    if (!/\/leave\/approvals/.test(apprUi.onResult.url)) fail('high', world.apprKey, 'Approvals page not reachable after restore', 'Stays on /leave/approvals', K.j(apprUi.onResult), K.j(apprUi.onResult), 'Capability cache invalidation.');
  }
} finally {
  restoreAll();
  await cleanupActors();
  K.runCleanup();
  console.log(`\n${fail.count()} finding(s) recorded to results/findings-hr.json`);
}
