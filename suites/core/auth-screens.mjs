// auth-web authenticated screens that no suite drove in a browser: /select-branch, /no-access
// (and the anonymous guard on /change-password). /forgot-password, /reset-password and /offline
// are covered by auth-recovery.mjs; the branch API by switch-org.mjs - this one proves the SCREENS
// agree with those APIs and fail safe.
//
//   S1  anonymous GET /select-branch, /no-access, /change-password: redirect to /login (3xx), never
//       200 with content, never 5xx; a hostile ?callbackUrl= never ends up in the Location header
//   S2  /select-branch for a multi-branch login (tenant admin A, tenant admin B, super admin):
//       the buttons shown == GET /auth/my-orgs (names, count, "Default" marker), nothing from the
//       other tenant is in the DOM, super admin is grouped under tenant headings, search filters
//       (> 6 branches) and "no match" copy
//   S3  picking a branch calls switch-org, lands on the callback, and /auth/me now reports that
//       branch; a refused switch (403 forced by route interception) shows an alert, keeps the picker
//       usable and does not navigate; a failed my-orgs lookup does not strand the user on a spinner
//   S4  hostile callbackUrl values (https://evil.example, //evil.example, javascript:, a lookalike
//       host) never produce a navigation or request to the foreign host after a successful pick
//   S5  single-branch login is sent straight on - the picker is never rendered
//   N1  /no-access for a user WITH product access bounces to the product (no dead end)
//   N2  /no-access for a user with NO usable product (read_only login with the product roots
//       denied through journalled tenant overrides): the card shows the CALLER's email / branch /
//       tenant / role only, offers Switch branch + Sign out; Sign out ends the session; re-granting
//       the capability bounces the user off the page on the next visit
//
// Every session is a conc.freshLogin (switch-org / logout revoke the jti) - nothing in .auth/ is
// touched. Capability overrides are journalled and restored in finally.
//
//   node suites/core/auth-screens.mjs
import fs from 'node:fs';
import { cfg, roleMeta, APPS, GATEWAY, CROSS_TENANT, authFile } from '../../lib.mjs';
import { freshLogin } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { req, anon, reporter, sleep, isOk } from '../../kit.mjs';
import { setOverride, restoreAll, loadJournal, tenantIdForOrg } from '../../capability.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('core', 'auth-web screens (select-branch / no-access)');
const { fail, log } = rep;
const AUTH = APPS['auth-web'];
const LMS_DEST = `${APPS['lms-web']}/dashboard/leads`;
loadJournal(); restoreAll();

const emailOf = (role) => roleMeta(role)?.email;
const tenantOfEmail = (e) => scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(String(e).toLowerCase())}`);
const orgNamesOfTenant = (t) => new Set(rows(`SELECT name FROM entity.organizations WHERE tenant_id=${lit(t)} AND NOT is_deleted`, ['n']).map((r) => r.n));
const settle = async (page, ms = 900) => { await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(ms); };
const branchButtons = (page) => page.locator('section button[aria-busy]');
const branchNames = async (page) => (await branchButtons(page).evaluateAll((els) => els.map((e) => (e.querySelector('span span')?.textContent ?? '').trim()))).filter(Boolean);
async function myOrgs(s) {
  const r = await req(s, 'GET', `${GATEWAY}/auth/my-orgs`);
  return { status: r.status, orgs: r.body?.data?.orgs ?? [], text: r.text };
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// ── S1 anonymous ─────────────────────────────────────────────────────────────
async function anonymousGuards() {
  console.log('\n== S1 anonymous guards ==');
  const an = await anon();
  try {
    const targets = [
      ['/select-branch', ''], ['/select-branch', '?callbackUrl=https://evil.example/steal'], ['/select-branch', `?callbackUrl=${encodeURIComponent('//evil.example')}`],
      ['/no-access', ''], ['/change-password', ''],
    ];
    for (const [p, qs] of targets) {
      const r = await req(an, 'GET', `${AUTH}${p}${qs}`);
      const loc = r.headers.location ?? '';
      const redirected = r.status >= 300 && r.status < 400 && /\/login/.test(loc);
      const content = r.status === 200 && /Select your branch|No products are assigned|Change password/i.test(r.text) && !/sign in|log in/i.test(r.text);
      log({ role: 'anonymous', area: 'auth-web', action: `GET ${p}${qs ? ' (hostile callbackUrl)' : ''} without a session`, method: 'GET', endpoint: p, status: r.status, verified: redirected && !/evil\.example/.test(loc), expected: '3xx -> /login, no foreign host in Location' });
      if (r.status >= 500 || r.status < 0) fail('high', 'anonymous', `${p} without a session 5xx`, '3xx to /login', `HTTP ${r.status}`, r.text.slice(0, 160), 'getServerSession() null -> redirect(buildLoginUrl()).', `auth-web ${p}`);
      else if (content) fail('high', 'anonymous', `${p} renders authenticated content without a session`, 'redirect to /login', 'page content served', r.text.slice(0, 160), 'The page must redirect before rendering.', `auth-web ${p}`);
      else if (!redirected) fail('medium', 'anonymous', `${p} without a session does not redirect to /login`, '3xx Location: /login...', `HTTP ${r.status} ${loc.slice(0, 120)}`, '', 'redirect(buildLoginUrl(callback)).', `auth-web ${p}`);
      if (/evil\.example/.test(loc)) fail('high', 'anonymous', `${p}: hostile callbackUrl survives into the login redirect`, 'dropped by resolveCallback', loc.slice(0, 200), '', 'resolveCallback must reject foreign origins before buildLoginUrl().', `auth-web ${p}`);
    }
  } finally { await an.close(); }
}

// ── S2 / S3 / S4 select-branch for multi-branch logins ───────────────────────
async function pickerFor(label, email, { expectGroups = false, tenantId = null } = {}) {
  console.log(`\n== select-branch: ${label} ==`);
  const s = await freshLogin(email);
  try {
    if (!isOk(s.loginStatus)) { console.log(`  (login ${s.loginStatus} - skipped)`); return; }
    const mo = await myOrgs(s);
    if (!isOk(mo.status)) { fail('high', label, 'GET /auth/my-orgs failed for a logged-in user', '200', `HTTP ${mo.status}`, mo.text.slice(0, 160), 'identity getMyOrgs.', 'auth-web /select-branch'); return; }
    const page = await s.context.newPage();
    const reqs = [];
    page.on('request', (r) => reqs.push(r.url()));
    const url = `${AUTH}/select-branch?callbackUrl=${encodeURIComponent(LMS_DEST)}`;
    if (mo.orgs.length <= 1) { console.log(`  (${label}: ${mo.orgs.length} branch - covered by S5)`); return; }
    await page.goto(url, { waitUntil: 'domcontentloaded' }); await settle(page);
    const head = await page.locator('h1, h2').first().innerText().catch(() => '');
    const names = await branchNames(page);
    const apiNames = mo.orgs.map((o) => o.org_name);
    const sameSet = names.length === apiNames.length && [...names].sort().join('|') === [...apiNames].sort().join('|');
    log({ role: label, area: 'auth-web /select-branch', action: 'branches shown equal GET /auth/my-orgs', method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: sameSet, expected: `${apiNames.length} branches`, note: `heading="${head.slice(0, 40)}" shown=${names.length}` });
    if (!/select your branch/i.test(await page.locator('body').innerText().catch(() => ''))) fail('medium', label, 'Select-branch heading missing for a multi-branch user', '"Select your branch"', head.slice(0, 80), page.url(), 'page.tsx / AuthCard.', 'auth-web /select-branch');
    if (!sameSet) fail('high', label, 'Branch picker disagrees with /auth/my-orgs', `${apiNames.length} branches: ${apiNames.slice(0, 4).join(', ')}...`, `${names.length} shown: ${names.slice(0, 4).join(', ')}...`, '', 'SelectBranchList renders res.data.orgs unfiltered; check client mapping.', 'auth-web /select-branch');
    // the home branch is marked
    const homeApi = mo.orgs.find((o) => o.is_home)?.org_name;
    if (homeApi) {
      const txt = await page.locator('section button[aria-busy]', { hasText: homeApi }).first().innerText().catch(() => '');
      if (!/default/i.test(txt)) fail('low', label, 'Home branch is not marked "Default" in the picker', `"${homeApi}" · Default`, txt.slice(0, 80), '', 'org.is_home marker.', 'auth-web /select-branch');
    }
    // tenant isolation in the DOM
    const t = tenantId ?? tenantOfEmail(email);
    if (!expectGroups && t) {
      const own = orgNamesOfTenant(t);
      const foreign = names.filter((n) => !own.has(n));
      log({ role: label, area: 'auth-web /select-branch', action: 'every branch shown belongs to the caller\'s tenant', method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: foreign.length === 0, expected: '0 foreign branches' });
      if (foreign.length) fail('critical', label, `Branch picker lists branches of ANOTHER tenant: ${foreign.slice(0, 3).join(', ')}`, 'own tenant only', foreign.join(', ').slice(0, 200), '', 'getMyOrgs must be tenant-bound for non-super-admins.', 'auth-web /select-branch');
    }
    if (expectGroups) {
      const groups = await page.locator('section h2').allInnerTexts().catch(() => []);
      const tenantNames = new Set(mo.orgs.map((o) => o.tenant_name).filter(Boolean));
      log({ role: label, area: 'auth-web /select-branch', action: 'super admin list is grouped under tenant headings', method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: tenantNames.size === 0 || groups.length >= Math.min(tenantNames.size, 2), expected: `${tenantNames.size} tenant headings` });
      if (tenantNames.size > 1 && groups.length < 2) fail('low', label, 'Cross-tenant picker is not grouped by tenant', 'one heading per tenant', `${groups.length} headings`, groups.join('|').slice(0, 120), 'groupByTenant needs tenant_id on every row.', 'auth-web /select-branch');
    }
    // search (rendered only above 6 branches)
    const search = page.getByLabel('Search branches');
    if (names.length > 6) {
      const has = (await search.count()) > 0;
      log({ role: label, area: 'auth-web /select-branch', action: 'search box present above 6 branches', method: 'UI', endpoint: '/select-branch', status: null, outcome: has ? 'visible' : 'hidden', verified: has, expected: 'visible' });
      if (!has) fail('low', label, 'No search box although the list has more than 6 branches', 'Search branches input', 'absent', '', 'orgs.length > 6 branch.', 'auth-web /select-branch');
      else {
        const needle = names[0].split(/[\s-]+/).filter((w) => w.length > 2)[0] ?? names[0].slice(0, 3);
        await search.fill(needle); await page.waitForTimeout(300);
        const shown = await branchNames(page);
        const expect = mo.orgs.filter((o) => [o.org_name, o.role_label, o.tenant_name ?? ''].some((v) => String(v).toLowerCase().includes(needle.toLowerCase()))).length;
        log({ role: label, area: 'auth-web /select-branch', action: `search "${needle}" filters client-side`, method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: shown.length === expect, expected: `${expect} rows`, note: `shown ${shown.length}` });
        if (shown.length !== expect) fail('low', label, 'Branch search returns the wrong rows', `${expect} rows for "${needle}"`, `${shown.length}`, shown.slice(0, 5).join(', '), 'Filter over org_name / role_label / tenant_name.', 'auth-web /select-branch');
        await search.fill(`zz-no-such-branch-${Date.now()}`); await page.waitForTimeout(300);
        const empty = await page.locator('body').innerText().catch(() => '');
        if (!/No branches match/i.test(empty)) fail('low', label, 'No "No branches match" message for an empty search', 'empty-state copy', empty.slice(0, 80), '', '', 'auth-web /select-branch');
        await search.fill('');
      }
    }
    const reqNames = await branchNames(page);

    // S3a refused switch: forced 403 -> alert, picker stays, no navigation
    await page.route('**/api/auth/switch-org', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'You do not have access to that branch' } }) }));
    const before = page.url();
    await branchButtons(page).first().click();
    await page.waitForTimeout(800);
    const alertTxt = await page.locator('[role="alert"]').first().innerText().catch(() => '');
    const stillThere = page.url() === before && (await branchButtons(page).count()) === reqNames.length;
    const enabled = await branchButtons(page).first().isEnabled().catch(() => false);
    log({ role: label, area: 'auth-web /select-branch', action: 'refused switch-org shows an alert and keeps the picker usable', method: 'UI', endpoint: 'POST /auth/switch-org', status: 403, outcome: 'denied', verified: !!alertTxt && stillThere && enabled, expected: 'alert, no navigation, buttons re-enabled' });
    if (!alertTxt) fail('medium', label, 'A refused branch switch shows no error to the user', 'role=alert message', '(none)', page.url(), 'handleSelect catch -> setError.', 'auth-web /select-branch');
    if (!stillThere || !enabled) fail('medium', label, 'After a refused switch the picker is stuck or navigated away', 'same page, buttons enabled', `url=${page.url()} enabled=${enabled}`, '', 'setSwitching(null) in the catch.', 'auth-web /select-branch');
    await page.unroute('**/api/auth/switch-org');

    // S3b real switch to a NON-home branch: lands on callback; /auth/me follows
    const target = mo.orgs.find((o) => !o.is_home) ?? mo.orgs[0];
    const sw = page.waitForResponse((r) => r.request().method() === 'POST' && /\/auth\/switch-org/.test(r.url()), { timeout: 15000 }).catch(() => null);
    await page.locator('section button[aria-busy]', { hasText: target.org_name }).first().click();
    const swr = await sw;
    await page.waitForURL((u) => !/\/select-branch/.test(u.pathname), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const me = await req(s, 'GET', `${GATEWAY}/auth/me`);
    const nowOrg = me.body?.data?.user?.org_id;
    const lands = hostOf(page.url()) === hostOf(LMS_DEST) && !/\/select-branch/.test(page.url());
    log({ role: label, area: 'auth-web /select-branch', action: `pick "${target.org_name}" -> switch-org -> callback`, method: 'UI', endpoint: 'POST /auth/switch-org', status: swr?.status() ?? null, outcome: swr && swr.status() < 300 ? 'allowed' : 'error', verified: !!swr && swr.status() < 300 && nowOrg === target.org_id && lands, expected: 'session re-minted for the chosen branch, redirected to the callback' });
    if (!swr || swr.status() >= 300) fail('high', label, 'Picking a branch did not call switch-org successfully', '2xx', String(swr?.status()), page.url(), 'auth.switchOrg client.', 'auth-web /select-branch');
    else {
      if (nowOrg !== target.org_id) fail('high', label, 'Session is not on the branch the user picked', `org_id == ${target.org_id}`, String(nowOrg), '', 'switch-org must re-mint for the chosen branch.', 'auth-web /select-branch');
      if (!lands) fail('medium', label, 'After picking a branch the user is not sent to the callback', LMS_DEST, page.url(), '', 'window.location.assign(callbackUrl).', 'auth-web /select-branch');
    }
    void reqs;
  } finally { await s.close(); }
}

// S4 hostile callbackUrl values: a fresh multi-branch session each is expensive (login bucket), so
// one session runs the values in turn, re-opening the picker each time.
async function hostileCallbacks(email, label) {
  console.log(`\n== S4 hostile callbackUrl (${label}) ==`);
  const s = await freshLogin(email);
  try {
    if (!isOk(s.loginStatus)) { console.log('  (login failed - skipped)'); return; }
    const mo = await myOrgs(s);
    if (!isOk(mo.status) || mo.orgs.length < 2) { console.log('  (needs a multi-branch login)'); return; }
    const hostile = ['https://evil.example/steal', '//evil.example/steal', 'javascript:alert(1)', 'https://app.localhost.evil.example/x', 'https://evil.example@app.localhost/x'];
    for (const cb of hostile) {
      const page = await s.context.newPage();
      const touched = [];
      await page.route(/evil\.example/, (route) => { touched.push(route.request().url()); return route.abort(); });
      page.on('request', (r) => { if (/evil\.example/.test(r.url())) touched.push(r.url()); });
      let dialog = false; page.on('dialog', (d) => { dialog = true; d.dismiss().catch(() => {}); });
      try {
        await page.goto(`${AUTH}/select-branch?callbackUrl=${encodeURIComponent(cb)}`, { waitUntil: 'domcontentloaded' }); await settle(page, 700);
        // single-branch fallthrough would navigate immediately; a multi-branch user sees the list
        const target = (await branchButtons(page).count()) ? mo.orgs.find((o) => o.is_home) ?? mo.orgs[0] : null;
        if (target) {
          await page.locator('section button[aria-busy]', { hasText: target.org_name }).first().click().catch(() => {});
          await page.waitForTimeout(1500);
        }
        const finalHost = hostOf(page.url());
        const bad = touched.length > 0 || /evil\.example/.test(finalHost) || dialog || /^javascript:/i.test(page.url());
        log({ role: label, area: 'auth-web /select-branch', action: `callbackUrl=${cb} never leaves our origins`, method: 'UI', endpoint: '/select-branch?callbackUrl=', status: null, outcome: 'visible', verified: !bad, expected: 'no navigation / request to a foreign host, no script execution' });
        if (bad) fail('high', label, `select-branch honoured a hostile callbackUrl: ${cb}`, 'resolveCallback rejects it; user lands on the session destination', `touched=${touched[0] ?? '-'} url=${page.url().slice(0, 100)} dialog=${dialog}`, '', 'resolveCallback (origin allowlist) must run before the callback reaches SelectBranchList.', 'auth-web /select-branch');
      } finally { await page.close(); }
    }
  } finally { await s.close(); }
}

// ── S5 single-branch login is sent straight on ───────────────────────────────
async function singleBranch() {
  console.log('\n== S5 single-branch login ==');
  const cands = [emailOf('sales_representative'), emailOf('fitness_trainer'), emailOf('org_manager')].filter(Boolean);
  for (const email of cands) {
    const s = await freshLogin(email);
    try {
      if (!isOk(s.loginStatus)) continue;
      const mo = await myOrgs(s);
      if (!isOk(mo.status) || mo.orgs.length !== 1) continue;
      const page = await s.context.newPage();
      await page.goto(`${AUTH}/select-branch?callbackUrl=${encodeURIComponent(LMS_DEST)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL((u) => !/\/select-branch/.test(u.pathname), { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(500);
      const left = !/\/select-branch/.test(page.url());
      const listed = (await branchButtons(page).count()) > 0;
      log({ role: email, area: 'auth-web /select-branch', action: 'a single-branch user is forwarded to the callback without a picker', method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: left && !listed, expected: 'redirect, no list' });
      if (!left || listed) fail('medium', email, 'Single-branch user is shown a one-item branch picker', 'forwarded to the product', page.url(), '', 'SelectBranchList: orgs.length <= 1 -> assign(callbackUrl).', 'auth-web /select-branch');
      // a failed my-orgs lookup must not strand the user on a spinner
      const p2 = await s.context.newPage();
      await p2.route('**/api/auth/my-orgs', (route) => route.abort());
      await p2.goto(`${AUTH}/select-branch?callbackUrl=${encodeURIComponent(LMS_DEST)}`, { waitUntil: 'domcontentloaded' });
      await p2.waitForURL((u) => !/\/select-branch/.test(u.pathname), { timeout: 12000 }).catch(() => {});
      const stuck = /\/select-branch/.test(p2.url());
      log({ role: email, area: 'auth-web /select-branch', action: 'a failed my-orgs lookup does not strand the user on the spinner', method: 'UI', endpoint: '/select-branch', status: null, outcome: 'visible', verified: !stuck, expected: 'forwarded to the callback' });
      if (stuck) fail('medium', email, 'select-branch hangs on the loading spinner when /auth/my-orgs fails', 'fall through to the callback', p2.url(), '', 'auth.myOrgs().catch -> window.location.assign(callbackUrl).', 'auth-web /select-branch');
      return;
    } finally { await s.close(); }
  }
  console.log('  (no single-branch login available - skipped)');
}

// ── N1 / N2 no-access ────────────────────────────────────────────────────────
async function noAccessWithProducts() {
  console.log('\n== N1 /no-access is not a dead end ==');
  for (const email of [emailOf('org_admin'), CROSS_TENANT.find((c) => c.role === 'tenant_admin')?.email].filter(Boolean)) {
    const s = await freshLogin(email);
    try {
      if (!isOk(s.loginStatus)) continue;
      const page = await s.context.newPage();
      await page.goto(`${AUTH}/no-access`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL((u) => !/\/no-access/.test(u.pathname), { timeout: 12000 }).catch(() => {});
      const left = !/\/no-access/.test(page.url());
      const body = await page.locator('body').innerText().catch(() => '');
      log({ role: email, area: 'auth-web /no-access', action: 'a user with product access is redirected away from /no-access', method: 'UI', endpoint: '/no-access', status: null, outcome: 'visible', verified: left && !/No products are assigned/i.test(body), expected: 'redirect to the product landing' });
      if (!left) fail('medium', email, 'A user WITH product access is stranded on /no-access', 'redirect to sessionDestination', page.url(), body.slice(0, 100), 'page.tsx usableProducts(...).length > 0 -> redirect.', 'auth-web /no-access');
    } finally { await s.close(); }
  }
}

async function noAccessWithout() {
  console.log('\n== N2 /no-access for a user with no usable product ==');
  const ro = roleMeta('read_only');
  if (!ro?.email || !fs.existsSync(authFile('read_only'))) { console.log('  (read_only login not provisioned - run provision-readonly.mjs; skipped)'); return; }
  const TA = tenantIdForOrg(ro.org);
  const ROOTS = ['lms', 'hr.attendance', 'hr.leave', 'hr.employees', 'tasks'];
  let s = null;
  try {
    for (const k of ROOTS) { try { setOverride(TA, 'read_only', k, false); } catch (e) { console.log(`  (override ${k}: ${String(e.message).slice(0, 60)})`); } }
    await sleep(1500);
    s = await freshLogin(ro.email);
    if (!isOk(s.loginStatus)) { console.log(`  (read_only login ${s.loginStatus} - skipped)`); return; }
    const me = (await req(s, 'GET', `${GATEWAY}/auth/me`)).body?.data?.user ?? {};
    const page = await s.context.newPage();
    await page.goto(`${AUTH}/no-access`, { waitUntil: 'domcontentloaded' }); await settle(page);
    const body = await page.locator('body').innerText().catch(() => '');
    const shown = /No products are assigned to your account/i.test(body);
    log({ role: 'read_only', area: 'auth-web /no-access', action: 'product-less user sees the explanation card', method: 'UI', endpoint: '/no-access', status: null, outcome: shown ? 'visible' : 'hidden', verified: shown, expected: 'card visible', note: `caps=${(me.capabilities ?? []).length}` });
    if (!shown) { fail('medium', 'read_only', 'A user with no usable product does not get the no-access card', 'No products are assigned...', `${page.url()} :: ${body.slice(0, 100).replace(/\n/g, ' ')}`, `caps=${(me.capabilities ?? []).filter((c) => /^(lms|hr|tasks)/.test(c)).slice(0, 5)}`, 'usableProducts() / override cascade; check iam.fn_role_capability_matrix for read_only.', 'auth-web /no-access'); }
    else {
      const emailShown = body.toLowerCase().includes(ro.email.toLowerCase());
      const orgName = me.org_name ?? ro.org;
      const tenantName = scalar(`SELECT name FROM entity.tenants WHERE id=${lit(TA)}`);
      const otherTenant = scalar(`SELECT name FROM entity.tenants WHERE id<>${lit(TA)} AND NOT is_deleted ORDER BY name LIMIT 1`);
      log({ role: 'read_only', area: 'auth-web /no-access', action: 'card shows the CALLER\'s email, branch, tenant and role only', method: 'UI', endpoint: '/no-access', status: null, outcome: 'visible', verified: emailShown && body.includes(orgName) && body.includes(tenantName) && !(otherTenant && body.includes(otherTenant)), expected: 'own identity only' });
      if (!emailShown) fail('medium', 'read_only', 'No-access card does not show who is signed in', ro.email, body.slice(0, 160), '', 'rows[] from session.email.', 'auth-web /no-access');
      if (otherTenant && body.includes(otherTenant)) fail('critical', 'read_only', 'No-access card names ANOTHER tenant', 'own tenant only', otherTenant, '', 'session.tenant_name.', 'auth-web /no-access');
      const sw = await page.getByRole('link', { name: /switch branch/i }).count();
      const so = await page.getByRole('button', { name: /sign out/i }).count();
      log({ role: 'read_only', area: 'auth-web /no-access', action: 'Switch branch link and Sign out button present', method: 'UI', endpoint: '/no-access', status: null, outcome: 'visible', verified: sw > 0 && so > 0, expected: 'both' });
      if (!sw || !so) fail('low', 'read_only', 'No-access card is missing an action', 'Switch branch + Sign out', `switch=${sw} signout=${so}`, '', '', 'auth-web /no-access');
      // the card must not leak through /select-branch: single branch user is forwarded, not shown others
      // re-grant -> next visit bounces
      restoreAll();
      await sleep(1500);
      await page.goto(`${AUTH}/no-access`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL((u) => !/\/no-access/.test(u.pathname), { timeout: 12000 }).catch(() => {});
      const bounced = !/\/no-access/.test(page.url());
      log({ role: 'read_only', area: 'auth-web /no-access', action: 'after the capability is granted back the next visit leaves /no-access', method: 'UI', endpoint: '/no-access', status: null, outcome: 'visible', verified: bounced, expected: 'redirect to the product' });
      if (!bounced) fail('low', 'read_only', 'User stays on /no-access after entitlements were granted', 'redirect once usableProducts() > 0', page.url(), '', 'The page re-reads the session each visit; check getServerSession caching.', 'auth-web /no-access');
      // Sign out ends the session (fresh session only)
      await page.goto(`${AUTH}/no-access`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      for (const k of ROOTS) { try { setOverride(TA, 'read_only', k, false); } catch {} }
      await sleep(1500);
      await page.goto(`${AUTH}/no-access`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const btn = page.getByRole('button', { name: /sign out/i }).first();
      if (await btn.count()) {
        const lo = page.waitForResponse((r) => /\/auth\/logout/.test(r.url()), { timeout: 10000 }).catch(() => null);
        await btn.click(); await lo;
        await page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
        const after = await req(s, 'GET', `${GATEWAY}/auth/me`);
        log({ role: 'read_only', area: 'auth-web /no-access', action: 'Sign out ends the session and returns to /login', method: 'UI', endpoint: 'POST /auth/logout', status: after.status, outcome: 'visible', verified: after.status === 401 && /\/login/.test(page.url()), expected: '/auth/me 401, on /login' });
        if (after.status !== 401) fail('high', 'read_only', 'Sign out on /no-access leaves the session alive', '/auth/me 401', `HTTP ${after.status}`, '', 'SignOutButton -> auth.logout (revokes the jti).', 'auth-web /no-access');
      }
    }
  } finally {
    restoreAll();
    if (s) await s.close();
  }
}

try {
  await anonymousGuards();
  const tadA = CROSS_TENANT ? roleMeta('tenant_admin')?.email : null;
  const tadB = CROSS_TENANT.find((c) => c.role === 'tenant_admin')?.email;
  const sa = roleMeta('super_admin')?.email;
  if (tadA) await pickerFor('tenant_admin (Fitclass)', tadA);
  if (tadB) await pickerFor('msq_tenant_admin (MSquare)', tadB);
  if (sa) await pickerFor('super_admin', sa, { expectGroups: true });
  if (tadA) await hostileCallbacks(tadA, 'tenant_admin (Fitclass)');
  await singleBranch();
  await noAccessWithProducts();
  await noAccessWithout();
} catch (e) {
  console.log(e.stack);
  fail('high', 'harness', 'auth-screens suite aborted', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'see log');
} finally {
  const n = restoreAll();
  void cfg;
  console.log(`\nrestored ${n} capability overrides; findings=${rep.state.findings} actions=${rep.state.actions}`);
}
