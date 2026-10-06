// Stitch tenant branding (schema 1.57.0): /me/branding, /me/preferences/theme,
// /tenant/branding, /sa/tenants/:id/branding(+assets, rotate-key), the public
// pre-login lookups, and the three UIs that edit it (admin-web, lookup-admin,
// auth-web login) plus the themed shell of lms/hr/todo.
//
// Authorisation model under test (branding.service.ts / branding.controller.ts):
//   * every authenticated user: GET /me/branding; theme writes need platform.appearance
//   * tenant admin: GET admin.branding.view, PUT admin.branding.manage, own tenant only
//   * super admin (rank >= 1000): /sa/* cross-tenant, assets, rotate-key
//   * anonymous: only GET /public/branding/:key (+ /assets/:slot), rate limited
//
//   P1  /me/branding for every login: shape, no-store, own-tenant data only
//   P2  /tenant/branding GET/PUT for every login, graded by LIVE capability
//   P3  /me/preferences/theme PUT/DELETE for every login + DB row + validation + tenant lock
//   P4  /sa/* for every login x (own tenant, other tenant): only super_admin may; DB untouched
//   P5  super_admin functional on tenant B: validation, uploads (type/size/SVG/slot traversal),
//       public asset headers, delete, lock enforcement, rotate-key invalidates the old link
//   P6  public routes anonymously: allow-listed fields, unknown key == default shape, rate limit
//   P7  UI: admin-web Branding, lookup-admin /sa branding+modules, auth-web login, theme applied
//       in the lms/hr/todo shells, personal theme persisted per user
//
// Everything that is changed is journalled BEFORE the change (restore-journal.json) and
// put back in finally: tenant A's branding row is snapshotted whole and re-written,
// tenant B's row is removed again when it did not exist, user_preferences rows are restored.
//
//   node suites/core/branding.mjs
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { cfg, openState, APPS, GATEWAY, GATEWAY_DIRECT, authFile, CROSS_TENANT, roleMeta } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { journalRestore, runRestore, restorePending, isDenied, leakOf } from '../../fixtures.mjs';
import { req, anon, reporter, grade, isOk, sleep, sweepPage } from '../../kit.mjs';
import fs from 'node:fs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('core', 'Tenant branding & appearance');
const { fail, log } = rep;
const STAMP = Date.now();
const MARK = `E2E${String(STAMP).slice(-7)}`;

restorePending('branding-');

// ── fixtures ─────────────────────────────────────────────────────────────────
const tenants = rows(`SELECT id, name FROM entity.tenants WHERE NOT is_deleted`, ['id', 'name']);
const TA = tenants.find((t) => t.name === 'Fitclass')?.id;
const TB = tenants.find((t) => t.name === 'MSquare Professionals')?.id;
if (!TA || !TB) { console.log('needs both Fitclass and MSquare tenants - aborting'); process.exit(0); }
const COLS = ['preset', 'seed_hex', 'font', 'default_mode', 'theme_locked', 'assets', 'product_names', 'terms', 'nav_overrides', 'public_key'];
const rowOf = (t) => rows(`SELECT ${COLS.map((c) => (['assets', 'product_names', 'terms', 'nav_overrides'].includes(c) ? `${c}::text` : `COALESCE(${c}::text,'<null>')`)).join(', ')} FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`, COLS)[0] ?? null;
const sig = (t) => scalar(`SELECT md5(row_to_json(b)::text) FROM entity.tenant_branding b WHERE tenant_id=${lit(t)}`) ?? 'none';
const pubKey = (t) => scalar(`SELECT public_key FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`);
const tenantOfEmail = (e) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(e.toLowerCase())}`);
const uidOf = (e) => scalar(`SELECT id FROM iam.users WHERE email=${lit(e.toLowerCase())}`);

const snapA = rowOf(TA);
const snapB = rowOf(TB);   // null: tenant B has no branding row today
const restoreRowSql = (t, snap) => {
  if (!snap) return [`DELETE FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`];
  return [`UPDATE entity.tenant_branding SET
    preset=${snap.preset === '<null>' ? 'NULL' : lit(snap.preset)}, seed_hex=${snap.seed_hex === '<null>' ? 'NULL' : lit(snap.seed_hex)},
    font=${snap.font === '<null>' ? 'NULL' : lit(snap.font)}, default_mode=${lit(snap.default_mode)}, theme_locked=${snap.theme_locked},
    assets=${lit(snap.assets)}::jsonb, product_names=${lit(snap.product_names)}::jsonb, terms=${lit(snap.terms)}::jsonb,
    nav_overrides=${lit(snap.nav_overrides)}::jsonb, public_key=${lit(snap.public_key)}::uuid
    WHERE tenant_id=${lit(t)}`];
};
const keyA = snapA?.public_key ?? null;

// Actors: every role ladder login + tenant B's three.
const ACTORS = [
  ...cfg.roles.map((r) => ({ key: r.role, email: r.email, role: r.role })),
  ...CROSS_TENANT.map((c) => ({ key: c.stateKey, email: c.email, role: c.role })),
].filter((a) => fs.existsSync(authFile(a.key)));
for (const a of ACTORS) { a.tenant = tenantOfEmail(a.email); a.uid = uidOf(a.email); a.other = a.tenant === TA ? TB : TA; }

// user_preferences snapshot (restore exactly)
const prefSnap = new Map(rows(`SELECT user_id, COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id IN (${ACTORS.map((a) => lit(a.uid)).join(',')})`, ['u', 't']).map((r) => [r.u, r.t]));
const prefSql = [];
for (const a of ACTORS) {
  prefSql.push(`DELETE FROM iam.user_preferences WHERE user_id=${lit(a.uid)}`);
  if (prefSnap.has(a.uid)) {
    const t = prefSnap.get(a.uid);
    prefSql.push(`INSERT INTO iam.user_preferences (user_id, tenant_id, theme) VALUES (${lit(a.uid)}, ${lit(a.tenant)}, ${t === '<null>' ? 'NULL' : `${lit(t)}::jsonb`})`);
  }
}
journalRestore('branding-A', 'tenant A branding row', restoreRowSql(TA, snapA));
journalRestore('branding-B', 'tenant B branding row', restoreRowSql(TB, snapB));
journalRestore('branding-prefs', 'user_preferences of every actor', prefSql);
// Prove the restore SQL for A works NOW (it is a no-op write), so a failure surfaces before anything is changed.
try { for (const s of restoreRowSql(TA, snapA)) q(s); console.log('restore SQL for tenant A verified (no-op replay)'); }
catch (e) { console.log(`!! restore SQL for tenant A failed: ${String(e.message).split('\n')[0]} - aborting before any change`); process.exit(1); }

const restoreTenants = () => { for (const s of restoreRowSql(TA, snapA)) q(s); for (const s of restoreRowSql(TB, snapB)) q(s); };

// ── asset byte factories ─────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 0x7c; raw[o + 1] = 0x3a; raw[o + 2] = 0xed; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (buf) => Buffer.from(buf).toString('base64');
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (inner, attrs = '') => `<svg ${SVG_NS} viewBox="0 0 10 10" ${attrs}>${inner}</svg>`;
const SVG_OK = svg('<rect width="10" height="10" fill="#e11d48"/>');
const PNG_SMALL = png(32, 32);

// ── helpers around the SA upload endpoint ────────────────────────────────────
const SA = (t, tail = '') => `${GATEWAY}/sa/tenants/${t}/branding${tail}`;
const upload = (a, t, slot, data) => req(a, 'POST', SA(t, `/assets/${slot}`), { data: { data } });
const pubUrl = (key, tail = '') => `${GATEWAY}/public/branding/${key}${tail}`;

// ── per-actor pass: P1-P4 ────────────────────────────────────────────────────
const caps = new Map();
const probeResults = {};
async function actorPass(A) {
  const a = await actor(A.key);
  try {
    const c = await sessionCaps(a); caps.set(A.key, c);
    const has = (k) => (c ? c.has(k) : null);
    const own = A.tenant, other = A.other;
    const ownKey = pubKey(own), otherKey = pubKey(other);

    // P1 /me/branding
    const me = await req(a, 'GET', `${GATEWAY}/me/branding`);
    const d = me.body?.data;
    const shapeOk = d && d.theme && 'locked' in d.theme && typeof d.assets === 'object' && 'public_key' in d;
    const leaksOther = (otherKey && me.text.includes(otherKey)) || me.text.includes(other);
    const keyOk = d && (d.public_key ?? null) === (ownKey ?? null);
    log({ role: A.key, action: 'GET /me/branding', method: 'GET', endpoint: '/me/branding', status: me.status, verified: !!shapeOk && !leaksOther && keyOk, expected: 'own tenant branding, no-store' });
    if (me.status !== 200) fail('high', A.key, 'GET /me/branding fails for an authenticated user', '200 (every user needs it to render the themed shell)', `HTTP ${me.status}`, me.text.slice(0, 200), 'Check branding.repository.getOwnBranding under the role context.');
    else {
      if (!shapeOk) fail('medium', A.key, '/me/branding response shape', '{theme:{tenant,user,locked}, personal, product_names, terms, nav_overrides, assets, public_key}', me.text.slice(0, 160), me.text.slice(0, 300), 'Keep getMyBranding() stable; every app layout depends on it.');
      if (leaksOther) fail('critical', A.key, '/me/branding leaks the OTHER tenant\'s branding', 'Only the caller\'s tenant row', 'other tenant id / login key present in the body', me.text.slice(0, 300), 'RLS on entity.tenant_branding must pin the session tenant.');
      if (!keyOk) fail('high', A.key, '/me/branding returns another tenant\'s login key', `public_key == ${ownKey}`, String(d?.public_key), me.text.slice(0, 200), 'Own-tenant RLS read returned a foreign row.');
      if (!/no-store/i.test(me.headers['cache-control'] ?? '') && !globalThis.__cacheNoted) { globalThis.__cacheNoted = true; fail('low', A.key, '/me/branding is cacheable', 'Cache-Control: private, no-store', me.headers['cache-control'] ?? '(none)', '', 'identity-service sets private,no-store but the gateway proxy drops it (server.ts /me/branding has no forwardResponseHeaders cache-control); forward it so a shared proxy never caches a per-user payload. Seen for every login.'); }
      const lk = leakOf(me.body); if (lk) fail('medium', A.key, '/me/branding leaks backend internals', 'none', lk, '', 'Strip internals.');
    }

    // P2 /tenant/branding
    const tg = await req(a, 'GET', `${GATEWAY}/tenant/branding`);
    grade(rep, { role: A.key, scenario: 'GET /tenant/branding', has: has('admin.branding.view'), status: tg.status, endpoint: '/tenant/branding', evidence: tg.text.slice(0, 200), fixOver: 'getTenantBranding must requireCap(ADMIN_BRANDING_VIEW).', fixUnder: 'Role holds admin.branding.view but the service refused.' });
    if (tg.status === 200) {
      if ((otherKey && tg.text.includes(otherKey)) || tg.text.includes(other)) fail('critical', A.key, 'GET /tenant/branding returned foreign-tenant data', 'own tenant only', 'foreign id/key in body', tg.text.slice(0, 200), 'RLS on tenant_branding.');
      if (/"key"\s*:\s*"brand\//.test(tg.text)) fail('medium', A.key, 'GET /tenant/branding exposes blob storage keys', 'asset_meta shows content_type/bytes/updated_at only', 'brand/<tenant>/... key present', tg.text.slice(0, 200), 'assetMeta() must never return the storage key.');
    }
    const termsBefore = rowOf(own)?.terms ?? '{}';
    const tp = await req(a, 'PUT', `${GATEWAY}/tenant/branding`, { data: { terms: { leads: MARK } } });
    const landed = (rowOf(own)?.terms ?? '').includes(MARK);
    grade(rep, { role: A.key, scenario: 'PUT /tenant/branding (rename a term)', has: has('admin.branding.manage'), status: tp.status, effect: landed, method: 'PUT', endpoint: '/tenant/branding', evidence: tp.text.slice(0, 200), fixOver: 'updateTenantBranding must requireCap(ADMIN_BRANDING_MANAGE, fresh).' });
    // the OTHER tenant must never change from a PUT by this actor
    if ((rowOf(other)?.terms ?? '').includes(MARK)) fail('critical', A.key, 'PUT /tenant/branding wrote to the OTHER tenant', 'own tenant only', 'foreign terms changed', `other=${other}`, 'tenantId must come from the session; RLS WITH CHECK must refuse.');
    if (landed) { if (rowOf(own)) q(`UPDATE entity.tenant_branding SET terms=${lit(termsBefore)}::jsonb WHERE tenant_id=${lit(own)}`); }
    // body-supplied tenant (strict schema must refuse)
    const spoof = await req(a, 'PUT', `${GATEWAY}/tenant/branding`, { data: { tenant_id: other, terms: { leads: `${MARK}x` } } });
    const spoofLanded = (rowOf(other)?.terms ?? '').includes(`${MARK}x`) || (rowOf(own)?.terms ?? '').includes(`${MARK}x`);
    log({ role: A.key, action: 'PUT /tenant/branding with a client-supplied tenant_id', method: 'PUT', endpoint: '/tenant/branding', status: spoof.status, verified: !spoofLanded, expected: '4xx; tenant never taken from the body' });
    if (isOk(spoof.status) || spoofLanded) fail('critical', A.key, 'PUT /tenant/branding honours a client-supplied tenant_id', '422 (strict schema) and nothing written', `HTTP ${spoof.status}, landed=${spoofLanded}`, spoof.text.slice(0, 200), 'Keep tenantBrandingUpdateSchema .strict(); tenant only from request.auth.');
    if (rowOf(own)) q(`UPDATE entity.tenant_branding SET terms=${lit(termsBefore)}::jsonb WHERE tenant_id=${lit(own)}`);
    if (own === TB && !snapB) q(`DELETE FROM entity.tenant_branding WHERE tenant_id=${lit(TB)}`);

    // P3 /me/preferences/theme
    const tpPut = await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { preset: 'royal-violet', font: 'manrope', mode: 'dark' } });
    const prefRow = scalar(`SELECT theme::text FROM iam.user_preferences WHERE user_id=${lit(A.uid)}`);
    const persisted = !!prefRow && /royal-violet/.test(prefRow);
    grade(rep, { role: A.key, scenario: 'PUT /me/preferences/theme', has: has('platform.appearance'), status: tpPut.status, effect: persisted, method: 'PUT', endpoint: '/me/preferences/theme', evidence: `${tpPut.text.slice(0, 160)} row=${prefRow}`, fixOver: 'updateMyTheme must requireCap(PLATFORM_APPEARANCE).' });
    if (isOk(tpPut.status)) {
      const after = await req(a, 'GET', `${GATEWAY}/me/branding`);
      const t = after.body?.data?.theme;
      const locked = t?.locked;
      const u = t?.user ?? {};
      if (locked && (u.preset || u.font || u.seed_hex)) fail('high', A.key, 'Tenant theme is LOCKED yet /me/branding still returns the user\'s colour/font override', 'user layer carries only {mode} while locked', JSON.stringify(u), after.text.slice(0, 200), 'getMyBranding must strip preset/seed_hex/font from the user layer when theme_locked.');
      if (!locked && u.preset !== 'royal-violet') fail('medium', A.key, 'Saved personal theme is not reflected in /me/branding', 'theme.user.preset == royal-violet', JSON.stringify(u), after.text.slice(0, 200), 'getMyBranding reads iam.user_preferences.theme.');
      log({ role: A.key, action: 'personal theme persists and is layered (lock respected)', method: 'GET', endpoint: '/me/branding', status: after.status, verified: locked ? !(u.preset || u.font) : u.preset === 'royal-violet', expected: 'persisted per user' });
      // only OWN preferences row may have changed
      const foreign = Number(scalar(`SELECT COUNT(*) FROM iam.user_preferences WHERE theme::text LIKE '%royal-violet%' AND user_id IN (${ACTORS.filter((x) => x !== A && !(prefSnap.get(x.uid) ?? '').includes('royal-violet')).map((x) => lit(x.uid)).join(',')})`));
      if (foreign > 0) fail('critical', A.key, 'A user\'s theme write changed ANOTHER user\'s preferences', 'only the caller\'s row', `${foreign} foreign rows carry the value`, '', 'setOwnTheme must pin user_id to the session.');
    }
    // validation: all must be 4xx and write nothing
    const bad = {
      'foreign user_id in body': { user_id: ACTORS.find((x) => x !== A)?.uid, mode: 'dark' },
      'foreign tenant_id in body': { tenant_id: other, mode: 'dark' },
      'unknown preset': { preset: 'neon-pwn' },
      'bad hex': { seed_hex: 'red' },
      'markup in hex': { seed_hex: '<script>alert(1)</script>' },
      'unknown font': { font: 'comic-sans' },
      'unknown mode': { mode: 'neon' },
    };
    const before = scalar(`SELECT COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id=${lit(A.uid)}`) ?? '<none>';
    const accepted = [];
    for (const [name, body] of Object.entries(bad)) {
      const r = await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: body });
      if (isOk(r.status)) accepted.push(name);
      else if (r.status >= 500) fail('medium', A.key, `PUT /me/preferences/theme (${name}) 5xx`, '422', `HTTP ${r.status}`, r.text.slice(0, 200), 'Validate before touching the DB.');
    }
    const afterBad = scalar(`SELECT COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id=${lit(A.uid)}`) ?? '<none>';
    if (has('platform.appearance') && accepted.length) fail('high', A.key, `Theme write accepted invalid/forged input: ${accepted.join(', ')}`, '422 for every one (userThemeUpdateSchema is strict)', accepted.join(', '), `before=${before} after=${afterBad}`, 'Keep the strict zod schema in front of setOwnTheme.');
    log({ role: A.key, action: 'theme write rejects forged/invalid bodies', method: 'PUT', endpoint: '/me/preferences/theme', status: accepted.length ? 200 : 422, verified: accepted.length === 0, expected: '422 x7' });
    const clr = await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`);
    const cleared = scalar(`SELECT COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id=${lit(A.uid)}`);
    grade(rep, { role: A.key, scenario: 'DELETE /me/preferences/theme', has: has('platform.appearance'), status: clr.status, effect: cleared === '<null>' || cleared === null, method: 'DELETE', endpoint: '/me/preferences/theme', evidence: `row=${cleared}` });

    // P4 super-admin surface, own + other tenant
    const isSA = A.key === 'super_admin';
    for (const [lbl, t] of [['own tenant', own], ['other tenant', other]]) {
      const g = await req(a, 'GET', SA(t));
      grade(rep, { role: A.key, scenario: `GET /sa/tenants/<${lbl}>/branding`, has: isSA, status: g.status, endpoint: '/sa/tenants/:id/branding', evidence: g.text.slice(0, 160), fixOver: 'requireSuperAdmin(request) must run before saGetBranding.', sevOver: 'critical' });
      if (g.status === 200 && !isSA) continue;
      if (isSA) { const lk = leakOf(g.body); if (lk) fail('medium', A.key, 'SA branding GET leaks internals', 'none', lk, '', ''); continue; }
      const sg0 = sig(t);
      const writes = [
        ['PUT product_names', 'PUT', SA(t), { product_names: { brand: { name: `${MARK}-HIJACK` } } }],
        ['PUT theme_locked', 'PUT', SA(t), { theme_locked: !(snapA?.theme_locked === 'true' || snapA?.theme_locked === true) }],
        ['POST asset logo', 'POST', SA(t, '/assets/logo'), { data: b64(PNG_SMALL) }],
        ['DELETE asset logo', 'DELETE', SA(t, '/assets/logo'), undefined],
        ['POST rotate-key', 'POST', SA(t, '/rotate-key'), undefined],
      ];
      for (const [name, m, url, body] of writes) {
        const r = await req(a, m, url, body === undefined ? {} : { data: body });
        const changed = sig(t) !== sg0;
        grade(rep, { role: A.key, scenario: `${name} on ${lbl}`, has: false, status: r.status, effect: changed, method: m, endpoint: url.replace(GATEWAY, '').replace(/[0-9a-f-]{36}/, ':id'), evidence: r.text.slice(0, 160), fixOver: 'requireSuperAdmin(request) must run first in every sa* handler.', sevOver: 'critical' });
        if (changed) { for (const s of restoreRowSql(TA, snapA)) q(s); for (const s of restoreRowSql(TB, snapB)) q(s); }
      }
    }
    probeResults[A.key] = { caps: c ? ['platform.appearance', 'admin.branding.view', 'admin.branding.manage'].filter((k) => c.has(k)) : null };
  } finally { await a.close(); }
}

// ── P5 super_admin functional (tenant B) ─────────────────────────────────────
async function superAdminFunctional() {
  console.log('\n== P5 super_admin functional on tenant B ==');
  const sa = await actor('super_admin');
  const anonA = await anon();
  const who = 'super_admin';
  try {
    // 5a GET + 404/422 targets
    const g = await req(sa, 'GET', SA(TA));
    log({ role: who, action: 'SA GET tenant A branding', method: 'GET', endpoint: '/sa/tenants/:id/branding', status: g.status, verified: g.status === 200 && g.body?.data?.tenant_name === 'Fitclass', expected: 'cross-tenant read by design' });
    if (g.status !== 200) fail('high', who, 'Super admin cannot read tenant A branding', '200', `HTTP ${g.status}`, g.text.slice(0, 200), 'saGetBranding.');
    const nf = await req(sa, 'GET', SA('00000000-0000-4000-8000-000000000000'));
    const mal = await req(sa, 'GET', SA('not-a-uuid'));
    const trav = await req(sa, 'GET', `${GATEWAY}/sa/tenants/..%2F..%2Fme/branding`);
    for (const [n, r, want] of [['unknown tenant', nf, [404]], ['malformed id', mal, [400, 422]], ['path-traversal id', trav, [400, 404, 422]]]) {
      log({ role: who, action: `SA GET with ${n}`, method: 'GET', endpoint: '/sa/tenants/:id/branding', status: r.status, verified: want.includes(r.status), expected: want.join('/') });
      if (!want.includes(r.status)) fail(r.status >= 500 ? 'high' : 'low', who, `SA branding GET with ${n}`, want.join('/'), `HTTP ${r.status}`, r.text.slice(0, 200), 'Validate the :id param (uuid) and map missing tenants to 404.');
    }

    // 5b SA PUT validation on B
    const validations = {
      'unknown field (strict)': { evil: 1 },
      'bad preset': { preset: 'nope' },
      'bad seed': { seed_hex: '#12345' },
      'markup in brand name': { product_names: { brand: { name: '<img src=x onerror=alert(1)>' } } },
      'brace in product title': { product_names: { lms: { title: 'x{{7*7}}' } } },
      'over-long short name': { product_names: { lms: { short: 'ThirteenChars' } } },
      'unknown product key': { product_names: { crm: { title: 'x' } } },
      'bad default_mode': { default_mode: 'neon' },
      'non-boolean lock': { theme_locked: 'yes' },
    };
    const sB0 = sig(TB);
    for (const [n, body] of Object.entries(validations)) {
      const r = await req(sa, 'PUT', SA(TB), { data: body });
      const ok = r.status === 422 || r.status === 400;
      log({ role: who, action: `SA PUT rejects ${n}`, method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: r.status, verified: ok, expected: '422' });
      if (!ok) fail(r.status >= 500 ? 'high' : 'high', who, `SA branding PUT accepted/crashed on: ${n}`, '422 and nothing stored', `HTTP ${r.status}`, r.text.slice(0, 200), 'saBrandingUpdateSchema must stay strict and bounded.');
    }
    if (sig(TB) !== sB0) fail('high', who, 'Rejected SA PUTs still changed the branding row', 'unchanged', 'row signature changed', '', 'Validation must precede the upsert.');

    // 5c happy path: theme + product names + lock
    const put = await req(sa, 'PUT', SA(TB), { data: { preset: 'electric-amber', font: 'outfit', default_mode: 'light', theme_locked: false, product_names: { brand: { name: `${MARK} Corp` }, task: { title: `${MARK} Tasks`, switcher: 'Work', short: 'Work' } } } });
    const r1 = rowOf(TB);
    const okPut = put.status === 200 && r1?.preset === 'electric-amber' && /E2E/.test(r1.product_names);
    log({ role: who, action: 'SA PUT theme + product names on tenant B', method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: put.status, verified: okPut, expected: 'row written' });
    if (!okPut) fail('high', who, 'Super admin cannot save tenant B branding', '200 and the row reflects it', `HTTP ${put.status} row=${JSON.stringify(r1)?.slice(0, 160)}`, put.text.slice(0, 200), 'saUpdateBranding / upsertBrandingAsService.');

    // 5d lock enforcement for the tenant admin of B
    const tadm = await actor('msq_tenant_admin');
    try {
      const lockOn = await req(sa, 'PUT', SA(TB), { data: { theme_locked: true } });
      const blocked = await req(tadm, 'PUT', `${GATEWAY}/tenant/branding`, { data: { preset: 'royal-violet' } });
      const stillAmber = rowOf(TB)?.preset === 'electric-amber';
      log({ role: 'msq_tenant_admin', action: 'tenant admin changes colours while locked', method: 'PUT', endpoint: '/tenant/branding', status: blocked.status, verified: stillAmber, expected: '403 BRANDING_THEME_LOCKED' });
      if (isOk(blocked.status) || !stillAmber) fail('high', 'msq_tenant_admin', 'Tenant admin changed colours while Super Admin had them LOCKED', '403 BRANDING_THEME_LOCKED', `HTTP ${blocked.status}, preset now ${rowOf(TB)?.preset}`, blocked.text.slice(0, 200), 'Enforce the lock in the service AND the DB trigger.');
      else if (blocked.status !== 403) fail('low', 'msq_tenant_admin', 'Locked-theme refusal status', '403', `HTTP ${blocked.status}`, blocked.text.slice(0, 200), '');
      const okTerm = await req(tadm, 'PUT', `${GATEWAY}/tenant/branding`, { data: { terms: { leads: MARK } } });
      log({ role: 'msq_tenant_admin', action: 'tenant admin edits terms while theme locked', method: 'PUT', endpoint: '/tenant/branding', status: okTerm.status, verified: (rowOf(TB)?.terms ?? '').includes(MARK), expected: '200 (terms stay editable)' });
      if (!isOk(okTerm.status)) fail('medium', 'msq_tenant_admin', 'Terms cannot be edited while the theme is locked', '200', `HTTP ${okTerm.status}`, okTerm.text.slice(0, 200), 'Lock covers theme columns only.');
      // a no-op theme re-submit while locked (same values) must not be refused
      const same = await req(tadm, 'PUT', `${GATEWAY}/tenant/branding`, { data: { preset: 'electric-amber', terms: { leads: MARK } } });
      log({ role: 'msq_tenant_admin', action: 'unchanged theme values re-submitted while locked', method: 'PUT', endpoint: '/tenant/branding', status: same.status, verified: isOk(same.status), expected: '200 (nothing actually changes)' });
      if (!isOk(same.status)) fail('low', 'msq_tenant_admin', 'Locked tenant cannot save terms from the UI form that re-sends unchanged theme fields', '200', `HTTP ${same.status}`, same.text.slice(0, 200), 'Compare before refusing (already done in the service; the DB trigger may be stricter).');
      await req(sa, 'PUT', SA(TB), { data: { theme_locked: false } });
      const unlockedPut = await req(tadm, 'PUT', `${GATEWAY}/tenant/branding`, { data: { preset: 'royal-violet' } });
      log({ role: 'msq_tenant_admin', action: 'tenant admin changes colours once unlocked', method: 'PUT', endpoint: '/tenant/branding', status: unlockedPut.status, verified: rowOf(TB)?.preset === 'royal-violet', expected: '200' });
      if (!isOk(unlockedPut.status) || rowOf(TB)?.preset !== 'royal-violet') fail('high', 'msq_tenant_admin', 'Tenant admin cannot change colours after the lock is lifted', '200 and preset=royal-violet', `HTTP ${unlockedPut.status}`, unlockedPut.text.slice(0, 200), 'Lock flag read must be fresh.');
    } finally { await tadm.close(); }

    // 5e uploads
    console.log('  uploads');
    const slotOf = (r) => rowOf(TB)?.assets ?? '{}';
    const expectReject = async (name, slot, data, codes = [400, 422]) => {
      const before = slotOf();
      const r = await upload(sa, TB, slot, data);
      const accepted = isOk(r.status);
      log({ role: who, action: `upload rejected: ${name}`, method: 'POST', endpoint: `/sa/tenants/:id/branding/assets/${slot}`, status: r.status, verified: !accepted && slotOf() === before, expected: codes.join('/') });
      if (accepted || slotOf() !== before) fail('high', who, `Brand asset upload accepted: ${name}`, 'rejected with 422 and nothing stored', `HTTP ${r.status}`, r.text.slice(0, 200), 'validateBrandAsset must reject it.');
      else if (r.status >= 500) fail('high', who, `Brand asset upload 5xx: ${name}`, '422', `HTTP ${r.status}`, r.text.slice(0, 200), 'Map to ValidationError.');
      else if (!codes.includes(r.status)) fail('low', who, `Brand asset upload status for ${name}`, codes.join('/'), `HTTP ${r.status}`, r.text.slice(0, 160), '');
      return r;
    };
    const unsafe = {
      'SVG with <script>': svg('<script>alert(1)</script>'),
      'SVG with onload handler': `<svg ${SVG_NS} onload="alert(1)"></svg>`,
      'SVG javascript: link': svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'),
      'SVG foreignObject': svg('<foreignObject><div>hi</div></foreignObject>'),
      'SVG external image': svg('<image href="https://evil.example/x.png"/>'),
      'SVG external CSS url()': svg('<rect style="fill:url(https://evil.example/x)" width="1" height="1"/>'),
      'SVG @import': svg('<style>@import "https://evil.example/a.css";</style>'),
      'SVG iframe': svg('<iframe src="https://evil.example"></iframe>'),
      'SVG with ENTITY (XXE)': `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${SVG_NS}>&x;</svg>`,
      'SVG uppercase SCRIPT': svg('<SCRIPT>alert(1)</SCRIPT>'),
      'SVG data: URI href': svg('<use href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
    };
    for (const [n, body] of Object.entries(unsafe)) await expectReject(n, 'logo', b64(body));
    // defence-in-depth probes: expected to be rejected; accepted == a gap in the regex deny list
    const probes = {
      'SVG unquoted href to https://': svg('<image href=https://evil.example/x.png />'),
      'SVG SMIL set href to javascript&#58;': svg('<a><set attributeName="href" to="javascript&#58;alert(1)"/><rect width="1" height="1"/></a>'),
      'SVG xlink:href with entity-encoded javascript': svg('<a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>'),
    };
    for (const [n, body] of Object.entries(probes)) {
      const before = slotOf();
      const r = await upload(sa, TB, 'mark', b64(body));
      const accepted = isOk(r.status);
      log({ role: who, action: `SVG deny-list probe: ${n}`, method: 'POST', endpoint: '/sa/tenants/:id/branding/assets/mark', status: r.status, verified: !accepted, expected: 'rejected' });
      if (accepted) { fail('low', who, `SVG sanitiser gap: accepted "${n}"`, 'Rejected (nothing executable or external in a brand mark)', `HTTP ${r.status}; stored`, body.slice(0, 200), 'Tighten SVG_FORBIDDEN in lib/brand-assets.ts (parse as XML, allow-list elements/attributes) - mitigated today by the sandbox CSP + nosniff on the public route and <img> rendering.'); await req(sa, 'DELETE', SA(TB, '/assets/mark')); }
      else if (slotOf() !== before) fail('medium', who, 'Rejected probe mutated assets', 'unchanged', 'changed', '', '');
    }
    await expectReject('HTML bytes into logo', 'logo', b64('<html><body><script>alert(1)</script></body></html>'));
    await expectReject('Windows executable bytes', 'logo', b64(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)])));
    await expectReject('GIF bytes', 'logo', b64(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)])));
    await expectReject('PHP/shell text', 'logo', b64('<?php system($_GET["c"]); ?> padding padding'));
    await expectReject('base64 garbage', 'logo', 'not-base64-!!!-not-base64-!!!');
    await expectReject('PNG magic with oversize body (600 KB > 512 KB logo cap)', 'logo', b64(Buffer.concat([png(8, 8), Buffer.alloc(600 * 1024, 7)])));
    await expectReject('SVG into app_icon (PNG only)', 'app_icon', b64(SVG_OK));
    await expectReject('non-square app_icon 600x500', 'app_icon', b64(png(600, 500)));
    await expectReject('too-small app_icon 256x256', 'app_icon', b64(png(256, 256)));
    await expectReject('ICO into logo (favicon-only type)', 'logo', b64(Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(200, 1)])));
    await expectReject('empty data', 'logo', 'AAAAAAAAAAAAAAAA', [400, 422]);
    const tooBig = await upload(sa, TB, 'logo', 'A'.repeat(3_000_000));
    log({ role: who, action: 'upload body > 2.8M chars', method: 'POST', endpoint: '/sa/tenants/:id/branding/assets/logo', status: tooBig.status, verified: !isOk(tooBig.status), expected: '413/422' });
    if (isOk(tooBig.status) || tooBig.status >= 500) fail('medium', who, 'Oversized upload body not cleanly refused', '413/422', `HTTP ${tooBig.status}`, tooBig.text.slice(0, 160), 'Zod max(2_800_000) + Fastify bodyLimit; the gateway must not 5xx.');
    // slot / id path traversal
    for (const slot of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fx', 'logo%2F..%2Fapp_icon', 'LOGO', 'banner', 'logo%00', 'logo.png', '%5C..%5Cwin.ini']) {
      const r = await req(sa, 'POST', SA(TB, `/assets/${slot}`), { data: { data: b64(PNG_SMALL) } });
      const d = await req(sa, 'DELETE', SA(TB, `/assets/${slot}`));
      const bad = isOk(r.status) || isOk(d.status) || r.status >= 500 || d.status >= 500;
      log({ role: who, action: `asset slot "${slot}" (POST ${r.status} / DELETE ${d.status})`, method: 'POST', endpoint: '/sa/tenants/:id/branding/assets/:slot', status: Math.max(r.status, d.status), verified: !bad, expected: '4xx, nothing stored' });
      if (bad) fail(r.status >= 500 || d.status >= 500 ? 'high' : 'high', who, `Asset slot not allow-listed: "${slot}"`, '422/404 (slot is z.enum)', `POST ${r.status} DELETE ${d.status}`, r.text.slice(0, 160), 'Validate :slot against BRAND_ASSET_SLOTS before use; the storage key must never contain client text.');
    }
    if (/\.\.|etc/.test(slotOf())) fail('critical', who, 'Traversal slot reached the assets column', 'no such key', slotOf().slice(0, 200), '', 'Reject before storage.');

    // valid assets
    const okPng = await upload(sa, TB, 'logo', b64(PNG_SMALL));
    const okSvg = await upload(sa, TB, 'mark', `data:image/svg+xml;base64,${b64(SVG_OK)}`);
    const okFav = await upload(sa, TB, 'favicon', b64(PNG_SMALL));
    const okIcon = await upload(sa, TB, 'app_icon', b64(png(512, 512)));
    for (const [n, r] of [['logo PNG', okPng], ['mark SVG (data: URI)', okSvg], ['favicon PNG', okFav], ['app_icon 512 PNG', okIcon]]) {
      log({ role: who, action: `upload ${n}`, method: 'POST', endpoint: '/sa/tenants/:id/branding/assets/:slot', status: r.status, verified: r.status === 201, expected: '201' });
      if (r.status !== 201) fail('high', who, `Valid brand asset refused: ${n}`, '201', `HTTP ${r.status}`, r.text.slice(0, 200), 'validateBrandAsset / blob store.');
    }
    const assets = JSON.parse(rowOf(TB)?.assets ?? '{}');
    const keyB = pubKey(TB);
    const stored = Object.keys(assets).sort().join(',');
    log({ role: who, action: 'assets recorded in entity.tenant_branding.assets', method: 'GET', endpoint: 'db', status: 200, verified: stored === 'app_icon,favicon,logo,mark', expected: 'app_icon,favicon,logo,mark' });
    if (stored !== 'app_icon,favicon,logo,mark') fail('high', who, 'Uploaded assets not recorded', 'four slots', stored, JSON.stringify(assets).slice(0, 200), 'setAssetAsService.');
    if (Object.values(assets).some((m) => !String(m.key).startsWith(`brand/${TB}/`))) fail('critical', who, 'Asset blob key outside the tenant\'s own prefix', `brand/${TB}/...`, JSON.stringify(Object.values(assets).map((m) => m.key)), '', 'Key must be derived from the tenant id only.');

    // public serving of the new assets (anonymous)
    const png1 = await req(anonA, 'GET', pubUrl(keyB, '/assets/logo'));
    const hdr = png1.headers;
    const hdrOk = /image\/png/.test(hdr['content-type'] ?? '') && /nosniff/i.test(hdr['x-content-type-options'] ?? '') && /immutable/.test(hdr['cache-control'] ?? '') && !!hdr['etag'];
    log({ role: 'anonymous', action: 'GET public logo asset', method: 'GET', endpoint: '/public/branding/:key/assets/logo', status: png1.status, verified: png1.status === 200 && hdrOk && png1.buf.equals(PNG_SMALL), expected: '200 bytes + nosniff + immutable + etag' });
    if (png1.status !== 200 || !png1.buf.equals(PNG_SMALL)) fail('high', 'anonymous', 'Public brand asset not served / bytes differ', 'identical bytes', `HTTP ${png1.status}`, png1.text.slice(0, 80), 'getPublicAsset.');
    else if (!hdrOk) fail('medium', 'anonymous', 'Public asset response headers incomplete', 'content-type, X-Content-Type-Options: nosniff, immutable cache, ETag', JSON.stringify(hdr).slice(0, 240), '', 'Controller sets them; check the gateway forwardResponseHeaders list.');
    const etag = hdr['etag'];
    if (etag) {
      const c304 = await req(anonA, 'GET', pubUrl(keyB, '/assets/logo'), { headers: { 'if-none-match': etag } });
      log({ role: 'anonymous', action: 'conditional GET with If-None-Match', method: 'GET', endpoint: '/public/branding/:key/assets/logo', status: c304.status, verified: c304.status === 304, expected: '304' });
      if (c304.status !== 304) fail('low', 'anonymous', 'ETag revalidation does not return 304', '304', `HTTP ${c304.status}`, '', 'Gateway forwards if-none-match; check the ETag round trip.');
    }
    const svgR = await req(anonA, 'GET', pubUrl(keyB, '/assets/mark'));
    const csp = svgR.headers['content-security-policy'] ?? '';
    log({ role: 'anonymous', action: 'SVG asset is served with a sandbox CSP', method: 'GET', endpoint: '/public/branding/:key/assets/mark', status: svgR.status, verified: /sandbox/.test(csp) && /default-src 'none'/.test(csp), expected: 'CSP default-src none; sandbox' });
    if (svgR.status !== 200 || !/sandbox/.test(csp)) fail('high', 'anonymous', 'Public SVG served without the locked-down CSP', "Content-Security-Policy: default-src 'none'; ...; sandbox", csp || '(none)', `HTTP ${svgR.status}`, 'Gateway forwardResponseHeaders must include content-security-policy (it does) - check the controller header.');
    // tenant isolation of bytes: A's key must serve A's asset (or 404), never B's bytes
    if (keyA) {
      const aLogo = await req(anonA, 'GET', pubUrl(keyA, '/assets/logo'));
      if (aLogo.status === 200 && aLogo.buf.equals(PNG_SMALL)) fail('critical', 'anonymous', 'Tenant A login key serves tenant B\'s asset bytes', 'A\'s own logo only', 'B\'s PNG returned', '', 'getBrandingByPublicKey must filter by the key\'s own tenant.');
      const crossSlot = await req(anonA, 'GET', pubUrl(keyA, '/assets/mark'));
      if (crossSlot.status === 200 && /E2E|e11d48/i.test(crossSlot.text)) fail('critical', 'anonymous', 'Tenant A key serves tenant B\'s mark', 'A\'s own', 'B\'s SVG', '', 'Same.');
    }
    // wrong slot / unknown key on asset route
    const noSlot = await req(anonA, 'GET', pubUrl(keyB, '/assets/banner'));
    const noKey = await req(anonA, 'GET', pubUrl('11111111-1111-4111-8111-111111111111', '/assets/logo'));
    const trav2 = await req(anonA, 'GET', `${GATEWAY}/public/branding/${keyB}/assets/..%2F..%2Fsecret`);
    for (const [n, r] of [['unknown slot', noSlot], ['unknown key', noKey], ['traversal slot', trav2]]) {
      log({ role: 'anonymous', action: `public asset ${n}`, method: 'GET', endpoint: '/public/branding/:key/assets/:slot', status: r.status, verified: r.status >= 400 && r.status < 500, expected: '404/422' });
      if (!(r.status >= 400 && r.status < 500)) fail('medium', 'anonymous', `Public asset route with ${n}`, '404/422', `HTTP ${r.status}`, r.text.slice(0, 120), 'Enum-validate slot; 404 unknown.');
    }

    // delete
    const del = await req(sa, 'DELETE', SA(TB, '/assets/favicon'));
    const gone = !(JSON.parse(rowOf(TB)?.assets ?? '{}').favicon);
    const after = await req(anonA, 'GET', pubUrl(keyB, '/assets/favicon'));
    log({ role: who, action: 'delete the favicon asset', method: 'DELETE', endpoint: '/sa/tenants/:id/branding/assets/favicon', status: del.status, verified: gone && after.status === 404, expected: '200, row cleared, public 404' });
    if (!isOk(del.status) || !gone) fail('high', who, 'Asset delete did not clear the slot', '200 and slot removed', `HTTP ${del.status} gone=${gone}`, del.text.slice(0, 160), 'setAssetAsService(null).');
    else if (after.status !== 404) fail('medium', who, 'Deleted asset still served publicly', '404', `HTTP ${after.status}`, '', 'Public route resolves meta from the row; stale cache or blob fallback?');
    const del2 = await req(sa, 'DELETE', SA(TB, '/assets/favicon'));
    if (del2.status >= 500) fail('medium', who, 'Deleting an already-empty slot 5xxs', '200/404', `HTTP ${del2.status}`, del2.text.slice(0, 160), 'Idempotent delete.');

    // 5f rotate-key
    const oldKey = pubKey(TB);
    const pub1 = await req(anonA, 'GET', pubUrl(oldKey));
    const rot = await req(sa, 'POST', SA(TB, '/rotate-key'));
    const newKey = pubKey(TB);
    const pubOld = await req(anonA, 'GET', pubUrl(oldKey));
    const pubNew = await req(anonA, 'GET', pubUrl(newKey));
    const oldAsset = await req(anonA, 'GET', pubUrl(oldKey, '/assets/logo'));
    const newAsset = await req(anonA, 'GET', pubUrl(newKey, '/assets/logo'));
    log({ role: who, action: 'rotate the login-link key', method: 'POST', endpoint: '/sa/tenants/:id/branding/rotate-key', status: rot.status, verified: newKey && newKey !== oldKey, expected: 'new key, old link dead' });
    if (!isOk(rot.status) || !newKey || newKey === oldKey) fail('high', who, 'Rotate-key did not issue a new key', 'public_key changes', `HTTP ${rot.status}`, rot.text.slice(0, 160), 'rotatePublicKeyAsService.');
    else {
      const brandName = (b) => b?.data?.brand_name;
      if (brandName(pubOld.body) !== null || (pubOld.body?.data?.assets && Object.keys(pubOld.body.data.assets).length)) fail('high', 'anonymous', 'Rotated (old) login key still resolves to the tenant\'s branding', 'platform default {brand_name:null, assets:{}}', JSON.stringify(pubOld.body?.data).slice(0, 200), '', 'Old key must stop resolving immediately.');
      if (oldAsset.status === 200) fail('high', 'anonymous', 'Rotated (old) key still serves assets', '404', 'HTTP 200', '', 'Same.');
      if (!(pubNew.status === 200 && brandName(pubNew.body))) fail('high', 'anonymous', 'New login key does not resolve', 'tenant branding', JSON.stringify(pubNew.body?.data).slice(0, 160), '', '');
      if (newAsset.status !== 200) fail('medium', 'anonymous', 'Assets not reachable under the new key', '200', `HTTP ${newAsset.status}`, '', 'Assets are keyed by the row, not the key.');
    }
    probeResults.keyB = pubKey(TB);
  } finally { await sa.close(); await anonA.close(); }
}

// ── P6 public routes ─────────────────────────────────────────────────────────
async function publicRoutes() {
  console.log('\n== P6 public pre-login routes ==');
  const an = await anon();
  try {
    const ALLOWED = new Set(['theme', 'brand_name', 'product_labels', 'assets']);
    if (keyA) {
      const r = await req(an, 'GET', pubUrl(keyA));
      const data = r.body?.data ?? {};
      const extra = Object.keys(data).filter((k) => !ALLOWED.has(k));
      const sensitive = /tenant_id|terms|nav_overrides|updated_by|@|password|"key"\s*:\s*"brand\//.test(r.text) || r.text.includes(TA) || r.text.includes(TB);
      log({ role: 'anonymous', action: 'GET /public/branding/<A key>', method: 'GET', endpoint: '/public/branding/:key', status: r.status, verified: r.status === 200 && !extra.length && !sensitive, expected: 'only theme, brand_name, product_labels, assets' });
      if (r.status !== 200) fail('high', 'anonymous', 'Public branding lookup fails', '200', `HTTP ${r.status}`, r.text.slice(0, 160), 'Gateway route / identity public handler.');
      if (extra.length || sensitive) fail('high', 'anonymous', 'Public branding exposes more than the login page needs', 'theme, brand_name, product_labels, assets only', `extra=${extra.join(',')} sensitive=${sensitive}`, r.text.slice(0, 300), 'getPublicBranding must keep the allow-list.');
      if (!/public/.test(r.headers['cache-control'] ?? '')) fail('low', 'anonymous', 'Public branding not cacheable', 'Cache-Control: public, max-age=300', r.headers['cache-control'] ?? '(none)', '', '');
    }
    // unknown vs rotated vs valid-but-absent: same shape, no oracle
    const unknown = await req(an, 'GET', pubUrl('22222222-2222-4222-8222-222222222222'));
    const rotatedOld = await req(an, 'GET', pubUrl('33333333-3333-4333-8333-333333333333'));
    const sameShape = JSON.stringify(Object.keys(unknown.body?.data ?? {}).sort()) === JSON.stringify(['assets', 'brand_name', 'product_labels', 'theme']);
    log({ role: 'anonymous', action: 'unknown login key returns the platform default (no 404 oracle)', method: 'GET', endpoint: '/public/branding/:key', status: unknown.status, verified: unknown.status === 200 && sameShape && JSON.stringify(unknown.body) === JSON.stringify(rotatedOld.body), expected: '200 default shape' });
    if (unknown.status !== 200 || !sameShape) fail('medium', 'anonymous', 'Unknown login key distinguishable from a real one', '200 with the platform-default shape', `HTTP ${unknown.status} keys=${Object.keys(unknown.body?.data ?? {})}`, unknown.text.slice(0, 160), 'Controller returns PLATFORM_DEFAULT; keep status+shape identical.');
    // malformed keys must be 4xx not 5xx, no SQL text
    for (const k of ["' OR 1=1 --", '..%2F..%2Fetc%2Fpasswd', 'x'.repeat(300), '%00', '00000000-0000-0000-0000-000000000000%27']) {
      const r = await req(an, 'GET', `${GATEWAY}/public/branding/${k}`);
      const lk = leakOf(r.text);
      log({ role: 'anonymous', action: `malformed public key ${k.slice(0, 20)}`, method: 'GET', endpoint: '/public/branding/:key', status: r.status, verified: r.status < 500 && !lk, expected: '4xx' });
      if (r.status >= 500 || lk) fail('high', 'anonymous', `Malformed public branding key "${k.slice(0, 24)}" -> ${r.status}`, '4xx without internals', lk ?? `HTTP ${r.status}`, r.text.slice(0, 200), 'Param validation (uuid) before the query.');
    }
    // identity-service must refuse the public route without the gateway secret
    try {
      const out = execFileSync('docker', ['exec', 'msq-identity-service-1', 'node', '-e',
        `Promise.all([fetch('http://localhost:4001/api/v1/public/branding/${keyA ?? '11111111-1111-4111-8111-111111111111'}'),fetch('http://localhost:4001/api/v1/auth/forgot-password',{method:'POST',headers:{'content-type':'application/json'},body:'{"email":"nobody@e2e.local"}'})]).then(rs=>console.log(rs.map(r=>r.status).join(',')))`],
        { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
      const [s1, s2] = out.split(',').map(Number);
      log({ role: 'anonymous', action: 'identity-service public routes without the gateway secret', method: 'GET', endpoint: 'identity:4001 /public/branding, /auth/forgot-password', status: Math.max(s1, s2), verified: [401, 403].includes(s1) && [401, 403].includes(s2), expected: '401/403' });
      if (!([401, 403].includes(s1) && [401, 403].includes(s2))) fail('high', 'anonymous', 'identity-service answers public routes without the internal secret', '401/403', `branding=${s1} forgot-password=${s2}`, out, 'requireInternalSecret on every pre-login route.');
    } catch (e) { console.log(`  (identity container probe skipped: ${String(e.message).split('\n')[0]})`); }

    // rate limits - gateway direct so the web apps' own (SSR) buckets are not spent
    const base = `${GATEWAY_DIRECT}/public/branding/${keyA ?? '44444444-4444-4444-8444-444444444444'}`;
    let first429 = null, n = 0, retry = null;
    for (; n < 75; n++) {
      const r = await req(an, 'GET', base);
      if (r.status === 429) { first429 = n + 1; retry = r.headers['retry-after']; break; }
    }
    log({ role: 'anonymous', action: 'public branding rate limit (60/min per IP)', method: 'GET', endpoint: '/public/branding/:key', status: first429 ? 429 : 200, verified: first429 != null && first429 > 30 && first429 <= 62, expected: '429 after ~60 requests with Retry-After' });
    if (!first429) fail('medium', 'anonymous', 'Public branding has no effective rate limit (75 requests, no 429)', '429 after 60/min per IP (brandingRateLimit)', 'never limited', base, 'Check createRateLimiter is attached and request.ip is stable (TRUST_PROXY_HOPS).');
    else if (!retry) fail('low', 'anonymous', '429 without Retry-After', 'Retry-After header', '(none)', '', 'rate-limit.ts sets it; the gateway proxy must not strip it.');
    // asset limiter (240/min): conditional GETs are cheap
    let a429 = null; const aUrl = `${GATEWAY_DIRECT}/public/branding/${keyA ?? '44444444-4444-4444-8444-444444444444'}/assets/logo`;
    for (let i = 0; i < 250; i++) { const r = await req(an, 'GET', aUrl, { headers: { 'if-none-match': '"x"' } }); if (r.status === 429) { a429 = i + 1; break; } }
    log({ role: 'anonymous', action: 'public asset rate limit (240/min per IP)', method: 'GET', endpoint: '/public/branding/:key/assets/:slot', status: a429 ? 429 : 200, verified: a429 != null, expected: '429 after ~240' });
    if (!a429) fail('low', 'anonymous', 'Public asset route not rate limited within 250 requests', '429 after 240/min', 'never limited', aUrl, 'brandingAssetRateLimit.');
    // the key-guessing bucket must be separate from login
    const login = await req(an, 'POST', `${GATEWAY_DIRECT}/auth/login`, { data: { email: 'nobody@e2e.local', password: 'x' } });
    log({ role: 'anonymous', action: 'branding flood does not exhaust the login bucket', method: 'POST', endpoint: '/auth/login', status: login.status, verified: login.status !== 429, expected: 'not 429' });
    if (login.status === 429) fail('medium', 'anonymous', 'Branding-key flood starved /auth/login', 'separate buckets', 'login 429', '', 'brandingRateLimit must be its own limiter instance.');
    console.log('  waiting for the rate-limit window to clear (65 s) so later suites are unaffected...');
    await sleep(65000);
  } finally { await an.close(); }
}

// ── P7 UI ────────────────────────────────────────────────────────────────────
async function uiPass() {
  console.log('\n== P7 UI ==');
  const adminUrl = (p) => `${APPS['admin-web']}${p}`;
  const saUrl = (p) => `${APPS['lookup-admin']}${p}`;
  const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(700); };
  const bodyOf = async (page) => (await page.locator('body').innerText().catch(() => ''));

  // 7a admin-web Branding page per role, graded by admin.branding.view / manage
  for (const A of ACTORS) {
    const c = caps.get(A.key); if (!c) continue;
    const { browser, page, log: plog } = await openState(A.key);
    try {
      await page.goto(adminUrl('/dashboard/branding'), { waitUntil: 'domcontentloaded' }); await settle(page);
      const body = await bodyOf(page);
      const shown = /Branding/.test(body) && /Colours & font/i.test(body);
      const has = c.has('admin.branding.view'), manage = c.has('admin.branding.manage');
      const swatches = page.locator('fieldset button[aria-pressed]');
      const enabledSw = await swatches.evaluateAll((els) => els.filter((e) => !e.disabled).length).catch(() => 0);
      log({ role: A.key, area: 'admin-web /dashboard/branding', action: 'open Branding settings', method: 'UI', endpoint: '/admin/dashboard/branding', status: null, outcome: shown ? 'visible' : 'hidden', verified: shown === has, expected: has ? 'visible' : 'hidden/403' });
      if (has && !shown && !/\/login/.test(page.url())) fail('medium', A.key, 'Branding page not rendered for an admin.branding.view holder', 'page renders', body.slice(0, 120).replace(/\n/g, ' '), page.url(), 'admin-web branding page guard vs capability.', 'admin-web /dashboard/branding');
      if (!has && shown) fail('high', A.key, 'Branding page rendered for a role WITHOUT admin.branding.view', '403 LoadError', 'page shown', page.url(), 'The server component re-checks can(session, ADMIN_BRANDING_VIEW); the gateway returns 403 anyway.', 'admin-web /dashboard/branding');
      if (shown) {
        if (manage && A.key === 'msq_tenant_admin' && enabledSw === 0 && !/locked/i.test(body)) fail('medium', A.key, 'Manager sees every colour swatch disabled although the theme is unlocked', 'enabled swatches', '0 enabled', '', 'ThemePicker disabled/locked props.', 'admin-web /dashboard/branding');
        if (!manage && enabledSw > 0) fail('medium', A.key, 'View-only role sees ENABLED colour swatches', 'disabled (read-only)', `${enabledSw} enabled`, '', 'Pass disabled={!canManage}.', 'admin-web /dashboard/branding');
        await sweepPage(page, { rep, role: A.key, label: 'admin-web /dashboard/branding', log: plog, maxButtons: 12 });
      }
    } finally { await browser.close(); }
  }

  // 7b lookup-admin /sa branding + modules: super_admin only
  for (const A of ACTORS) {
    const { browser, page, log: plog } = await openState(A.key);
    try {
      const isSA = A.key === 'super_admin';
      const targets = [saUrl('/dashboard/branding'), saUrl(`/dashboard/tenants/${TB}/branding`), saUrl(`/dashboard/tenants/${TB}/modules`)];
      for (const u of targets) {
        await page.goto(u, { waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(page);
        const body = await bodyOf(page);
        const onPage = page.url().startsWith(u.split('?')[0]) && /Tenant branding|Branding|modules/i.test(body) && !/access (restricted|denied)|forbidden|not authori[sz]ed|couldn.t load|could not load/i.test(body);
        log({ role: A.key, area: `lookup-admin ${u.replace(APPS['lookup-admin'], '/sa')}`, action: 'open page', method: 'UI', endpoint: u.replace(APPS['lookup-admin'], '/sa'), status: null, outcome: onPage ? 'visible' : 'hidden', verified: onPage === isSA, expected: isSA ? 'visible' : 'hidden' });
        if (isSA && !onPage) fail('high', A.key, `Super admin cannot open ${u.replace(APPS['lookup-admin'], '/sa')}`, 'page renders', `${page.url()} :: ${body.slice(0, 100).replace(/\n/g, ' ')}`, '', 'lookup-admin page/guard.', 'lookup-admin branding');
        if (!isSA && onPage) fail('critical', A.key, `${A.key} can open the super-admin branding console ${u.replace(APPS['lookup-admin'], '/sa')}`, 'redirect/403', 'rendered', page.url(), 'lookup-admin must refuse non-super-admins server-side (the gateway does).', 'lookup-admin branding');
        if (isSA && onPage) {
          await sweepPage(page, { rep, role: A.key, label: `lookup-admin ${u.replace(APPS['lookup-admin'], '/sa')}`, log: plog, maxButtons: 14 });
        }
      }
    } finally { await browser.close(); }
  }

  // 7c super admin saves tenant B branding THROUGH the UI (colour + upload), DB verified
  {
    const { browser, page } = await openState('super_admin');
    try {
      await page.goto(saUrl(`/dashboard/tenants/${TB}/branding`), { waitUntil: 'domcontentloaded' }); await settle(page);
      const target = 'Sky Velocity';
      const sw = page.getByRole('button', { name: new RegExp(`^${target}$`) }).first();
      const fileIn = page.locator('input[type="file"][aria-label="Upload Full logo"], input[type="file"]').first();
      let did = false;
      if (await sw.count()) {
        await sw.click();
        const saveBtn = page.getByRole('button', { name: /^save/i }).first();
        const w = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/sa\/tenants\/.+\/branding/.test(r.url()), { timeout: 15000 }).catch(() => null);
        if (await saveBtn.count() && !(await saveBtn.isDisabled())) { await saveBtn.click(); const resp = await w; did = !!resp && resp.status() < 300; }
      }
      await page.waitForTimeout(1200);
      const preset = rowOf(TB)?.preset;
      log({ role: 'super_admin', area: 'lookup-admin tenant branding', action: 'pick a palette and press Save', method: 'UI', endpoint: `/sa/dashboard/tenants/${TB}/branding`, status: did ? 200 : null, outcome: did ? 'allowed' : 'no-op', verified: preset === 'sky-velocity', expected: 'preset=sky-velocity in entity.tenant_branding' });
      if (preset !== 'sky-velocity') fail('high', 'super_admin', 'Super-admin branding UI: choosing a palette and pressing Save did not persist', 'preset=sky-velocity', `preset=${preset} (save sent=${did})`, '', 'TenantBrandingClient.save -> PUT /sa/tenants/:id/branding.', 'lookup-admin tenant branding');
      if (await fileIn.count()) {
        const up = page.waitForResponse((r) => r.request().method() === 'POST' && /branding\/assets\//.test(r.url()), { timeout: 15000 }).catch(() => null);
        await fileIn.setInputFiles({ name: 'e2e-logo.png', mimeType: 'image/png', buffer: PNG_SMALL });
        const resp = await up;
        log({ role: 'super_admin', area: 'lookup-admin tenant branding', action: 'upload a logo file via the file input', method: 'UI', endpoint: 'POST branding/assets/:slot', status: resp?.status() ?? null, outcome: resp && resp.status() < 300 ? 'allowed' : 'error', verified: !!JSON.parse(rowOf(TB)?.assets ?? '{}').logo, expected: '201 + asset row' });
        if (!resp || resp.status() >= 300) fail('medium', 'super_admin', 'UI logo upload failed', '201', String(resp?.status()), '', 'TenantBrandingClient upload handler.', 'lookup-admin tenant branding');
      }
    } finally { await browser.close(); }
  }

  // 7d auth-web login branding + forgot/reset pages carry the same brand
  {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const keyBNow = pubKey(TB);
      const cases = [['tenant A key', keyA, /fitclass/i], ['tenant B key', keyBNow, new RegExp(MARK, 'i')], ['unknown key', '55555555-5555-4555-8555-555555555555', null]];
      for (const [n, k, rx] of cases) {
        if (!k) continue;
        await page.goto(`${APPS['auth-web']}/login?t=${k}`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const body = await bodyOf(page);
        const imgs = await page.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src') || ''));
        const brandImg = imgs.some((s) => /public\/branding/.test(s) || /branding/.test(decodeURIComponent(s)));
        const ok = rx ? rx.test(body) || brandImg : true;
        const otherKey = k === keyA ? keyBNow : keyA;
        const leak = otherKey && (body.includes(otherKey) || imgs.some((s) => s.includes(otherKey)));
        log({ role: 'anonymous', area: 'auth-web /login?t=', action: `render login with ${n}`, method: 'UI', endpoint: '/login?t=<key>', status: null, outcome: 'visible', verified: ok && !leak, expected: rx ? 'brand name or logo applied' : 'platform default' });
        if (!ok) fail('medium', 'anonymous', `Login page does not apply branding for ${n}`, 'tenant brand name / logo', body.slice(0, 120).replace(/\n/g, ' '), `imgs=${imgs.slice(0, 3)}`, 'auth-web loadBrand(t) -> /public/branding/:key.', 'auth-web /login');
        if (leak) fail('critical', 'anonymous', `Login page for ${n} carries the OTHER tenant's key`, 'own tenant only', 'foreign key in DOM', '', 'loadBrand.', 'auth-web /login');
        if (/\bundefined\b|\[object Object\]|NaN/.test(body)) fail('low', 'anonymous', `Login page for ${n} prints undefined/NaN`, 'clean copy', body.slice(0, 120), '', '', 'auth-web /login');
      }
      // old (rotated) key must render the default, not tenant B
      const rotated = pubKey(TB) !== probeResults.keyB;
      await page.goto(`${APPS['auth-web']}/login?t=${snapB?.public_key ?? '66666666-6666-4666-8666-666666666666'}`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const old = await bodyOf(page);
      if (new RegExp(MARK, 'i').test(old)) fail('high', 'anonymous', 'Login page still shows tenant B branding for a rotated key', 'platform default', 'tenant brand shown', '', 'Old key must not resolve.', 'auth-web /login');
    } finally { await browser.close(); }
  }

  // 7e theme preference: persisted per user, applied in the lms/hr/todo shells
  {
    const user = ACTORS.find((a) => a.key === 'msq_rep1');
    const tadm = await actor('msq_tenant_admin');
    try {
      // tenant B: unlocked, known colours
      const sa = await actor('super_admin');
      await req(sa, 'PUT', SA(TB), { data: { preset: 'emerald-fit', theme_locked: false, default_mode: 'light' } });
      await sa.close();
      const SEEDS = { 'emerald-fit': '#059669', 'royal-violet': '#7c3aed' };
      const shells = [['lms-web', '/dashboard/leads'], ['hr-web', '/'], ['todo-web', '/tasks']];
      for (const [app, path] of shells) {
        const { browser, page } = await openState(user.key);
        try {
          await page.goto(`${APPS[app]}${path}`, { waitUntil: 'domcontentloaded' }); await settle(page);
          const style = await page.locator('style#platform-theme').first().textContent().catch(() => null);
          const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()).catch(() => '');
          const fits = !!style && !!primary && style.includes(primary);
          const wantEmerald = primary && primary.toLowerCase() !== '#3525cd';
          log({ role: user.key, area: `${app} themed shell`, action: 'tenant colours applied (emerald-fit)', method: 'UI', endpoint: path, status: null, outcome: 'visible', verified: !!wantEmerald, expected: 'primary != platform default #3525cd' });
          if (/\/login/.test(page.url())) { console.log(`  (${app}: session not accepted, skipped)`); continue; }
          if (!style) fail('medium', user.key, `${app} shell has no #platform-theme style block`, 'ThemeStyle rendered in <head>', 'missing', page.url(), 'Root layout must render <ThemeStyle>.', `${app} shell`);
          else if (!wantEmerald) fail('high', user.key, `Tenant colours not applied in ${app}`, 'tenant B preset emerald-fit overrides --color-primary', `--color-primary=${primary}`, style.slice(0, 160), 'Layout must call getEffectiveBranding() and render ThemeStyle.', `${app} shell`);
        } finally { await browser.close(); }
      }
      // personal theme -> persisted (DB) -> applied after reload, and survives a fresh login
      const put = await actor(user.key);
      await req(put, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { preset: 'royal-violet' } });
      await put.close();
      const row = scalar(`SELECT theme::text FROM iam.user_preferences WHERE user_id=${lit(user.uid)}`);
      const { browser, page } = await openState(user.key);
      try {
        await page.goto(`${APPS['todo-web']}/tasks`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()).catch(() => '');
        const style = await page.locator('style#platform-theme').first().textContent().catch(() => '');
        const applied = style && /#[0-9a-f]{6}/i.test(primary);
        log({ role: user.key, area: 'todo-web themed shell', action: 'personal theme (royal-violet) persisted and applied', method: 'UI', endpoint: '/tasks', status: null, outcome: 'visible', verified: /royal-violet/.test(row ?? '') && primary.toLowerCase() !== '#059669', expected: 'DB row + different primary than tenant colour' });
        if (!/royal-violet/.test(row ?? '')) fail('high', user.key, 'Personal theme not persisted', 'iam.user_preferences.theme has royal-violet', String(row), '', 'setOwnTheme.', 'todo-web shell');
        else if (primary.toLowerCase() === '#059669' || !applied) fail('medium', user.key, 'Personal theme saved but the shell still renders the tenant colour', 'user layer overrides tenant layer while unlocked', `--color-primary=${primary}`, '', 'resolveTheme(tenant, user) in the layout.', 'todo-web shell');
        // the Appearance modal (UserMenu): opens and lists the picker
        const menu = page.locator('button[aria-haspopup="menu"], button[aria-label*="account" i], button[aria-label*="user" i]').first();
        if (await menu.count()) {
          await menu.click().catch(() => {});
          const app = page.getByRole('menuitem', { name: /appearance/i }).first();
          const vis = (await app.count()) > 0;
          log({ role: user.key, area: 'todo-web UserMenu', action: 'Appearance entry in user menu', method: 'UI', endpoint: 'UserMenu', status: null, outcome: vis ? 'visible' : 'hidden', verified: vis, expected: 'visible for platform.appearance holders' });
          if (!vis) fail('low', user.key, 'UserMenu has no Appearance entry for a platform.appearance holder', 'Appearance menu item', 'absent', '', 'UserMenu gating.', 'todo-web shell');
          else { await app.click().catch(() => {}); await page.waitForTimeout(500); const dlg = await page.locator('[role="dialog"]').filter({ hasText: /Appearance/i }).first().innerText({ timeout: 3000 }).catch(() => ''); if (!/Light|Dark|Colour/i.test(dlg)) fail('low', user.key, 'Appearance dialog did not show the mode/colour picker', 'ThemePicker', dlg.slice(0, 80), '', '', 'todo-web shell'); await page.keyboard.press('Escape'); }
        }
      } finally { await browser.close(); }
      // cross-user: another user in tenant B must NOT inherit this user's personal theme
      const other = ACTORS.find((a) => a.key === 'msq_org_admin');
      if (other) {
        const { browser: b2, page: p2 } = await openState(other.key);
        try {
          await p2.goto(`${APPS['todo-web']}/tasks`, { waitUntil: 'domcontentloaded' }); await settle(p2);
          const prim2 = await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()).catch(() => '');
          const prefOther = scalar(`SELECT theme::text FROM iam.user_preferences WHERE user_id=${lit(other.uid)}`);
          log({ role: other.key, area: 'todo-web themed shell', action: 'a colleague\'s personal theme does not leak', method: 'UI', endpoint: '/tasks', status: null, outcome: 'visible', verified: !/royal-violet/.test(prefOther ?? ''), expected: 'no royal-violet row for this user' });
          if (/royal-violet/.test(prefOther ?? '')) fail('critical', other.key, 'Personal theme written for the WRONG user', 'only the acting user', 'colleague row changed', '', 'setOwnTheme user pin.', 'todo-web shell');
        } finally { await b2.close(); }
      }
    } finally { await tadm.close(); }
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
try {
  console.log(`branding suite: ${ACTORS.length} logins, tenant A=${TA.slice(0, 8)} (locked=${snapA?.theme_locked}, key=${keyA?.slice(0, 8)}), tenant B=${TB.slice(0, 8)} (row ${snapB ? 'exists' : 'absent'})`);
  for (const A of ACTORS) { console.log(`\n-- ${A.key} --`); await actorPass(A).catch((e) => { fail('high', A.key, 'actor pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); console.log(e.stack); }); }
  await superAdminFunctional().catch((e) => { console.log(e.stack); fail('high', 'super_admin', 'SA functional pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
  await publicRoutes().catch((e) => { console.log(e.stack); fail('high', 'anonymous', 'public pass crashed', 'completes', String(e.message).slice(0, 200), '', ''); });
  await uiPass().catch((e) => { console.log(e.stack); fail('high', 'ui', 'UI pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
} finally {
  restoreTenants();
  runRestore('branding-A'); runRestore('branding-B'); runRestore('branding-prefs');
  const okA = JSON.stringify(rowOf(TA)) === JSON.stringify(snapA);
  const okB = snapB ? JSON.stringify(rowOf(TB)) === JSON.stringify(snapB) : rowOf(TB) === null;
  console.log(`\nrestored branding: tenant A ${okA ? 'identical' : 'DIFFERS'}, tenant B ${okB ? 'identical' : 'DIFFERS'}; findings=${rep.state.findings} actions=${rep.state.actions}`);
  if (!okA) console.log('A now:', JSON.stringify(rowOf(TA)), '\nA was:', JSON.stringify(snapA));
}
