// HR Documents vault (schema 1.65 / 1.66): /hr/documents/{mine,admin/pending,employee/:userId,
// :id/file,:id/review,:id (DELETE),settings}.
//
// Proves, against hr.employee_documents and the audit log:
//   * UPLOAD HARDENING  type comes from the BYTES (PDF/JPG/PNG/WebP), never the file name:
//     renamed text/EXE/HTML/SVG/ZIP/GIF are refused; a PNG called x.pdf is stored as image/png;
//     the stored object key is server-generated (uuid) whatever the client-supplied name
//     ("../../etc/passwd.pdf", CRLF, <img onerror>) — those names live only in a column;
//     size limit is enforced AT the configured limit (limit OK / limit+1 refused), schema ceiling
//     (3.5 MiB) and the gateway body cap (5 MB -> 413) are clean errors; bad dates / enums / lengths are 4xx.
//   * DOWNLOAD IDOR     only the owner (documents.view) or HR in the SAME BRANCH (documents.manage) can
//     fetch the bytes; a same-branch peer, a no-capability user, another branch's HR and the other
//     TENANT's admin all get 404; headers: nosniff, private/no-store, inline filename sanitised.
//   * REVIEW            verify / reject lifecycle, reviewer stamped, double-review 409, own-document
//     review 403, concurrent verify-vs-reject has exactly one winner.
//   * DELETE            owner may remove while not verified (file erased -> 404 afterwards), verified is
//     HR-only (409 for the owner), peers/foreign tenants 404.
//   * SETTINGS          GET for any vault user, PUT only documents.manage, bounds 100 KB..3.5 MiB, the
//     write lands in the caller's branch only.
//   * AUDIT             document_uploaded / document_opened / documents_listed / document_verified|rejected /
//     document_removed rows exist and carry ids, never content.
//
//   node suites/hr/hr-documents-vault.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, who, guarded, snapshotRow, journalPurge, waitAudit, q, scalar, rows, lit,
  pdfBytes, pngBytes, jpgBytes, webpBytes, b64,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR Documents vault');
const cleanups = [];
const made = []; // { id, key }

await guarded(async () => {
  const EMP = await open('msq_rep1'), ADM = await open('msq_org_admin'), ADM2 = await open('msq_tenant_admin');
  const MGR = await open('fitness_manager'), MGR2 = await open('org_manager'), HRA = await open('hr_admin'), ORG = await open('org_admin'), RO = await open('read_only');
  if (!EMP || !ADM) { console.log('tenant B actors missing'); return; }
  const e = await who(EMP), a = await who(ADM), a2 = ADM2 ? await who(ADM2) : null, m = MGR ? await who(MGR) : null, h = HRA ? await who(HRA) : null;
  console.log(`EMP=${e.email}/${e.org_id} ADM=${a.email}/${a.org_id} MGR=${m?.email}/${m?.org_id} HRA=${h?.email}/${h?.org_id}`);

  cleanups.push(snapshotRow('people-docset-b', 'hr.document_settings', 'org_id', a.org_id));
  if (h) cleanups.push(snapshotRow('people-docset-a', 'hr.document_settings', 'org_id', h.org_id));
  const undoB = cleanups[0], undoA = h ? cleanups[1] : null; void undoB; void undoA;
  cleanups.push(journalPurge('people-docs-purge', 'E2E documents', [`DELETE FROM hr.employee_documents WHERE title LIKE '${MARK}%'`]));
  cleanups.push(async () => {
    // erase blobs via the product (owner/HR delete removes the file), then hard-delete rows
    for (const d of made) { if (scalar(`SELECT count(*) FROM hr.employee_documents WHERE id=${lit(d.id)} AND NOT is_deleted`) === '1') { await t.api(ADM, 'DELETE', `/documents/${d.id}`, { label: 'cleanup delete' }).catch(() => {}); } }
    q(`DELETE FROM hr.employee_documents WHERE title LIKE ${lit(`${MARK}%`)}`);
  });

  const upload = async (who_, over = {}, label = 'upload') => {
    const body = { category: 'id_proof', title: `${MARK} ${over.tag ?? 'doc'}`, file_name: 'e2e.pdf', data_base64: b64(pdfBytes(700)), ...over };
    delete body.tag; delete body.expect;
    const r = await t.api(who_, 'POST', '/documents/mine', { body, label, expect: over.expect ?? [201] });
    if (r.body?.data?.id) made.push({ id: r.body.data.id });
    return r;
  };
  const row = (id) => rows(`SELECT user_id::text, org_id::text, category, title, translate(file_name, E'

	', '   '), file_key, mime_type, size_bytes, status, reviewed_by::text, reviewed_at::text, review_note, is_deleted::text, expires_on::text, tax_section, amount::text FROM hr.employee_documents WHERE id=${lit(id)}`,
    ['u', 'o', 'cat', 'title', 'fn', 'key', 'mime', 'size', 'st', 'rb', 'ra', 'rn', 'del', 'exp', 'sec', 'amt'])[0];

  // ═══ 0. anonymous ═════════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['GET', '/documents/mine'], ['POST', '/documents/mine'], ['GET', `/documents/${uuid()}/file`], ['GET', '/documents/settings'], ['PUT', '/documents/settings'], ['GET', '/documents/admin/pending']]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'GET' ? undefined : '{}' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p} without a session`, '401', `HTTP ${r.status}`);
  }

  // ═══ 1. settings ══════════════════════════════════════════════════════════
  console.log('\n— 1. settings —');
  const s0 = await t.api(EMP, 'GET', '/documents/settings', { expect: 'ok', label: 'EMP reads the upload limit' });
  t.check(Number.isInteger(s0.body?.data?.max_bytes) && s0.body.data.max_bytes >= 102400, 'medium', 'msq_rep1', 'settings returns an integer max_bytes within bounds', '>=100 KB', String(s0.body?.data?.max_bytes));
  await t.api(EMP, 'PUT', '/documents/settings', { body: { max_bytes: 200000 }, expect: 'forbidden', label: 'EMP changes the upload limit' });
  if (ORG) await t.api(ORG, 'GET', '/documents/settings', { expect: 'forbidden', label: 'tenant-A org_admin (no documents cap) reads settings' });
  if (RO) await t.api(RO, 'GET', '/documents/settings', { expect: 'forbidden', label: 'read_only reads settings' });
  for (const [lbl, v] of [['99999 (below 100 KB)', 99999], ['3670017 (above 3.5 MiB)', 3670017], ['string', '300000'], ['float', 200000.5], ['null', null], ['negative', -1]]) {
    await t.api(ADM, 'PUT', '/documents/settings', { body: { max_bytes: v }, expect: 'invalid', label: `settings PUT max_bytes=${lbl}` });
  }
  await t.api(ADM, 'PUT', '/documents/settings', { body: {}, expect: 'invalid', label: 'settings PUT without max_bytes' });
  const tenantAOrgLimitBefore = h ? scalar(`SELECT max_bytes FROM hr.document_settings WHERE org_id=${lit(h.org_id)} AND NOT is_deleted`) : null;
  await t.api(ADM, 'PUT', '/documents/settings', { body: { max_bytes: 102400, org_id: h?.org_id ?? uuid() }, expect: [204], label: 'ADM sets the limit to 100 KB (with a smuggled org_id)' });
  t.check(scalar(`SELECT max_bytes FROM hr.document_settings WHERE org_id=${lit(a.org_id)} AND NOT is_deleted`) === '102400', 'high', 'msq_org_admin', 'limit stored for the caller\'s branch', '102400', 'other');
  t.check(!h || scalar(`SELECT max_bytes FROM hr.document_settings WHERE org_id=${lit(h.org_id)} AND NOT is_deleted`) === tenantAOrgLimitBefore, 'critical', 'msq_org_admin', 'a smuggled org_id did not move another tenant\'s limit', 'unchanged', 'changed');
  const s1 = await t.api(EMP, 'GET', '/documents/settings', { expect: 'ok', label: 'EMP sees the new limit' });
  t.check(s1.body?.data?.max_bytes === 102400, 'high', 'msq_rep1', 'the limit applies to the branch immediately', '102400', String(s1.body?.data?.max_bytes));
  if (MGR) { const sm = await t.api(MGR, 'GET', '/documents/settings', { expect: 'ok', label: 'tenant-A employee reads own limit' }); t.check(sm.body?.data?.max_bytes !== 102400 || tenantAOrgLimitBefore === '102400', 'critical', 'fitness_manager', 'tenant-B\'s limit does not leak into tenant A', 'not 102400', String(sm.body?.data?.max_bytes)); }

  // ═══ 2. upload hardening ══════════════════════════════════════════════════
  console.log('\n— 2. upload —');
  const at = new Date(Date.now() - 1500).toISOString();
  const okPdf = await upload(EMP, { tag: 'limit-exact', data_base64: b64(pdfBytes(102400)) }, 'upload a file exactly at the limit (100 KB)');
  await upload(EMP, { tag: 'limit-plus-1', data_base64: b64(pdfBytes(102401)), expect: 'invalid' }, 'upload limit+1 byte');
  const lim = await t.api(EMP, 'POST', '/documents/mine', { body: { category: 'other', title: `${MARK} limit-msg`, file_name: 'a.pdf', data_base64: b64(pdfBytes(150000)) }, expect: 'invalid', label: 'over-limit upload message' });
  t.check(/MB|KB|limit/i.test(JSON.stringify(lim.body)), 'low', 'msq_rep1', 'over-limit refusal explains the limit', 'mentions limit', JSON.stringify(lim.body).slice(0, 120));
  const pdfRow = row(okPdf.body?.data?.id);
  t.check(pdfRow?.u === e.id && pdfRow?.o === e.org_id && pdfRow?.st === 'pending' && pdfRow?.mime === 'application/pdf' && Number(pdfRow?.size) === 102400, 'high', 'msq_rep1', 'row: owner=caller, org=caller\'s, pending, mime from bytes, size = byte length', 'EMP/pending/pdf/102400', JSON.stringify(pdfRow));
  t.check(pdfRow?.key?.startsWith(`documents/${e.org_id}/${e.id}/`) && /\/[0-9a-f-]{36}\.pdf$/.test(pdfRow.key) && !pdfRow.key.includes('..'), 'high', 'msq_rep1', 'object key is server-generated (org/user/uuid.ext), never the client file name', 'documents/<org>/<user>/<uuid>.pdf', pdfRow?.key);
  t.check(!!(await waitAudit('document_uploaded', e.id, at)), 'medium', 'msq_rep1', 'document_uploaded audit row', '1 row', 'none');
  // restore a roomy limit for the type tests
  await t.api(ADM, 'PUT', '/documents/settings', { body: { max_bytes: 307200 }, expect: [204], label: 'ADM raises the limit to 300 KB' });

  const rejects = [
    ['plain text named .pdf', Buffer.from('hello, I am not a pdf at all'), 'a.pdf'],
    ['EXE (MZ) named .pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0)]), 'setup.pdf'],
    ['HTML+script named .png', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png'],
    ['SVG with onload named .jpg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.jpg'],
    ['ZIP/Office (PK) named .pdf', Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(200)]), 'x.pdf'],
    ['GIF named .png', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200)]), 'x.png'],
    ['PDF with leading whitespace/BOM', Buffer.concat([Buffer.from('﻿  '), pdfBytes(300)]), 'x.pdf'],
    ['4-byte truncated PDF header', Buffer.from('%PDF'), 'x.pdf'],
    ['RIFF without WEBP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]), 'x.webp'],
  ];
  for (const [lbl, buf, fname] of rejects) await upload(EMP, { tag: 'bad', file_name: fname, data_base64: b64(buf), expect: 'invalid' }, `upload refused: ${lbl}`);
  for (const [lbl, buf, fname, mime] of [['PNG called .pdf', pngBytes(500), 'photo.pdf', 'image/png'], ['JPEG called .exe', jpgBytes(500), 'run.exe', 'image/jpeg'], ['WebP', webpBytes(500), 'x.webp', 'image/webp']]) {
    const r = await upload(EMP, { tag: 'type', file_name: fname, data_base64: b64(buf) }, `upload accepted: ${lbl}`);
    t.check(row(r.body?.data?.id)?.mime === mime, 'high', 'msq_rep1', `${lbl} is stored as ${mime} (decided by bytes)`, mime, row(r.body?.data?.id)?.mime);
  }
  const poly = await upload(EMP, { tag: 'polyglot', data_base64: b64(pdfBytes(800, '<script>alert(document.domain)</script>')) }, 'upload a PDF carrying a <script> tail');
  const polyFile = await t.api(EMP, 'GET', `/documents/${poly.body?.data?.id}/file`, { raw: true, expect: 'ok', label: 'download the polyglot' });
  t.check(/application\/pdf/.test(polyFile.headers['content-type'] ?? '') && polyFile.headers['x-content-type-options'] === 'nosniff', 'high', 'msq_rep1', 'polyglot is served as application/pdf + nosniff (never as HTML)', 'pdf + nosniff', `${polyFile.headers['content-type']} / ${polyFile.headers['x-content-type-options']}`);

  const nasty = ['../../etc/passwd.pdf', 'a"b;c.pdf', '<img src=x onerror=alert(1)>.pdf', 'résumé 履歴書.pdf', 'x\r\nSet-Cookie: pwn=1.pdf', 'NUL\u0000.pdf', 'con.pdf', '.htaccess'];
  for (const fname of nasty) {
    const r = await upload(EMP, { tag: 'name', file_name: fname, expect: [201, 400, 422] }, `upload with file name ${JSON.stringify(fname).slice(0, 40)}`);
    if (r.status === 201) {
      const d = row(r.body.data.id);
      t.check(!d.key.includes('..') && !/[\r\n"<>]/.test(d.key), 'high', 'msq_rep1', `object key is clean for name ${JSON.stringify(fname).slice(0, 30)}`, 'uuid key', d.key);
      const f = await t.api(EMP, 'GET', `/documents/${r.body.data.id}/file`, { raw: true, expect: 'ok', label: `download file named ${JSON.stringify(fname).slice(0, 30)}` });
      const cd = f.headers['content-disposition'] ?? '';
      t.check(/^inline; filename="[\w.\- ]*"$/.test(cd) && !/[\r\n]/.test(cd), 'high', 'msq_rep1', `Content-Disposition is sanitised for ${JSON.stringify(fname).slice(0, 30)}`, 'inline; filename="[\\w.- ]*"', cd, '', 'safeName strips everything outside [\\w.\\- ].');
    }
  }
  const bad = [
    ['category not in enum', { category: 'passport' }], ['empty title', { title: '' }], ['whitespace title', { title: '   ' }], ['title 151 chars', { title: 'x'.repeat(151) }],
    ['file_name 201 chars', { file_name: 'f'.repeat(201) }], ['empty file_name', { file_name: '' }], ['expires_on wrong shape', { expires_on: '31-12-2030' }],
    ['expires_on impossible 2030-02-31', { expires_on: '2030-02-31' }], ['expires_on month 13', { expires_on: '2030-13-01' }], ['negative amount', { category: 'tax_proof', amount: -5 }],
    ['amount above 1e9', { category: 'tax_proof', amount: 2e9 }], ['amount as string', { category: 'tax_proof', amount: '100' }], ['tax_section 31 chars', { category: 'tax_proof', tax_section: 's'.repeat(31) }],
    ['data_base64 too short', { data_base64: 'QQ==' }], ['data_base64 not base64', { data_base64: '!!!!!!!!!!!!!!!!' }], ['data_base64 number', { data_base64: 12345678 }],
  ];
  for (const [lbl, over] of bad) await upload(EMP, { tag: 'bad', ...over, expect: 'invalid' }, `upload: ${lbl}`);
  // tax proof metadata
  const tp = await upload(EMP, { tag: 'tax', category: 'tax_proof', tax_section: '80C', amount: 12345.5, expires_on: '2031-03-31' }, 'upload a tax proof with section/amount/expiry');
  const tpr = row(tp.body?.data?.id);
  t.check(tpr?.sec === '80C' && Number(tpr?.amt) === 12345.5 && tpr?.exp === '2031-03-31', 'medium', 'msq_rep1', 'tax-proof metadata persisted', '80C/12345.5/2031-03-31', JSON.stringify(tpr));
  const nt = await upload(EMP, { tag: 'nontax', category: 'id_proof', tax_section: '80C', amount: 99 }, 'non-tax category with tax_section/amount');
  t.check(row(nt.body?.data?.id)?.sec === '' && row(nt.body?.data?.id)?.amt === '', 'low', 'msq_rep1', 'tax fields are dropped for non-tax categories', 'null/null', JSON.stringify(row(nt.body?.data?.id)));
  // identity smuggling
  const smug = await upload(EMP, { tag: 'smuggle', user_id: a.id, org_id: h?.org_id ?? uuid(), status: 'verified', reviewed_by: a.id }, 'upload with smuggled user_id/org_id/status');
  const sr = row(smug.body?.data?.id);
  t.check(sr?.u === e.id && sr?.o === e.org_id && sr?.st === 'pending' && !sr?.rb, 'critical', 'msq_rep1', 'smuggled user_id / org_id / status / reviewed_by are ignored', 'EMP/org/pending/no reviewer', JSON.stringify(sr), '', 'insert takes user_id/org_id from request.auth and relies on column defaults.');
  // oversize
  const schemaCeil = await t.api(EMP, 'POST', '/documents/mine', { body: { category: 'other', title: `${MARK} ceil`, file_name: 'big.pdf', data_base64: b64(pdfBytes(3_670_017)) }, expect: 'invalid', label: 'upload 3.5 MiB + 1 byte (schema ceiling)' });
  const huge = await t.api(EMP, 'POST', '/documents/mine', { body: { category: 'other', title: `${MARK} huge`, file_name: 'huge.pdf', data_base64: b64(pdfBytes(4_200_000)) }, expect: [413, 400], label: 'upload 4.2 MB (base64 ≈ 5.6 MB, over the gateway body cap)' });
  t.check(huge.status === 413 || huge.status === 400, 'medium', 'msq_rep1', 'a body over the 5 MB cap is a clean 413/400 JSON error', '413', String(huge.status), JSON.stringify(huge.body).slice(0, 120));
  const base64only = await t.api(EMP, 'POST', '/documents/mine', { body: 'not json at all', headers: { 'content-type': 'application/json' }, expect: 'invalid', label: 'upload with a non-JSON body' });
  // role gates on upload
  if (ORG) await t.api(ORG, 'POST', '/documents/mine', { body: { category: 'other', title: `${MARK} x`, file_name: 'x.pdf', data_base64: b64(pdfBytes(300)) }, expect: 'forbidden', label: 'tenant-A org_admin (no documents cap) uploads' });
  if (RO) await t.api(RO, 'POST', '/documents/mine', { body: { category: 'other', title: `${MARK} x`, file_name: 'x.pdf', data_base64: b64(pdfBytes(300)) }, expect: 'forbidden', label: 'read_only uploads' });

  // ═══ 3. listing / pending / per-employee ═══════════════════════════════════
  console.log('\n— 3. lists —');
  const mine = await t.api(EMP, 'GET', '/documents/mine', { expect: 'ok', label: 'EMP lists own documents' });
  t.check((mine.body?.data ?? []).length > 0 && (mine.body.data).every((d) => d.user_id === e.id), 'critical', 'msq_rep1', '/documents/mine lists only the caller\'s documents', 'all EMP', 'foreign row');
  t.check(!JSON.stringify(mine.body).includes('file_key') && !JSON.stringify(mine.body).includes('documents/'), 'high', 'msq_rep1', 'list responses never expose the storage key', 'no file_key', 'key present');
  await t.api(EMP, 'GET', `/documents/employee/${e.id}`, { expect: 'forbidden', label: 'EMP lists documents via the HR route' });
  await t.api(EMP, 'GET', '/documents/admin/pending', { expect: 'forbidden', label: 'EMP reads the HR review queue' });
  const l0 = new Date(Date.now() - 1500).toISOString();
  const emp = await t.api(ADM, 'GET', `/documents/employee/${e.id}`, { expect: 'ok', label: 'ADM lists EMP documents' });
  t.check((emp.body?.data ?? []).length > 0 && emp.body.data.every((d) => d.user_id === e.id), 'high', 'msq_org_admin', 'HR per-employee list = that employee only', 'all EMP', 'foreign row');
  t.check(!!(await waitAudit('documents_listed', e.id, l0)), 'medium', 'msq_org_admin', 'listing another person\'s documents is audited (documents_listed)', '1 row', 'none');
  const pend = await t.api(ADM, 'GET', '/documents/admin/pending', { expect: 'ok', label: 'ADM reads the review queue' });
  t.check((pend.body?.data ?? []).every((d) => d.status === 'pending' && row(d.id)?.o === a.org_id) && (pend.body.data ?? []).some((d) => d.user_id === e.id && d.user_full_name), 'high', 'msq_org_admin', 'queue = pending documents of the caller\'s branch, with owner name', 'org-fenced + pending', 'foreign/non-pending row');
  if (HRA) {
    const pa = await t.api(HRA, 'GET', '/documents/admin/pending', { expect: 'ok', label: 'tenant-A HR reads its review queue' });
    t.check(!(pa.body?.data ?? []).some((d) => d.user_id === e.id), 'critical', 'hr_admin', 'tenant-A review queue never lists a tenant-B document', 'absent', 'present');
    const x = await t.api(HRA, 'GET', `/documents/employee/${e.id}`, { expect: 'ok', label: 'cross-tenant: tenant-A HR lists a tenant-B employee\'s documents' });
    t.check(Array.isArray(x.body?.data) && x.body.data.length === 0, 'critical', 'hr_admin', 'cross-tenant per-employee list is EMPTY (org fence)', '[]', JSON.stringify(x.body?.data)?.slice(0, 120));
  }
  if (MGR2 && RO) await t.api(MGR2, 'GET', `/documents/employee/${e.id}`, { expect: 'forbidden', label: 'self-service (no manage) lists a colleague via the HR route' });

  // ═══ 4. download IDOR ═════════════════════════════════════════════════════
  console.log('\n— 4. file download —');
  const mine1 = made.find((d) => row(d.id)?.u === e.id && row(d.id)?.mime === 'application/pdf' && Number(row(d.id)?.size) === 102400);
  const f = await t.api(EMP, 'GET', `/documents/${mine1.id}/file`, { raw: true, expect: 'ok', label: 'owner downloads own file' });
  t.check(f.buf?.length === 102400 && f.buf.subarray(0, 5).toString() === '%PDF-', 'high', 'msq_rep1', 'downloaded bytes are the uploaded bytes', '102400 bytes %PDF-', `${f.buf?.length}`);
  t.check(f.headers['x-content-type-options'] === 'nosniff' && /no-store/.test(f.headers['cache-control'] ?? '') && /private/.test(f.headers['cache-control'] ?? ''), 'high', 'msq_rep1', 'file response is nosniff + private/no-store', 'nosniff, private, no-store', `${f.headers['x-content-type-options']} | ${f.headers['cache-control']}`, '', "api-gateway server.ts GET /hr/documents/:id/file calls proxyTo without options.forwardResponseHeaders, so hr-service Cache-Control: private, no-store is dropped on the way out; pass { forwardResponseHeaders: ['cache-control', 'content-disposition'] } like the avatar routes do.");
  const o0 = new Date(Date.now() - 1500).toISOString();
  const fa = await t.api(ADM, 'GET', `/documents/${mine1.id}/file`, { raw: true, expect: 'ok', label: 'HR (same branch) downloads the employee\'s file' });
  t.check(fa.buf?.length === 102400, 'high', 'msq_org_admin', 'HR gets the same bytes', '102400', String(fa.buf?.length));
  t.check(!!(await waitAudit('document_opened', e.id, o0)), 'medium', 'msq_org_admin', 'HR opening someone else\'s file writes document_opened', '1 row', 'none');
  for (const [k, lbl] of [['fitness_manager', 'tenant-A employee'], ['hr_admin', 'tenant-A HR admin'], ['org_admin', 'tenant-A org_admin (no caps)'], ['read_only', 'read_only']]) {
    const A = await open(k); if (!A) continue;
    const r = await t.api(A, 'GET', `/documents/${mine1.id}/file`, { raw: true, expect: 'missing', label: `cross-tenant IDOR: ${lbl} downloads a tenant-B document` });
    t.check(r.status !== 200 && !(r.buf?.length > 1000 && r.buf.subarray(0, 5).toString() === '%PDF-'), 'critical', k, `${lbl} got NO bytes`, '404', `HTTP ${r.status}`);
  }
  await t.api(EMP, 'GET', `/documents/${uuid()}/file`, { raw: true, expect: 'missing', label: 'download an unknown id' });
  await t.api(EMP, 'GET', '/documents/not-a-uuid/file', { raw: true, expect: 'notok', label: 'download a malformed id' });

  // same-branch peer IDOR (tenant A: fitness_manager vs org_manager)
  if (MGR && MGR2 && m.org_id === (await who(MGR2)).org_id) {
    const own = await upload(MGR, { tag: 'mgr-doc' }, 'tenant-A fitness_manager uploads a document');
    const did = own.body?.data?.id;
    if (did) {
      await t.api(MGR2, 'GET', `/documents/${did}/file`, { raw: true, expect: 'missing', label: 'same-branch peer downloads a colleague\'s document' });
      await t.api(MGR2, 'DELETE', `/documents/${did}`, { expect: 'missing', label: 'same-branch peer deletes a colleague\'s document' });
      await t.api(MGR2, 'POST', `/documents/${did}/review`, { body: { decision: 'verified' }, expect: 'forbidden', label: 'same-branch peer verifies a colleague\'s document' });
      t.check(row(did)?.st === 'pending' && row(did)?.del === 'false', 'critical', 'org_manager', 'peer IDOR attempts changed nothing', 'pending, not deleted', JSON.stringify(row(did)));
      if (HRA) {
        await t.api(HRA, 'GET', `/documents/${did}/file`, { raw: true, expect: 'missing', label: 'branch fence: Head-Office HR downloads a Sector-69 document' });
        await t.api(HRA, 'POST', `/documents/${did}/review`, { body: { decision: 'verified' }, expect: 'missing', label: 'branch fence: Head-Office HR verifies a Sector-69 document' });
        await t.api(HRA, 'DELETE', `/documents/${did}`, { expect: 'missing', label: 'branch fence: Head-Office HR deletes a Sector-69 document' });
        t.check(row(did)?.st === 'pending' && row(did)?.del === 'false', 'critical', 'hr_admin', 'cross-branch HR attempts changed nothing', 'pending, not deleted', JSON.stringify(row(did)));
      }
      await t.api(ADM, 'GET', `/documents/${did}/file`, { raw: true, expect: 'missing', label: 'cross-tenant: tenant-B HR downloads a tenant-A document' });
      await t.api(ADM, 'POST', `/documents/${did}/review`, { body: { decision: 'rejected', note: 'x' }, expect: 'missing', label: 'cross-tenant: tenant-B HR reviews a tenant-A document' });
      await t.api(ADM, 'DELETE', `/documents/${did}`, { expect: 'missing', label: 'cross-tenant: tenant-B HR deletes a tenant-A document' });
      t.check(row(did)?.st === 'pending' && row(did)?.del === 'false', 'critical', 'msq_org_admin', 'cross-tenant attempts changed nothing', 'pending, not deleted', JSON.stringify(row(did)));
      await t.api(MGR, 'DELETE', `/documents/${did}`, { expect: [204], label: 'owner removes own pending document' });
      t.check(row(did)?.del === 'true', 'high', 'fitness_manager', 'owner delete soft-deletes the row', 'is_deleted', row(did)?.del);
      await t.api(MGR, 'GET', `/documents/${did}/file`, { raw: true, expect: 'missing', label: 'removed document is gone for the owner' });
    }
  }

  // ═══ 5. review lifecycle ═════════════════════════════════════════════════
  console.log('\n— 5. review —');
  const dv = await upload(EMP, { tag: 'verify' }, 'EMP uploads a document to be verified');
  const dr = await upload(EMP, { tag: 'reject' }, 'EMP uploads a document to be rejected');
  const dv2 = dv.body.data.id, dr2 = dr.body.data.id;
  await t.api(EMP, 'POST', `/documents/${dv2}/review`, { body: { decision: 'verified' }, expect: 'forbidden', label: 'EMP verifies their own document' });
  await t.api(ADM, 'POST', `/documents/${dr2}/review`, { body: { decision: 'rejected' }, expect: 'invalid', label: 'reject without a note' });
  await t.api(ADM, 'POST', `/documents/${dr2}/review`, { body: { decision: 'maybe' }, expect: 'invalid', label: 'review with an unknown decision' });
  await t.api(ADM, 'POST', `/documents/${uuid()}/review`, { body: { decision: 'verified' }, expect: 'missing', label: 'review an unknown id' });
  await t.api(ADM, 'POST', '/documents/not-a-uuid/review', { body: { decision: 'verified' }, expect: 'notok', label: 'review a malformed id' });
  const v0 = new Date(Date.now() - 1500).toISOString();
  await t.api(ADM, 'POST', `/documents/${dv2}/review`, { body: { decision: 'verified', note: `${MARK} fine` }, expect: [204], label: 'ADM verifies' });
  const vr = row(dv2);
  t.check(vr?.st === 'verified' && vr?.rb === a.id && !!vr?.ra && vr?.rn === `${MARK} fine`, 'high', 'msq_org_admin', 'verified + reviewer + timestamp + note persisted', 'verified by ADM', JSON.stringify(vr));
  t.check(!!(await waitAudit('document_verified', e.id, v0)), 'medium', 'msq_org_admin', 'document_verified audit row', '1 row', 'none');
  await t.api(ADM, 'POST', `/documents/${dv2}/review`, { body: { decision: 'rejected', note: 'flip' }, expect: 'conflict', label: 'review an already-reviewed document (409)' });
  await t.api(ADM, 'POST', `/documents/${dr2}/review`, { body: { decision: 'rejected', note: `${MARK} blurry` }, expect: [204], label: 'ADM rejects with a note' });
  t.check(row(dr2)?.st === 'rejected' && row(dr2)?.rn === `${MARK} blurry`, 'high', 'msq_org_admin', 'rejection note stored', 'rejected + note', JSON.stringify(row(dr2)));
  t.check(!!(await waitAudit('document_rejected', e.id, v0)), 'medium', 'msq_org_admin', 'document_rejected audit row', '1 row', 'none');
  const ownA = await upload(ADM, { tag: 'adm-own' }, 'ADM uploads their own document');
  if (ownA.body?.data?.id) {
    await t.api(ADM, 'POST', `/documents/${ownA.body.data.id}/review`, { body: { decision: 'verified' }, expect: 'forbidden', label: 'ADM verifies their OWN document' });
    if (ADM2 && a2.org_id === a.org_id) await t.api(ADM2, 'POST', `/documents/${ownA.body.data.id}/review`, { body: { decision: 'verified' }, expect: [204], label: 'second admin verifies ADM\'s document' });
  }
  // race
  if (ADM2 && a2.org_id === a.org_id) {
    const dRace = (await upload(EMP, { tag: 'race' }, 'EMP uploads the race document')).body.data.id;
    const res = await Promise.all([
      t.api(ADM, 'POST', `/documents/${dRace}/review`, { body: { decision: 'verified' }, label: 'race: verify', allow5xx: true }),
      t.api(ADM2, 'POST', `/documents/${dRace}/review`, { body: { decision: 'rejected', note: 'race' }, label: 'race: reject', allow5xx: true }),
    ]);
    t.check(res.filter((r) => r.status === 204).length === 1 && res.filter((r) => r.status === 409).length === 1 && ['verified', 'rejected'].includes(row(dRace).st), 'high', 'msq_org_admin + msq_tenant_admin', 'concurrent verify-vs-reject: one 204, one 409, a single final state', '1×204 + 1×409', `${res.map((r) => r.status)} final=${row(dRace).st}`);
  }

  // ═══ 6. delete rules ═════════════════════════════════════════════════════
  console.log('\n— 6. delete —');
  await t.api(EMP, 'DELETE', `/documents/${dv2}`, { expect: 'conflict', label: 'owner removes a VERIFIED document (409, HR-only)' });
  await t.api(EMP, 'DELETE', `/documents/${dr2}`, { expect: [204], label: 'owner removes a rejected document' });
  t.check(row(dr2)?.del === 'true', 'high', 'msq_rep1', 'owner delete = soft delete', 'is_deleted', row(dr2)?.del);
  await t.api(EMP, 'GET', `/documents/${dr2}/file`, { raw: true, expect: 'missing', label: 'deleted document no longer downloadable' });
  await t.api(EMP, 'DELETE', `/documents/${dr2}`, { expect: 'missing', label: 'delete twice' });
  const d0 = new Date(Date.now() - 1500).toISOString();
  await t.api(ADM, 'DELETE', `/documents/${dv2}`, { expect: [204], label: 'HR removes a verified document' });
  t.check(!!(await waitAudit('document_removed', e.id, d0)), 'medium', 'msq_org_admin', 'document_removed audit row', '1 row', 'none');
  await t.api(ADM, 'GET', `/documents/${dv2}/file`, { raw: true, expect: 'missing', label: 'HR-removed document is gone' });
  await t.api(EMP, 'DELETE', `/documents/${uuid()}`, { expect: 'missing', label: 'delete an unknown id' });
  await t.api(EMP, 'DELETE', '/documents/not-a-uuid', { expect: 'notok', label: 'delete a malformed id' });
  if (ORG) await t.api(ORG, 'DELETE', `/documents/${mine1.id}`, { expect: 'forbidden', label: 'tenant-A org_admin (no caps) deletes a tenant-B document' });
  const stillThere = row(mine1.id);
  t.check(stillThere?.del === 'false', 'critical', 'org_admin', 'foreign delete attempts left the document alive', 'not deleted', JSON.stringify(stillThere));
}, cleanups);

t.summary();
process.exit(0);
