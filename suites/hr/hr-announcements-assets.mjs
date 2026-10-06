// HR Announcements (schema 1.63) and Assets (schema 1.63):
//   /hr/announcements{,/admin,/:id/read,/:id/publish,/:id/retire}   /hr/assets{,/mine,/:id/assign,/:id/return}
//
// Announcements — lifecycle + AUDIENCE:
//   draft is invisible to employees (list AND mark-read -> 404), publish makes it visible, expiry hides
//   it, retire removes it at once; read-marks are per user; only announcements.manage drafts / publishes /
//   retires; visibility is the caller's BRANCH only (Head-Office post is invisible to a Sector-69 employee)
//   and never crosses tenants (a foreign id on publish / retire / read is a 404 that changes nothing);
//   smuggled org_id / author_id are ignored. XSS payloads in title/body are stored verbatim as JSON text
//   and rendered ESCAPED in the dashboard UI (no element created, no script run, no dialog).
//
// Assets — inventory lifecycle + ownership:
//   create (409 on a duplicate tag, per-branch namespace), assign / return state machine (409 on
//   already-assigned / not-assigned / retired), concurrent double-assign has one winner, employee sees
//   ONLY what they hold (/mine), assignee must be an employee of the caller's branch, foreign-tenant ids
//   are 404.
//
//   node suites/hr/hr-announcements-assets.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import { openAs, APPS } from '../../lib.mjs';
import { logAction } from '../../journal.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, who, guarded, journalPurge, waitFor, q, scalar, rows, lit,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR Announcements & Assets');
const cleanups = [];
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

await guarded(async () => {
  const EMP = await open('msq_rep1'), ADM = await open('msq_org_admin'), ADM2 = await open('msq_tenant_admin');
  const MGR = await open('fitness_manager'), HRA = await open('hr_admin'), ORG = await open('org_admin'), RO = await open('read_only');
  if (!EMP || !ADM) { console.log('tenant B actors missing'); return; }
  const e = await who(EMP), a = await who(ADM), m = MGR ? await who(MGR) : null, h = HRA ? await who(HRA) : null;
  console.log(`EMP=${e.email}/${e.org_id} ADM=${a.email}/${a.org_id} MGR=${m?.email}/${m?.org_id} HRA=${h?.email}/${h?.org_id}`);

  const PURGE = [
    `DELETE FROM hr.announcement_reads WHERE announcement_id IN (SELECT id FROM hr.announcements WHERE title LIKE '${MARK}%')`,
    `DELETE FROM hr.announcements WHERE title LIKE '${MARK}%'`,
    `DELETE FROM hr.asset_assignments WHERE asset_id IN (SELECT id FROM hr.assets WHERE asset_tag LIKE '${MARK}%')`,
    `DELETE FROM hr.assets WHERE asset_tag LIKE '${MARK}%'`,
  ];
  cleanups.push(journalPurge('people-annassets-purge', 'E2E announcements / assets', PURGE));
  cleanups.push(() => { for (const s of PURGE) q(s); });

  const ann = (id) => rows(`SELECT org_id::text, author_id::text, title, body, category, is_pinned::text, published_at::text, expires_on::text, is_deleted::text FROM hr.announcements WHERE id=${lit(id)}`,
    ['o', 'au', 'title', 'body', 'cat', 'pin', 'pub', 'exp', 'del'])[0];
  const mk = async (who_, over, label, expect = [201]) => t.api(who_, 'POST', '/announcements', { body: { title: `${MARK} ${over.tag ?? 'a'}`, body: 'body text', ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'tag')) }, expect, label });
  const listIds = async (who_) => ((await t.api(who_, 'GET', '/announcements', { label: 'list announcements' })).body?.data ?? []);

  // ═══ 0. anonymous ═════════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['GET', '/announcements'], ['POST', '/announcements'], ['GET', '/announcements/admin'], ['POST', `/announcements/${uuid()}/publish`], ['GET', '/assets'], ['GET', '/assets/mine'], ['POST', `/assets/${uuid()}/assign`]]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'GET' ? undefined : '{}' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p} without a session`, '401', `HTTP ${r.status}`);
  }

  // ═══ 1. announcements: draft -> publish -> read -> retire ═════════════════
  console.log('\n— 1. announcement lifecycle —');
  const smug = { org_id: h?.org_id ?? uuid(), author_id: e.id, tenant_id: h?.tenant_id ?? uuid(), published_at: '2001-01-01T00:00:00Z', is_deleted: true };
  const dr = await mk(ADM, { tag: 'draft', publish: false, category: 'policy', is_pinned: true, ...smug }, 'ADM drafts an announcement (with smuggled org_id/author_id/published_at)');
  const did = dr.body?.data?.id;
  const d0 = ann(did);
  t.check(d0?.o === a.org_id && d0?.au === a.id && !d0?.pub && d0?.del === 'false' && d0?.cat === 'policy' && d0?.pin === 'true', 'critical', 'msq_org_admin', 'draft stored in the CALLER\'s org, authored by the caller, unpublished (smuggled fields ignored)', 'ADM org / ADM / no published_at', JSON.stringify(d0), '', 'insert takes org/author from ctx and publish only from the schema flag.');
  const eList0 = await listIds(EMP);
  t.check(!eList0.some((x) => x.id === did), 'critical', 'msq_rep1', 'an unpublished draft is invisible to employees', 'absent', 'present');
  await t.api(EMP, 'POST', `/announcements/${did}/read`, { expect: 'missing', label: 'EMP marks a DRAFT as read' });
  t.check(Number(scalar(`SELECT count(*) FROM hr.announcement_reads WHERE announcement_id=${lit(did)}`)) === 0, 'high', 'msq_rep1', 'no read-mark row was created for the draft', '0', 'row');
  const adm0 = await t.api(ADM, 'GET', '/announcements/admin', { expect: 'ok', label: 'ADM lists all (admin view)' });
  t.check((adm0.body?.data ?? []).some((x) => x.id === did && x.read_count === 0), 'high', 'msq_org_admin', 'admin view lists the draft with read_count 0', 'present', 'absent');
  t.check((adm0.body?.data ?? []).every((x) => ann(x.id)?.o === a.org_id), 'critical', 'msq_org_admin', 'admin view is the caller\'s org only', 'org-fenced', 'foreign row');
  // permissions
  for (const [mth, p, b] of [['POST', '/announcements', { title: `${MARK} x`, body: 'x' }], ['GET', '/announcements/admin'], ['POST', `/announcements/${did}/publish`], ['POST', `/announcements/${did}/retire`]]) {
    await t.api(EMP, mth, p, { body: b, expect: 'forbidden', label: `EMP ${mth} /announcements${p.replace('/announcements', '').replace(did, ':id')}` });
  }
  t.check(ann(did)?.pub == null || ann(did)?.pub === '', 'critical', 'msq_rep1', 'employee publish attempt did not publish the draft', 'still draft', ann(did)?.pub);
  if (ORG) { await t.api(ORG, 'GET', '/announcements', { expect: 'forbidden', label: 'tenant-A org_admin (no announcements cap) lists' }); await t.api(ORG, 'POST', '/announcements', { body: { title: `${MARK} x`, body: 'x' }, expect: 'forbidden', label: 'tenant-A org_admin posts' }); }
  if (RO) await t.api(RO, 'GET', '/announcements', { expect: 'forbidden', label: 'read_only lists announcements' });
  // cross-tenant attempts on the draft
  if (HRA) {
    await t.api(HRA, 'POST', `/announcements/${did}/publish`, { expect: 'missing', label: 'cross-tenant: tenant-A HR publishes a tenant-B draft' });
    await t.api(HRA, 'POST', `/announcements/${did}/retire`, { expect: 'missing', label: 'cross-tenant: tenant-A HR retires a tenant-B draft' });
    t.check(!ann(did)?.pub && ann(did)?.del === 'false', 'critical', 'hr_admin', 'cross-tenant publish/retire changed nothing', 'draft, alive', JSON.stringify(ann(did)));
    const ha = await t.api(HRA, 'GET', '/announcements/admin', { expect: 'ok', label: 'tenant-A HR admin list' });
    t.check(!(ha.body?.data ?? []).some((x) => x.id === did), 'critical', 'hr_admin', 'tenant-A admin list never shows a tenant-B announcement', 'absent', 'present');
  }
  await t.api(ADM, 'POST', `/announcements/${uuid()}/publish`, { expect: 'missing', label: 'publish an unknown id' });
  for (const act of ['publish', 'retire']) await t.api(ADM, 'POST', `/announcements/not-a-uuid/${act}`, { expect: 'notok', label: `${act} a malformed id` });
  await t.api(EMP, 'POST', '/announcements/not-a-uuid/read', { expect: 'notok', label: 'mark-read a malformed id' });
  // publish
  await t.api(ADM, 'POST', `/announcements/${did}/publish`, { expect: [204], label: 'ADM publishes the draft' });
  const pub1 = ann(did)?.pub;
  t.check(!!pub1, 'high', 'msq_org_admin', 'published_at set', 'timestamp', String(pub1));
  const eList1 = await listIds(EMP);
  const mineAnn = eList1.find((x) => x.id === did);
  t.check(!!mineAnn && mineAnn.is_read === false && mineAnn.title === ann(did).title, 'high', 'msq_rep1', 'employee now sees it, unread', 'visible, is_read=false', JSON.stringify(mineAnn));
  t.check(eList1.every((x) => ann(x.id)?.o === e.org_id), 'critical', 'msq_rep1', 'employee feed holds only the caller\'s branch', '0 foreign', 'foreign row');
  const pinned = eList1.findIndex((x) => x.is_pinned);
  t.check(pinned === -1 || eList1.slice(0, pinned + 1).every((x) => x.is_pinned), 'low', 'msq_rep1', 'pinned announcements sort first', 'pinned first', JSON.stringify(eList1.map((x) => x.is_pinned)));
  await t.api(ADM, 'POST', `/announcements/${did}/publish`, { expect: [204], label: 'publish again (idempotent)' });
  t.check(ann(did)?.pub === pub1, 'low', 'msq_org_admin', 're-publish keeps the original published_at', pub1, ann(did)?.pub);
  // read marks
  await t.api(EMP, 'POST', `/announcements/${did}/read`, { expect: [204], label: 'EMP marks it read' });
  await t.api(EMP, 'POST', `/announcements/${did}/read`, { expect: [204], label: 'EMP marks it read again (idempotent)' });
  t.check(Number(scalar(`SELECT count(*) FROM hr.announcement_reads WHERE announcement_id=${lit(did)} AND user_id=${lit(e.id)} AND org_id=${lit(e.org_id)}`)) === 1, 'high', 'msq_rep1', 'exactly one read row (caller, branch) after two marks', '1', 'other');
  t.check((await listIds(EMP)).find((x) => x.id === did)?.is_read === true, 'medium', 'msq_rep1', 'feed shows is_read=true', 'true', 'false');
  t.check((await listIds(ADM)).find((x) => x.id === did)?.is_read === false, 'high', 'msq_org_admin', 'read marks are per user (admin still sees it unread)', 'false', 'true');
  const adm1 = await t.api(ADM, 'GET', '/announcements/admin', { expect: 'ok', label: 'admin read_count' });
  t.check((adm1.body?.data ?? []).find((x) => x.id === did)?.read_count === 1, 'medium', 'msq_org_admin', 'read_count = 1', '1', String((adm1.body?.data ?? []).find((x) => x.id === did)?.read_count));
  if (MGR) {
    t.check(!(await listIds(MGR)).some((x) => x.id === did), 'critical', 'fitness_manager', 'tenant-A employee feed never shows a tenant-B announcement', 'absent', 'present');
    await t.api(MGR, 'POST', `/announcements/${did}/read`, { expect: 'missing', label: 'cross-tenant: tenant-A employee marks a tenant-B announcement read' });
    t.check(Number(scalar(`SELECT count(*) FROM hr.announcement_reads WHERE announcement_id=${lit(did)} AND user_id=${lit(m.id)}`)) === 0, 'critical', 'fitness_manager', 'no cross-tenant read row', '0', 'row');
  }
  // expiry
  const ex = await mk(ADM, { tag: 'expired', expires_on: day(-1) }, 'ADM posts an already-expired announcement');
  const ex2 = await mk(ADM, { tag: 'expires-today', expires_on: day(0) }, 'ADM posts one that expires today');
  const ex3 = await mk(ADM, { tag: 'expires-later', expires_on: day(7) }, 'ADM posts one that expires in a week');
  const feed = await listIds(EMP);
  t.check(!feed.some((x) => x.id === ex.body?.data?.id), 'high', 'msq_rep1', 'expired announcement is hidden from employees', 'absent', 'present');
  t.check(feed.some((x) => x.id === ex2.body?.data?.id) && feed.some((x) => x.id === ex3.body?.data?.id), 'medium', 'msq_rep1', 'announcements expiring today/in future are visible (expires_on inclusive)', 'present', 'absent');
  const admFeed = await t.api(ADM, 'GET', '/announcements/admin', { expect: 'ok', label: 'admin sees the expired one' });
  t.check((admFeed.body?.data ?? []).some((x) => x.id === ex.body?.data?.id), 'low', 'msq_org_admin', 'admin view still lists the expired announcement', 'present', 'absent');
  // validation
  for (const [lbl, over] of [['empty title', { title: '' }], ['whitespace body', { body: '   ' }], ['title 151', { title: 'x'.repeat(151) }], ['body 4001', { body: 'b'.repeat(4001) }], ['bad category', { category: 'gossip' }],
    ['expires_on wrong shape', { expires_on: '5/10/2030' }], ['expires_on impossible 2030-02-31', { expires_on: '2030-02-31' }], ['expires_on month 13', { expires_on: '2030-13-01' }], ['is_pinned string', { is_pinned: 'yes' }], ['publish string', { publish: 'now' }], ['title number', { title: 42 }]]) {
    await t.api(ADM, 'POST', '/announcements', { body: { title: `${MARK} v`, body: 'x', ...over }, expect: 'invalid', label: `announcement: ${lbl}` });
  }
  const big = await mk(ADM, { tag: 'max', title: `${MARK}`.padEnd(150, 'm'), body: 'b'.repeat(4000) }, 'announcement at exactly the max title/body length');
  // retire
  await t.api(ADM, 'POST', `/announcements/${did}/retire`, { expect: [204], label: 'ADM retires the announcement' });
  t.check(ann(did)?.del === 'true', 'high', 'msq_org_admin', 'retire soft-deletes', 'is_deleted', ann(did)?.del);
  t.check(!(await listIds(EMP)).some((x) => x.id === did), 'high', 'msq_rep1', 'retired announcement vanishes from the employee feed at once', 'absent', 'present');
  await t.api(EMP, 'POST', `/announcements/${did}/read`, { expect: 'missing', label: 'mark a retired announcement read' });
  await t.api(ADM, 'POST', `/announcements/${did}/retire`, { expect: 'missing', label: 'retire twice' });
  await t.api(ADM, 'POST', `/announcements/${did}/publish`, { expect: 'missing', label: 'publish a retired announcement' });
  t.check(!((await t.api(ADM, 'GET', '/announcements/admin', { label: 'admin list after retire' })).body?.data ?? []).some((x) => x.id === did), 'medium', 'msq_org_admin', 'retired announcement leaves the admin list', 'absent', 'present');

  // branch audience (tenant A): Head-Office post must not reach a Sector-69 employee
  if (HRA && MGR && h.org_id !== m.org_id) {
    const ho = await mk(HRA, { tag: 'head-office-only' }, 'tenant-A HR (Head Office) posts an announcement');
    const hoId = ho.body?.data?.id;
    t.check(!(await listIds(MGR)).some((x) => x.id === hoId), 'high', 'fitness_manager', 'a Head-Office announcement is invisible to a Sector-69 employee (audience = branch)', 'absent', 'present', '', 'announcements.org_isolation_policy keys on app.current_org_id.');
    await t.api(MGR, 'POST', `/announcements/${hoId}/read`, { expect: 'missing', label: 'branch fence: Sector-69 employee marks a Head-Office announcement read' });
    t.check(!(await listIds(EMP)).some((x) => x.id === hoId), 'critical', 'msq_rep1', 'tenant-B employee never sees a tenant-A announcement', 'absent', 'present');
    await t.api(ADM, 'POST', `/announcements/${hoId}/retire`, { expect: 'missing', label: 'cross-tenant: tenant-B HR retires a tenant-A announcement' });
    t.check(ann(hoId)?.del === 'false', 'critical', 'msq_org_admin', 'cross-tenant retire changed nothing', 'alive', ann(hoId)?.del);
    t.check(!((await t.api(ADM, 'GET', '/announcements/admin', { label: 'tenant-B admin list' })).body?.data ?? []).some((x) => x.id === hoId), 'critical', 'msq_org_admin', 'tenant-B admin list never shows a tenant-A announcement', 'absent', 'present');
  }

  // XSS payloads: stored verbatim, rendered escaped
  const XSS_T = `${MARK} <img src=x onerror=window.__xss=1> <script>window.__xss=2</script>`;
  const XSS_B = `"><svg onload=window.__xss=3> '--; <iframe srcdoc="<script>parent.__xss=4</script>"></iframe> javascript:window.__xss=5`;
  const xs = await t.api(ADM, 'POST', '/announcements', { body: { title: XSS_T.slice(0, 150), body: XSS_B, category: 'event', is_pinned: true }, expect: [201], label: 'post an XSS-payload announcement' });
  const xid = xs.body?.data?.id;
  const xrow = ann(xid);
  t.check(xrow?.title === XSS_T.slice(0, 150) && xrow?.body === XSS_B, 'medium', 'msq_org_admin', 'payload stored verbatim (output encoding, not input mangling, is the defence)', 'verbatim', JSON.stringify(xrow)?.slice(0, 160));
  const xf = await t.api(EMP, 'GET', '/announcements', { expect: 'ok', label: 'EMP fetches the XSS announcement via the API' });
  t.check(/application\/json/.test(xf.headers['content-type'] ?? '') && !/<script/i.test(String(xf.headers['content-type'])), 'medium', 'msq_rep1', 'API serves it as application/json (not HTML)', 'application/json', xf.headers['content-type']);

  // ═══ 2. assets ════════════════════════════════════════════════════════════
  console.log('\n— 2. assets —');
  const asset = (id) => rows(`SELECT org_id::text, asset_tag, name, category, status, serial_no FROM hr.assets WHERE id=${lit(id)}`, ['o', 'tag', 'name', 'cat', 'st', 'sn'])[0];
  const holder = (id) => rows(`SELECT user_id::text, org_id::text, returned_on::text FROM hr.asset_assignments WHERE asset_id=${lit(id)} ORDER BY created_at DESC`, ['u', 'o', 'ret']);
  const tag = (s) => `${MARK}-${s}`;
  const mkA = (who_, over, label, expect = [201]) => t.api(who_, 'POST', '/assets', { body: { asset_tag: tag(over.tag), name: `Laptop ${over.tag}`, category: 'laptop', ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'tag')) }, expect, label });
  const ASSET_XSS = `<img src=x onerror=window.__xss=9>`;
  const a1 = await mkA(ADM, { tag: 'A1', name: ASSET_XSS, serial_no: 'SN-<b>1</b>', notes: 'n', org_id: h?.org_id ?? uuid() }, 'ADM creates an asset (XSS-shaped name, smuggled org_id)');
  const aid = a1.body?.data?.id;
  t.check(asset(aid)?.o === a.org_id && asset(aid)?.st === 'in_stock' && asset(aid)?.name === ASSET_XSS, 'critical', 'msq_org_admin', 'asset created in the caller\'s org, in_stock, name stored verbatim', 'ADM org / in_stock', JSON.stringify(asset(aid)));
  await mkA(ADM, { tag: 'A1' }, 'duplicate asset tag in the same branch', 'conflict');
  if (HRA) {
    const x = await mkA(HRA, { tag: 'A1' }, 'tenant-A HR creates an asset with the SAME tag as a tenant-B asset', [201, 409]);
    t.check(x.status === 201, 'medium', 'hr_admin', 'asset-tag uniqueness is per branch — another tenant\'s tag must not be reported as taken', '201', `HTTP ${x.status}`, JSON.stringify(x.body), 'Unique index on (org_id, asset_tag) only; do not enforce it across orgs (it would confirm a competitor\'s tag exists).');
  }
  for (const [lbl, over] of [['empty tag', { asset_tag: '' }], ['tag 51 chars', { asset_tag: 't'.repeat(51) }], ['empty name', { name: '' }], ['name 151 chars', { name: 'n'.repeat(151) }], ['bad category', { category: 'spaceship' }], ['serial 101', { serial_no: 's'.repeat(101) }], ['notes 501', { notes: 'n'.repeat(501) }]]) {
    await t.api(ADM, 'POST', '/assets', { body: { asset_tag: tag('V'), name: 'v', category: 'other', ...over }, expect: 'invalid', label: `asset: ${lbl}` });
  }
  await t.api(EMP, 'POST', '/assets', { body: { asset_tag: tag('E'), name: 'x' }, expect: 'forbidden', label: 'EMP creates an asset' });
  await t.api(EMP, 'GET', '/assets', { expect: 'forbidden', label: 'EMP lists the full inventory' });
  if (ORG) await t.api(ORG, 'GET', '/assets/mine', { expect: 'forbidden', label: 'tenant-A org_admin (no assets cap) reads /assets/mine' });
  if (RO) await t.api(RO, 'GET', '/assets/mine', { expect: 'forbidden', label: 'read_only reads /assets/mine' });
  const inv = await t.api(ADM, 'GET', '/assets', { expect: 'ok', label: 'ADM lists inventory' });
  t.check((inv.body?.data ?? []).some((x) => x.id === aid) && (inv.body.data ?? []).every((x) => asset(x.id)?.o === a.org_id), 'critical', 'msq_org_admin', 'inventory = the caller\'s branch only', 'org-fenced', 'foreign row');
  if (HRA) t.check(!((await t.api(HRA, 'GET', '/assets', { expect: 'ok', label: 'tenant-A HR lists inventory' })).body?.data ?? []).some((x) => x.id === aid), 'critical', 'hr_admin', 'tenant-A inventory never shows a tenant-B asset', 'absent', 'present');
  // assign
  await t.api(EMP, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id }, expect: 'forbidden', label: 'EMP assigns an asset to themself' });
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: 'nope' }, expect: 'invalid', label: 'assign to a non-uuid user' });
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id, note: 'n'.repeat(301) }, expect: 'invalid', label: 'assign with a 301-char note' });
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: uuid() }, expect: 'missing', label: 'assign to an unknown user id' });
  if (m) await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: m.id }, expect: 'missing', label: 'cross-tenant: assign a tenant-B asset to a tenant-A employee' });
  await t.api(ADM, 'POST', '/assets/not-a-uuid/assign', { body: { user_id: e.id }, expect: 'notok', label: 'assign a malformed asset id' });
  if (HRA) {
    await t.api(HRA, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id }, expect: 'missing', label: 'cross-tenant: tenant-A HR assigns a tenant-B asset' });
    await t.api(HRA, 'POST', `/assets/${aid}/return`, { expect: 'missing', label: 'cross-tenant: tenant-A HR returns a tenant-B asset' });
    t.check(asset(aid)?.st === 'in_stock' && holder(aid).length === 0, 'critical', 'hr_admin', 'cross-tenant assign/return changed nothing', 'in_stock, no holder', JSON.stringify([asset(aid), holder(aid)]));
  }
  await t.api(ADM, 'POST', `/assets/${aid}/return`, { expect: 'conflict', label: 'return an asset that is in stock' });
  const as0 = new Date(Date.now() - 1500).toISOString();
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id, note: `${MARK} note` }, expect: [204], label: 'ADM assigns the asset to EMP' });
  const hd = holder(aid);
  t.check(asset(aid)?.st === 'assigned' && hd.length === 1 && hd[0].u === e.id && hd[0].o === a.org_id && !hd[0].ret, 'high', 'msq_org_admin', 'assignment row (EMP, caller\'s org, open) + status assigned', 'assigned to EMP', JSON.stringify([asset(aid)?.st, hd]));
  const mineA = await t.api(EMP, 'GET', '/assets/mine', { expect: 'ok', label: 'EMP reads /assets/mine' });
  t.check((mineA.body?.data ?? []).some((x) => x.id === aid) && (mineA.body.data ?? []).every((x) => holder(x.id).some((hh) => hh.u === e.id && !hh.ret)), 'critical', 'msq_rep1', '/assets/mine lists only what the caller currently holds', 'own assets only', JSON.stringify(mineA.body?.data)?.slice(0, 160));
  t.check(!JSON.stringify(mineA.body).includes('holder_id') && !JSON.stringify(mineA.body).includes('"notes"'), 'medium', 'msq_rep1', '/assets/mine omits inventory-wide fields (holder, notes)', 'no holder_id/notes', JSON.stringify(mineA.body?.data?.[0]));
  t.check(!((await t.api(ADM, 'GET', '/assets/mine', { expect: 'ok', label: 'ADM reads their own /assets/mine' })).body?.data ?? []).some((x) => x.id === aid), 'critical', 'msq_org_admin', 'another user\'s asset does not appear in the caller\'s /mine', 'absent', 'present');
  if (MGR) t.check(!((await t.api(MGR, 'GET', '/assets/mine', { expect: 'ok', label: 'tenant-A employee reads /assets/mine' })).body?.data ?? []).some((x) => x.id === aid), 'critical', 'fitness_manager', 'cross-tenant /mine never shows the asset', 'absent', 'present');
  const inv2 = await t.api(ADM, 'GET', '/assets', { expect: 'ok', label: 'inventory shows the holder' });
  t.check((inv2.body?.data ?? []).find((x) => x.id === aid)?.holder_id === e.id, 'medium', 'msq_org_admin', 'inventory shows the holder', e.id, String((inv2.body?.data ?? []).find((x) => x.id === aid)?.holder_id));
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: a.id }, expect: 'conflict', label: 'assign an already-assigned asset' });
  await t.api(EMP, 'POST', `/assets/${aid}/return`, { expect: 'forbidden', label: 'EMP returns (takes back) their own asset' });
  // return
  await t.api(ADM, 'POST', `/assets/${aid}/return`, { expect: [204], label: 'ADM takes the asset back' });
  const hd2 = holder(aid);
  t.check(asset(aid)?.st === 'in_stock' && hd2.length === 1 && !!hd2[0].ret, 'high', 'msq_org_admin', 'return closes the assignment and restores in_stock', 'in_stock, returned_on set', JSON.stringify([asset(aid)?.st, hd2]));
  t.check(!((await t.api(EMP, 'GET', '/assets/mine', { expect: 'ok', label: 'EMP /mine after return' })).body?.data ?? []).some((x) => x.id === aid), 'high', 'msq_rep1', 'returned asset leaves /assets/mine', 'absent', 'present');
  await t.api(ADM, 'POST', `/assets/${aid}/return`, { expect: 'conflict', label: 'return an already-returned asset' });
  // retired
  q(`UPDATE hr.assets SET status='retired' WHERE id=${lit(aid)}`);
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id }, expect: 'conflict', label: 'assign a RETIRED asset' });
  q(`UPDATE hr.assets SET status='in_stock' WHERE id=${lit(aid)}`);
  // concurrent double assign
  const rc = await mkA(ADM, { tag: 'RACE' }, 'ADM creates the race asset');
  const rid = rc.body?.data?.id;
  const res = await Promise.all([
    t.api(ADM, 'POST', `/assets/${rid}/assign`, { body: { user_id: e.id }, label: 'race assign → EMP', allow5xx: true }),
    t.api(ADM, 'POST', `/assets/${rid}/assign`, { body: { user_id: a.id }, label: 'race assign → ADM', allow5xx: true }),
  ]);
  const open_ = holder(rid).filter((x) => !x.ret);
  t.check(res.filter((r) => r.status === 204).length === 1 && res.filter((r) => r.status === 409).length === 1 && open_.length === 1, 'high', 'msq_org_admin', 'two simultaneous assigns of one asset: one 204, one 409, exactly one open holder', '1×204 + 1×409 + 1 holder', `${res.map((r) => r.status)} holders=${open_.length}`, '', 'assetInOrg() takes SELECT … FOR UPDATE; if this fails the status check races.');
  // branch fence on assign target (tenant A)
  if (HRA && m && h.org_id !== m.org_id) {
    const ha = await mkA(HRA, { tag: 'HO' }, 'tenant-A HR creates a Head-Office asset', [201, 409]);
    if (ha.body?.data?.id) await t.api(HRA, 'POST', `/assets/${ha.body.data.id}/assign`, { body: { user_id: m.id }, expect: 'missing', label: 'branch fence: assign a Head-Office asset to a Sector-69 employee' });
  }
  const audited = Number(scalar(`SELECT count(*) FROM audit.activities WHERE action_type IN ('asset_assigned','asset_returned','asset_created') AND created_at >= ${lit(as0)}::timestamptz`));
  t.check(audited >= 3 || (await waitFor(() => Number(scalar(`SELECT count(*) FROM audit.activities WHERE action_type IN ('asset_assigned','asset_returned','asset_created') AND created_at >= ${lit(as0)}::timestamptz`)) >= 3)), 'medium', 'msq_org_admin', 'asset_created / asset_assigned / asset_returned audit rows written', '>=3', String(audited));

  // ═══ 3. UI: XSS renders as text ═══════════════════════════════════════════
  console.log('\n— 3. UI: payloads render escaped —');
  // Make the asset visible to EMP so /hrms/profile can show it.
  await t.api(ADM, 'POST', `/assets/${aid}/assign`, { body: { user_id: e.id }, expect: [204], label: 'assign the XSS-named asset to EMP for the UI check' });
  const { browser, page, log } = await openAs('msq_rep1');
  try {
    const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
    for (const [lbl, path] of [['dashboard', '/dashboard'], ['profile', '/profile']]) {
      await page.goto(`${APPS['hr-web']}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1500);
      for (const tab of await page.getByRole('tab').all()) { await tab.click().catch(() => {}); await page.waitForTimeout(400); }
      const probe = await page.evaluate(() => ({ xss: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"]').length, scripts: [...document.querySelectorAll('script')].filter((s) => /__xss/.test(s.textContent || '')).length, svgs: document.querySelectorAll('svg[onload]').length, iframes: document.querySelectorAll('iframe[srcdoc]').length, text: document.body.innerText }));
      t.check(probe.xss === null && probe.imgs === 0 && probe.scripts === 0 && probe.svgs === 0 && probe.iframes === 0 && dialogs.length === 0, 'critical', 'msq_rep1', `/hrms${path}: stored XSS payloads create no element, run no script, open no dialog`, 'inert', JSON.stringify({ ...probe, text: undefined, dialogs }), '', 'Render user text as React text nodes only (never dangerouslySetInnerHTML).');
      if (lbl === 'dashboard') {
        const shown = probe.text.includes('<img src=x onerror=window.__xss=1>') || probe.text.includes('<script>window.__xss=2</script>');
        logAction({ tool: 'hr', role: 'msq_rep1', area: '/hrms/dashboard', action: 'XSS announcement rendered as literal text', method: 'UI', endpoint: 'Announcements panel', status: null, outcome: shown ? 'visible' : 'hidden', verified: shown, expected: 'literal text visible', note: shown ? '' : 'payload text not found on page (feed may be paginated)' });
        t.check(shown, 'low', 'msq_rep1', 'the dashboard shows the payload as visible literal text (escaped)', 'literal text on page', 'not found');
      }
    }
    const leaked = [...log.pageErrors, ...log.consoleErrors].filter((x) => /__xss|alert/.test(x));
    t.check(leaked.length === 0, 'medium', 'msq_rep1', 'no script error from payload execution', 'none', leaked.join(' | '));
  } finally { await browser.close(); }
}, cleanups);

t.summary();
process.exit(0);
