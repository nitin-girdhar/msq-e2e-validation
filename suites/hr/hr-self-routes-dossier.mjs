// HR self-scoped dashboard routes + documents dossier + attendance admin writes that no suite asserted:
//
//   GET  /hr/me/activity                         own recent activity (privacy: own rows only, per-capability kinds, no amounts)
//   GET  /hr/attendance/me/shift?date=           own shift for a day (self-only, validated date)
//   GET  /hr/attendance/today-summary?date=      counts-only team roster (same reach as the team view)
//   GET  /hr/attendance/reports/detail           csv / xlsx daily detail (capability + tenant fence + CSV formula safety)
//   POST /hr/attendance/regularizations/:id/cancel   requester-only withdraw (IDOR, state machine, audit)
//   GET  /hr/documents/mine/dossier              own folder as a ZIP (verified + pending, never rejected)
//   GET  /hr/documents/employee/:userId/dossier  HR download of someone's folder (documents.manage, same branch, audited)
//   PATCH /hr/shifts/:id, /hr/shift-assignments/:id   shift / assignment edits (capability, branch + tenant fence, validation)
//
// Expectations come from each login's live /auth/me capabilities, never a role name. Everything is
// DB-verified. Attacks on rows the suite does not own are written to be NON-mutating even if they
// succeed (a no-op payload equal to the stored value), so a defect is detected without damaging data.
//
// SAFETY: E2E-people-<stamp> documents / regularizations and E2E-TXS-<stamp> shifts+assignments are
// journalled and hard-purged in finally (restorePending('people-')). No password change, logout or
// switch-org is ever issued; stored .auth sessions are only used for ordinary calls.
//
//   node suites/hr/hr-self-routes-dossier.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, who, holds, guarded, journalPurge, waitAudit, q, scalar, rows, lit,
  pdfBytes, b64,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR self routes / dossier / shift PATCH');
const cleanups = [];
const SHIFT_PREFIX = `E2E-TXS-${STAMP}`;
const tenantOfOrg = (org) => scalar(`SELECT tenant_id::text FROM entity.organizations WHERE id=${lit(org)}`);
const dayIso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// ── tiny parsers ─────────────────────────────────────────────────────────────
function zipEntries(buf) {
  if (!buf || buf.length < 22) return null;
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    out.push(buf.slice(p + 46, p + 46 + nl).toString('utf8')); p += 46 + nl + xl + cl;
  }
  return out;
}
function parseCsv(text) {
  const s = text.replace(/^﻿/, ''); const out = []; let row = [], cur = '', q2 = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q2) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q2 = false; } else cur += c; }
    else if (c === '"') q2 = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out;
}

await guarded(async () => {
  cleanups.push(journalPurge('people-selfroutes-purge', 'E2E self routes / dossier', [
    `DELETE FROM hr.employee_documents WHERE title LIKE '${MARK}%'`,
    `DELETE FROM hr.attendance_regularizations WHERE reason LIKE '${MARK}%'`,
    `DELETE FROM hr.shift_assignments WHERE shift_id IN (SELECT id FROM hr.shifts WHERE name LIKE '${SHIFT_PREFIX}%')`,
    `DELETE FROM hr.shift_segments WHERE shift_id IN (SELECT id FROM hr.shifts WHERE name LIKE '${SHIFT_PREFIX}%')`,
    `DELETE FROM hr.shifts WHERE name LIKE '${SHIFT_PREFIX}%'`,
  ]));
  cleanups.push(() => {
    q(`DELETE FROM hr.employee_documents WHERE title LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM hr.attendance_regularizations WHERE reason LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM hr.shift_assignments WHERE shift_id IN (SELECT id FROM hr.shifts WHERE name LIKE ${lit(`${SHIFT_PREFIX}%`)})`);
    q(`DELETE FROM hr.shift_segments WHERE shift_id IN (SELECT id FROM hr.shifts WHERE name LIKE ${lit(`${SHIFT_PREFIX}%`)})`);
    q(`DELETE FROM hr.shifts WHERE name LIKE ${lit(`${SHIFT_PREFIX}%`)}`);
  });

  const keys = ['msq_org_admin', 'msq_tenant_admin', 'msq_rep1', 'hr_admin', 'org_admin', 'org_manager', 'sales_representative', 'rep2', 'read_only', 'fitness_trainer'];
  const A = {}, W = {};
  for (const k of keys) { const a = await open(k); if (a) { const w = await who(a); if (w) { w.tenant_id = w.tenant_id || tenantOfOrg(w.org_id); A[k] = a; W[k] = w; } } }
  const ADM = A.msq_org_admin, EMPB = A.msq_rep1;
  if (!ADM || !EMPB) { console.log('tenant B actors missing (run auth-setup)'); return; }
  const adm = W.msq_org_admin, empb = W.msq_rep1;
  const tenantB = adm.tenant_id;
  const foreign = (cap) => Object.keys(A).find((k) => W[k].tenant_id !== tenantB && holds(W[k], cap));
  console.log('actors: ' + Object.keys(A).map((k) => `${k}[org ${W[k].org_id.slice(0, 8)}]`).join(' '));

  // ═══ 0. anonymous ═════════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['GET', '/me/activity'], ['GET', '/attendance/me/shift?date=2030-01-01'], ['GET', '/attendance/today-summary'], ['GET', '/attendance/reports/detail'],
    ['POST', `/attendance/regularizations/${uuid()}/cancel`], ['GET', '/documents/mine/dossier'], ['GET', `/documents/employee/${uuid()}/dossier`],
    ['PATCH', `/shifts/${uuid()}`], ['PATCH', `/shift-assignments/${uuid()}`]]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'GET' ? undefined : '{}' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p.split('?')[0]} without a session`, '401', `HTTP ${r.status}`);
  }

  // ═══ 1. seed documents for the dossier + activity (tenant B) ════════════════
  const docsOk = holds(empb, 'hr.employees.documents.view') && holds(adm, 'hr.employees.documents.manage');
  const docs = {};
  if (docsOk) {
    for (const [tag, cat] of [['pend', 'id_proof'], ['ver', 'address_proof'], ['rej', 'education']]) {
      const r = await t.api(EMPB, 'POST', '/documents/mine', { body: { category: cat, title: `${MARK} ${tag}`, file_name: `${tag}.pdf`, data_base64: b64(pdfBytes(700 + tag.length)) }, expect: [201], label: `seed ${tag} document` });
      docs[tag] = r.body?.data?.id;
    }
    if (docs.ver) await t.api(ADM, 'POST', `/documents/${docs.ver}/review`, { body: { decision: 'verified' }, expect: 'ok', label: 'verify seed doc' });
    if (docs.rej) await t.api(ADM, 'POST', `/documents/${docs.rej}/review`, { body: { decision: 'rejected', note: 'E2E reject' }, expect: 'ok', label: 'reject seed doc' });
  } else console.log('  (tenant-B documents capabilities not held — dossier/activity seeding skipped)');

  // ═══ 2. /me/activity ═══════════════════════════════════════════════════════
  console.log('\n— 2. /me/activity —');
  const KIND_CAP = { punch: 'hr.attendance.view', regularization: 'hr.attendance.view', leave: 'hr.leave.view', payslip: 'hr.employees.payslip.view', document: 'hr.employees.documents.view' };
  const FORBIDDEN_KEYS = /net_pay|gross|salary|ctc|amount|file_key|data_base64|password|token|email/i;
  const snaps = {};
  for (const k of Object.keys(A)) {
    const w = W[k];
    const r = await t.api(A[k], 'GET', '/me/activity', { expect: [200], label: `${k} reads own activity` });
    const items = r.body?.data;
    if (!Array.isArray(items)) { t.check(false, 'high', k, '/me/activity returns { data: [] }', 'array', JSON.stringify(r.body).slice(0, 150)); continue; }
    snaps[k] = JSON.stringify(items);
    t.check(items.length <= 10, 'medium', k, 'activity is capped at 10 rows', '<=10', String(items.length));
    t.check(items.every((i) => Object.keys(i).sort().join() === 'at,detail,href,kind,title'), 'medium', k, 'every item has exactly {kind,title,detail,at,href}', 'fixed shape', JSON.stringify(items[0] ?? {}));
    t.check(items.every((i) => KIND_CAP[i.kind] && holds(w, KIND_CAP[i.kind])), 'high', k, 'a kind appears only when the caller holds the capability behind its screen', 'kinds ⊆ caps', JSON.stringify([...new Set(items.map((i) => i.kind))]), '', 'Keep the want* guards in me.router.ts.');
    t.check(items.every((i) => !Number.isNaN(Date.parse(i.at)) && /^\d{4}-\d\d-\d\dT/.test(i.at)), 'low', k, 'timestamps are ISO-8601 (Safari-safe)', 'ISO', JSON.stringify(items.map((i) => i.at).slice(0, 2)));
    t.check(items.every((x, i) => i === 0 || Date.parse(items[i - 1].at) >= Date.parse(x.at)), 'low', k, 'newest first', 'descending', 'unsorted');
    t.check(items.every((i) => typeof i.href === 'string' && i.href.startsWith('/') && !i.href.startsWith('//')), 'medium', k, 'hrefs are same-app relative paths', '/…', JSON.stringify(items.map((i) => i.href).slice(0, 3)));
    t.check(!FORBIDDEN_KEYS.test(Object.keys(items[0] ?? {}).join(',')) && !/net_pay|gross|salary|file_key|data_base64/i.test(JSON.stringify(items)), 'high', k, 'titles are labels only: no amounts, file keys or content', 'no money / blobs', JSON.stringify(items).slice(0, 160));
    // own rows only: every punch timestamp must exist in THIS user's attendance_events
    const punches = items.filter((i) => i.kind === 'punch');
    if (punches.length) {
      const ts = new Set(rows(`SELECT (extract(epoch from occurred_at)*1000)::bigint::text FROM hr.attendance_events WHERE user_id=${lit(w.id)}`, ['ms']).map((x) => Math.floor(Number(x.ms) / 1000)));
      const strange = punches.filter((p) => !ts.has(Math.floor(Date.parse(p.at) / 1000)));
      t.check(strange.length === 0, 'critical', k, 'every punch item is one of the caller\'s own events', '0 foreign punches', JSON.stringify(strange.slice(0, 2)), '', 'Keep user_id = request.auth.user_id on every source query.');
    }
    const dItems = items.filter((i) => i.kind === 'document');
    if (dItems.length) {
      const own = new Set(rows(`SELECT title FROM hr.employee_documents WHERE user_id=${lit(w.id)} AND NOT is_deleted`, ['t']).map((x) => x.t));
      t.check(dItems.every((d) => own.has(d.detail)), 'critical', k, 'every document item is one of the caller\'s own documents', 'own titles', JSON.stringify(dItems.slice(0, 2)));
    }
    // identity is never taken from the query string
    const sm = await t.api(A[k], 'GET', `/me/activity?user_id=${uuid()}&org_id=${uuid()}&limit=500`, { expect: [200, 400], label: `${k} /me/activity with smuggled user_id/org_id/limit` });
    if (sm.status === 200) t.check(JSON.stringify(sm.body?.data) === snaps[k], 'critical', k, 'smuggled user_id/org_id/limit changed nothing', 'identical rows', JSON.stringify(sm.body?.data).slice(0, 120));
  }
  if (docs.ver && docs.rej) {
    const mine = (await t.api(EMPB, 'GET', '/me/activity', { expect: [200], label: 'seeded owner reads activity' })).body?.data ?? [];
    t.check(mine.some((i) => i.kind === 'document' && /verified/i.test(i.title) && i.detail === `${MARK} ver`) && mine.some((i) => i.kind === 'document' && /rejected/i.test(i.title)), 'medium', 'msq_rep1', 'reviewed documents show up in the owner\'s activity', 'verified + rejected items', JSON.stringify(mine.filter((i) => i.kind === 'document')).slice(0, 200));
    for (const [k] of Object.entries(A).filter(([k]) => k !== 'msq_rep1')) {
      const o = (await t.api(A[k], 'GET', '/me/activity', { expect: [200], label: `${k} reads own activity (must not contain msq_rep1's documents)` })).body?.data ?? [];
      t.check(!JSON.stringify(o).includes(MARK), 'critical', k, 'another user\'s reviewed documents never appear', 'no marker', JSON.stringify(o.filter((i) => JSON.stringify(i).includes(MARK))).slice(0, 160));
    }
  }

  // ═══ 3. /attendance/me/shift ═══════════════════════════════════════════════
  console.log('\n— 3. /attendance/me/shift —');
  const today = dayIso(0);
  for (const k of Object.keys(A)) {
    const can = holds(W[k], 'hr.attendance.view');
    const r = await t.api(A[k], 'GET', `/attendance/me/shift?date=${today}`, { expect: can ? 'ok' : 'denied', label: `${k} own shift today (attendance.view=${can})` });
    if (r.status === 200) {
      const d = r.body?.data;
      const dbShift = scalar(`SELECT s.id::text FROM hr.shift_assignments a JOIN hr.shifts s ON s.id=a.shift_id WHERE a.user_id=${lit(W[k].id)} AND NOT a.is_deleted AND a.is_active AND a.effective_from <= ${lit(today)}::date AND (a.effective_to IS NULL OR a.effective_to >= ${lit(today)}::date) AND s.org_id=${lit(W[k].org_id)} LIMIT 1`);
      t.check((d == null && !dbShift) || (d?.shift_id === dbShift), 'high', k, 'own shift matches hr.shift_assignments (never another user\'s / org\'s)', dbShift ?? 'null', JSON.stringify(d)?.slice(0, 160));
      const sm = await t.api(A[k], 'GET', `/attendance/me/shift?date=${today}&user_id=${uuid()}&org_id=${uuid()}`, { expect: [200, 400], label: `${k} own shift with smuggled user_id/org_id` });
      if (sm.status === 200) t.check(JSON.stringify(sm.body) === JSON.stringify(r.body), 'critical', k, 'identity comes from the session, not the query', 'identical', JSON.stringify(sm.body).slice(0, 120));
    }
  }
  for (const [lbl, p] of [['no date', '/attendance/me/shift'], ['empty date', '/attendance/me/shift?date='], ['garbage date', '/attendance/me/shift?date=abc'], ['impossible date', '/attendance/me/shift?date=2026-02-30'],
    ['month 13', '/attendance/me/shift?date=2026-13-01'], ['datetime', `/attendance/me/shift?date=${encodeURIComponent('2026-01-01T00:00:00Z')}`], ['SQL probe', `/attendance/me/shift?date=${encodeURIComponent("2026-01-01'; DROP TABLE x;--")}`],
    ['array date', '/attendance/me/shift?date=2026-01-01&date=2026-01-02'], ['far past 0001-01-01', '/attendance/me/shift?date=0001-01-01'], ['far future 9999-12-31', '/attendance/me/shift?date=9999-12-31']]) {
    await t.api(EMPB, 'GET', p, { expect: lbl.startsWith('far') || lbl === 'array date' ? [200, 400, 422] : 'invalid', label: `me/shift: ${lbl}` });
  }

  // ═══ 4. /attendance/today-summary ═══════════════════════════════════════════
  console.log('\n— 4. /attendance/today-summary —');
  const COUNT_KEYS = ['present', 'checked_in', 'checked_out', 'half_day', 'on_leave', 'wfh', 'absent', 'not_marked'];
  for (const k of Object.keys(A)) {
    const can = holds(W[k], 'hr.attendance.view');
    const r = await t.api(A[k], 'GET', `/attendance/today-summary?date=${today}`, { expect: can ? [200, 403] : 'denied', label: `${k} today-summary (attendance.view=${can})` });
    if (r.status === 200) {
      const d = r.body?.data ?? {};
      t.check(COUNT_KEYS.every((c) => Number.isFinite(Number(d[c]))) && Object.values(d).every((v) => typeof v === 'number' || /^\d+$/.test(String(v))), 'high', k, 'summary is counts only (no names / ids / emails)', 'numbers', JSON.stringify(d).slice(0, 200));
      const roster = Number(scalar(`SELECT count(*) FROM hr.employee_profiles WHERE org_id=${lit(W[k].org_id)} AND is_active AND NOT is_deleted`));
      t.check(Number(d.not_marked ?? 0) + Number(d.present ?? 0) + Number(d.half_day ?? 0) + Number(d.on_leave ?? 0) + Number(d.absent ?? 0) <= roster, 'critical', k, 'the counts never exceed the caller\'s branch roster', `<= ${roster}`, JSON.stringify(d), '', 'Roster CTE must filter ep.org_id = ctx.org_id.');
      const sm = await t.api(A[k], 'GET', `/attendance/today-summary?date=${today}&org_id=${uuid()}`, { expect: [200, 400], label: `${k} today-summary with smuggled org_id` });
      if (sm.status === 200) t.check(JSON.stringify(sm.body) === JSON.stringify(r.body), 'critical', k, 'org comes from the session', 'identical', JSON.stringify(sm.body).slice(0, 120));
    } else if (r.status === 403) {
      // team-view reach (rank/scope) can deny a holder of attendance.view: it must be the same verdict as /attendance/team
      const tm = await t.api(A[k], 'GET', `/attendance/team?date=${today}`, { expect: [403], label: `${k} /attendance/team agrees with today-summary` });
      void tm;
    }
  }
  for (const [lbl, p] of [['garbage date', 'date=abc'], ['impossible date', 'date=2026-02-30'], ['month 13', 'date=2026-13-01']]) await t.api(ADM, 'GET', `/attendance/today-summary?${p}`, { expect: [400, 422, 403], label: `today-summary: ${lbl}` });

  // ═══ 5. regularization cancel ═══════════════════════════════════════════════
  console.log('\n— 5. regularization cancel —');
  const REQ = A.sales_representative ?? A.fitness_trainer, rq = REQ === A.sales_representative ? W.sales_representative : W.fitness_trainer;
  if (REQ && holds(rq, 'hr.attendance.regularization.request')) {
    const BASE = 31 + (STAMP % 15);
    const wd = (n) => dayIso(-(BASE + n));
    const regRow = (id) => rows(`SELECT status, COALESCE(approver_id::text,''), COALESCE(acted_at::text,''), user_id::text FROM hr.attendance_regularizations WHERE id=${lit(id)}`, ['st', 'appr', 'acted', 'user'])[0];
    const file = async (n, reason = `${MARK} reg ${n}`) => {
      const r = await t.api(REQ, 'POST', '/attendance/regularizations', { body: { work_date: wd(n), requested_status_name: 'present', reason }, expect: [201, 400, 403, 409, 422], label: `file regularization for ${wd(n)}` });
      return r.status === 201 ? (r.body?.data?.id ?? scalar(`SELECT id::text FROM hr.attendance_regularizations WHERE user_id=${lit(rq.id)} AND work_date=${lit(wd(n))} AND reason=${lit(reason)} ORDER BY created_at DESC LIMIT 1`)) : null;
    };
    const rA = await file(0, `${MARK} =HYPERLINK("http://example.invalid/x","click")`);
    if (!rA) console.log('  (could not file a regularization — outside the window / already open; cancel cases skipped)');
    else {
      const bA = regRow(rA);
      // everyone else: not the requester -> must not cancel (404 by design: the row is invisible to them)
      const others = Object.keys(A).filter((k) => A[k] !== REQ && !(W[k].id === rq.id));
      for (const k of others) await t.api(A[k], 'POST', `/attendance/regularizations/${rA}/cancel`, { expect: 'denied', label: `${k} cancels someone else's regularization` });
      t.check(regRow(rA).st === 'pending', 'critical', 'others', 'a non-requester cancel left the request pending', 'pending', regRow(rA).st, '', 'loadOwnPendingReg must stay scoped to ctx.user_id.');
      // approver cannot use cancel as a back-door reject
      const apr = Object.keys(A).find((k) => A[k] !== REQ && holds(W[k], 'hr.attendance.regularization.approve') && W[k].org_id === rq.org_id);
      if (apr) { await t.api(A[apr], 'POST', `/attendance/regularizations/${rA}/cancel`, { expect: 'denied', label: `approver ${apr} cancels (not an approval action)` }); t.check(regRow(rA).st === 'pending', 'high', apr, 'approver cancel left it pending', 'pending', regRow(rA).st); }
      // malformed
      for (const [lbl, p] of [['non-uuid id', 'zzz'], ['unknown id', uuid()], ['SQL probe', encodeURIComponent("x' OR '1'='1")]]) await t.api(REQ, 'POST', `/attendance/regularizations/${p}/cancel`, { expect: 'notok', label: `cancel: ${lbl}` });
      // CSV formula safety of the detail report while the request is open (see section 6)
      const hrFor = Object.keys(A).find((k) => holds(W[k], 'hr.reports.attendance.view') && W[k].org_id === rq.org_id);
      if (hrFor) {
        const month = wd(0).slice(0, 7);
        const csv = await t.api(A[hrFor], 'GET', `/attendance/reports/detail?month=${month}&format=csv`, { raw: true, expect: [200, 403], label: `${hrFor} detail csv for ${month}`, });
        if (csv.status === 200) {
          const cells = parseCsv(csv.buf.toString('utf8')).flat();
          const hit = cells.filter((c) => c.includes(MARK));
          if (hit.length) t.check(hit.every((c) => !/^[=+\-@\t\r]/.test(c)), 'medium', hrFor, 'detail CSV neutralises a formula-leading regularization reason (CSV/Excel injection)', 'cell does not start with = + - @', JSON.stringify(hit.slice(0, 2)), '', 'In csvEscape/toCsv prefix cells that start with = + - @ TAB CR with a single quote (or a space) before quoting; apply to xlsx text cells too.');
          else console.log('  (the reason is not surfaced in the CSV — formula check n/a)');
        }
      }
      // owner cancels
      const since = new Date(Date.now() - 1000).toISOString();
      await t.api(REQ, 'POST', `/attendance/regularizations/${rA}/cancel`, { expect: 'ok', label: 'owner cancels a pending regularization' });
      const aA = regRow(rA);
      t.check(aA.st === 'cancelled' && aA.appr === '' && aA.acted === '', 'high', 'requester', 'cancelled; nobody decided it (approver/acted_at stay null)', 'cancelled, no approver', JSON.stringify(aA));
      t.check(!!(await waitAudit('attendance_regularization_cancelled', rq.id, since)), 'low', 'requester', 'cancel is audited', '1 audit row', 'none');
      await t.api(REQ, 'POST', `/attendance/regularizations/${rA}/cancel`, { expect: 'notok', label: 'cancel the same request twice' });
      if (apr) { await t.api(A[apr], 'POST', `/attendance/regularizations/${rA}/approve`, { body: { comment: 'late' }, expect: 'notok', label: 'approve a cancelled request' }); t.check(regRow(rA).st === 'cancelled', 'high', apr, 'a cancelled request cannot be approved', 'cancelled', regRow(rA).st); }
      const re = await t.api(REQ, 'POST', '/attendance/regularizations', { body: { work_date: wd(0), requested_status_name: 'present', reason: `${MARK} refile` }, expect: [201], label: 'cancel released the one-open-per-date slot (re-file same day)' });
      void re;
      // a decided request cannot be cancelled
      const rB = await file(1);
      if (rB && apr) {
        await t.api(A[apr], 'POST', `/attendance/regularizations/${rB}/reject`, { body: { comment: 'E2E reject' }, expect: 'ok', label: 'approver rejects the second request' });
        await t.api(REQ, 'POST', `/attendance/regularizations/${rB}/cancel`, { expect: 'notok', label: 'cancel an already-rejected request' });
        t.check(regRow(rB).st === 'rejected', 'high', 'requester', 'a decided request is immutable by cancel', 'rejected', regRow(rB).st);
      }
      // capability gate: a login without regularization.request cannot cancel even its own (probe with a foreign id => gate verdict)
      const noCap = Object.keys(A).find((k) => !holds(W[k], 'hr.attendance.regularization.request'));
      if (noCap) await t.api(A[noCap], 'POST', `/attendance/regularizations/${uuid()}/cancel`, { expect: 'forbidden', label: `${noCap} (no regularization.request) cancel is gated by capability` });
    }
  } else console.log('  (no tenant-A requester holding hr.attendance.regularization.request — cancel cases skipped)');

  // ═══ 6. reports/detail ═══════════════════════════════════════════════════════
  console.log('\n— 6. attendance reports/detail —');
  const month = new Date().toISOString().slice(0, 7);
  const emailsOutsideTenant = (csvText, tenant) => {
    const cells = parseCsv(csvText).flat().filter((c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c));
    if (!cells.length) return [];
    return rows(`SELECT u.email FROM iam.users u LEFT JOIN entity.organizations o ON o.id=u.org_id WHERE lower(u.email) IN (${[...new Set(cells.map((c) => c.toLowerCase()))].map(lit).join(',')}) AND (o.tenant_id IS DISTINCT FROM ${lit(tenant)})`, ['e']).map((r) => r.e);
  };
  for (const k of Object.keys(A)) {
    const can = holds(W[k], 'hr.reports.attendance.view');
    const csv = await t.api(A[k], 'GET', `/attendance/reports/detail?month=${month}&format=csv`, { raw: true, expect: can ? 'ok' : 'denied', label: `${k} detail csv (reports.attendance.view=${can})` });
    if (csv.status === 200) {
      const text = csv.buf.toString('utf8');
      t.check(/text\/csv/.test(csv.headers['content-type'] ?? '') && /attachment; filename="attendance-detail-\d{4}-\d\d\.csv"/.test(csv.headers['content-disposition'] ?? ''), 'low', k, 'csv content-type + attachment filename', 'text/csv; attachment', `${csv.headers['content-type']} | ${csv.headers['content-disposition']}`);
      const leak = emailsOutsideTenant(text, W[k].tenant_id);
      t.check(leak.length === 0, 'critical', k, 'detail csv holds only employees of the caller\'s tenant', '0 foreign emails', leak.slice(0, 3).join(','), '', 'reportDetail must keep the tenant/branch reach from requireReportReach.');
    }
  }
  const rp = Object.keys(A).find((k) => holds(W[k], 'hr.reports.attendance.view'));
  if (rp) {
    const x = await t.api(A[rp], 'GET', `/attendance/reports/detail?month=${month}&format=xlsx`, { raw: true, expect: 'ok', label: `${rp} detail xlsx` });
    t.check(x.buf?.length > 100 && x.buf.slice(0, 2).toString('latin1') === 'PK' && /spreadsheetml/.test(x.headers['content-type'] ?? ''), 'medium', rp, 'xlsx is a real OOXML zip with the spreadsheet content-type', 'PK + spreadsheetml', `${x.headers['content-type']} ${x.buf?.length}`);
    const dflt = await t.api(A[rp], 'GET', '/attendance/reports/detail', { raw: true, expect: 'ok', label: `${rp} detail with no params (month=current, xlsx)` });
    t.check(/spreadsheetml/.test(dflt.headers['content-type'] ?? ''), 'low', rp, 'format defaults to xlsx', 'xlsx', dflt.headers['content-type']);
    for (const [lbl, p] of [['bad month text', 'month=abc'], ['month 13', 'month=2026-13'], ['month with day', 'month=2026-05-01'], ['bad format', `month=${month}&format=pdf`], ['format json (not offered)', `month=${month}&format=json`], ['SQL probe', `month=${encodeURIComponent("2026-01'; --")}`]]) {
      await t.api(A[rp], 'GET', `/attendance/reports/detail?${p}`, { raw: true, expect: 'invalid', label: `detail: ${lbl}` });
    }
    await t.api(A[rp], 'GET', `/attendance/reports/detail?month=${month}&format=csv&org_id=${uuid()}&user_id=${uuid()}`, { raw: true, expect: [200, 400], label: `${rp} detail with smuggled org_id/user_id` });
    await t.api(A[rp], 'GET', '/attendance/reports/detail?month=1999-01&format=csv', { raw: true, expect: [200, 400], label: `${rp} detail for a month before any data` });
  }

  // ═══ 7. documents dossier ═════════════════════════════════════════════════════
  console.log('\n— 7. documents dossier —');
  if (docsOk && docs.pend && docs.ver && docs.rej) {
    const ownSince = new Date(Date.now() - 1000).toISOString();
    const own = await t.api(EMPB, 'GET', '/documents/mine/dossier', { raw: true, expect: [200], label: 'owner downloads own dossier' });
    const names = zipEntries(own.buf);
    t.check(own.status === 200 && Array.isArray(names), 'high', 'msq_rep1', 'dossier is a valid ZIP', 'PK zip', `${own.status} ${own.buf?.length}`);
    if (names) {
      t.check(names.some((n) => /^id_proof_/.test(n)) && names.some((n) => /^address_proof_/.test(n)), 'high', 'msq_rep1', 'pending and verified files are included', 'id_proof_* + address_proof_*', JSON.stringify(names));
      t.check(!names.some((n) => /^education_/.test(n)), 'high', 'msq_rep1', 'a rejected file is NOT in the dossier', 'no education_*', JSON.stringify(names));
      t.check(names.every((n) => !/[\\/]|\.\./.test(n) && n.length < 200), 'high', 'msq_rep1', 'ZIP entry names are flat (no path traversal / zip-slip)', 'no / \\ ..', JSON.stringify(names));
      t.check(new Set(names).size === names.length, 'medium', 'msq_rep1', 'entry names are unique', 'unique', JSON.stringify(names));
    }
    const h = own.headers;
    t.check(/application\/zip/.test(h['content-type'] ?? '') && h['x-content-type-options'] === 'nosniff' && /no-store/.test(h['cache-control'] ?? '') && /^attachment; filename="[\w\- .]*_documents\.zip"$/.test(h['content-disposition'] ?? ''), 'high', 'msq_rep1', 'zip headers: application/zip, nosniff, private no-store, sanitised attachment name', 'safe headers', `${h['content-type']} | ${h['x-content-type-options']} | ${h['cache-control']} | ${h['content-disposition']}`);
    await new Promise((r) => setTimeout(r, 1500));
    t.check(!auditRows0(empb.id, ownSince, 'document_dossier_downloaded'), 'low', 'msq_rep1', 'an OWN dossier download is not written to the HR audit trail', 'no audit row', 'row written');
    await t.api(EMPB, 'GET', `/documents/mine/dossier?user_id=${W.msq_tenant_admin?.id ?? uuid()}`, { raw: true, expect: [200], label: 'own dossier with smuggled user_id' });

    // HR download
    const hrSince = new Date(Date.now() - 1000).toISOString();
    const hd = await t.api(ADM, 'GET', `/documents/employee/${empb.id}/dossier`, { raw: true, expect: [200], label: 'HR (documents.manage) downloads the employee dossier' });
    t.check(Array.isArray(zipEntries(hd.buf)) && zipEntries(hd.buf).length === (names?.length ?? -1), 'high', 'msq_org_admin', 'HR gets the same folder as the owner', `${names?.length} entries`, String(zipEntries(hd.buf)?.length));
    t.check(!!(await waitAudit('document_dossier_downloaded', empb.id, hrSince)), 'medium', 'msq_org_admin', 'HR download of someone else\'s dossier is audited', '1 audit row', 'none', '', 'sendDossier must call audit() when !own.');
    // denied: employee without manage, other-branch/tenant HR
    await t.api(EMPB, 'GET', `/documents/employee/${adm.id}/dossier`, { raw: true, expect: 'forbidden', label: 'employee without documents.manage downloads someone else\'s dossier' });
    for (const k of Object.keys(A).filter((x) => W[x].tenant_id !== tenantB)) await t.api(A[k], 'GET', `/documents/employee/${empb.id}/dossier`, { raw: true, expect: 'denied', label: `tenant-A ${k} downloads a tenant-B dossier` });
    const sameTenantOtherBranch = Object.keys(A).find((k) => W[k].tenant_id === tenantB && W[k].org_id !== adm.org_id && holds(W[k], 'hr.employees.documents.manage'));
    if (sameTenantOtherBranch) await t.api(A[sameTenantOtherBranch], 'GET', `/documents/employee/${empb.id}/dossier`, { raw: true, expect: 'denied', label: `${sameTenantOtherBranch} (other branch HR) downloads this branch's dossier` });
    // malformed / unknown
    for (const [lbl, id] of [['non-uuid userId', 'not-a-uuid'], ['unknown userId', uuid()], ['SQL probe', encodeURIComponent("x' OR '1'='1")]]) await t.api(ADM, 'GET', `/documents/employee/${id}/dossier`, { raw: true, expect: 'notok', label: `HR dossier: ${lbl}` });
    // empty / rejected-only folder is a clean 404, not an empty zip or a 5xx
    const peerNoDocs = Object.keys(A).find((k) => W[k].tenant_id === tenantB && k !== 'msq_rep1' && holds(W[k], 'hr.employees.documents.view') && Number(scalar(`SELECT count(*) FROM hr.employee_documents WHERE user_id=${lit(W[k].id)} AND NOT is_deleted AND status <> 'rejected'`)) === 0);
    if (peerNoDocs) await t.api(A[peerNoDocs], 'GET', '/documents/mine/dossier', { raw: true, expect: [404], label: `${peerNoDocs} (no documents) own dossier -> clean 404` });
    // after the owner removes pending+verified... keep fixtures; instead verify rejecting all leaves nothing to ship
    const noView = Object.keys(A).find((k) => !holds(W[k], 'hr.employees.documents.view'));
    if (noView) await t.api(A[noView], 'GET', '/documents/mine/dossier', { raw: true, expect: 'forbidden', label: `${noView} (no documents.view) own dossier` });
  } else console.log('  (documents fixtures unavailable — dossier cases skipped)');

  // ═══ 8. shift / shift-assignment PATCH ═════════════════════════════════════════
  console.log('\n— 8. shift + assignment PATCH —');
  const SH = 'hr.attendance.admin.shifts.manage', AS = 'hr.attendance.admin.assignments.manage';
  const shiftRow = (id) => rows(`SELECT org_id::text, name, start_time::text, end_time::text, grace_minutes::text, min_half_day_minutes::text, min_full_day_minutes::text, is_night_shift::text, is_split::text, is_active::text, is_deleted::text FROM hr.shifts WHERE id=${lit(id)}`,
    ['org', 'name', 'start', 'end', 'grace', 'half', 'full', 'night', 'split', 'active', 'del'])[0];
  const asnRow = (id) => rows(`SELECT user_id::text, org_id::text, shift_id::text, effective_from::text, COALESCE(effective_to::text,''), is_active::text, is_deleted::text FROM hr.shift_assignments WHERE id=${lit(id)}`,
    ['user', 'org', 'shift', 'from', 'to', 'active', 'del'])[0];
  const mkShift = (n, s, e) => scalar(`INSERT INTO hr.shifts (org_id, name, start_time, end_time) VALUES (${lit(adm.org_id)}, ${lit(`${SHIFT_PREFIX}-${n}`)}, ${lit(s)}, ${lit(e)}) RETURNING id::text`);
  const sA = mkShift('A', '08:00', '12:00'), sB = mkShift('B', '12:00', '16:00');
  if (holds(adm, SH) && sA) {
    const b = shiftRow(sA);
    await t.api(ADM, 'PATCH', `/shifts/${sA}`, { body: { name: `${SHIFT_PREFIX}-A2`, grace_minutes: 15, min_half_day_minutes: 200, min_full_day_minutes: 400 }, expect: 'ok', label: 'edit own shift' });
    const a1 = shiftRow(sA);
    t.check(a1.name === `${SHIFT_PREFIX}-A2` && a1.grace === '15' && a1.half === '200' && a1.full === '400' && a1.org === b.org && a1.start === b.start, 'high', 'msq_org_admin', 'shift PATCH persisted; org + untouched fields intact', 'edited', JSON.stringify(a1));
    await t.api(ADM, 'PATCH', `/shifts/${sA}`, { body: { org_id: uuid(), is_deleted: true, id: uuid() }, expect: [200, 204, 400, 404, 422], label: 'PATCH a shift with smuggled org_id / is_deleted / id' });
    t.check(shiftRow(sA).org === b.org && shiftRow(sA).del === 'false', 'critical', 'msq_org_admin', 'smuggled shift fields ignored', 'unchanged', JSON.stringify(shiftRow(sA)));
    const before = shiftRow(sA);
    for (const [lbl, body] of [
      ['start_time 25:00', { start_time: '25:00' }], ['start_time text', { start_time: 'morning' }], ['end_time 12:60', { end_time: '12:60' }], ['grace 601', { grace_minutes: 601 }], ['grace -1', { grace_minutes: -1 }],
      ['grace float', { grace_minutes: 1.5 }], ['half-day > full-day minutes', { min_half_day_minutes: 500, min_full_day_minutes: 100 }], ['full-day 1441', { min_full_day_minutes: 1441 }],
      ['name 201 chars', { name: 'n'.repeat(201) }], ['empty name', { name: '' }], ['is_night_shift string', { is_night_shift: 'yes' }],
      ['split without segments inside window', { is_split: true, segments: [{ seq: 1, start_time: '07:00', end_time: '09:00' }] }],
      ['13 segments', { is_split: true, segments: Array.from({ length: 13 }, (_, i) => ({ seq: i + 1, start_time: '08:00', end_time: '09:00' })) }],
    ]) await t.api(ADM, 'PATCH', `/shifts/${sA}`, { body, expect: 'notok', label: `shift PATCH: ${lbl}` });
    t.check(JSON.stringify(shiftRow(sA)) === JSON.stringify(before), 'high', 'msq_org_admin', 'no rejected shift PATCH changed the row', 'unchanged', JSON.stringify(shiftRow(sA)));
    await t.api(ADM, 'PATCH', '/shifts/not-a-uuid', { body: { name: 'x' }, expect: 'notok', label: 'shift PATCH: non-uuid id' });
    await t.api(ADM, 'PATCH', `/shifts/${uuid()}`, { body: { name: 'x' }, expect: 'notok', label: 'shift PATCH: unknown id' });
    await t.api(ADM, 'PATCH', `/shifts/${sA}`, { body: {}, expect: [200, 204, 400, 422], label: 'shift PATCH: empty body' });
  } else console.log('  (tenant-B admin cannot manage shifts — shift PATCH happy path skipped)');
  // authz by live capability
  for (const k of Object.keys(A)) {
    if (!sA) break;
    const can = holds(W[k], SH);
    if (can && k === 'msq_org_admin') continue;
    if (W[k].org_id === adm.org_id || !can) {
      const b = shiftRow(sA);
      await t.api(A[k], 'PATCH', `/shifts/${sA}`, { body: { name: b.name }, expect: can && W[k].org_id === adm.org_id ? 'ok' : 'denied', label: `${k} no-op PATCH on a tenant-B branch shift (shifts.manage=${can}, same branch=${W[k].org_id === adm.org_id})` });
      t.check(JSON.stringify(shiftRow(sA)) === JSON.stringify(b), 'critical', k, 'no-op PATCH left the row byte-identical', 'unchanged', JSON.stringify(shiftRow(sA)));
    } else {
      // holds the cap but in another tenant / branch: must be 404 (branch fence)
      await t.api(A[k], 'PATCH', `/shifts/${sA}`, { body: { name: shiftRow(sA).name }, expect: 'denied', label: `${k} (holds shifts.manage elsewhere) PATCHes this branch's shift` });
    }
  }
  // the attack in the other direction: tenant B admin against a tenant-A shift, with a no-op payload
  const fShift = scalar(`SELECT s.id::text FROM hr.shifts s JOIN entity.organizations o ON o.id=s.org_id WHERE o.tenant_id <> ${lit(tenantB)} AND NOT s.is_deleted LIMIT 1`);
  if (fShift) {
    const fb = shiftRow(fShift);
    await t.api(ADM, 'PATCH', `/shifts/${fShift}`, { body: { name: fb.name }, expect: 'denied', label: 'tenant B admin PATCHes a tenant-A shift (no-op payload)' });
    t.check(JSON.stringify(shiftRow(fShift)) === JSON.stringify(fb), 'critical', 'msq_org_admin', 'foreign shift byte-identical', 'unchanged', JSON.stringify(shiftRow(fShift)));
  }

  // assignments
  const targetUser = empb.id;
  let asn1 = null, asn2 = null;
  if (sA && sB && holds(adm, AS)) {
    try {
      asn1 = scalar(`INSERT INTO hr.shift_assignments (user_id, org_id, shift_id, effective_from, effective_to) VALUES (${lit(targetUser)}, ${lit(adm.org_id)}, ${lit(sA)}, '2032-01-01', '2032-01-31') RETURNING id::text`);
      asn2 = scalar(`INSERT INTO hr.shift_assignments (user_id, org_id, shift_id, effective_from, effective_to) VALUES (${lit(targetUser)}, ${lit(adm.org_id)}, ${lit(sA)}, '2032-03-01', '2032-03-31') RETURNING id::text`);
    } catch (e) { console.log(`  (could not seed far-future assignments: ${String(e.message).split('\n')[0]})`); }
  }
  if (asn1 && asn2) {
    const b = asnRow(asn2);
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { shift_id: sB, effective_from: '2032-03-05', effective_to: '2032-03-20' }, expect: 'ok', label: 'edit own assignment (shift + window)' });
    const a1 = asnRow(asn2);
    t.check(a1.shift === sB && a1.from === '2032-03-05' && a1.to === '2032-03-20' && a1.user === b.user && a1.org === b.org, 'high', 'msq_org_admin', 'assignment PATCH persisted; user + org untouched', 'edited', JSON.stringify(a1));
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { user_id: W.msq_tenant_admin?.id ?? uuid(), org_id: uuid(), is_deleted: true }, expect: [200, 204, 400, 404, 422], label: 'PATCH an assignment with smuggled user_id / org_id / is_deleted' });
    t.check(asnRow(asn2).user === b.user && asnRow(asn2).org === b.org && asnRow(asn2).del === 'false', 'critical', 'msq_org_admin', 'smuggled assignment fields ignored', 'unchanged', JSON.stringify(asnRow(asn2)));
    const before = asnRow(asn2);
    // overlap with the other window of the same user -> 409 (exclusion constraint), never 5xx
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { effective_from: '2032-01-15' }, expect: [409], label: 'assignment PATCH that overlaps the same user\'s other assignment' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { effective_from: '2032-03-25', effective_to: '2032-03-10' }, expect: 'notok', label: 'assignment PATCH: effective_to before effective_from' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { effective_from: '2032-02-30' }, expect: 'invalid', label: 'assignment PATCH: impossible date' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { shift_id: 'nope' }, expect: 'invalid', label: 'assignment PATCH: non-uuid shift_id' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { shift_id: uuid() }, expect: 'notok', label: 'assignment PATCH: unknown shift_id (FK) is a 4xx' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { is_active: 'no' }, expect: 'invalid', label: 'assignment PATCH: is_active string' });
    // IDOR via shift_id: point my assignment at ANOTHER TENANT's shift (FK passes, RLS does not apply to FK checks)
    if (fShift) {
      await t.api(ADM, 'PATCH', `/shift-assignments/${asn2}`, { body: { shift_id: fShift }, expect: 'notok', label: 'assignment PATCH: shift_id of ANOTHER TENANT\'s shift' });
      t.check(asnRow(asn2).shift !== fShift, 'high', 'msq_org_admin', 'an assignment can never reference another tenant\'s shift', 'shift_id unchanged', asnRow(asn2).shift, 'updateShiftAssignment sets shift_id without checking the shift belongs to ctx.org_id; the FK alone does not fence tenants.', 'In updateShiftAssignment (and createShiftAssignment) verify EXISTS(SELECT 1 FROM hr.shifts WHERE id=$shift AND org_id=ctx.org_id AND NOT is_deleted) -> 404, or add a composite (org_id, shift_id) FK.');
    }
    void before;
    await t.api(ADM, 'PATCH', '/shift-assignments/not-a-uuid', { body: { is_active: true }, expect: 'notok', label: 'assignment PATCH: non-uuid id' });
    await t.api(ADM, 'PATCH', `/shift-assignments/${uuid()}`, { body: { is_active: true }, expect: 'notok', label: 'assignment PATCH: unknown id' });
    // capability / tenant fences, with a no-op payload
    for (const k of Object.keys(A).filter((x) => x !== 'msq_org_admin')) {
      const can = holds(W[k], AS), sameBranch = W[k].org_id === adm.org_id;
      const b2 = asnRow(asn2);
      await t.api(A[k], 'PATCH', `/shift-assignments/${asn2}`, { body: { is_active: b2.active === 'true' }, expect: can && sameBranch ? 'ok' : 'denied', label: `${k} no-op PATCH on tenant-B assignment (assignments.manage=${can}, same branch=${sameBranch})` });
      t.check(JSON.stringify(asnRow(asn2)) === JSON.stringify(b2), 'critical', k, 'no-op PATCH left the assignment byte-identical', 'unchanged', JSON.stringify(asnRow(asn2)));
    }
  } else console.log('  (assignment fixtures unavailable — assignment PATCH cases skipped)');
  const fAsn = scalar(`SELECT a.id::text FROM hr.shift_assignments a JOIN entity.organizations o ON o.id=a.org_id WHERE o.tenant_id <> ${lit(tenantB)} AND NOT a.is_deleted LIMIT 1`);
  if (fAsn) {
    const fb = asnRow(fAsn);
    await t.api(ADM, 'PATCH', `/shift-assignments/${fAsn}`, { body: { is_active: fb.active === 'true' }, expect: 'denied', label: 'tenant B admin PATCHes a tenant-A assignment (no-op payload)' });
    t.check(JSON.stringify(asnRow(fAsn)) === JSON.stringify(fb), 'critical', 'msq_org_admin', 'foreign assignment byte-identical', 'unchanged', JSON.stringify(asnRow(fAsn)));
  }
}, cleanups);

function auditRows0(userId, sinceIso, action) {
  return Number(scalar(`SELECT count(*) FROM audit.activities WHERE action_type=${lit(action)} AND performed_by=${lit(userId)} AND created_at >= ${lit(sinceIso)}::timestamptz`)) > 0;
}

t.summary();
process.exit(0);
