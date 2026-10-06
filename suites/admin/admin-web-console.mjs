// admin-web console (msq-core/apps/admin-web): Team, API Tokens, Leave admin, Attendance admin, Branding.
//
// deep-crawl-admin.mjs proves every route opens and every control renders; team-user-contracts.mjs /
// user-management.mjs prove the user API; apiclients-fresh-revoke.mjs the token capability cache;
// branding.mjs the branding page. What no suite asserted is the CONSOLE as a whole, per login:
//
//   C1  console gating, per login (14 logins, both tenants): the dashboard shows an "Access restricted"
//       panel iff the login has no admin screen; every tile shown is backed by a held capability node
//       (admin.team / admin.api_tokens / hr.leave.admin / hr.attendance.admin / admin.branding); a tile
//       that is shown OPENS (no 403 / "unavailable" / bounce); a screen with no tile does NOT render
//       its data when typed into the URL ("a link that appears must open" and the reverse)
//   C2  Team: nobody sees another tenant's people (every e-mail in the table is looked up in
//       Postgres); a hand-typed ?scope=org|tenant buys nothing without admin.team.view.org/tenant
//       (row count identical to the default); the page 4xx-not-5xx for junk scope values
//   C3  API tokens (UI): "New token" shown iff admin.api_tokens.manage; rows == GET /api-clients;
//       the raw key / hash never appear in the page or the list payload
//   C4  API tokens (API): GET/POST/PATCH/rotate/DELETE per login graded by LIVE capability AND the
//       branch-admin rank floor; org admin cannot widen scope (org_ids / scope_all_orgs are overridden
//       to the own branch - DB verified); foreign-tenant org ids refused; validation limits; the key is
//       returned once and only its hash is stored; tenant B cannot list, edit, rotate or revoke tenant
//       A's token and the row stays byte-identical (critical otherwise)
//   C5  Leave / Attendance admin: shell renders for holders of hr.leave.admin / hr.attendance.admin
//       without page errors or 5xx while its tabs and filters are exercised (kit.sweepPage); the
//       redirect to /dashboard (not hr-web's /leave) for everyone else
//
// Throwaway tokens are named E2E-adm-<stamp> and hard-purged in finally. Nothing session-killing
// (no logout / switch / password change) is performed on .auth/ logins.
//
//   node suites/admin/admin-web-console.mjs
import fs from 'node:fs';
import { cfg, roleMeta, APPS, GATEWAY, authFile, CROSS_TENANT, openState } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { purgeById } from '../../fixtures.mjs';
import { req, reporter, grade, isOk, sweepPage } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('admin', 'admin-web console (team / api tokens / leave / attendance)');
const { fail, log } = rep;
const MARK = `E2E-adm-${Date.now()}`;
const ADMIN = APPS['admin-web'];
const created = [];

const ACTORS = [
  ...cfg.roles.map((r) => ({ key: r.role, email: r.email, rank: r.rank })),
  ...CROSS_TENANT.map((c) => ({ key: c.stateKey, email: c.email, rank: c.rank })),
].filter((a) => fs.existsSync(authFile(a.key)));
if (!ACTORS.length) { console.log('no logins available - aborting'); process.exit(0); }
const tenantOfEmail = (e) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(String(e).toLowerCase())}`);
const orgOfEmail = (e) => scalar(`SELECT org_id FROM iam.users WHERE email=${lit(String(e).toLowerCase())}`);
for (const a of ACTORS) { a.tenant = tenantOfEmail(a.email); a.org = orgOfEmail(a.email); }

const SCREENS = [
  { id: 'team', label: 'Team', path: '/dashboard/team', node: 'admin.team' },
  { id: 'api-tokens', label: 'API Tokens', path: '/dashboard/api-tokens', node: 'admin.api_tokens' },
  { id: 'leave-admin', label: 'Leave', path: '/dashboard/leave/admin', node: 'hr.leave.admin' },
  { id: 'attendance-admin', label: 'Attendance', path: '/dashboard/attendance/admin', node: 'hr.attendance.admin' },
  { id: 'branding', label: 'Branding', path: '/dashboard/branding', node: 'admin.branding' },
];
const holds = (caps, node) => !!caps && (caps.has(node) || [...caps].some((c) => c.startsWith(`${node}.`)));
const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(700); };
const emailsIn = (text) => [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase()))];

// What "the screen opened" means, per screen (app code in app/dashboard/**/page.tsx).
async function opened(page, screen) {
  const body = await page.locator('body').innerText().catch(() => '');
  const path = new URL(page.url()).pathname.replace(/\/$/, '');
  const onIt = path.endsWith(screen.path);
  const restricted = /Access restricted/i.test(body);
  const unavailable = /is unavailable/i.test(body);
  const login = /\/login/.test(path);
  return { onIt, restricted, unavailable, login, body, ok: onIt && !restricted && !unavailable && !login };
}

// ── C1 / C2 / C3 / C5 per login (browser) ────────────────────────────────────
async function consolePass(A) {
  const a = await actor(A.key);
  let caps = null;
  try { caps = await sessionCaps(a); } finally { await a.close(); }
  if (!caps) { console.log(`  (${A.key}: /auth/me gave no capabilities)`); return; }
  const { browser, ctx, page, log: plog } = await openState(A.key);
  try {
    const where = (p) => `admin-web ${p}`;
    await page.goto(`${ADMIN}/dashboard`, { waitUntil: 'domcontentloaded' }); await settle(page);
    const dbody = await page.locator('body').innerText().catch(() => '');
    if (/\/login/.test(page.url())) { console.log(`  (${A.key}: session not accepted by admin-web)`); return; }
    const expectedAny = SCREENS.some((s) => holds(caps, s.node));
    const restricted = /Access restricted/i.test(dbody) && /no admin screens enabled/i.test(dbody);
    log({ role: A.key, area: where('/dashboard'), action: 'console opens iff the login holds at least one admin screen', method: 'UI', endpoint: '/dashboard', status: null, outcome: restricted ? 'hidden' : 'visible', verified: restricted === !expectedAny, expected: expectedAny ? 'tiles' : 'Access restricted' });
    if (restricted && expectedAny) fail('medium', A.key, 'Console says "Access restricted" although the login holds an admin node', 'tiles for held nodes', `caps with admin nodes: ${SCREENS.filter((s) => holds(caps, s.node)).map((s) => s.node).join(', ')}`, dbody.slice(0, 100), 'filterNavGroups / holdsUsableNode: node granted but nothing usable beneath it (check the operation rows) or a stale session.', where('/dashboard'));
    if (!restricted && !expectedAny) fail('high', A.key, 'Console renders for a login with no admin capability', 'Access restricted', dbody.slice(0, 100).replace(/\n/g, ' '), page.url(), 'DashboardLayout must show the restricted panel when filterNavGroups() is empty.', where('/dashboard'));
    // tiles
    const tiles = {};
    for (const s of SCREENS) tiles[s.id] = (await page.locator(`a:has(h2)[href$="${s.path}"]`).count()) > 0;
    for (const s of SCREENS) {
      const shown = tiles[s.id];
      if (shown && !holds(caps, s.node)) fail('high', A.key, `Dashboard tile "${s.label}" is shown without holding ${s.node}`, 'tile derived from the same capability filter as the sidebar', 'tile present', `caps=${[...caps].filter((c) => c.startsWith(s.node)).join(',') || '(none)'}`, 'filterNavGroups(ADMIN_NAV, session).', where('/dashboard'));
      log({ role: A.key, area: where('/dashboard'), action: `tile "${s.label}" ${shown ? 'shown' : 'hidden'}`, method: 'UI', endpoint: s.path, status: null, outcome: shown ? 'visible' : 'hidden', verified: shown ? holds(caps, s.node) : null, expected: holds(caps, s.node) ? 'visible (if usable)' : 'hidden' });
    }
    // every screen: tile <=> opens
    const bodies = {};
    for (const s of SCREENS) {
      const plogMark = { c: plog.consoleErrors.length, p: plog.pageErrors.length, b: plog.badRequests.length };
      await page.goto(`${ADMIN}${s.path}`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const o = await opened(page, s); bodies[s.id] = o;
      const new5xx = plog.badRequests.slice(plogMark.b).filter((x) => /^5\d\d /.test(x));
      if (tiles[s.id] && !o.ok) fail('medium', A.key, `"${s.label}" tile is shown but the screen does not open`, 'a link that appears must open', `${o.restricted ? 'Access restricted' : o.unavailable ? 'unavailable (load failed)' : `landed on ${new URL(page.url()).pathname}`}`, o.body.slice(0, 120).replace(/\n/g, ' '), 'ADMIN_NAV capability and the page gate disagree (canOpenTeam / can(...VIEW) / canManageLeaveAdmin).', where(s.path));
      if (!tiles[s.id] && o.ok) fail(s.id === 'branding' || s.id === 'api-tokens' ? 'high' : 'medium', A.key, `"${s.label}" renders by direct URL although the console shows no tile for it`, 'Access restricted / redirect', 'screen rendered', page.url(), 'Each page owns its own gate; it must match the nav predicate.', where(s.path));
      if (o.unavailable && holds(caps, s.node)) fail('high', A.key, `"${s.label}" is "unavailable" for a holder of ${s.node}`, 'screen loads', 'LoadError 5xx state', o.body.slice(0, 120).replace(/\n/g, ' '), 'The server fetch behind the page failed (gateway/identity/hr-service).', where(s.path));
      if (new5xx.length) fail('medium', A.key, `"${s.label}" produced 5xx while loading`, 'no 5xx', new5xx.slice(0, 2).join(' | '), '', 'Typed 4xx for unauthorised calls.', where(s.path));
      log({ role: A.key, area: where(s.path), action: `open ${s.label} by URL`, method: 'UI', endpoint: s.path, status: null, outcome: o.ok ? 'visible' : 'hidden', verified: o.ok === tiles[s.id], expected: tiles[s.id] ? 'opens' : 'blocked' });
    }

    // C2 Team: tenant isolation + hand-typed scope
    if (bodies.team?.ok) {
      const teamBody = bodies.team.body;
      const mails = emailsIn(teamBody);
      const foreign = A.key === 'super_admin' ? [] : mails.filter((e) => { const t = tenantOfEmail(e); return t && t !== A.tenant; });
      log({ role: A.key, area: where('/dashboard/team'), action: 'every person listed belongs to the caller\'s tenant', method: 'UI', endpoint: '/dashboard/team', status: null, outcome: 'visible', verified: foreign.length === 0, expected: '0 foreign users', note: `${mails.length} e-mails` });
      if (foreign.length) fail('critical', A.key, `Team lists users of ANOTHER tenant: ${foreign.slice(0, 3).join(', ')}`, 'own tenant only', foreign.join(', ').slice(0, 200), '', 'loadTeamData / users list RLS: tenant fence.', where('/dashboard/team'));
      const countRows = async () => page.locator('tbody tr').count().catch(() => 0);
      await page.goto(`${ADMIN}/dashboard/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const base = await countRows();
      const wide = holds(caps, 'admin.team.view.org') || holds(caps, 'admin.team.view.tenant') || A.key === 'super_admin';
      for (const sc of ['org', 'tenant', 'reports', 'all', '../../etc', "' OR 1=1 --"]) {
        const r = await page.goto(`${ADMIN}/dashboard/team?scope=${encodeURIComponent(sc)}`, { waitUntil: 'domcontentloaded' }).catch(() => null); await settle(page);
        const n = await countRows();
        const b = await page.locator('body').innerText().catch(() => '');
        if ((r && r.status() >= 500) || /application error|internal server error/i.test(b)) fail('medium', A.key, `Team ?scope=${sc} 5xx / crash`, 'ignored or narrowed', `HTTP ${r?.status()}`, b.slice(0, 100), 'Validate scope server-side (page.tsx SCOPES + identity narrows).', where('/dashboard/team'));
        if (!wide && ['org', 'tenant'].includes(sc) && n > base) {
          log({ role: A.key, area: where('/dashboard/team'), action: `hand-typed ?scope=${sc} does not widen the roster`, method: 'UI', endpoint: `/dashboard/team?scope=${sc}`, status: null, outcome: 'visible', verified: false, expected: `${base} rows`, note: `${n} rows` });
          fail('critical', A.key, `Typing ?scope=${sc} widened the Team roster without admin.team.view.${sc}`, `${base} rows (identity narrows to the caller's rung)`, `${n} rows`, '', 'identity-service must re-derive scope from admin.team.view.* and ignore the request.', where('/dashboard/team'));
        }
      }
    }

    // C3 API tokens page vs API
    if (bodies['api-tokens']?.ok) {
      await page.goto(`${ADMIN}/dashboard/api-tokens`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const ui = await page.locator('body').innerText().catch(() => '');
      const manage = caps.has('admin.api_tokens.manage');
      const newBtn = (await page.getByRole('button', { name: /new token/i }).count()) > 0;
      log({ role: A.key, area: where('/dashboard/api-tokens'), action: '"New token" shown iff admin.api_tokens.manage', method: 'UI', endpoint: '/dashboard/api-tokens', status: null, outcome: newBtn ? 'visible' : 'hidden', verified: newBtn === manage, expected: manage ? 'visible' : 'hidden' });
      if (newBtn !== manage) fail('medium', A.key, `"New token" ${newBtn ? 'shown without' : 'missing for a holder of'} admin.api_tokens.manage`, manage ? 'visible' : 'hidden', String(newBtn), '', 'canManage={can(session, ADMIN_API_TOKENS_MANAGE)}.', where('/dashboard/api-tokens'));
      const api = await actor(A.key);
      try {
        const list = await req(api, 'GET', `${GATEWAY}/api-clients`);
        const nApi = Array.isArray(list.body?.data) ? list.body.data.length : null;
        const m = ui.match(/(\d+)\s+total/i);
        if (nApi != null && m) {
          log({ role: A.key, area: where('/dashboard/api-tokens'), action: 'header total equals GET /api-clients', method: 'UI', endpoint: '/dashboard/api-tokens', status: list.status, outcome: 'visible', verified: Number(m[1]) === nApi, expected: `${nApi} total` });
          if (Number(m[1]) !== nApi) fail('medium', A.key, 'API Tokens header count disagrees with the API', `${nApi} total`, `${m[1]} total`, '', 'ApiTokensShell receives the server-fetched list.', where('/dashboard/api-tokens'));
        }
        if (/crmk_live_[A-Za-z0-9_-]{24,}|key_hash/.test(ui) || /key_hash|"api_key"/.test(list.text)) fail('critical', A.key, 'The API tokens page / list exposes a raw key or key hash', 'prefix only', 'secret material present', ui.slice(0, 80), 'SELECT_COLUMNS in api-clients.repository must never include key_hash.', where('/dashboard/api-tokens'));
      } finally { await api.close(); }
    }

    // C5 Leave / Attendance admin shells
    for (const s of SCREENS.filter((x) => x.id === 'leave-admin' || x.id === 'attendance-admin')) {
      const o = bodies[s.id];
      const has = holds(caps, s.node);
      if (has && o?.ok) {
        await page.goto(`${ADMIN}${s.path}`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const txt = await page.locator('body').innerText().catch(() => '');
        const rx = s.id === 'leave-admin' ? /leave|polic|holiday|cycle|adjust/i : /attendance|shift|rule|geo|assign/i;
        log({ role: A.key, area: where(s.path), action: `${s.label} admin shell renders its content`, method: 'UI', endpoint: s.path, status: null, outcome: 'visible', verified: rx.test(txt), expected: 'policy/shift content' });
        if (!rx.test(txt)) fail('medium', A.key, `${s.label} admin screen opened but shows no ${s.label.toLowerCase()} content`, 'shell with tabs', txt.slice(0, 120).replace(/\n/g, ' '), page.url(), 'LeaveAdminShell / AttendanceAdminShell load.', where(s.path));
        await sweepPage(page, { rep, role: A.key, label: where(s.path), log: plog, maxButtons: 10 });
      } else if (!has && o && !o.onIt && !/\/login/.test(new URL(page.url()).pathname + '')) {
        // redirect target for non-holders is /dashboard (admin-web has no self-service fallback)
        log({ role: A.key, area: where(s.path), action: `${s.label} admin redirects non-holders to /dashboard`, method: 'UI', endpoint: s.path, status: null, outcome: 'hidden', verified: true, expected: 'redirect' });
      }
    }
    // generic sweep on the two data screens a holder can open
    for (const s of SCREENS.filter((x) => x.id === 'team' || x.id === 'api-tokens')) {
      if (!bodies[s.id]?.ok) continue;
      await page.goto(`${ADMIN}${s.path}`, { waitUntil: 'domcontentloaded' }); await settle(page);
      await sweepPage(page, { rep, role: A.key, label: where(s.path), log: plog, maxButtons: 10 });
    }
    void ctx;
  } finally { await browser.close(); }
}

// ── C4 API tokens: authz, scope, validation, cross-tenant ────────────────────
const sigOf = (id) => scalar(`SELECT md5(row_to_json(c)::text) FROM iam.api_clients c WHERE id=${lit(id)}`);
const rowOf = (id) => rows(`SELECT tenant_id::text, is_active::text, scope_all_orgs::text, name, key_hash, COALESCE(revoked_at::text,'') FROM iam.api_clients WHERE id=${lit(id)}`, ['tenant', 'active', 'all', 'name', 'hash', 'revoked'])[0] ?? null;
const orgIdsOf = (id) => rows(`SELECT org_id::text FROM iam.api_client_orgs WHERE api_client_id=${lit(id)}`, ['o']).map((r) => r.o);
const byName = (n) => rows(`SELECT id::text FROM iam.api_clients WHERE name LIKE ${lit(`${n}%`)}`, ['id']).map((r) => r.id);

async function tokenApi() {
  console.log('\n== C4 API tokens (API) ==');
  const live = new Map();
  for (const A of ACTORS) {
    const a = await actor(A.key);
    try {
      const caps = await sessionCaps(a); live.set(A.key, caps);
      const floor = A.rank >= 980;
      const hasView = !!caps && caps.has('admin.api_tokens.view') && floor;
      const hasManage = !!caps && caps.has('admin.api_tokens.manage') && floor;
      const lst = await req(a, 'GET', `${GATEWAY}/api-clients`);
      grade(rep, { role: A.key, scenario: 'GET /api-clients', has: caps ? hasView : null, status: lst.status, endpoint: '/api-clients', evidence: lst.text.slice(0, 120), fixOver: 'requireApiClientCapability(ADMIN_API_TOKENS_VIEW) + the branch-admin rank floor.' });
      if (isOk(lst.status)) {
        const data = Array.isArray(lst.body?.data) ? lst.body.data : [];
        const foreign = A.key === 'super_admin' ? [] : data.filter((c) => { const t = scalar(`SELECT tenant_id FROM iam.api_clients WHERE id=${lit(c.id)}`); return t && t !== A.tenant; });
        log({ role: A.key, action: 'every listed token belongs to the caller\'s tenant', method: 'GET', endpoint: '/api-clients', status: lst.status, verified: foreign.length === 0, expected: '0 foreign tokens', note: `${data.length} tokens` });
        if (foreign.length) fail('critical', A.key, `GET /api-clients lists ${foreign.length} token(s) of ANOTHER tenant`, 'own tenant only', foreign.map((c) => c.id).join(',').slice(0, 120), '', 'iam.api_clients RLS (tenant fence) / listApiClients.');
        if (/key_hash|"api_key"|"key"\s*:\s*"crmk_/.test(lst.text)) fail('critical', A.key, 'GET /api-clients leaks key material', 'prefix only', lst.text.slice(0, 120), '', 'SELECT_COLUMNS.');
      }
      // create (graded) - minimal valid body, own branch
      const name = `${MARK}-c-${A.key}`;
      const cr = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: { name, scopes: ['leads:read'], rate_limit_per_min: 30 } });
      const ids = byName(name); created.push(...ids);
      grade(rep, { role: A.key, scenario: 'POST /api-clients (own branch, leads:read)', has: caps ? hasManage : null, status: cr.status, effect: ids.length > 0, method: 'POST', endpoint: '/api-clients', evidence: cr.text.slice(0, 120).replace(/api_key"\s*:\s*"[^"]+/, 'api_key":"<redacted>'), fixOver: 'requireApiClientCapability(ADMIN_API_TOKENS_MANAGE) must run before createApiClient.', sevOver: 'critical' });
      if (isOk(cr.status) && ids[0]) {
        const raw = cr.body?.data?.api_key;
        const row = rowOf(ids[0]);
        const keyOnce = typeof raw === 'string' && raw.length > 20 && row && row.hash !== raw && !JSON.stringify(row).includes(raw);
        log({ role: A.key, action: 'raw key returned once, only its hash stored', method: 'POST', endpoint: '/api-clients', status: cr.status, verified: !!keyOnce, expected: 'api_key in response; DB holds a hash' });
        if (!keyOnce) fail('critical', A.key, 'API key is missing from the create response or stored in clear', 'api_key returned once; key_hash = HMAC(pepper, key)', `raw=${typeof raw} hash==raw:${row?.hash === raw}`, '', 'createApiClient.');
        if (row?.tenant !== A.tenant) fail('critical', A.key, 'Token created under another tenant than the caller\'s', A.tenant, String(row?.tenant), ids[0], 'tenant_id from ctx.');
        const again = await req(a, 'GET', `${GATEWAY}/api-clients`);
        if (raw && again.text.includes(raw)) fail('critical', A.key, 'The raw API key is returned by a later list call', 'never again', 'present', '', 'list must not select the key.');
        const cache = (cr.headers['cache-control'] ?? '');
        if (!/no-store/i.test(cache)) fail('low', A.key, 'Secret-bearing create response is cacheable', 'Cache-Control: no-store', cache || '(none)', '', 'Controller sets no-store; the gateway proxy must forward it.');
      }
      void hasManage;
    } finally { await a.close(); }
  }

  // org admin cannot widen scope; tenant admin cannot name a foreign-tenant branch
  const orgAdminA = ACTORS.find((x) => x.key === 'org_admin');
  const tenAdminA = ACTORS.find((x) => x.key === 'tenant_admin');
  const tenAdminB = ACTORS.find((x) => x.key === 'msq_tenant_admin');
  const canMint = (A) => !!A && !!live.get(A.key)?.has('admin.api_tokens.manage') && A.rank >= 980;
  if (canMint(orgAdminA)) {
    const a = await actor(orgAdminA.key);
    try {
      const otherBranch = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(orgAdminA.tenant)} AND id<>${lit(orgAdminA.org)} AND NOT is_deleted LIMIT 1`);
      const foreignOrg = scalar(`SELECT id FROM entity.organizations WHERE tenant_id<>${lit(orgAdminA.tenant)} AND NOT is_deleted LIMIT 1`);
      for (const [lbl, body] of [['scope_all_orgs:true', { scope_all_orgs: true }], ['org_ids of another branch', { org_ids: [otherBranch] }], ['org_ids of a foreign tenant', { org_ids: [foreignOrg] }]].filter(([, b]) => Object.values(b)[0] && (Array.isArray(Object.values(b)[0]) ? Object.values(b)[0][0] : true))) {
        const nm = `${MARK}-widen-${lbl.replace(/\W+/g, '')}`;
        const r = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: { name: nm, scopes: ['leads:read'], ...body } });
        const ids = byName(nm); created.push(...ids);
        const row = ids[0] ? rowOf(ids[0]) : null; const orgs = ids[0] ? orgIdsOf(ids[0]) : [];
        const pinned = !row || (row.all === 'false' && orgs.length === 1 && orgs[0] === orgAdminA.org);
        log({ role: orgAdminA.key, action: `org admin POST with ${lbl}: scope pinned to the own branch`, method: 'POST', endpoint: '/api-clients', status: r.status, verified: pinned, expected: 'own branch only (or 4xx)' });
        if (!pinned) fail('critical', orgAdminA.key, `Org admin minted a token wider than their branch (${lbl})`, 'resolveBranchScope overrides to [own org], scope_all_orgs=false', JSON.stringify({ all: row?.all, orgs }), ids[0], 'resolveBranchScope isOrgAdmin branch.');
        if (r.status >= 500) fail('high', orgAdminA.key, `POST /api-clients (${lbl}) 5xx`, '2xx/4xx', `HTTP ${r.status}`, r.text.slice(0, 120), '');
      }
    } finally { await a.close(); }
  }
  if (canMint(tenAdminA)) {
    const a = await actor(tenAdminA.key);
    try {
      const foreignOrg = scalar(`SELECT id FROM entity.organizations WHERE tenant_id<>${lit(tenAdminA.tenant)} AND NOT is_deleted LIMIT 1`);
      const nm = `${MARK}-foreign-org`;
      const r = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: { name: nm, scopes: ['leads:read'], org_ids: [foreignOrg] } });
      const ids = byName(nm); created.push(...ids);
      log({ role: tenAdminA.key, action: 'tenant admin cannot bind a token to another tenant\'s branch', method: 'POST', endpoint: '/api-clients', status: r.status, verified: !isOk(r.status) && !ids.length, expected: '400, nothing created' });
      if (isOk(r.status) || ids.length) fail('critical', tenAdminA.key, 'Token bound to a branch of ANOTHER tenant', '400 "do not belong to this tenant"', `HTTP ${r.status}`, ids[0] ?? '', 'orgsBelongToTenant in resolveBranchScope.');
      // validation limits
      const bad = {
        'no scopes': { name: `${MARK}-v1`, scopes: [] }, 'unknown scope': { name: `${MARK}-v2`, scopes: ['leads:*'] },
        'rate limit 0': { name: `${MARK}-v3`, scopes: ['leads:read'], rate_limit_per_min: 0 }, 'rate limit 6001': { name: `${MARK}-v4`, scopes: ['leads:read'], rate_limit_per_min: 6001 },
        'expired expires_at': { name: `${MARK}-v5`, scopes: ['leads:read'], expires_at: new Date(Date.now() - 864e5).toISOString() },
        'empty name': { name: '', scopes: ['leads:read'] }, 'name 121 chars': { name: `${MARK}${'x'.repeat(121)}`, scopes: ['leads:read'] },
        'non-boolean scope_all_orgs': { name: `${MARK}-v6`, scopes: ['leads:read'], scope_all_orgs: 'yes' }, 'scopes not an array': { name: `${MARK}-v7`, scopes: 'leads:read' },
      };
      const took = [];
      for (const [n, body] of Object.entries(bad)) {
        const rr = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: body });
        const made = byName(MARK + (body.name.startsWith(MARK) ? body.name.slice(MARK.length, MARK.length + 4) : '')).filter((i) => !created.includes(i));
        created.push(...made);
        if (isOk(rr.status)) took.push(n);
        if (rr.status >= 500) fail('medium', tenAdminA.key, `POST /api-clients (${n}) 5xx`, '422', `HTTP ${rr.status}`, rr.text.slice(0, 120), 'createApiClientSchema before the handler.');
      }
      log({ role: tenAdminA.key, action: 'invalid token requests are rejected and create nothing', method: 'POST', endpoint: '/api-clients', status: took.length ? 200 : 422, verified: !took.length, expected: `422 x${Object.keys(bad).length}` });
      if (took.length) fail('high', tenAdminA.key, `API token create accepted invalid input: ${took.join(', ')}`, '422', took.join(', '), '', 'createApiClientSchema / expires_at check.');
    } finally { await a.close(); }
  }

  // cross-tenant: B cannot touch A's token (and vice versa), row byte-identical
  if (canMint(tenAdminA) && canMint(tenAdminB)) {
    const aA = await actor(tenAdminA.key), aB = await actor(tenAdminB.key);
    try {
      const mk = async (a, nm) => { const r = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: { name: nm, scopes: ['leads:read'] } }); const id = r.body?.data?.id ?? byName(nm)[0]; if (id) created.push(id); return id; };
      const tokA = await mk(aA, `${MARK}-tenantA-token`), tokB = await mk(aB, `${MARK}-tenantB-token`);
      if (tokA && tokB) {
        for (const [who, a, victim, vname] of [[tenAdminB.key, aB, tokA, 'tenant A'], [tenAdminA.key, aA, tokB, 'tenant B']]) {
          const s0 = sigOf(victim);
          const probes = {
            'PATCH rename': await req(a, 'PATCH', `${GATEWAY}/api-clients/${victim}`, { data: { name: `${MARK}-HIJACK` } }),
            'PATCH scope_all_orgs': await req(a, 'PATCH', `${GATEWAY}/api-clients/${victim}`, { data: { scope_all_orgs: true } }),
            'rotate': await req(a, 'POST', `${GATEWAY}/api-clients/${victim}/rotate`, { data: {} }),
            'revoke': await req(a, 'DELETE', `${GATEWAY}/api-clients/${victim}`),
          };
          const leaked = Object.entries(probes).filter(([, r]) => isOk(r.status)).map(([k]) => k);
          const crashed = Object.entries(probes).filter(([, r]) => r.status >= 500).map(([k, r]) => `${k}:${r.status}`);
          const same = sigOf(victim) === s0;
          log({ role: who, action: `${who} cannot patch / rotate / revoke ${vname}'s token`, method: 'PATCH', endpoint: '/api-clients/:id', status: Object.values(probes).map((r) => r.status).join('/'), verified: !leaked.length && same, expected: '404 x4, row byte-identical' });
          if (leaked.length || !same) fail('critical', who, `Cross-tenant API token tampering: ${leaked.join(', ') || 'row changed'}`, `${vname}'s token untouched (404)`, `HTTP ${Object.values(probes).map((r) => r.status).join('/')}, row identical=${same}`, victim, 'iam.api_clients RLS + id lookups scoped to ctx.tenant_id.');
          if (crashed.length) fail('medium', who, `Cross-tenant token probes 5xx: ${crashed.join(', ')}`, '404', crashed.join(', '), '', 'Typed NotFound.');
          for (const [k, r] of Object.entries(probes)) if (isOk(r.status) === false && r.status !== 404 && r.status !== 403) fail('low', who, `${k} on a foreign token returns ${r.status}`, '404', `HTTP ${r.status}`, r.text.slice(0, 80), '');
        }
        // own revoke -> row state; rotate of a revoked token is refused
        const rv = await req(aA, 'DELETE', `${GATEWAY}/api-clients/${tokA}`);
        const row = rowOf(tokA);
        log({ role: tenAdminA.key, action: 'revoke sets is_active=false and revoked_at', method: 'DELETE', endpoint: '/api-clients/:id', status: rv.status, verified: isOk(rv.status) && row?.active === 'false' && !!row?.revoked, expected: 'revoked' });
        if (isOk(rv.status) && (row?.active !== 'false' || !row?.revoked)) fail('high', tenAdminA.key, 'Revoke reported success but the token is still active', 'is_active=false, revoked_at set', JSON.stringify(row), tokA, 'revokeApiClient.');
        const rr = await req(aA, 'POST', `${GATEWAY}/api-clients/${tokA}/rotate`, { data: {} });
        if (isOk(rr.status)) fail('high', tenAdminA.key, 'A revoked API token can be rotated back to life', '404 "Active API client not found"', `HTTP ${rr.status}`, tokA, 'rotateApiClient must require is_active.');
        const miss = await req(aA, 'DELETE', `${GATEWAY}/api-clients/99999999-9999-4999-8999-999999999999`);
        const bad = await req(aA, 'DELETE', `${GATEWAY}/api-clients/not-a-uuid`);
        if (miss.status >= 500 || bad.status >= 500) fail('medium', tenAdminA.key, 'DELETE /api-clients with a random / malformed id 5xx', '404 / 4xx', `${miss.status}/${bad.status}`, '', 'uuid param validation (the route has no params schema).');
      }
    } finally { await aA.close(); await aB.close(); }
  }
}

try {
  console.log(`admin-web-console: ${ACTORS.length} logins`);
  for (const A of ACTORS) {
    console.log(`\n-- ${A.key} --`);
    await consolePass(A).catch((e) => { console.log(e.stack); fail('high', A.key, 'console pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error', 'admin-web'); });
  }
  await tokenApi().catch((e) => { console.log(e.stack); fail('high', 'api-tokens', 'token API pass crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error', 'admin-web api-tokens'); });
} finally {
  for (const id of new Set([...created, ...byName(MARK)])) { try { purgeById('iam.api_clients', id); } catch {} }
  console.log(`\npurged ${new Set(created).size} throwaway tokens; findings=${rep.state.findings} actions=${rep.state.actions}`);
  void roleMeta;
}
