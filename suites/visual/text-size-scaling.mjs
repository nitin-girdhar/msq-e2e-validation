// Personal TEXT SIZE (4 steps: sm 87.5 % / md 100 % / lg 112.5 % / xl 125 % of the root font size) and
// the rem-only rule, checked at RUNTIME in every app.
//
// docs/Architecture.md (Text size): <ThemeStyle> emits html{font-size:<pct>%}; every rem token, spacing
// and grid follows it; new code uses rem/tokens, never text-[Npx]; AG Grid CSS is rem. `pnpm check:theme`
// guards the source - this suite guards what actually renders, which is what a user sees:
//
//   T1  PX-PIN SWEEP: every route of every app (tools.config routes + the new pages: /tasks/<id>,
//       /tasks/lists, lookup-admin branding + tenant branding, auth-web /login /forgot-password
//       /reset-password /offline /select-branch /change-password) is loaded; every visible text
//       element's computed font-size is read at the page's own size, then with the root forced to
//       87.5 % and 125 % (inline html style - the same CSS cascade ThemeStyle uses). An element that
//       does not follow the root (ratio ~1) is a hardcoded-px (or rem-defeating) size. Elements that
//       are aria-hidden / inside <svg> / opted out (data-fixed-size) are exempt by design (e.g. the
//       "Aa" size samples). Also lists first-party px font-size rules in the loaded stylesheets.
//   T2  PERSISTED SIZE: for each writer login the size is saved through PUT /me/preferences/theme
//       (sm, xl), and /dashboard-class pages of lms-web, hr-web, admin-web (and todo-web, lookup-admin,
//       auth-web for the logins that reach them) must render html font-size == 16 * pct and their
//       first heading must scale by the same factor. A colleague's page is unaffected.
//   T3  UI: User menu -> Appearance -> Text size: choosing "Extra large" previews immediately
//       (before saving), Save reloads at 125 %, the DB row holds font_size=xl, "Use company theme"
//       clears it back to 100 %.
//   T4  server render: the size is in the FIRST HTML (no flash): the <style id="platform-theme"> of a
//       raw fetch carries font-size:125% for that user - and NOT for an anonymous request.
//
// Preference rows of every login used are snapshotted and journalled BEFORE any write and restored
// in finally (restore-journal.json); nothing in .auth/ is logged out or switched.
//
//   node suites/visual/text-size-scaling.mjs            # all of it
//   node suites/visual/text-size-scaling.mjs --quick    # T2 + T3 + T4 only (skip the route sweep)
import fs from 'node:fs';
import { cfg, roleMeta, APPS, GATEWAY, authFile, openState, save } from '../../lib.mjs';
import { TOOLS } from '../../tools.config.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { journalRestore, runRestore, restorePending } from '../../fixtures.mjs';
import { req, reporter, isOk, anon } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const QUICK = process.argv.includes('--quick');
const rep = reporter('visual', 'Text size & rem-only (runtime)');
const { fail, log } = rep;
const MARK = `E2E-tsz-${Date.now()}`;
restorePending('textsize-');

const STEPS = { sm: 87.5, md: 100, lg: 112.5, xl: 125 };
const TOL = 0.03;      // ratio tolerance (computed sizes are floats; some tokens round)
const BASE = 16;       // Chromium default root font size

// ── who measures what ────────────────────────────────────────────────────────
const metaOf = (key) => cfg.roles.find((r) => r.role === key) ?? [...(cfg.crossTenantActors ?? [])].map((c) => ({ role: c.stateKey, email: c.email })).find((r) => r.role === key) ?? null;
const emailOfKey = (k) => metaOf(k)?.email;
// app -> the login that sees the richest UI there (and can reach it at all)
const PLAN = [
  { app: 'lms-web', tool: 'lms', key: 'org_admin' },
  { app: 'hr-web', tool: 'hr', key: 'org_admin' },
  { app: 'todo-web', tool: 'todo', key: 'msq_org_admin' },   // Tasks is licensed for MSquare, not Fitclass
  { app: 'admin-web', tool: 'admin', key: 'org_admin' },
  { app: 'lookup-admin', tool: 'lookup', key: 'super_admin' },
  { app: 'auth-web', tool: 'core', key: 'tenant_admin' },
].filter((p) => fs.existsSync(authFile(p.key)));
const WRITERS = [...new Set(PLAN.map((p) => p.key))];
const COLLEAGUE = fs.existsSync(authFile('msq_rep1')) ? 'msq_rep1' : null;

const uidOfKey = (k) => { const e = emailOfKey(k); return e ? scalar(`SELECT id FROM iam.users WHERE email=${lit(e.toLowerCase())}`) : null; };
const tenantOfKey = (k) => { const e = emailOfKey(k); return e ? scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(e.toLowerCase())}`) : null; };
const UID = Object.fromEntries([...WRITERS, COLLEAGUE].filter(Boolean).map((k) => [k, uidOfKey(k)]));
const prefFont = (k) => scalar(`SELECT theme->>'font_size' FROM iam.user_preferences WHERE user_id=${lit(UID[k])}`);

// snapshot + journal every preference row we may touch
{
  const ids = Object.values(UID).filter(Boolean);
  const snap = new Map(rows(`SELECT user_id, COALESCE(theme::text,'<null>') FROM iam.user_preferences WHERE user_id IN (${ids.map(lit).join(',') || "''"})`, ['u', 't']).map((r) => [r.u, r.t]));
  const sql = [];
  for (const [k, id] of Object.entries(UID)) {
    if (!id) continue;
    sql.push(`DELETE FROM iam.user_preferences WHERE user_id=${lit(id)}`);
    if (snap.has(id)) { const t = snap.get(id); sql.push(`INSERT INTO iam.user_preferences (user_id, tenant_id, theme) VALUES (${lit(id)}, ${lit(tenantOfKey(k))}, ${t === '<null>' ? 'NULL' : `${lit(t)}::jsonb`})`); }
  }
  journalRestore('textsize-prefs', 'user_preferences of the text-size suite logins', sql);
}

// ── in-page measurement ──────────────────────────────────────────────────────
// Runs in the page: collects text-bearing elements once, then reads their computed font-size at the
// page's own root size, at 87.5 % and at 125 % (inline html style), and restores the root.
async function measure(page) {
  return page.evaluate(({ pcts, BASE }) => {
    const root = document.documentElement;
    const own = getComputedStyle(root).fontSize;
    const els = [];
    const skipTag = /^(SCRIPT|STYLE|NOSCRIPT|HEAD|META|LINK|TITLE|SVG|PATH|CANVAS|TEMPLATE|IFRAME)$/i;
    for (const el of document.body.querySelectorAll('*')) {
      if (skipTag.test(el.tagName) || el.closest('svg, [aria-hidden="true"], [data-fixed-size], script, style, noscript, canvas, iframe')) continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      els.push(el);
      if (els.length >= 400) break;
    }
    const sel = (el) => {
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      const anc = el.closest('[id]');
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${anc && anc !== el ? ` (in #${anc.id})` : ''}`;
    };
    const px = () => els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    const base = px();
    const keep = root.style.fontSize;
    const at = {};
    for (const p of pcts) { root.style.fontSize = `${p}%`; void root.offsetHeight; at[p] = px(); }
    root.style.fontSize = keep; void root.offsetHeight;
    const first = document.querySelector('h1, h2');
    return {
      htmlPx: parseFloat(own),
      n: els.length,
      items: els.map((e, i) => ({ sel: sel(e), t: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), base: base[i], at: Object.fromEntries(pcts.map((p) => [p, at[p][i]])) })),
      heading: first ? { t: (first.textContent || '').trim().slice(0, 40), base: parseFloat(getComputedStyle(first).fontSize) } : null,
      themeStyle: (document.getElementById('platform-theme')?.textContent ?? '').slice(0, 300),
      // first-party stylesheet rules that pin a font-size in px (outside print media)
      pxRules: (() => {
        const out = [];
        for (const sh of document.styleSheets) {
          let href = ''; try { href = sh.href || ''; } catch { /* ignore */ }
          if (href && !/\/_next\/static\/css\//.test(href)) continue;
          let rules; try { rules = sh.cssRules; } catch { continue; }
          const walk = (list, inPrint) => {
            for (const r of list) {
              if (r.cssRules && r.media) { walk(r.cssRules, inPrint || /print/.test(r.media.mediaText)); continue; }
              if (r.cssRules && !r.media) { walk(r.cssRules, inPrint); continue; }
              if (inPrint || !r.style) continue;
              const v = r.style.getPropertyValue('font-size');
              if (/^[\d.]+px$/.test(v) && !/^html$|^:root$/.test(r.selectorText || '')) out.push(`${(r.selectorText || '').slice(0, 70)} { font-size:${v} }`);
              if (out.length >= 12) return;
            }
          };
          walk(rules, false);
        }
        return out;
      })(),
    };
  }, { pcts: [87.5, 125], BASE });
}

// ── T1 sweep ─────────────────────────────────────────────────────────────────
const routesFor = (p) => {
  const t = TOOLS[p.tool];
  const base = APPS[p.app];
  const list = (t?.routes ?? []).filter((r) => !r.dynamicChildOf && !r.public && r.id !== 'select-branch').map((r) => ({ id: r.id, url: base + r.path }));
  if (p.tool === 'core') {
    return ['/select-branch', '/change-password'].map((pth) => ({ id: pth.slice(1), url: base + pth }));
  }
  if (p.tool === 'todo') {
    const uid = UID[p.key]; const org = scalar(`SELECT org_id FROM iam.users WHERE id=${lit(uid)}`);
    const tid = scalar(`SELECT id FROM task.tasks WHERE org_id=${lit(org)} AND NOT is_deleted AND (created_by=${lit(uid)} OR assignee_id=${lit(uid)}) ORDER BY created_at DESC LIMIT 1`);
    if (tid) list.push({ id: 'tasks-detail', url: `${base}/tasks/${tid}` });
  }
  if (p.tool === 'lookup') {
    const tid = scalar(`SELECT id FROM entity.tenants WHERE NOT is_deleted AND name='MSquare Professionals' LIMIT 1`) ?? scalar(`SELECT id FROM entity.tenants WHERE NOT is_deleted LIMIT 1`);
    if (tid) { list.push({ id: 'tenant-branding', url: `${base}/dashboard/tenants/${tid}/branding` }, { id: 'tenant-modules', url: `${base}/dashboard/tenants/${tid}/modules` }); }
  }
  return list;
};

function judge(role, label, m) {
  if (!m || !m.n) return { pinned: [], partial: 0 };
  const k = (BASE * 1.25) / m.htmlPx, ks = (BASE * 0.875) / m.htmlPx;
  const pinned = [], partial = [];
  for (const it of m.items) {
    if (!it.base) continue;
    const rx = it.at['125'] / it.base, rs = it.at['87.5'] / it.base;
    const follows = Math.abs(rx - k) <= TOL * k && Math.abs(rs - ks) <= TOL * ks;
    if (follows) continue;
    if (Math.abs(rx - 1) < 0.02 && Math.abs(rs - 1) < 0.02) pinned.push(it); else partial.push(it);
  }
  return { pinned, partial: partial.length, partialItems: partial };
}

async function sweep() {
  console.log('\n== T1 px-pin sweep ==');
  const summary = [];
  for (const p of PLAN) {
    const { browser, page, log: plog } = await openState(p.key);
    try {
      for (const r of routesFor(p)) {
        await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(500);
        const label = `${p.app} ${r.url.replace(APPS[p.app], '') || '/'}`;
        if (/\/login/.test(page.url()) && !/\/login/.test(r.url)) { console.log(`  skip ${label} (session not accepted)`); continue; }
        const body = await page.locator('body').innerText().catch(() => '');
        if (/this page could not be found|access restricted|forbidden|not authori[sz]ed/i.test(body) && p.tool !== 'core') { console.log(`  skip ${label} (denied / not found for ${p.key})`); continue; }
        const m = await measure(page).catch((e) => { console.log(`  ${label}: measure failed ${String(e.message).slice(0, 80)}`); return null; });
        if (!m) continue;
        const j = judge(p.key, label, m);
        summary.push({ app: p.app, role: p.key, route: r.url.replace(APPS[p.app], '') || '/', sampled: m.n, pinned: j.pinned.length, partial: j.partial, htmlPx: m.htmlPx, pxRules: m.pxRules.length });
        log({ role: p.key, area: `${p.app} text size`, action: `text scales with the root size on ${label}`, method: 'UI', endpoint: r.url.replace(APPS[p.app], '') || '/', status: null, outcome: 'visible', verified: j.pinned.length === 0, expected: 'every text element follows 87.5 / 125 %', note: `sampled ${m.n}, pinned ${j.pinned.length}, partial ${j.partial}` });
        console.log(`  ${p.key.padEnd(15)} ${label.padEnd(46)} n=${String(m.n).padStart(3)} pinned=${j.pinned.length} partial=${j.partial} px-rules=${m.pxRules.length}`);
        if (j.pinned.length) {
          const grouped = new Map();
          for (const it of j.pinned) { const g = grouped.get(it.sel) ?? { n: 0, ex: it }; g.n++; grouped.set(it.sel, g); }
          const ev = [...grouped.entries()].slice(0, 6).map(([s, g]) => `${s} x${g.n} "${g.ex.t}" ${g.ex.base}px (87.5%:${g.ex.at['87.5']} 125%:${g.ex.at['125']})`).join(' | ');
          fail(j.pinned.length >= 10 ? 'medium' : 'low', p.key, `${label}: ${j.pinned.length} text element(s) ignore the text-size setting (hardcoded px)`, 'computed font-size follows html font-size (rem-only rule)', ev.slice(0, 400), ev, 'Replace text-[Npx] / font-size:Npx with rem (text-[N/16rem]) or a type token; AG Grid sizes go through scalePx().', `${p.app} ${r.url.replace(APPS[p.app], '')}`);
        }
        if (m.pxRules.length) fail('low', p.key, `${label}: first-party stylesheet pins font-size in px (${m.pxRules.length} rule(s))`, 'rem-only font sizes', m.pxRules.slice(0, 4).join(' | '), m.pxRules.join(' | '), 'Convert to rem; print-only rules (payslip) are exempt and already skipped.', `${p.app} ${r.url.replace(APPS[p.app], '')}`);
        void plog;
      }
    } finally { await browser.close(); }
  }
  // public auth-web pages as an anonymous visitor
  const { chromium } = await import('@playwright/test');
  const br = await chromium.launch(); const ctx = await br.newContext(); const page = await ctx.newPage();
  try {
    for (const pth of ['/login', '/forgot-password', '/reset-password?token=e2e-not-a-real-token', '/offline']) {
      await page.goto(`${APPS['auth-web']}${pth}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(400);
      const m = await measure(page).catch(() => null); if (!m) continue;
      const j = judge('anonymous', pth, m);
      summary.push({ app: 'auth-web', role: 'anonymous', route: pth, sampled: m.n, pinned: j.pinned.length, partial: j.partial, htmlPx: m.htmlPx, pxRules: m.pxRules.length });
      log({ role: 'anonymous', area: 'auth-web text size', action: `text scales with the root size on ${pth}`, method: 'UI', endpoint: pth, status: null, outcome: 'visible', verified: j.pinned.length === 0, expected: 'every text element follows 87.5 / 125 %', note: `sampled ${m.n}, pinned ${j.pinned.length}` });
      console.log(`  anonymous       auth-web ${pth.padEnd(38)} n=${String(m.n).padStart(3)} pinned=${j.pinned.length} partial=${j.partial}`);
      if (j.pinned.length) { const ev = j.pinned.slice(0, 5).map((it) => `${it.sel} "${it.t}" ${it.base}px`).join(' | '); fail('low', 'anonymous', `auth-web ${pth}: ${j.pinned.length} text element(s) ignore the text-size setting`, 'follow the root size', ev.slice(0, 300), ev, 'rem tokens in auth-web.', `auth-web ${pth}`); }
    }
  } finally { await br.close(); }
  save('visual', 'text-size-sweep', summary);
  const bad = summary.filter((s) => s.pinned);
  console.log(`  swept ${summary.length} pages; ${bad.length} with px-pinned text`);
}

// ── T2 persisted ─────────────────────────────────────────────────────────────
async function persisted() {
  console.log('\n== T2 persisted size across apps ==');
  const probe = (p, a) => ({ lms: `${APPS['lms-web']}/dashboard/leads`, hr: `${APPS['hr-web']}/attendance`, todo: `${APPS['todo-web']}/tasks`, admin: `${APPS['admin-web']}/dashboard`, lookup: `${APPS['lookup-admin']}/dashboard`, core: `${APPS['auth-web']}/change-password` })[p.tool];
  const colleagueBase = {};
  if (COLLEAGUE) {
    const { browser, page } = await openState(COLLEAGUE);
    try { await page.goto(`${APPS['todo-web']}/tasks`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(600); colleagueBase.px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)); }
    finally { await browser.close(); }
  }
  for (const p of PLAN) {
    const a = await actor(p.key);
    try {
      const caps = await sessionCaps(a);
      if (!caps?.has('platform.appearance')) { console.log(`  (${p.key} lacks platform.appearance - skipped)`); continue; }
      const url = probe(p);
      const md = {};
      for (const step of ['md', 'sm', 'xl']) {
        const w = step === 'md' ? await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`) : await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: step } });
        if (!isOk(w.status)) { fail('high', p.key, `cannot set text size ${step}`, '2xx', `HTTP ${w.status}`, w.text.slice(0, 160), 'PUT /me/preferences/theme', `${p.app}`); continue; }
        const { browser, page } = await openState(p.key);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); await page.waitForTimeout(500);
          if (/\/login/.test(page.url()) && !/\/login/.test(url)) { console.log(`  (${p.app}: session not accepted)`); break; }
          const m = await measure(page);
          const want = BASE * STEPS[step] / 100;
          md[step] = m;
          const okRoot = Math.abs(m.htmlPx - want) < 0.6;
          log({ role: p.key, area: `${p.app} text size`, action: `saved size ${step} renders root ${want}px`, method: 'UI', endpoint: url.replace(APPS[p.app], ''), status: null, outcome: 'visible', verified: okRoot, expected: `html font-size ${want}px`, note: `got ${m.htmlPx}px` });
          console.log(`  ${p.key.padEnd(15)} ${p.app.padEnd(13)} ${step}: html=${m.htmlPx}px (want ${want})`);
          if (!okRoot) fail('high', p.key, `${p.app}: saved text size ${step} is not applied`, `html font-size ${want}px`, `${m.htmlPx}px`, `style#platform-theme=${m.themeStyle.slice(0, 160)}`, 'The app layout must render <ThemeStyle theme={resolveTheme(...)}> from getEffectiveBranding(); a hardcoded html{font-size} in globals.css would also defeat it.', `${p.app}`);
          if (step !== 'md' && md.md?.heading && m.heading && md.md.heading.t === m.heading.t) {
            const ratio = m.heading.base / md.md.heading.base;
            const wantR = STEPS[step] / 100;
            const ok = Math.abs(ratio - wantR) <= TOL * wantR;
            log({ role: p.key, area: `${p.app} text size`, action: `first heading scales x${wantR} at ${step}`, method: 'UI', endpoint: url.replace(APPS[p.app], ''), status: null, outcome: 'visible', verified: ok, expected: `x${wantR}`, note: `x${ratio.toFixed(3)}` });
            if (!ok) fail('medium', p.key, `${p.app}: heading does not scale with the ${step} text size`, `x${wantR}`, `x${ratio.toFixed(3)} (${md.md.heading.base}px -> ${m.heading.base}px)`, m.heading.t, 'Heading uses a px size or a clamp(); use rem tokens.', `${p.app}`);
          }
        } finally { await browser.close(); }
      }
    } finally { await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`).catch(() => {}); await a.close(); }
  }
  // a colleague is unaffected by other people's sizes
  if (COLLEAGUE) {
    const a = await actor('msq_org_admin').catch(() => null);
    if (a) {
      try {
        await req(a, 'PUT', `${GATEWAY}/me/preferences/theme`, { data: { font_size: 'xl' } });
        const { browser, page } = await openState(COLLEAGUE);
        try {
          await page.goto(`${APPS['todo-web']}/tasks`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(600);
          const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
          const ok = Math.abs(px - colleagueBase.px) < 0.6;
          log({ role: COLLEAGUE, area: 'todo-web text size', action: 'a colleague\'s text size does not change mine', method: 'UI', endpoint: '/tasks', status: null, outcome: 'visible', verified: ok, expected: `${colleagueBase.px}px`, note: `got ${px}px` });
          if (!ok) fail('critical', COLLEAGUE, 'Another user\'s text-size setting changed this user\'s page', `html font-size ${colleagueBase.px}px`, `${px}px`, '', 'user_preferences must be read by the session user id; check the layout cache key.', 'todo-web /tasks');
        } finally { await browser.close(); }
      } finally { await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`).catch(() => {}); await a.close(); }
    }
  }
}

// ── T3 UI flow ───────────────────────────────────────────────────────────────
async function uiFlow() {
  console.log('\n== T3 Appearance -> Text size (UI) ==');
  const key = fs.existsSync(authFile('msq_org_admin')) ? 'msq_org_admin' : PLAN[0]?.key;
  const app = key === 'msq_org_admin' ? 'todo-web' : PLAN[0]?.app;
  if (!key) return;
  const path = app === 'todo-web' ? '/tasks' : app === 'lms-web' ? '/dashboard/leads' : '/';
  const a = await actor(key);
  const caps = await sessionCaps(a); await req(a, 'DELETE', `${GATEWAY}/me/preferences/theme`); await a.close();
  if (!caps?.has('platform.appearance')) { console.log(`  (${key} lacks platform.appearance - skipped)`); return; }
  const { browser, page } = await openState(key);
  try {
    await page.goto(`${APPS[app]}${path}`, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(600);
    const px0 = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const menu = page.locator('button[aria-haspopup="menu"]').last();
    if (!(await menu.count())) { fail('medium', key, 'No user menu found to open Appearance', 'a button[aria-haspopup=menu]', 'absent', page.url(), 'UserMenu.', app); return; }
    await menu.click();
    const item = page.getByRole('menuitem', { name: /appearance/i }).first();
    if (!(await item.count())) { fail('medium', key, 'Appearance entry missing for a platform.appearance holder', 'menuitem Appearance', 'absent', '', 'UserMenu mayCustomise.', app); return; }
    await item.click(); await page.waitForTimeout(500);
    const dlg = page.getByRole('dialog').filter({ hasText: /Appearance/i }).first();
    const radios = dlg.getByRole('radio');
    const labels = await radios.allInnerTexts().catch(() => []);
    const sizeLabels = labels.filter((t) => /small|default|large|extra large/i.test(t));
    log({ role: key, area: `${app} Appearance`, action: 'Text size offers exactly 4 steps', method: 'UI', endpoint: 'Appearance', status: null, outcome: 'visible', verified: sizeLabels.length === 4, expected: 'Small, Default, Large, Extra large', note: sizeLabels.join(' / ').replace(/\n/g, ' ') });
    if (sizeLabels.length !== 4) fail('medium', key, 'Text size control does not offer exactly four steps', 'Small / Default / Large / Extra large', `${sizeLabels.length}: ${sizeLabels.join(' | ')}`.slice(0, 160), '', 'FONT_SIZES in ThemePicker.', app);
    const xl = dlg.getByRole('radio', { name: /extra large/i }).first();
    await xl.click(); await page.waitForTimeout(400);
    const previewPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const checked = await xl.getAttribute('aria-checked');
    log({ role: key, area: `${app} Appearance`, action: 'choosing Extra large previews before saving', method: 'UI', endpoint: 'Appearance', status: null, outcome: 'visible', verified: Math.abs(previewPx - 20) < 0.6 && checked === 'true' && prefFont(key) === null, expected: 'html 20px, nothing saved yet', note: `preview=${previewPx}px stored=${prefFont(key)}` });
    if (Math.abs(previewPx - 20) >= 0.6) fail('medium', key, 'Text size is not previewed live in the Appearance panel', 'html font-size 20px before Save', `${previewPx}px (was ${px0}px)`, '', 'applyThemePreview(resolveTheme(...)) with font_size.', app);
    if (prefFont(key)) fail('high', key, 'Selecting a text size saved it before Save was pressed', 'nothing stored until Save', String(prefFont(key)), '', 'AppearanceModal only calls appearance.save on Save.', app);
    // Cancel drops the preview
    await dlg.getByRole('button', { name: /^cancel$/i }).click().catch(() => {}); await page.waitForTimeout(400);
    const afterCancel = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    if (Math.abs(afterCancel - px0) >= 0.6) fail('low', key, 'Cancelling the Appearance panel leaves the previewed size applied', `${px0}px`, `${afterCancel}px`, '', 'applyThemePreview(null) cleanup.', app);
    // do it for real
    await page.locator('button[aria-haspopup="menu"]').last().click(); await page.getByRole('menuitem', { name: /appearance/i }).first().click(); await page.waitForTimeout(400);
    const dlg2 = page.getByRole('dialog').filter({ hasText: /Appearance/i }).first();
    await dlg2.getByRole('radio', { name: /extra large/i }).first().click();
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /preferences\/theme/.test(r.url()), { timeout: 15000 }).catch(() => null);
    await dlg2.getByRole('button', { name: /^save$/i }).click();
    const resp = await put;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1200);
    const px1 = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    log({ role: key, area: `${app} Appearance`, action: 'Save persists and the reloaded page renders 125 %', method: 'UI', endpoint: 'PUT /me/preferences/theme', status: resp?.status() ?? null, outcome: resp && resp.status() < 300 ? 'allowed' : 'error', verified: prefFont(key) === 'xl' && Math.abs(px1 - 20) < 0.6, expected: 'font_size=xl, html 20px', note: `db=${prefFont(key)} px=${px1}` });
    if (prefFont(key) !== 'xl') fail('high', key, 'Appearance Save did not persist the text size', 'iam.user_preferences.theme.font_size = xl', `HTTP ${resp?.status()} db=${prefFont(key)}`, '', 'AppearanceModal.save -> PUT /me/preferences/theme.', app);
    else if (Math.abs(px1 - 20) >= 0.6) fail('high', key, 'Saved Extra large is not applied after the reload', 'html 20px', `${px1}px`, '', 'Layout must pass the saved font_size into ThemeStyle (server-rendered, no flash).', app);
    // T4 first-HTML check: the style block carries the size before any JS
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.filter((c) => new URL(APPS[app]).hostname.endsWith(c.domain.replace(/^\./, '')) || c.domain.replace(/^\./, '') === new URL(APPS[app]).hostname).map((c) => `${c.name}=${c.value}`).join('; ');
    const raw = await fetch(`${APPS[app]}${path}`, { headers: { cookie: cookieHeader }, redirect: 'manual' }).then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => null);
    if (raw && raw.status === 200) {
      const m = raw.text.match(/<style id="platform-theme"[^>]*>([\s\S]*?)<\/style>/);
      const ok = !!m && /font-size:\s*125%/.test(m[1]);
      log({ role: key, area: `${app} Appearance`, action: 'the size is in the first server-rendered HTML (no flash)', method: 'GET', endpoint: path, status: 200, outcome: 'visible', verified: ok, expected: 'style#platform-theme carries font-size:125%' });
      if (!ok) fail('medium', key, 'Saved text size is not in the server-rendered HTML', 'style#platform-theme ... font-size:125%', (m?.[1] ?? '(no theme style)').slice(0, 160), '', 'Apply the size server-side (ThemeStyle), not after hydration.', app);
    }
    const an = await anon();
    try {
      const r2 = await req(an, 'GET', `${APPS['auth-web']}/login`);
      const m2 = r2.text.match(/<style id="platform-theme"[^>]*>([\s\S]*?)<\/style>/);
      if (m2 && /font-size:\s*125%/.test(m2[1])) fail('high', 'anonymous', 'An anonymous /login response carries a signed-in user\'s text size', 'default 100 %', m2[1].slice(0, 120), '', 'Personal preferences must never reach unauthenticated renders (cache poisoning).', 'auth-web /login');
    } finally { await an.close(); }
    // reset
    await page.locator('button[aria-haspopup="menu"]').last().click(); await page.getByRole('menuitem', { name: /appearance/i }).first().click(); await page.waitForTimeout(400);
    const dlg3 = page.getByRole('dialog').filter({ hasText: /Appearance/i }).first();
    const rs = page.waitForResponse((r) => r.request().method() === 'DELETE' && /preferences\/theme/.test(r.url()), { timeout: 15000 }).catch(() => null);
    await dlg3.getByRole('button', { name: /use company theme/i }).click();
    const rr = await rs;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1000);
    const px2 = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    log({ role: key, area: `${app} Appearance`, action: 'Use company theme resets the text size', method: 'UI', endpoint: 'DELETE /me/preferences/theme', status: rr?.status() ?? null, outcome: rr && rr.status() < 300 ? 'allowed' : 'error', verified: !prefFont(key) && Math.abs(px2 - px0) < 0.6, expected: 'no stored size, back to the original px', note: `px=${px2}` });
    if (prefFont(key) || Math.abs(px2 - px0) >= 0.6) fail('medium', key, 'Use company theme does not clear the text size', `no font_size, html ${px0}px`, `db=${prefFont(key)} px=${px2}`, '', 'appearance.reset -> DELETE /me/preferences/theme.', app);
  } catch (e) {
    console.log(e.stack); fail('high', key, 'Text size UI flow crashed', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'harness or product error', app);
  } finally { await browser.close(); }
}

try {
  console.log(`text-size-scaling: ${PLAN.length} app/login pairs (${PLAN.map((p) => `${p.app}:${p.key}`).join(', ') || 'none - run npm run auth'})${QUICK ? ' [quick]' : ''}`);
  if (!PLAN.length) { console.log('no auth states - aborting'); }
  else {
    if (!QUICK) await sweep();
    await persisted();
    await uiFlow();
  }
} catch (e) {
  console.log(e.stack);
  fail('high', 'harness', 'text-size-scaling suite aborted', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'see log');
} finally {
  runRestore('textsize-prefs');
  console.log(`\nrestored preferences; findings=${rep.state.findings} actions=${rep.state.actions}; marker ${MARK}`);
}
