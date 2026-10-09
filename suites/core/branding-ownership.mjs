// Branding OWNERSHIP SPLIT + the personal text-size preference (schema 1.57.0 / font_size, 2026-10-05).
//
// suites/core/branding.mjs proves the happy paths, the Super-Admin-only surface and the theme lock.
// This suite pins the three-way split it does not assert field by field:
//
//   Super Admin owns   : logos/icons, product names, terms (renamed words), menu labels/icons (nav_overrides),
//                        regional formats (locale_config), login link (public_key), theme + theme_locked
//   Tenant admin owns  : the THEME only (preset, seed_hex, font, default_mode, color_overrides), and only while unlocked
//                        (tenantBrandingUpdateSchema is .strict(), schema 1.73.0 / 1.75.0)
//   Every user owns    : a personal theme; light/dark AND text size survive the tenant lock
//
//   O1  tenant admin PUT /tenant/branding with every SA-owned or forged field (theme_locked,
//       product_names, assets, public_key, updated_by, tenant_id, font_size, unknown keys): all 4xx,
//       row signature identical, never a 5xx          (tenantBrandingUpdateSchema is .strict())
//   O2  tenant admin PUT with malformed terms / nav_overrides (unknown term key, markup, over-long,
//       61 menu entries, bad icon / id): all 4xx and nothing stored
//   O3  tenant admin valid PUT lands in OWN tenant only; a colleague's /me/branding shows it, the
//       OTHER tenant's users and its row signature do not; SA PUT on tenant B leaves tenant A byte-identical
//   O4  Super Admin PUT with personal / forged fields (font_size, public_key, tenant_id, assets): 422, nothing stored;
//       unknown tenant 404, malformed id 422
//   F1  text size for EVERY login: PUT {font_size: sm|md|lg|xl} graded by LIVE platform.appearance,
//       DB iam.user_preferences.theme.font_size, /me/branding theme.user.font_size + personal
//   F2  invalid sizes (xxl, large, 12px, '', 14, [], {}, null-byte) rejected with 4xx, stored value unchanged;
//       font_size + forged user_id / tenant_id rejected; a size write never touches tenant_branding
//       or ANY other user's preferences row
//   F3  tenant theme LOCKED: personal text size and mode still apply (theme.user carries them), personal
//       colour/font are stored but stripped from the resolved layer; unlock restores them
//   F4  public (pre-login) branding responses never carry personal preferences or font_size
//
// Everything changed is journalled BEFORE the change (restore-journal.json) and put back in finally:
// both tenants' branding rows are snapshotted whole (tenant B's is DELETED again when it did not
// exist) and every actor's user_preferences row is restored.
//
//   node suites/core/branding-ownership.mjs
import { cfg, APPS, GATEWAY, authFile, CROSS_TENANT } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { journalRestore, runRestore, restorePending, leakOf } from '../../fixtures.mjs';
import { req, anon, reporter, grade, isOk } from '../../kit.mjs';
import fs from 'node:fs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('core', 'Branding ownership split & text size');
const { fail, log } = rep;
const MARK = `E2Eown${String(Date.now()).slice(-6)}`;
void APPS;

restorePending('brandown-');

const tenants = rows(`SELECT id, name FROM entity.tenants WHERE NOT is_deleted`, ['id', 'name']);
const TA = tenants.find((t) => t.name === 'Fitclass')?.id;
const TB = tenants.find((t) => t.name === 'MSquare Professionals')?.id;
if (!TA || !TB) { console.log('needs both Fitclass and MSquare tenants - aborting'); process.exit(0); }

// ── snapshot / restore (same shape as branding.mjs) ──────────────────────────
const COLS = ['preset', 'seed_hex', 'font', 'default_mode', 'theme_locked', 'assets', 'product_names', 'terms', 'nav_overrides', 'public_key'];
const JSONC = ['assets', 'product_names', 'terms', 'nav_overrides'];
const rowOf = (t) => rows(`SELECT ${COLS.map((c) => (JSONC.includes(c) ? `${c}::text` : `COALESCE(${c}::text,'<null>')`)).join(', ')} FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`, COLS)[0] ?? null;
const sig = (t) => scalar(`SELECT md5(row_to_json(b)::text) FROM entity.tenant_branding b WHERE tenant_id=${lit(t)}`) ?? 'none';
const restoreRowSql = (t, snap) => {
  if (!snap) return [`DELETE FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`];
  return [`UPDATE entity.tenant_branding SET
    preset=${snap.preset === '<null>' ? 'NULL' : lit(snap.preset)}, seed_hex=${snap.seed_hex === '<null>' ? 'NULL' : lit(snap.seed_hex)},
    font=${snap.font === '<null>' ? 'NULL' : lit(snap.font)}, default_mode=${lit(snap.default_mode)}, theme_locked=${snap.theme_locked},
    assets=${lit(snap.assets)}::jsonb, product_names=${lit(snap.product_names)}::jsonb, terms=${lit(snap.terms)}::jsonb,
    nav_overrides=${lit(snap.nav_overrides)}::jsonb, public_key=${lit(snap.public_key)}::uuid
    WHERE tenant_id=${lit(t)}`];
};
const snapA = rowOf(TA), snapB = rowOf(TB);
const pubKey = (t) => scalar(`SELECT public_key FROM entity.tenant_branding WHERE tenant_id=${lit(t)}`);
const tenantOfEmail = (e) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(e.toLowerCase())}`);
const uidOf = (e) => scalar(`SELECT id FROM iam.users WHERE email=${lit(e.toLowerCase())}`);

const ACTORS = [
  ...cfg.roles.map((r) => ({ key: r.role, email: r.email, role: r.role })),
  ...CROSS_TENANT.map((c) => ({ key: c.stateKey, email: c.email, role: c.role })),
].filter((a) => fs.existsSync(authFile(a.key)));
for (const a of ACTORS) { a.tenant = tenantOfEmail(a.email); a.uid = uidOf(a.email); a.other = a.tenant === TA ? TB : TA; }
if (!ACTORS.length) { console.log('no logins available - aborting'); process.exit(0); }

const prefSnap = new Map(rows(`SELECT user_id, COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id IN (${ACTORS.map((a) => lit(a.uid)).join(',')})`, ['u', 't']).map((r) => [r.u, r.t]));
const prefSql = [];
for (const a of ACTORS) {
  prefSql.push(`DELETE FROM iam.user_preferences WHERE user_id=${lit(a.uid)}`);
  if (prefSnap.has(a.uid)) { const t = prefSnap.get(a.uid); prefSql.push(`INSERT INTO iam.user_preferences (user_id, tenant_id, theme) VALUES (${lit(a.uid)}, ${lit(a.tenant)}, ${t === '<null>' ? 'NULL' : `${lit(t)}::jsonb`})`); }
}
journalRestore('brandown-A', 'tenant A branding row', restoreRowSql(TA, snapA));
journalRestore('brandown-B', 'tenant B branding row', restoreRowSql(TB, snapB));
journalRestore('brandown-prefs', 'user_preferences of every actor', prefSql);
try { for (const s of restoreRowSql(TA, snapA)) q(s); console.log('restore SQL for tenant A verified (no-op replay)'); }
catch (e) { console.log(`!! restore SQL for tenant A failed: ${String(e.message).split('\n')[0]} - aborting before any change`); process.exit(1); }

const prefFont = (uid) => scalar(`SELECT theme->>'font_size' FROM iam.user_preferences WHERE user_id=${lit(uid)}`);
const prefRaw = (uid) => scalar(`SELECT COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id=${lit(uid)}`) ?? '<none>';
const SA = (t, tail = '') => `${GATEWAY}/sa/tenants/${t}/branding${tail}`;
const cap = new Map();

const by = (key) => ACTORS.find((a) => a.key === key);
const TADM_B = by('msq_tenant_admin');
const REP_B = by('msq_rep1');
const TADM_A = by('tenant_admin');
const ORGA_A = by('org_admin');

// ── O1 / O2 : tenant admin cannot cross the ownership split ──────────────────
async function tenantSplit(A) {
  const a = await actor(A.key);
  try {
    const c = cap.get(A.key) ?? await sessionCaps(a); cap.set(A.key, c);
    if (!c?.has('admin.branding.manage')) { log({ role: A.key, action: 'tenant split probes skipped (no admin.branding.manage)', method: 'PUT', endpoint: '/tenant/branding', status: null, outcome: 'visible', expected: 'n/a' }); return; }
    const own = A.tenant;
    const s0 = sig(own), sOther0 = sig(A.other);
    const forged = {
      'theme_locked (SA-owned)': { theme_locked: true },
      'product_names (SA-owned)': { product_names: { brand: { name: `${MARK}-HIJACK` } } },
      'assets (SA-owned)': { assets: { logo: { key: 'brand/x/logo.png', content_type: 'image/png', bytes: 1, updated_at: new Date().toISOString() } } },
      'public_key (SA-owned login link)': { public_key: '77777777-7777-4777-8777-777777777777' },
      'updated_by (audit column)': { updated_by: A.uid },
      'tenant_id (foreign)': { tenant_id: A.other },
      'font_size (personal-only)': { font_size: 'xl' },
      'terms (SA-owned since 1.73.0)': { terms: { leads: MARK } },
      'nav_overrides (SA-owned since 1.73.0)': { nav_overrides: { leads: { label: MARK } } },
      'locale_config (SA-owned)': { locale_config: { locale: 'en-GB' } },
      'unknown key': { is_admin: true },
      'terms + a smuggled SA field': { terms: { leads: MARK }, theme_locked: false },
    };
    const accepted = [];
    for (const [name, body] of Object.entries(forged)) {
      const r = await req(a, 'PUT', `${GATEWAY}/tenant/branding`, { data: body });
      if (isOk(r.status)) accepted.push(name);
      if (r.status >= 500) fail('medium', A.key, `PUT /tenant/branding (${name}) 5xx`, '422', `HTTP ${r.status}`, r.text.slice(0, 200), 'Strict zod schema in front of the handler.');
    }
    const changed = sig(own) !== s0 || sig(A.other) !== sOther0;
    log({ role: A.key, action: 'tenant admin PUT with SA-owned / forged fields', method: 'PUT', endpoint: '/tenant/branding', status: accepted.length ? 200 : 422, verified: !accepted.length && !changed, expected: `422 x${Object.keys(forged).length}, rows identical` });
    if (accepted.length) fail('critical', A.key, `Tenant admin wrote a field owned by Super Admin / forged: ${accepted.join(', ')}`, '422 for every one (.strict())', accepted.join(', '), `row=${JSON.stringify(rowOf(own))?.slice(0, 200)}`, 'tenantBrandingUpdateSchema must stay strict; column grants on entity.tenant_branding are the DB backstop.');
    if (changed) { fail('critical', A.key, 'A rejected tenant-admin PUT still changed a branding row', 'row signature identical (own and foreign tenant)', `own changed=${sig(own) !== s0} other changed=${sig(A.other) !== sOther0}`, '', 'Validation must precede the upsert.'); for (const s of restoreRowSql(own, own === TA ? snapA : snapB)) q(s); }

    // O2 malformed terms / menu
    const nav61 = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`item-${i}`, { label: 'x' }]));
    const bad = {
      'unknown term key': { terms: { password: 'x' } },
      'markup in a term': { terms: { leads: '<img src=x onerror=1>' } },
      'brace in a term': { terms: { leads: '{{7*7}}' } },
      'term over 24 chars': { terms: { leads: 'x'.repeat(25) } },
      'term not a string': { terms: { leads: 5 } },
      'empty term': { terms: { leads: '' } },
      'nav label markup': { nav_overrides: { leads: { label: '<b>x</b>' } } },
      'nav label over 30': { nav_overrides: { leads: { label: 'x'.repeat(31) } } },
      'nav bad id (uppercase / space)': { nav_overrides: { 'Bad Id': { label: 'x' } } },
      'nav bad icon': { nav_overrides: { leads: { icon: 'Bad Icon!' } } },
      'nav extra key': { nav_overrides: { leads: { label: 'x', href: 'https://evil.example' } } },
      '61 nav entries': { nav_overrides: nav61 },
      'bad hex': { seed_hex: 'blue' },
      'unknown preset': { preset: 'neon-pwn' },
      'unknown mode': { default_mode: 'neon' },
    };
    const s1 = sig(own);
    const took = [];
    for (const [name, body] of Object.entries(bad)) {
      const r = await req(a, 'PUT', `${GATEWAY}/tenant/branding`, { data: body });
      if (isOk(r.status)) took.push(name);
      else if (r.status >= 500) fail('medium', A.key, `PUT /tenant/branding (${name}) 5xx`, '422', `HTTP ${r.status}`, r.text.slice(0, 200), 'Validate before the DB (a CHECK violation surfacing as 500 is the tell).');
      const lk = leakOf(r.body); if (lk) fail('medium', A.key, `PUT /tenant/branding (${name}) leaks internals`, 'none', lk, '', 'Map validation errors.');
    }
    log({ role: A.key, action: 'tenant admin PUT with malformed terms / menu / theme values', method: 'PUT', endpoint: '/tenant/branding', status: took.length ? 200 : 422, verified: !took.length && sig(own) === s1, expected: `422 x${Object.keys(bad).length}, nothing stored` });
    if (took.length) { fail('high', A.key, `Tenant branding accepted invalid input: ${took.join(', ')}`, '422 and nothing stored', took.join(', '), JSON.stringify(rowOf(own))?.slice(0, 200), 'Keep the bounded zod schemas (displayText, navOverridesSchema) and the DB CHECK constraints in step.'); for (const s of restoreRowSql(own, own === TA ? snapA : snapB)) q(s); }
    else if (sig(own) !== s1) fail('high', A.key, 'Rejected terms/menu PUTs still changed the row', 'unchanged', 'signature changed', '', 'Validation precedes the upsert.');
  } finally { await a.close(); }
}

// ── O3: valid tenant write lands in OWN tenant only ──────────────────────────
async function tenantIsolation() {
  console.log('\n== O3 tenant write isolation ==');
  if (!TADM_B || !REP_B) { console.log('  (needs msq_tenant_admin and msq_rep1)'); return; }
  const ta = await actor(TADM_B.key), rp = await actor(REP_B.key);
  const otherUser = TADM_A ?? ORGA_A; const ou = otherUser ? await actor(otherUser.key) : null;
  try {
    if (!(cap.get(TADM_B.key) ?? await sessionCaps(ta))?.has('admin.branding.manage')) { console.log('  (tenant B admin lacks admin.branding.manage)'); return; }
    const sA0 = sig(TA);
    // make sure the theme is NOT locked so a colour write is meaningful too
    const sa = await actor('super_admin');
    try { await req(sa, 'PUT', SA(TB), { data: { theme_locked: false } }); } finally { await sa.close(); }
    // Terms and menu labels are Super Admin's since 1.73.0: the SA writes them, the tenant admin is refused.
    const saW = await actor('super_admin');
    let put;
    try { put = await req(saW, 'PUT', SA(TB), { data: { terms: { lead: MARK, leads: `${MARK}s` }, nav_overrides: { leads: { label: `${MARK} Nav`, icon: 'users' } } } }); } finally { await saW.close(); }
    const tryTa = await req(ta, 'PUT', `${GATEWAY}/tenant/branding`, { data: { terms: { leads: `${MARK}-TA` } } });
    log({ role: TADM_B.key, action: 'tenant admin may NOT write terms (Super Admin owns them)', method: 'PUT', endpoint: '/tenant/branding', status: tryTa.status, verified: !isOk(tryTa.status) && !(rowOf(TB)?.terms ?? '').includes(`${MARK}-TA`), expected: '4xx, nothing stored' });
    if (isOk(tryTa.status)) fail('high', TADM_B.key, 'Tenant admin wrote terms, which Super Admin owns', '422', `HTTP ${tryTa.status}`, tryTa.text.slice(0, 160), 'tenantBrandingUpdateSchema must stay strict.');
    const rowB = rowOf(TB);
    const landed = !!rowB && rowB.terms.includes(MARK) && rowB.nav_overrides.includes(`${MARK} Nav`);
    log({ role: 'super_admin', action: 'SA saves tenant B terms + menu label', method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: put.status, verified: landed, expected: 'tenant B row updated' });
    if (!isOk(put.status) || !landed) { fail('high', 'super_admin', 'Super Admin cannot save terms / menu overrides', '200 and the row reflects it', `HTTP ${put.status}`, put.text.slice(0, 200), 'saUpdateBranding / upsertTenantBranding.'); return; }
    if (sig(TA) !== sA0) fail('critical', TADM_B.key, 'A tenant B admin save changed tenant A\'s branding row', 'tenant A signature identical', 'changed', '', 'tenant_id must come from the session; RLS WITH CHECK pins it.');
    // propagation: a same-tenant colleague sees it
    const m = await req(rp, 'GET', `${GATEWAY}/me/branding`);
    const seen = JSON.stringify(m.body?.data?.terms ?? {}).includes(MARK) && JSON.stringify(m.body?.data?.nav_overrides ?? {}).includes(`${MARK} Nav`);
    log({ role: REP_B.key, action: 'colleague of the same tenant receives the new terms and menu label', method: 'GET', endpoint: '/me/branding', status: m.status, verified: seen, expected: 'visible' });
    if (!seen) fail('medium', REP_B.key, 'Tenant terms/menu change not visible to a colleague in /me/branding', 'terms + nav_overrides reflect the save', JSON.stringify(m.body?.data?.terms ?? {}).slice(0, 120), '', 'getMyBranding reads the tenant row for the session tenant.');
    // the other tenant must not see it
    if (ou) {
      const o = await req(ou, 'GET', `${GATEWAY}/me/branding`);
      const leaked = o.text.includes(MARK);
      log({ role: otherUser.key, action: 'the OTHER tenant does not receive tenant B terms / menu', method: 'GET', endpoint: '/me/branding', status: o.status, verified: !leaked, expected: 'absent' });
      if (leaked) fail('critical', otherUser.key, 'Tenant A user receives tenant B\'s branding terms/menu', 'own tenant only', 'marker present', o.text.slice(0, 160), 'RLS on entity.tenant_branding / getOwnBranding.');
    }
    // tenant admin read of the SA-owned halves is read-only and own-tenant
    const g = await req(ta, 'GET', `${GATEWAY}/tenant/branding`);
    if (isOk(g.status) && g.body?.data?.public_key && g.body.data.public_key !== pubKey(TB)) fail('critical', TADM_B.key, '/tenant/branding returns another tenant\'s login key', 'own key', String(g.body.data.public_key), '', 'RLS.');
    // SA edit of B leaves A identical
    const sa2 = await actor('super_admin');
    try {
      const sA1 = sig(TA);
      const sp = await req(sa2, 'PUT', SA(TB), { data: { preset: 'sky-velocity', default_mode: 'light' } });
      log({ role: 'super_admin', action: 'SA edit of tenant B leaves tenant A byte-identical', method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: sp.status, verified: sig(TA) === sA1 && rowOf(TB)?.preset === 'sky-velocity', expected: 'A unchanged, B changed' });
      if (sig(TA) !== sA1) fail('critical', 'super_admin', 'SA edit of tenant B changed tenant A', 'tenant A unchanged', 'changed', '', 'saUpdateBranding must pin the :id tenant.');
    } finally { await sa2.close(); }
  } finally { await ta.close(); await rp.close(); if (ou) await ou.close(); }
}

// ── O4: SA half is not a back door to tenant-owned or personal fields ────────
async function superAdminHalf() {
  console.log('\n== O4 Super Admin half ==');
  const sa = await actor('super_admin').catch(() => null);
  if (!sa) { console.log('  (no super_admin login)'); return; }
  try {
    const s0 = sig(TB);
    const bad = {
      'font_size (personal-only)': { font_size: 'xl' },
      'public_key (use rotate-key)': { public_key: '88888888-8888-4888-8888-888888888888' },
      'tenant_id in body': { tenant_id: TA },
      'assets (use the upload route)': { assets: {} },
    };
    const took = [];
    for (const [n, body] of Object.entries(bad)) {
      const r = await req(sa, 'PUT', SA(TB), { data: body });
      if (isOk(r.status)) took.push(n); else if (r.status >= 500) fail('medium', 'super_admin', `SA PUT (${n}) 5xx`, '422', `HTTP ${r.status}`, r.text.slice(0, 160), 'saBrandingUpdateSchema is strict.');
    }
    log({ role: 'super_admin', action: 'SA PUT with personal / forged fields', method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: took.length ? 200 : 422, verified: !took.length && sig(TB) === s0, expected: `422 x${Object.keys(bad).length}, nothing stored` });
    if (took.length) fail('high', 'super_admin', `SA branding PUT accepted fields it does not own: ${took.join(', ')}`, '422 (the halves are separate strict schemas)', took.join(', '), '', 'Keep saBrandingUpdateSchema and tenantBrandingUpdateSchema disjoint.');
    for (const [n, url, want] of [['unknown tenant', SA('99999999-9999-4999-8999-999999999999'), 404], ['malformed tenant id', SA('not-a-uuid'), 422]]) {
      const r = await req(sa, 'PUT', url, { data: { default_mode: 'light' } });
      log({ role: 'super_admin', action: `SA PUT on ${n}`, method: 'PUT', endpoint: '/sa/tenants/:id/branding', status: r.status, verified: r.status === want, expected: String(want) });
      if (r.status >= 500) fail('high', 'super_admin', `SA PUT on ${n} 5xx`, String(want), `HTTP ${r.status}`, r.text.slice(0, 160), 'requireTenant -> NotFound.');
      else if (r.status !== want) fail('low', 'super_admin', `SA PUT on ${n} status`, String(want), `HTTP ${r.status}`, r.text.slice(0, 120), '');
    }
    const g = await req(sa, 'GET', SA('99999999-9999-4999-8999-999999999999'));
    if (isOk(g.status)) fail('medium', 'super_admin', 'SA GET of a tenant that does not exist returns 200', '404', 'HTTP 200', g.text.slice(0, 120), 'saGetBranding must requireTenant.');
  } finally { await sa.close(); }
}

// ── F1 / F2: text size per login ─────────────────────────────────────────────
const STEPS = ['sm', 'md', 'lg', 'xl'];
async function textSize(A) {
  const a = await actor(A.key);
  try {
    const c = cap.get(A.key) ?? await sessionCaps(a); cap.set(A.key, c);
    const has = c ? c.has('platform.appearance') : null;
    const others = ACTORS.filter((x) => x.uid !== A.uid);
    const tSig0 = sig(A.tenant), oSig0 = sig(A.other);
    const otherPrefs0 = new Map(others.map((x) => [x.uid, prefRaw(x.uid)]));
    for (const step of STEPS) {
      const r = await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: step } });
      const landed = prefFont(A.uid) === step;
      grade(rep, { role: A.key, scenario: `PUT /me/preferences/theme font_size=${step}`, has, status: r.status, effect: landed, method: 'PUT', endpoint: '/me/preferences/theme', evidence: `${r.text.slice(0, 120)} row=${prefRaw(A.uid).slice(0, 80)}`, fixOver: 'updateMyTheme must requireCap(PLATFORM_APPEARANCE) for font_size too.' });
      if (isOk(r.status)) {
        const m = await req(a, 'GET', `${GATEWAY}/me/branding`);
        const t = m.body?.data;
        const ok = t?.personal?.font_size === step && (t?.theme?.user?.font_size ?? null) === step;
        log({ role: A.key, action: `/me/branding reflects text size ${step}`, method: 'GET', endpoint: '/me/branding', status: m.status, verified: ok, expected: `personal.font_size and theme.user.font_size == ${step}` });
        if (!ok) fail('medium', A.key, `Saved text size ${step} is not reflected in /me/branding`, `theme.user.font_size == ${step}`, JSON.stringify({ personal: t?.personal, user: t?.theme?.user }).slice(0, 200), '', 'getMyBranding user layer / locked layer must carry font_size.');
      }
    }
    // F2 invalid values: stored value must not change
    const keep = prefRaw(A.uid);
    const invalid = { 'xxl': 'xxl', 'large': 'large', '12px': '12px', 'uppercase': 'XL', 'empty': '', 'number': 14, 'array': ['sm'], 'object': { pct: 300 }, 'null-byte': 'x\u0000l', 'percent': '300%' };
    const took = [];
    for (const [n, v] of Object.entries(invalid)) {
      const r = await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: v } });
      if (isOk(r.status)) took.push(n); else if (r.status >= 500) fail('medium', A.key, `PUT font_size (${n}) 5xx`, '422', `HTTP ${r.status}`, r.text.slice(0, 160), 'Validate before the DB.');
    }
    const forged = await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: 'xl', user_id: others[0]?.uid, tenant_id: A.other } });
    const forgedTook = isOk(forged.status);
    const kept = prefRaw(A.uid) === keep;
    if (has) {
      log({ role: A.key, action: 'invalid font_size values and forged ids are rejected', method: 'PUT', endpoint: '/me/preferences/theme', status: took.length ? 200 : 422, verified: !took.length && !forgedTook && kept, expected: `422 x${Object.keys(invalid).length + 1}, stored value unchanged` });
      if (took.length) fail('high', A.key, `Text-size write accepted invalid input: ${took.join(', ')}`, '422 (z.enum sm|md|lg|xl)', took.join(', '), `row=${prefRaw(A.uid)}`, 'Keep FONT_SIZE_IDS strict in themeChoiceSchema; an arbitrary pct would defeat the 4-step design.');
      if (forgedTook) fail('critical', A.key, 'Text-size write accepted a client-supplied user_id / tenant_id', '422 (strict schema)', `HTTP ${forged.status}`, forged.text.slice(0, 160), 'userThemeUpdateSchema is .strict(); identity only from the session.');
      if (!kept && !forgedTook) fail('high', A.key, 'Rejected font_size writes changed the stored preference', 'unchanged', `${keep.slice(0, 60)} -> ${prefRaw(A.uid).slice(0, 60)}`, '', 'Validation precedes the upsert.');
    }
    // nothing else moved
    const moved = others.filter((x) => prefRaw(x.uid) !== otherPrefs0.get(x.uid)).map((x) => x.key);
    log({ role: A.key, action: 'text-size writes touch only the caller\'s preferences row and no branding row', method: 'GET', endpoint: 'iam.user_preferences', status: 200, verified: !moved.length && sig(A.tenant) === tSig0 && sig(A.other) === oSig0, expected: 'no other row changed' });
    if (moved.length) fail('critical', A.key, `A text-size write changed OTHER users' preferences: ${moved.join(', ')}`, 'only the caller\'s row', moved.join(', '), '', 'setOwnTheme must pin user_id to the session.');
    if (sig(A.tenant) !== tSig0 || sig(A.other) !== oSig0) fail('high', A.key, 'A personal text-size write changed a tenant branding row', 'entity.tenant_branding untouched', 'signature changed', '', 'Personal prefs live in iam.user_preferences only.');
    // tenant-owned endpoints refuse font_size
    const tb = await req(a, 'PUT', `${GATEWAY}/tenant/branding`, { data: { font_size: 'xl' } });
    if (isOk(tb.status)) fail('high', A.key, 'PUT /tenant/branding accepted font_size', '422 (text size is personal, never tenant-wide)', `HTTP ${tb.status}`, tb.text.slice(0, 160), 'tenantBrandingUpdateSchema omits font_size.');
    // reset
    const clr = await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`);
    if (has && !isOk(clr.status)) fail('medium', A.key, 'DELETE /me/preferences/theme failed after text-size writes', '2xx', `HTTP ${clr.status}`, clr.text.slice(0, 120), '');
    if (isOk(clr.status) && prefFont(A.uid)) fail('medium', A.key, 'Reset left a stored font_size behind', 'no font_size', String(prefFont(A.uid)), '', 'clearMyTheme sets theme NULL.');
  } finally { await a.close(); }
}

// ── F3: lock covers colour/font, never text size / mode ──────────────────────
async function lockedTextSize() {
  console.log('\n== F3 locked theme keeps text size ==');
  if (!REP_B) { console.log('  (needs msq_rep1)'); return; }
  const sa = await actor('super_admin').catch(() => null); if (!sa) return;
  const u = await actor(REP_B.key);
  try {
    if (!(cap.get(REP_B.key) ?? await sessionCaps(u))?.has('platform.appearance')) { console.log('  (msq_rep1 lacks platform.appearance)'); return; }
    await req(sa, 'PUT', SA(TB), { data: { preset: 'emerald-fit', theme_locked: true } });
    await req(u, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { preset: 'royal-violet', font: 'outfit', mode: 'dark', font_size: 'xl' } });
    const m = (await req(u, 'GET', `${GATEWAY}/me/branding`)).body?.data;
    const user = m?.theme?.user ?? {};
    const sizeKept = user.font_size === 'xl' && user.mode === 'dark';
    const coloursStripped = !user.preset && !user.font && !user.seed_hex;
    log({ role: REP_B.key, action: 'locked tenant: personal text size + mode apply, personal colour/font are stripped', method: 'GET', endpoint: '/me/branding', status: 200, verified: sizeKept && coloursStripped && m?.theme?.locked === true, expected: 'user layer = {mode, font_size}' });
    if (!sizeKept) fail('high', REP_B.key, 'Tenant theme lock removed the user\'s text size / mode', 'theme.user.font_size == xl and mode == dark while locked', JSON.stringify(user), '', 'getMyBranding locked branch must keep {mode, font_size}.');
    if (!coloursStripped) fail('high', REP_B.key, 'Tenant theme lock leaks the user\'s personal colour/font', 'preset/font/seed_hex stripped while locked', JSON.stringify(user), '', 'getMyBranding locked branch.');
    if (!/royal-violet/.test(prefRaw(REP_B.uid))) fail('medium', REP_B.key, 'Personal colour was not stored while locked (unlocking would lose it)', 'stored as chosen', prefRaw(REP_B.uid), '', 'updateMyTheme stores as chosen; the lock is applied at resolve time.');
    // size-only write under lock
    const only = await req(u, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: 'sm' } });
    log({ role: REP_B.key, action: 'text size can still be changed while the theme is locked', method: 'PUT', endpoint: '/me/preferences/theme', status: only.status, verified: isOk(only.status) && prefFont(REP_B.uid) === 'sm', expected: '200 and stored' });
    if (!isOk(only.status) || prefFont(REP_B.uid) !== 'sm') fail('high', REP_B.key, 'Text size cannot be changed while the tenant theme is locked', '200 (text size is exempt from the lock)', `HTTP ${only.status}`, only.text.slice(0, 160), 'updateMyTheme must not gate font_size on theme_locked.');
    // unlock restores personal colours
    await req(sa, 'PUT', SA(TB), { data: { theme_locked: false } });
    const m2 = (await req(u, 'GET', `${GATEWAY}/me/branding`)).body?.data;
    if (m2?.theme?.locked !== false || m2?.theme?.user?.preset !== 'royal-violet') fail('medium', REP_B.key, 'Unlocking the theme did not restore the user\'s stored colour', 'theme.user.preset == royal-violet', JSON.stringify(m2?.theme?.user), '', 'Lock is applied at resolve time only.');
  } finally { await u.close(); await sa.close(); }
}

// ── F4: public responses carry no personal data ──────────────────────────────
async function publicNoPersonal() {
  console.log('\n== F4 public branding carries no personal data ==');
  const an = await anon();
  try {
    for (const [lbl, t] of [['tenant A', TA], ['tenant B', TB]]) {
      const key = pubKey(t); if (!key) continue;
      const r = await req(an, 'GET', `${GATEWAY}/public/branding/${key}`);
      const bad = /font_size|"personal"|user_preferences|theme_locked|"terms"|nav_overrides|updated_by|tenant_id/.test(r.text);
      log({ role: 'anonymous', action: `public branding of ${lbl} omits personal / tenant-internal fields`, method: 'GET', endpoint: '/public/branding/:key', status: r.status, verified: r.status < 500 && !bad, expected: 'allow-listed display fields only' });
      if (r.status >= 500) fail('medium', 'anonymous', 'Public branding 5xx', '200', `HTTP ${r.status}`, r.text.slice(0, 120), '');
      if (bad) fail('high', 'anonymous', `Public branding of ${lbl} exposes personal or tenant-internal fields`, 'brand name, colours, logo only', r.text.slice(0, 200), '', 'getPublicBranding allow-list.');
    }
  } finally { await an.close(); }
}

try {
  console.log(`branding-ownership: ${ACTORS.length} logins; tenant A=${TA.slice(0, 8)} B=${TB.slice(0, 8)} (B row ${snapB ? 'exists' : 'absent'})`);
  for (const A of ACTORS) {
    console.log(`\n-- ${A.key} --`);
    await tenantSplit(A).catch((e) => { console.log(e.stack); fail('high', A.key, 'tenant split pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
    await textSize(A).catch((e) => { console.log(e.stack); fail('high', A.key, 'text size pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
  }
  await tenantIsolation().catch((e) => { console.log(e.stack); fail('high', 'ui', 'tenant isolation pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
  await superAdminHalf().catch((e) => { console.log(e.stack); fail('high', 'super_admin', 'SA half pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
  await lockedTextSize().catch((e) => { console.log(e.stack); fail('high', 'msq_rep1', 'locked text size pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error'); });
  await publicNoPersonal().catch((e) => { console.log(e.stack); fail('high', 'anonymous', 'public pass crashed', 'completes', String(e.message).slice(0, 200), '', ''); });
} finally {
  for (const s of restoreRowSql(TA, snapA)) q(s);
  for (const s of restoreRowSql(TB, snapB)) q(s);
  runRestore('brandown-A'); runRestore('brandown-B'); runRestore('brandown-prefs');
  const okA = JSON.stringify(rowOf(TA)) === JSON.stringify(snapA);
  const okB = snapB ? JSON.stringify(rowOf(TB)) === JSON.stringify(snapB) : rowOf(TB) === null;
  console.log(`\nrestored branding: tenant A ${okA ? 'identical' : 'DIFFERS'}, tenant B ${okB ? 'identical' : 'DIFFERS'}; findings=${rep.state.findings} actions=${rep.state.actions}`);
}
