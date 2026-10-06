// HR Employee 360 & "My profile" (schema 1.60 – 1.64).
//
//   /hr/profile/me, PUT /me/personal, /me/contacts CRUD, /me/statutory, /me/change-requests
//   (create / list / cancel), admin /hr/profile/change-requests (list / approve / reject),
//   /hr/employees/:userId/{profile-360,notes,statutory,attendance,audit}, /hr/employees/org-chart.
//
// What this proves (every item is graded against the backend, not the HTTP code alone):
//   1. SELF-ONLY. /me routes take no id and ignore every identity the client volunteers
//      (query, body, x-user-id headers); a peer's contact id / change-request id is a 404 and
//      the row is untouched; nobody reads or writes another user's statutory / PII.
//   2. PRIVACY SHAPE. /profile/me and the 360 never carry bank / PAN / Aadhaar; the statutory
//      endpoint returns the MASKED view and `values:null` unless the caller holds
//      hr.employees.statutory.manage; reads of another person's numbers are audited.
//   3. CHANGE REQUESTS. approve APPLIES the payload to hr.employee_statutory, stamps reviewer +
//      acted_at, writes the audit row (field names only, never values); reject keeps the old
//      values; self-approval is refused; DOUBLE-APPROVE races have exactly one winner.
//   4. ISOLATION. tenant-A HR cannot reach tenant-B people (404) and a branch-A HR cannot reach a
//      branch-B colleague of the same tenant (org fence); org-chart rows are the caller's branch only.
//   5. INPUT HARDENING. impossible calendar dates, malformed ids, oversize / wrong-typed fields
//      are 4xx, never a 5xx and never leak SQL.
//
// Tenant B (MSquare) carries the full lifecycle because its HR admin shares a branch with a
// self-service employee; tenant A's hr_admin is homed in Head Office, so tenant A contributes
// the isolation / fence probes.
//
// Throwaway data: contacts E2E-people-*, change requests with reason E2E-people-*, notes E2E-people-*.
// The employee's personal + statutory rows are snapshotted (journalled) and restored.
//
//   node suites/hr/hr-profile-360.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, who, holds, guarded, otherEmployeeIn, hasProfile,
  snapshotRow, journalPurge, waitAudit, auditRows, waitFor, q, scalar, rows, lit,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR Employee 360 & My profile');
const cleanups = [];
const SELF_ONLY_RX = /"(pan|aadhaar|uan|account_number|ifsc|bank_name|tax_regime)"\s*:/i;

await guarded(async () => {
  const EMP = await open('msq_rep1');            // tenant B self-service employee
  const ADM = await open('msq_org_admin');       // tenant B HR admin (same branch as EMP)
  const ADM2 = await open('msq_tenant_admin');   // tenant B second admin (race partner)
  const MGR = await open('fitness_manager');     // tenant A self-service (Sector 69)
  const MGR2 = await open('org_manager');        // tenant A self-service, same branch as MGR
  const HRA = await open('hr_admin');            // tenant A HR admin (homed in Head Office)
  const ORG = await open('org_admin');           // tenant A, holds no HR capability
  const RO = await open('read_only');            // tenant A read-only
  if (!EMP || !ADM) { console.log('tenant B actors missing — run auth-setup'); return; }

  const e = await who(EMP), a = await who(ADM), a2 = ADM2 ? await who(ADM2) : null;
  const m = MGR ? await who(MGR) : null, h = HRA ? await who(HRA) : null;
  console.log(`EMP=${e.email} org=${e.org_id}\nADM=${a.email} org=${a.org_id}\nADM2=${a2?.email} org=${a2?.org_id}\nMGR=${m?.email} org=${m?.org_id}\nHRA=${h?.email} org=${h?.org_id}`);
  if (!hasProfile(e.id, e.org_id)) { console.log('EMP has no employee profile — aborting'); return; }

  // ── before-images (journalled) ─────────────────────────────────────────────
  const undoPersonalEmp = snapshotRow('people-personal-emp2', 'hr.employee_personal', 'user_id', e.id);
  const undoPersonalAdm = snapshotRow('people-personal-adm', 'hr.employee_personal', 'user_id', a.id);
  const undoStatEmp = snapshotRow('people-stat-emp', 'hr.employee_statutory', 'user_id', e.id);
  const undoStatAdm = snapshotRow('people-stat-adm', 'hr.employee_statutory', 'user_id', a.id);
  const preContacts = rows(`SELECT id::text, is_primary::text, is_deleted::text FROM hr.emergency_contacts WHERE user_id IN (${lit(e.id)}, ${lit(a.id)})`, ['id', 'p', 'd']);
  cleanups.push(() => {
    undoPersonalEmp(); undoPersonalAdm(); undoStatEmp(); undoStatAdm();
    q(`DELETE FROM hr.emergency_contacts WHERE user_id IN (${lit(e.id)}, ${lit(a.id)}) AND name LIKE ${lit(`${MARK}%`)}`);
    for (const c of preContacts) q(`UPDATE hr.emergency_contacts SET is_primary=${c.p}, is_deleted=${c.d} WHERE id=${lit(c.id)}`);
    q(`DELETE FROM hr.profile_change_requests WHERE reason LIKE ${lit(`${MARK}%`)}`);
    q(`DELETE FROM hr.employee_notes WHERE body LIKE ${lit(`${MARK}%`)}`);
  });
  cleanups.push(journalPurge('people-profile-purge', 'E2E profile rows', [
    `DELETE FROM hr.emergency_contacts WHERE name LIKE '${MARK}%'`,
    `DELETE FROM hr.profile_change_requests WHERE reason LIKE '${MARK}%'`,
    `DELETE FROM hr.employee_notes WHERE body LIKE '${MARK}%'`,
  ]));
  const persJson = (id) => scalar(`SELECT row_to_json(p)::text FROM hr.employee_personal p WHERE user_id=${lit(id)}`);
  const personalOf = (id) => { const j = persJson(id); return j ? JSON.parse(j) : null; };

  // ═══ 0. unauthenticated ════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['GET', '/profile/me'], ['PUT', '/profile/me/personal'], ['GET', '/profile/me/statutory'], ['GET', '/profile/change-requests'], ['GET', `/employees/${e.id}/profile-360`], ['GET', '/employees/org-chart']]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'PUT' ? '{}' : undefined, redirect: 'manual' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p} without a session`, '401', `HTTP ${r.status}`, p, 'Gateway withAuth must reject a request with no verified session.');
  }

  // ═══ 1. My profile: identity is never taken from the client ═══════════════
  console.log('\n— 1. /profile/me is self-only —');
  const me = await t.api(EMP, 'GET', '/profile/me', { expect: 'ok', label: 'EMP reads own profile' });
  t.check(me.body?.data?.header?.user_id === e.id, 'critical', 'msq_rep1', 'GET /profile/me returns the CALLER\'s profile', e.id, me.body?.data?.header?.user_id);
  t.check(!SELF_ONLY_RX.test(JSON.stringify(me.body)), 'high', 'msq_rep1', '/profile/me carries no bank/PAN/Aadhaar fields', 'no statutory keys', 'statutory-like key present', JSON.stringify(me.body).slice(0, 200), 'Statutory data lives only behind /profile/me/statutory and the masked 360 endpoint.');
  for (const [lbl, path, headers] of [
    ['query ?user_id=admin', `/profile/me?user_id=${a.id}&userId=${a.id}&org_id=${a.org_id}`, undefined],
    ['x-user-id / x-org-id headers', '/profile/me', { 'x-user-id': a.id, 'x-org-id': a.org_id, 'x-tenant-id': a.tenant_id }],
  ]) {
    const r = await t.api(EMP, 'GET', path, { headers, expect: 'ok', label: `EMP /profile/me with spoofed identity (${lbl})` });
    t.check(r.body?.data?.header?.user_id === e.id, 'critical', 'msq_rep1', `spoofed identity via ${lbl} is ignored`, `still ${e.id}`, r.body?.data?.header?.user_id, '', 'Derive the acting user from the verified session only.');
  }
  if (ORG) await t.api(ORG, 'GET', '/profile/me', { expect: 'forbidden', label: 'tenant-A org_admin (no hr.employees.profile.edit) reads /profile/me' });
  if (RO) await t.api(RO, 'GET', '/profile/me', { expect: 'forbidden', label: 'read_only reads /profile/me' });
  if (RO) await t.api(RO, 'PUT', '/profile/me/personal', { body: { preferred_name: 'x' }, expect: 'forbidden', label: 'read_only writes personal details' });

  // ═══ 2. personal details ═══════════════════════════════════════════════════
  console.log('\n— 2. PUT /profile/me/personal —');
  const admBefore = persJson(a.id);
  const since = new Date(Date.now() - 1500).toISOString();
  const xss = `${MARK}<img src=x onerror=window.__xss=1>`;
  const body = {
    preferred_name: xss, date_of_birth: '1991-02-03', gender: 'female', marital_status: 'single', blood_group: 'O+',
    nationality: 'E2E-Land', personal_email: `e2e.${STAMP}@example.test`, current_address: `${MARK} cur "q" 'a'`, permanent_address: `${MARK} perm`,
    // identity / tenancy smuggling — zod strips, nothing may land on anyone else
    user_id: a.id, org_id: a.org_id, tenant_id: a.tenant_id,
  };
  const put = await t.api(EMP, 'PUT', '/profile/me/personal', { body, expect: [204], label: 'EMP saves personal details (with smuggled user_id/org_id)' });
  const row = personalOf(e.id);
  t.check(!!row && row.preferred_name === xss && row.date_of_birth === '1991-02-03' && row.blood_group === 'O+', 'high', 'msq_rep1', 'personal details persisted verbatim in hr.employee_personal', 'row matches payload', JSON.stringify(row)?.slice(0, 200), '', 'upsertOwnPersonal must write every submitted column.');
  t.check(persJson(a.id) === admBefore, 'critical', 'msq_rep1', 'smuggled user_id did NOT touch the admin\'s personal row', 'unchanged', 'changed', '', 'upsertOwnPersonal binds user_id from ctx only.');
  t.check(row?.org_id === e.org_id || row?.org_id == null, 'high', 'msq_rep1', 'personal row keeps the caller\'s own org (smuggled org_id ignored)', e.org_id, row?.org_id);
  const aud = await waitAudit('employee_personal_updated', e.id, since);
  t.check(!!aud, 'medium', 'msq_rep1', 'employee_personal_updated audit row written', '1 row', 'none', '', 'logActivity in profile.service.savePersonal.');
  t.check(!aud || !aud.some((r) => r.meta.includes('E2E-Land') || r.meta.includes('1991')), 'high', 'msq_rep1', 'audit row records THAT it changed, never the values', 'no PII in meta', aud?.[0]?.meta?.slice(0, 120));
  const back = await t.api(EMP, 'GET', '/profile/me', { expect: 'ok', label: 'EMP re-reads personal' });
  t.check(back.body?.data?.personal?.preferred_name === xss, 'medium', 'msq_rep1', 'XSS-shaped preferred_name is stored as inert text and returned as JSON data', 'verbatim string', String(back.body?.data?.personal?.preferred_name).slice(0, 80));
  t.check(/application\/json/.test(back.headers['content-type'] ?? ''), 'medium', 'msq_rep1', 'profile API content-type is application/json', 'application/json', back.headers['content-type']);

  for (const [lbl, patch, exp] of [
    ['bad gender', { gender: 'robot' }, 'invalid'], ['bad blood group', { blood_group: 'Z+' }, 'invalid'], ['bad email', { personal_email: 'nope' }, 'invalid'],
    ['dob wrong shape', { date_of_birth: '03/02/1991' }, 'invalid'], ['dob impossible date 2026-02-31', { date_of_birth: '2026-02-31' }, 'invalid'],
    ['dob month 13', { date_of_birth: '1990-13-01' }, 'invalid'], ['address 501 chars', { current_address: 'x'.repeat(501) }, 'invalid'],
    ['name 101 chars', { preferred_name: 'y'.repeat(101) }, 'invalid'], ['numeric preferred_name', { preferred_name: 12345 }, 'invalid'],
    ['null-byte in name', { preferred_name: 'a\u0000b' }, 'notok'],
  ]) {
    const before = persJson(e.id);
    const r = await t.api(EMP, 'PUT', '/profile/me/personal', { body: patch, expect: lbl.startsWith('null-byte') ? [204, 400, 422] : exp, label: `personal: ${lbl}` });
    if (r.status >= 400) t.check(persJson(e.id) === before, 'medium', 'msq_rep1', `rejected personal save (${lbl}) leaves the row untouched`, 'unchanged', 'changed');
  }
  // empty string clears
  await t.api(EMP, 'PUT', '/profile/me/personal', { body: { preferred_name: '', nationality: '' }, expect: [204], label: 'personal: empty string clears a field' });
  const cleared = personalOf(e.id);
  t.check(cleared && cleared.preferred_name === null && cleared.nationality === null, 'low', 'msq_rep1', '"" clears a field to NULL', 'NULL', JSON.stringify(cleared)?.slice(0, 120));

  // ═══ 3. emergency contacts ═════════════════════════════════════════════════
  console.log('\n— 3. /profile/me/contacts —');
  const c1 = await t.api(EMP, 'POST', '/profile/me/contacts', { body: { name: `${MARK}-one`, relation: 'Parent', phone: '+919800000001' }, expect: [201], label: 'add first contact' });
  const id1 = c1.body?.data?.id;
  const dbc = (id) => rows(`SELECT user_id::text, is_primary::text, is_deleted::text, name FROM hr.emergency_contacts WHERE id=${lit(id)}`, ['u', 'p', 'd', 'n'])[0];
  t.check(dbc(id1)?.u === e.id && dbc(id1)?.p === 'true', 'high', 'msq_rep1', 'first contact is the caller\'s and auto-primary', 'user=EMP, primary', JSON.stringify(dbc(id1)));
  const c2 = await t.api(EMP, 'POST', '/profile/me/contacts', { body: { name: `${MARK}-two`, relation: 'Sibling', phone: '+919800000002', is_primary: true }, expect: [201], label: 'add second contact as primary' });
  const id2 = c2.body?.data?.id;
  const prim = () => Number(scalar(`SELECT count(*) FROM hr.emergency_contacts WHERE user_id=${lit(e.id)} AND is_primary AND NOT is_deleted`));
  t.check(prim() === 1 && dbc(id2)?.p === 'true' && dbc(id1)?.p === 'false', 'high', 'msq_rep1', 'promoting a contact demotes the previous primary (exactly one primary)', '1 primary = second', `primaries=${prim()}`);
  await t.api(EMP, 'PATCH', `/profile/me/contacts/${id1}`, { body: { is_primary: true, name: `${MARK}-one-renamed` }, expect: [204], label: 'PATCH contact to primary + rename' });
  t.check(dbc(id1)?.p === 'true' && dbc(id1)?.n.endsWith('renamed') && prim() === 1, 'high', 'msq_rep1', 'PATCH applied and primary moved', 'renamed + sole primary', JSON.stringify(dbc(id1)));
  // two simultaneous "make me primary" must still leave exactly one primary
  await Promise.all([
    t.api(EMP, 'PATCH', `/profile/me/contacts/${id1}`, { body: { is_primary: true }, label: 'race: primary A', allow5xx: true }),
    t.api(EMP, 'PATCH', `/profile/me/contacts/${id2}`, { body: { is_primary: true }, label: 'race: primary B', allow5xx: true }),
  ]);
  t.check(prim() === 1, 'high', 'msq_rep1', 'concurrent "make primary" PATCHes leave exactly one primary', '1', String(prim()), '', 'demote + promote in one tx; the unique index is the backstop and must map to 409 not 500.');
  for (const [lbl, b2] of [['empty name', { name: '', relation: 'x', phone: '12345' }], ['short phone', { name: 'n', relation: 'r', phone: '12' }], ['phone 21 chars', { name: 'n', relation: 'r', phone: '1'.repeat(21) }], ['name 101', { name: 'n'.repeat(101), relation: 'r', phone: '12345' }], ['no body fields', {}], ['is_primary string', { name: 'n', relation: 'r', phone: '12345', is_primary: 'yes' }]]) {
    await t.api(EMP, 'POST', '/profile/me/contacts', { body: b2, expect: 'invalid', label: `add contact: ${lbl}` });
  }
  await t.api(EMP, 'PATCH', `/profile/me/contacts/${id1}`, { body: {}, expect: 'invalid', label: 'PATCH contact with nothing to update' });
  // IDOR: admin has their own contact; EMP must not be able to touch it, and vice versa
  const ca = await t.api(ADM, 'POST', '/profile/me/contacts', { body: { name: `${MARK}-adm`, relation: 'Spouse', phone: '+919800000003' }, expect: [201], label: 'ADM adds their own contact' });
  const idA = ca.body?.data?.id;
  await t.api(EMP, 'PATCH', `/profile/me/contacts/${idA}`, { body: { name: `${MARK}-HACKED` }, expect: 'missing', label: 'IDOR: EMP edits ADM\'s contact' });
  await t.api(EMP, 'DELETE', `/profile/me/contacts/${idA}`, { expect: 'missing', label: 'IDOR: EMP deletes ADM\'s contact' });
  if (MGR) { await t.api(MGR, 'PATCH', `/profile/me/contacts/${id1}`, { body: { name: 'x1' }, expect: 'missing', label: 'cross-tenant: tenant-A MGR edits tenant-B contact' }); await t.api(MGR, 'DELETE', `/profile/me/contacts/${id1}`, { expect: 'missing', label: 'cross-tenant: tenant-A MGR deletes tenant-B contact' }); }
  t.check(dbc(idA)?.d === 'false' && dbc(idA)?.n === `${MARK}-adm` && dbc(id1)?.d === 'false', 'critical', 'msq_rep1', 'peer / cross-tenant contact IDOR left both rows untouched', 'unchanged', JSON.stringify([dbc(idA), dbc(id1)]));
  await t.api(EMP, 'PATCH', '/profile/me/contacts/not-a-uuid', { body: { name: 'z' }, expect: 'notok', label: 'PATCH contact with malformed id' });
  await t.api(EMP, 'DELETE', `/profile/me/contacts/${uuid()}`, { expect: 'missing', label: 'DELETE unknown contact id' });
  await t.api(EMP, 'DELETE', `/profile/me/contacts/${id2}`, { expect: [204], label: 'EMP removes a contact' });
  t.check(dbc(id2)?.d === 'true', 'medium', 'msq_rep1', 'DELETE is a soft delete (is_deleted)', 'true', dbc(id2)?.d);
  const after = await t.api(EMP, 'GET', '/profile/me', { expect: 'ok', label: 'EMP lists contacts' });
  const listed = (after.body?.data?.contacts ?? []).map((c) => c.id);
  t.check(!listed.includes(id2) && !listed.includes(idA) && listed.includes(id1), 'high', 'msq_rep1', 'contact list shows own live contacts only', `[${id1}]`, JSON.stringify(listed));
  await t.api(EMP, 'DELETE', `/profile/me/contacts/${id2}`, { expect: 'missing', label: 'DELETE an already-removed contact' });

  // ═══ 4. statutory: self read, change request lifecycle ═════════════════════
  console.log('\n— 4. statutory + change requests —');
  const mine0 = await t.api(EMP, 'GET', '/profile/me/statutory', { expect: 'ok', label: 'EMP reads own statutory' });
  for (const [lbl, p] of [['EMP PUTs own statutory via the HR route', { m: 'PUT', p: `/employees/${e.id}/statutory`, b: { bank_name: 'selfbank' } }], ['EMP PUTs admin\'s statutory', { m: 'PUT', p: `/employees/${a.id}/statutory`, b: { bank_name: 'x' } }], ['EMP reads admin\'s statutory', { m: 'GET', p: `/employees/${a.id}/statutory` }], ['EMP lists the HR queue', { m: 'GET', p: '/profile/change-requests' }]]) {
    await t.api(EMP, p.m, p.p, { body: p.b, expect: 'forbidden', label: lbl });
  }
  if (ORG) { await t.api(ORG, 'GET', '/profile/me/statutory', { expect: 'forbidden', label: 'tenant-A org_admin (no caps) reads /me/statutory' }); await t.api(ORG, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: 'x' } }, expect: 'forbidden', label: 'tenant-A org_admin files a change request' }); }

  const bank = `E2E-Bank-${STAMP}`;
  const PAYLOAD = { pan: 'abcde1234f', aadhaar: '1234 5678 9012', account_number: '123456789012', ifsc: 'hdfc0001234', bank_name: bank, account_type: 'savings', tax_regime: 'new' };
  for (const [lbl, pl] of [['bad PAN', { pan: 'XXXX' }], ['11-digit Aadhaar', { aadhaar: '12345678901' }], ['account 5 digits', { account_number: '12345' }], ['bad IFSC', { ifsc: 'HDFC1001234' }], ['bad account_type', { account_type: 'gold' }], ['bad tax regime', { tax_regime: 'x' }], ['empty payload', {}], ['bank_name 101 chars', { bank_name: 'b'.repeat(101) }]]) {
    await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: pl, reason: `${MARK} ${lbl}` }, expect: 'invalid', label: `change request: ${lbl}` });
  }
  t.check(Number(scalar(`SELECT count(*) FROM hr.profile_change_requests WHERE user_id=${lit(e.id)} AND status='pending' AND reason LIKE ${lit(`${MARK}%`)}`)) === 0, 'high', 'msq_rep1', 'rejected payloads created no pending request', '0', 'some');

  // cancel lifecycle
  const cr1 = await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: `${bank}-cancel` }, reason: `${MARK} cancel` }, expect: [201], label: 'EMP files a change request' });
  const rid1 = cr1.body?.data?.id;
  const crow = (id) => rows(`SELECT status, reviewer_id::text, acted_at::text, reviewer_comment, user_id::text, org_id::text, payload::text FROM hr.profile_change_requests WHERE id=${lit(id)}`, ['st', 'rev', 'at', 'cm', 'u', 'o', 'pl'])[0];
  t.check(crow(rid1)?.st === 'pending' && crow(rid1)?.u === e.id && crow(rid1)?.o === e.org_id, 'high', 'msq_rep1', 'request stored for the CALLER (user/org from the session)', 'pending, EMP, EMP org', JSON.stringify(crow(rid1)));
  await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: 'second' } }, expect: 'conflict', label: 'second pending request is refused (409)' });
  await t.api(ADM, 'POST', `/profile/me/change-requests/${rid1}/cancel`, { expect: 'missing', label: 'IDOR: ADM cancels EMP\'s request via /me/…/cancel' });
  if (MGR) await t.api(MGR, 'POST', `/profile/me/change-requests/${rid1}/cancel`, { expect: 'missing', label: 'cross-tenant: tenant-A MGR cancels tenant-B request' });
  t.check(crow(rid1)?.st === 'pending', 'critical', 'msq_rep1', 'a non-owner cancel left the request pending', 'pending', crow(rid1)?.st);
  const hisReq = await t.api(EMP, 'GET', '/profile/me/change-requests', { expect: 'ok', label: 'EMP lists own change requests' });
  t.check((hisReq.body?.data ?? []).every((r) => crow(r.id)?.u === e.id), 'critical', 'msq_rep1', '/me/change-requests lists only the caller\'s requests', 'all EMP', 'foreign row');
  await t.api(EMP, 'POST', `/profile/me/change-requests/${rid1}/cancel`, { expect: [204], label: 'EMP withdraws own request' });
  t.check(crow(rid1)?.st === 'cancelled', 'high', 'msq_rep1', 'cancel flips status to cancelled', 'cancelled', crow(rid1)?.st);
  await t.api(EMP, 'POST', `/profile/me/change-requests/${rid1}/cancel`, { expect: 'missing', label: 'cancel an already-cancelled request' });
  await t.api(ADM, 'POST', `/profile/change-requests/${rid1}/approve`, { body: {}, expect: 'conflict', label: 'approve a cancelled request (409)' });

  // approve applies + audit
  const cr2 = await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: PAYLOAD, reason: `${MARK} approve` }, expect: [201], label: 'EMP files request with full statutory payload' });
  const rid2 = cr2.body?.data?.id;
  const q1 = await t.api(ADM, 'GET', '/profile/change-requests?status=pending', { expect: 'ok', label: 'ADM lists pending requests' });
  t.check((q1.body?.data ?? []).some((r) => r.id === rid2) && (q1.body.data ?? []).every((r) => crow(r.id)?.o === a.org_id), 'critical', 'msq_org_admin', 'HR queue lists the request and only requests of the caller\'s org', 'org-fenced', 'foreign org row or missing');
  await t.api(ADM, 'GET', '/profile/change-requests?status=hacked', { expect: 'invalid', label: 'queue with unknown status filter' });
  if (HRA) { const hq = await t.api(HRA, 'GET', '/profile/change-requests?status=pending', { expect: 'ok', label: 'tenant-A HR lists its queue' }); t.check(!(hq.body?.data ?? []).some((r) => r.id === rid2), 'critical', 'hr_admin', 'tenant-A HR queue never shows a tenant-B request', 'absent', 'present'); }
  if (HRA) { await t.api(HRA, 'POST', `/profile/change-requests/${rid2}/approve`, { body: {}, expect: 'missing', label: 'cross-tenant: tenant-A HR approves tenant-B request' }); await t.api(HRA, 'POST', `/profile/change-requests/${rid2}/reject`, { body: { comment: 'no' }, expect: 'missing', label: 'cross-tenant: tenant-A HR rejects tenant-B request' }); t.check(crow(rid2)?.st === 'pending', 'critical', 'hr_admin', 'cross-tenant decide left the request pending', 'pending', crow(rid2)?.st); }
  await t.api(EMP, 'POST', `/profile/change-requests/${rid2}/approve`, { body: {}, expect: 'forbidden', label: 'EMP approves their own request' });
  await t.api(ADM, 'POST', `/profile/change-requests/${uuid()}/approve`, { body: {}, expect: 'missing', label: 'approve unknown request id' });
  await t.api(ADM, 'POST', '/profile/change-requests/not-a-uuid/approve', { body: {}, expect: 'notok', label: 'approve with a malformed id' });
  await t.api(ADM, 'POST', `/profile/change-requests/${rid2}/reject`, { body: {}, expect: 'invalid', label: 'reject without a comment' });
  const t0 = new Date(Date.now() - 1500).toISOString();
  await t.api(ADM, 'POST', `/profile/change-requests/${rid2}/approve`, { body: { comment: `${MARK} ok` }, expect: [204], label: 'ADM approves the request' });
  const st = rows(`SELECT pan, aadhaar, account_number, ifsc, bank_name, account_type, tax_regime, org_id::text FROM hr.employee_statutory WHERE user_id=${lit(e.id)} AND NOT is_deleted`, ['pan', 'aad', 'acc', 'ifsc', 'bank', 'type', 'tax', 'org'])[0];
  t.check(!!st && st.pan === 'ABCDE1234F' && st.aad === '123456789012' && st.acc === '123456789012' && st.ifsc === 'HDFC0001234' && st.bank === bank && st.org === e.org_id, 'critical', 'msq_org_admin', 'approval APPLIED the payload to hr.employee_statutory (normalised: PAN/IFSC upper-cased, Aadhaar spaces stripped)', 'row written for EMP', JSON.stringify(st), '', 'decide(): saveRow(mergeStatutory(...)) must run before status flips.');
  const cr = crow(rid2);
  t.check(cr?.st === 'approved' && cr?.rev === a.id && !!cr?.at && cr?.cm === `${MARK} ok`, 'high', 'msq_org_admin', 'request stamped approved + reviewer + acted_at + comment', 'approved by ADM', JSON.stringify(cr));
  const ap = await waitAudit('profile_change_approved', e.id, t0);
  t.check(!!ap && ap[0].by === a.id, 'high', 'msq_org_admin', 'profile_change_approved audit row written (performed_by = ADM, subject = EMP)', '1 row', JSON.stringify(ap));
  t.check(!ap || (!ap[0].meta.includes('ABCDE1234F') && !ap[0].meta.includes('123456789012') && !ap[0].meta.includes(bank)), 'critical', 'msq_org_admin', 'approval audit meta holds field NAMES, never the PAN/Aadhaar/bank values', 'no values', ap?.[0]?.meta?.slice(0, 160), '', 'changedFields() only.');
  await t.api(ADM, 'POST', `/profile/change-requests/${rid2}/approve`, { body: {}, expect: 'conflict', label: 'approve an already-approved request (409)' });
  await t.api(ADM, 'POST', `/profile/change-requests/${rid2}/reject`, { body: { comment: 'late' }, expect: 'conflict', label: 'reject an already-approved request (409)' });
  const own = await t.api(EMP, 'GET', '/profile/me/statutory', { expect: 'ok', label: 'EMP reads the now-applied statutory' });
  t.check(own.body?.data?.bank_name === bank && own.body.data.pan === 'ABCDE1234F', 'high', 'msq_rep1', 'employee sees the approved values', 'applied', JSON.stringify(own.body?.data)?.slice(0, 160));

  // admin view: masked + values, audited
  const s0 = new Date(Date.now() - 1500).toISOString();
  const sv = await t.api(ADM, 'GET', `/employees/${e.id}/statutory`, { expect: 'ok', label: 'ADM (statutory.manage) reads EMP statutory' });
  t.check(sv.body?.data?.values?.pan === 'ABCDE1234F' && /^•+/.test(sv.body?.data?.masked?.pan ?? '') && !String(sv.body?.data?.masked?.pan).includes('ABCDE') && !String(sv.body?.data?.masked?.account_number).includes('123456789012'), 'high', 'msq_org_admin', 'response carries masked numbers AND full values (manage holder only)', 'masked + values', JSON.stringify(sv.body?.data)?.slice(0, 200));
  t.check(!!(await waitAudit('statutory_viewed', e.id, s0)), 'high', 'msq_org_admin', 'reading another person\'s numbers writes a statutory_viewed audit row', '1 row', 'none', '', 'router audit(request,\'statutory_viewed\').');
  // PUT validation + effect
  for (const [lbl, b2] of [['bad PAN', { pan: 'x' }], ['bad Aadhaar', { aadhaar: 'abc' }], ['unknown account_type', { account_type: 'z' }]]) await t.api(ADM, 'PUT', `/employees/${e.id}/statutory`, { body: b2, expect: 'invalid', label: `HR statutory PUT: ${lbl}` });
  const p0 = new Date(Date.now() - 1500).toISOString();
  await t.api(ADM, 'PUT', `/employees/${e.id}/statutory`, { body: { bank_branch: `${MARK}-br`, uan: '' }, expect: [204], label: 'HR statutory PUT (partial: set branch, clear UAN)' });
  const st2 = rows(`SELECT bank_branch, uan, pan FROM hr.employee_statutory WHERE user_id=${lit(e.id)} AND NOT is_deleted`, ['br', 'uan', 'pan'])[0];
  t.check(st2?.br === `${MARK}-br` && !st2?.uan && st2?.pan === 'ABCDE1234F', 'high', 'msq_org_admin', 'partial PUT merges: set field written, "" cleared, absent field untouched', 'br set, uan null, pan kept', JSON.stringify(st2));
  const up = await waitAudit('statutory_updated', e.id, p0);
  t.check(!!up && !up[0].meta.includes(MARK), 'high', 'msq_org_admin', 'statutory_updated audit logs field names only', 'no values', up?.[0]?.meta?.slice(0, 120));
  // reject keeps values
  const cr3 = await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: `${bank}-REJECTED` }, reason: `${MARK} reject` }, expect: [201], label: 'EMP files a second request' });
  const rid3 = cr3.body?.data?.id;
  await t.api(ADM, 'POST', `/profile/change-requests/${rid3}/reject`, { body: { comment: `${MARK} nope` }, expect: [204], label: 'ADM rejects with a comment' });
  t.check(crow(rid3)?.st === 'rejected' && crow(rid3)?.cm === `${MARK} nope` && scalar(`SELECT bank_name FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`) === bank, 'high', 'msq_org_admin', 'reject stores the comment and does NOT change the numbers', 'rejected, bank unchanged', JSON.stringify(crow(rid3)));

  // self-approval refusal + double-approve race
  const own1 = await t.api(ADM, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: `${bank}-adm` }, reason: `${MARK} self` }, expect: [201], label: 'ADM files a request for themselves' });
  if (own1.body?.data?.id) {
    await t.api(ADM, 'POST', `/profile/change-requests/${own1.body.data.id}/approve`, { body: {}, expect: 'forbidden', label: 'ADM approves their OWN request' });
    await t.api(ADM, 'POST', `/profile/change-requests/${own1.body.data.id}/reject`, { body: { comment: 'self' }, expect: 'forbidden', label: 'ADM rejects their OWN request' });
    if (ADM2 && a2?.org_id === a.org_id) await t.api(ADM2, 'POST', `/profile/change-requests/${own1.body.data.id}/reject`, { body: { comment: `${MARK} cleanup` }, expect: [204], label: 'second admin decides ADM\'s request' });
    else await t.api(ADM, 'POST', `/profile/me/change-requests/${own1.body.data.id}/cancel`, { expect: [204], label: 'ADM withdraws own request' });
  }
  if (ADM2 && a2?.org_id === a.org_id) {
    console.log('\n— race: two admins approve the same request —');
    const cr4 = await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: `${bank}-race` }, reason: `${MARK} race` }, expect: [201], label: 'EMP files the race request' });
    const rid4 = cr4.body?.data?.id;
    const r0 = new Date(Date.now() - 1500).toISOString();
    const res = await Promise.all([
      t.api(ADM, 'POST', `/profile/change-requests/${rid4}/approve`, { body: {}, label: 'race approve #1 (ADM)', allow5xx: true }),
      t.api(ADM2, 'POST', `/profile/change-requests/${rid4}/approve`, { body: {}, label: 'race approve #2 (ADM2)', allow5xx: true }),
    ]);
    const ok = res.filter((r) => r.status === 204).length, conf = res.filter((r) => r.status === 409).length;
    t.check(ok === 1 && conf === 1, 'high', 'msq_org_admin + msq_tenant_admin', 'double-approve: exactly one 204 and one 409', '1×204 + 1×409', res.map((r) => r.status).join('/'), '', 'decide() takes SELECT … FOR UPDATE; the loser must see status<>pending and 409.');
    await waitFor(() => auditRows('profile_change_approved', e.id, r0).length >= 1, { timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 1500));
    t.check(auditRows('profile_change_approved', e.id, r0).length === 1, 'high', 'msq_org_admin', 'exactly ONE profile_change_approved audit row for the raced request', '1', String(auditRows('profile_change_approved', e.id, r0).length));
    t.check(scalar(`SELECT bank_name FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`) === `${bank}-race`, 'high', 'msq_org_admin', 'the raced approval applied exactly once', `${bank}-race`, scalar(`SELECT bank_name FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`));
    // approve vs reject race
    const cr5 = await t.api(EMP, 'POST', '/profile/me/change-requests', { body: { payload: { bank_name: `${bank}-ar` }, reason: `${MARK} ar` }, expect: [201], label: 'EMP files approve-vs-reject request' });
    const rid5 = cr5.body?.data?.id;
    const res2 = await Promise.all([
      t.api(ADM, 'POST', `/profile/change-requests/${rid5}/approve`, { body: {}, label: 'race approve', allow5xx: true }),
      t.api(ADM2, 'POST', `/profile/change-requests/${rid5}/reject`, { body: { comment: `${MARK} race-reject` }, label: 'race reject', allow5xx: true }),
    ]);
    const final = crow(rid5)?.st;
    const bankNow = scalar(`SELECT bank_name FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`);
    t.check(res2.filter((r) => r.status === 204).length === 1 && ((final === 'approved' && bankNow === `${bank}-ar`) || (final === 'rejected' && bankNow !== `${bank}-ar`)), 'high', 'msq_org_admin', 'approve-vs-reject race: one winner and the numbers agree with the final status', 'consistent', `${res2.map((r) => r.status)} final=${final} bank=${bankNow}`);
  } else console.log('  (ADM2 not in ADM\'s branch — double-approve race skipped)');

  // ═══ 5. Employee 360 ═══════════════════════════════════════════════════════
  console.log('\n— 5. Employee 360 —');
  const d360 = new Date(Date.now() - 1500).toISOString();
  const v = await t.api(ADM, 'GET', `/employees/${e.id}/profile-360`, { expect: 'ok', label: 'ADM opens EMP\'s 360' });
  t.check(v.body?.data?.header?.user_id === e.id && Array.isArray(v.body.data.contacts) && Array.isArray(v.body.data.notes) && Array.isArray(v.body.data.chain), 'high', 'msq_org_admin', '360 has header/personal/contacts/balances/notes/chain', 'full shape', Object.keys(v.body?.data ?? {}).join(','));
  t.check(!SELF_ONLY_RX.test(JSON.stringify(v.body)), 'critical', 'msq_org_admin', '360 payload never contains bank / PAN / Aadhaar (those only via /statutory)', 'no statutory keys', 'statutory-like key present', JSON.stringify(v.body).slice(0, 160), 'getEmployee360 must not join employee_statutory.');
  t.check(!!(await waitAudit('employee_360_viewed', e.id, d360)), 'medium', 'msq_org_admin', 'opening another person\'s 360 writes employee_360_viewed', '1 row', 'none');
  const noteBody = `${MARK} <b>note</b> "q"`;
  const n1 = await t.api(ADM, 'POST', `/employees/${e.id}/notes`, { body: { kind: 'appraisal', body: noteBody }, expect: [201], label: 'ADM adds an HR note' });
  const nrow = rows(`SELECT user_id::text, author_id::text, org_id::text, kind, body FROM hr.employee_notes WHERE id=${lit(n1.body?.data?.id ?? uuid())}`, ['u', 'au', 'o', 'k', 'b'])[0];
  t.check(nrow?.u === e.id && nrow?.au === a.id && nrow?.o === a.org_id && nrow?.k === 'appraisal' && nrow?.b === noteBody, 'high', 'msq_org_admin', 'note stored for EMP, authored by the CALLER, in the caller\'s org', 'EMP/ADM/org', JSON.stringify(nrow));
  const v2 = await t.api(ADM, 'GET', `/employees/${e.id}/profile-360`, { expect: 'ok', label: 'ADM re-opens 360' });
  t.check((v2.body?.data?.notes ?? []).some((n) => n.body === noteBody), 'medium', 'msq_org_admin', 'note shows on the 360 timeline', 'present', 'absent');
  await t.api(ADM, 'POST', `/employees/${a.id}/notes`, { body: { kind: 'note', body: `${MARK} self` }, expect: 'invalid', label: 'ADM adds a note to THEIR OWN profile' });
  for (const [lbl, b2] of [['bad kind', { kind: 'gossip', body: 'x' }], ['empty body', { kind: 'note', body: '   ' }], ['2001 chars', { kind: 'note', body: 'n'.repeat(2001) }]]) await t.api(ADM, 'POST', `/employees/${e.id}/notes`, { body: b2, expect: 'invalid', label: `note: ${lbl}` });
  await t.api(EMP, 'POST', `/employees/${e.id}/notes`, { body: { kind: 'note', body: `${MARK} x` }, expect: 'forbidden', label: 'EMP adds a note to themself' });
  await t.api(EMP, 'GET', `/employees/${a.id}/profile-360`, { expect: 'forbidden', label: 'IDOR: EMP opens ADM\'s 360' });
  await t.api(EMP, 'GET', `/employees/${e.id}/profile-360`, { expect: 'forbidden', label: 'EMP opens their OWN 360 route (no profile360.view)' });
  for (const sub of ['statutory', 'attendance?month=2026-10', 'audit']) await t.api(EMP, 'GET', `/employees/${e.id}/${sub}`, { expect: 'forbidden', label: `EMP reads /employees/<self>/${sub.split('?')[0]}` });
  if (MGR) for (const sub of ['profile-360', 'statutory', 'audit', 'attendance?month=2026-10']) await t.api(MGR, 'GET', `/employees/${e.id}/${sub}`, { expect: 'denied', label: `cross-tenant: tenant-A self-service reads tenant-B /employees/<id>/${sub.split('?')[0]}` });
  if (HRA) {
    for (const sub of ['profile-360', 'statutory', 'audit', 'attendance?month=2026-10']) {
      const r = await t.api(HRA, 'GET', `/employees/${e.id}/${sub}`, { expect: 'missing', label: `cross-tenant: tenant-A HR reads tenant-B /employees/<id>/${sub.split('?')[0]}` });
      t.check(!JSON.stringify(r.body).includes(e.email) && !JSON.stringify(r.body).includes(bank), 'critical', 'hr_admin', `no tenant-B data in the ${sub.split('?')[0]} answer`, 'none', 'leak');
    }
    await t.api(HRA, 'POST', `/employees/${e.id}/notes`, { body: { kind: 'note', body: `${MARK} xt` }, expect: 'missing', label: 'cross-tenant: tenant-A HR adds a note on a tenant-B employee' });
    await t.api(HRA, 'PUT', `/employees/${e.id}/statutory`, { body: { bank_name: 'HACK' }, expect: 'missing', label: 'cross-tenant: tenant-A HR PUTs tenant-B statutory' });
    t.check(scalar(`SELECT bank_name FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`) !== 'HACK' && Number(scalar(`SELECT count(*) FROM hr.employee_notes WHERE body=${lit(`${MARK} xt`)}`)) === 0, 'critical', 'hr_admin', 'cross-tenant writes landed nothing', 'nothing', 'a row changed');
    if (m) {
      for (const sub of ['profile-360', 'statutory', 'audit']) await t.api(HRA, 'GET', `/employees/${m.id}/${sub}`, { expect: 'missing', label: `branch fence: Head-Office HR reads Sector-69 colleague /${sub}` });
      await t.api(HRA, 'PUT', `/employees/${m.id}/statutory`, { body: { bank_name: 'HACK' }, expect: 'missing', label: 'branch fence: Head-Office HR PUTs Sector-69 statutory' });
      const hrApprove = await t.api(HRA, 'POST', `/profile/change-requests/${uuid()}/approve`, { body: {}, expect: 'missing', label: 'unknown request id as tenant-A HR' });
    }
    const ho = otherEmployeeIn(h.org_id, h.id);
    if (ho) {
      const r360 = await t.api(HRA, 'GET', `/employees/${ho}/profile-360`, { expect: 'ok', label: 'tenant-A HR opens a Head-Office employee\'s 360' });
      t.check(!SELF_ONLY_RX.test(JSON.stringify(r360.body)), 'critical', 'hr_admin', 'tenant-A 360 carries no statutory keys', 'none', 'present');
      const rs = await t.api(HRA, 'GET', `/employees/${ho}/statutory`, { expect: 'ok', label: 'tenant-A HR reads a Head-Office employee\'s statutory' });
      t.check(rs.body?.data && 'masked' in rs.body.data && 'values' in rs.body.data, 'medium', 'hr_admin', 'statutory answer always has {masked, values}', 'both keys', Object.keys(rs.body?.data ?? {}).join(','));
    }
  }
  // attendance tab
  const att = await t.api(ADM, 'GET', `/employees/${e.id}/attendance?month=${new Date().toISOString().slice(0, 7)}`, { expect: 'ok', label: 'ADM reads EMP attendance tab' });
  const month = new Date().toISOString().slice(0, 7);
  const nDb = Number(scalar(`SELECT count(*) FROM hr.attendance_days WHERE user_id=${lit(e.id)} AND work_date >= (${lit(month)}||'-01')::date AND work_date < ((${lit(month)}||'-01')::date + INTERVAL '1 month')`));
  t.check(Array.isArray(att.body?.data) && att.body.data.length === nDb, 'medium', 'msq_org_admin', 'attendance tab rows == DB rows for that person/month', String(nDb), String(att.body?.data?.length));
  for (const bad of ['2026-13', '2026-1', 'garbage', '']) await t.api(ADM, 'GET', `/employees/${e.id}/attendance?month=${encodeURIComponent(bad)}`, { expect: 'invalid', label: `attendance tab month="${bad}"` });
  await t.api(ADM, 'GET', `/employees/${e.id}/attendance`, { expect: 'invalid', label: 'attendance tab without month' });
  // audit tab
  const au = await t.api(ADM, 'GET', `/employees/${e.id}/audit`, { expect: 'ok', label: 'ADM reads EMP audit trail' });
  const items = au.body?.data ?? [];
  t.check(items.length > 0 && items.every((x) => Object.keys(x).sort().join() === 'action_type,created_at,id,performed_by_name') && !items.some((x) => /^(login|logout|account_|password)/.test(x.action_type)), 'high', 'msq_org_admin', 'audit tab = action/actor/time only, no values, no login noise', 'safe shape', JSON.stringify(items[0]), '', 'Select only action_type/performed_by/created_at; keep the login filter.');
  t.check(items.some((x) => x.action_type === 'employee_note_added') && items.some((x) => x.action_type === 'profile_change_approved'), 'medium', 'msq_org_admin', 'audit tab lists the note + approval actions that targeted EMP', 'both present', items.map((x) => x.action_type).slice(0, 8).join(','));
  // malformed ids
  for (const [mth, tail, b2] of [['GET', 'profile-360'], ['GET', 'statutory'], ['GET', 'audit'], ['GET', 'attendance?month=2026-10'], ['POST', 'notes', { kind: 'note', body: `${MARK} bad-id` }], ['PUT', 'statutory', { bank_name: 'x' }]]) {
    await t.api(ADM, mth, `/employees/not-a-uuid/${tail}`, { body: b2, expect: 'notok', label: `${mth} /employees/not-a-uuid/${tail.split('?')[0]}` });
    await t.api(ADM, mth, `/employees/${uuid()}/${tail}`, { body: b2, expect: 'missing', label: `${mth} /employees/<random uuid>/${tail.split('?')[0]}` });
  }

  // ═══ 6. org chart ══════════════════════════════════════════════════════════
  console.log('\n— 6. org chart —');
  const oc = await t.api(EMP, 'GET', '/employees/org-chart', { expect: 'ok', label: 'EMP (employees.view) reads org-chart' });
  const ocRows = oc.body?.data ?? [];
  const foreign = ocRows.filter((r) => !hasProfile(r.user_id, e.org_id));
  t.check(ocRows.length > 0 && foreign.length === 0, 'critical', 'msq_rep1', 'org-chart lists only people of the caller\'s branch', '0 foreign', `${foreign.length}/${ocRows.length} foreign`);
  t.check(ocRows.every((r) => Object.keys(r).sort().join() === 'department_name,designation_name,full_name,manager_id,user_id'), 'high', 'msq_rep1', 'org-chart rows expose name/title/reporting line only (no email, mobile, pay, personal data)', 'safe shape', Object.keys(ocRows[0] ?? {}).join(','));
  if (MGR) {
    const oa = await t.api(MGR, 'GET', '/employees/org-chart', { expect: 'ok', label: 'tenant-A employee reads org-chart' });
    const ids = new Set((oa.body?.data ?? []).map((r) => r.user_id));
    t.check(!ocRows.some((r) => ids.has(r.user_id)), 'critical', 'fitness_manager', 'org-charts of tenant A and B share no person', 'disjoint', 'overlap');
    t.check((oa.body?.data ?? []).every((r) => hasProfile(r.user_id, m.org_id)), 'critical', 'fitness_manager', 'tenant-A org-chart is the caller\'s branch only', '0 foreign', 'foreign rows');
  }
  if (ORG) await t.api(ORG, 'GET', '/employees/org-chart', { expect: 'forbidden', label: 'tenant-A org_admin (no hr.employees.view) reads org-chart' });
  if (RO) await t.api(RO, 'GET', '/employees/org-chart', { expect: 'forbidden', label: 'read_only reads org-chart' });
  await t.api(EMP, 'GET', '/employees/org-chart?org_id=' + (m?.org_id ?? uuid()), { expect: 'ok', label: 'org-chart with a smuggled org_id query' });
  const oc2 = await t.api(EMP, 'GET', '/employees/org-chart?org_id=' + (m?.org_id ?? uuid()), { label: 'org-chart smuggled org_id (re-read)' });
  t.check((oc2.body?.data ?? []).every((r) => hasProfile(r.user_id, e.org_id)), 'critical', 'msq_rep1', 'a client-supplied org_id cannot widen the org-chart', 'own branch only', 'foreign rows');
}, cleanups);

const s = t.summary();
process.exit(0);
