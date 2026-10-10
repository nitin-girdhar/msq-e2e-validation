// Small shared kit for the 2026-10 suites (branding, auth-recovery, tasks-v2,
// leads-bulk-and-ui). Keeps each suite terse: a reporter bound to one tool/page
// (record() + journal.logAction()), a raw HTTP helper that also returns headers,
// an anonymous request context, a capability-grading helper and a light UI sweep.
//
// Nothing here mutates product state on its own.
import { chromium, request as pwRequest } from '@playwright/test';
import { record } from './lib.mjs';
import { logAction } from './journal.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isOk = (s) => s >= 200 && s < 300;

// ── HTTP ──────────────────────────────────────────────────────────────────────
// `a` is anything with `.request` (conc.actor / conc.freshLogin / anon()).
export async function req(a, method, url, { data, headers, timeout = 60000 } = {}) {
  const t0 = Date.now();
  let resp;
  try {
    resp = await a.request.fetch(url, { method, data, headers, failOnStatusCode: false, timeout, maxRedirects: 0 });
  } catch (e) {
    return { status: -1, headers: {}, text: String(e.message).slice(0, 300), body: null, ms: Date.now() - t0, buf: null };
  }
  const buf = await resp.body().catch(() => Buffer.alloc(0));
  const text = buf.toString('utf8');
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: resp.status(), headers: resp.headers(), text, body, ms: Date.now() - t0, buf };
}

// Unauthenticated request context (no cookies at all).
export async function anon() {
  const ctx = await pwRequest.newContext();
  return { request: ctx, async close() { await ctx.dispose(); } };
}

// ── Reporting ────────────────────────────────────────────────────────────────
export function reporter(tool, page) {
  const state = { findings: 0, actions: 0 };
  return {
    state,
    // fail(severity, role, scenario, expected, actual, evidence, proposedSolution)
    fail(severity, role, scenario, expected, actual, evidence, proposedSolution, pageOverride) {
      state.findings++;
      record(tool, {
        severity, role, tool, page: pageOverride ?? page, scenario, expected, actual,
        evidence: String(evidence ?? '').slice(0, 700), proposedSolution,
      });
      console.log(`  !! [${severity}] ${role} - ${scenario}: ${String(actual).slice(0, 160)}`);
    },
    // log({role, action, method, endpoint, status, expected, verified, note, outcome, area})
    log(e) {
      state.actions++;
      const status = e.status ?? null;
      const outcome = e.outcome ?? (status == null ? 'visible'
        : status >= 500 || status < 0 ? 'error'
        : status === 401 || status === 403 || status === 404 ? 'denied'
        : status >= 400 ? 'error'
        : e.verified === false ? 'no-op' : 'allowed');
      logAction({ tool, area: e.area ?? page, tab: e.tab, method: 'GET', status, ...e, outcome });
    },
  };
}

// Grade one attempt against what the actor's live capabilities say.
//   has      : the actor holds the capability (true/false/null = not graded)
//   status   : HTTP status of the attempt
//   effect   : did the DB show the change (true/false/null = not checked)
// Returns 'ok' | 'over' | 'under' | 'crash' | 'observed'.
export function grade(rep, { role, scenario, has, status, effect = null, evidence = '', fixOver, fixUnder, sevOver = 'high', sevUnder = 'medium', method = 'GET', endpoint = '', note = '' }) {
  const ok2 = isOk(status);
  let verdict = 'ok';
  if (status >= 500 || status < 0) verdict = 'crash';
  else if (has === null || has === undefined) verdict = 'observed';
  else if (has && !(ok2 && effect !== false)) verdict = 'under';
  else if (!has && (ok2 || effect === true)) verdict = 'over';
  rep.log({ role, action: scenario, method, endpoint, status, verified: effect, expected: has == null ? 'observed' : has ? 'allowed' : 'denied', note: `${verdict}${note ? '; ' + note : ''}` });
  const tag = `${role.padEnd(24)} http=${String(status).padStart(3)} ${effect == null ? '' : `db=${effect} `}${verdict}`;
  console.log(`  ${tag}  (${scenario})`);
  if (verdict === 'over') rep.fail(effect === true ? 'critical' : sevOver, role, `${scenario} - succeeded without the capability`, 'Refused (403/404) and nothing written', `HTTP ${status}${effect != null ? `, db changed=${effect}` : ''}`, evidence, fixOver ?? 'Enforce the capability server-side before the handler runs.');
  else if (verdict === 'under') rep.fail(sevUnder, role, `${scenario} - refused a permitted actor`, '2xx and the effect lands', `HTTP ${status}${effect != null ? `, db changed=${effect}` : ''}`, evidence, fixUnder ?? 'The page guard, service guard and capability resolver disagree for this role.');
  else if (verdict === 'crash') rep.fail('high', role, `${scenario} - 5xx / transport error`, '4xx for a refusal, 2xx for success', `HTTP ${status}`, evidence, 'Map the failure to a typed 4xx before it reaches the error handler.');
  return verdict;
}

// ── UI sweep ─────────────────────────────────────────────────────────────────
// Buttons that must NEVER be pressed in a sweep: session ends, remote
// side-effects (Meta/sync/transfer), destructive, key rotation, submits.
export const NEVER_CLICK = /\b(lock|unlock|finali[sz]e|log\s?out|sign\s?out|logout|switch (account|branch)|change branch|delete|remove|deactivate|disable|revoke|archive|reset password|terminate|sync|pull|fetch leads|retry|ignore|remap|re-?run|run now|import|transfer|resend|notify|send|publish|rotate|regenerate|enroll|activate|enable|mark|merge|restore|apply|assign|reassign|confirm|submit|save|create|upload|export|download|clear all|approve|reject|whatsapp|transfer|campaign|meta)\b/i;

async function snapshotLog(log) { return { c: log.consoleErrors.length, p: log.pageErrors.length, b: log.badRequests.length }; }
function since(log, m) { return { console: log.consoleErrors.slice(m.c), page: log.pageErrors.slice(m.p), bad: log.badRequests.slice(m.b) }; }

// Walk one already-loaded page: click every in-page tab, select every option of
// every native select (restoring it), press safe buttons (View/Edit/filter/open),
// then back out of any dialog. Reports uncaught page errors and 5xx per control.
// Returns a coverage summary. `ctx` = { rep, role, label, log }.
export async function sweepPage(page, { rep, role, label, log, maxSelectOptions = 6, maxButtons = 14 }) {
  const out = { tabs: 0, selects: 0, options: 0, buttons: 0, skipped: 0 };
  const problems = [];
  const check = (what, m) => {
    const d = since(log, m);
    const bad5 = d.bad.filter((b) => /^5\d\d /.test(b) || (/^FAILED /.test(b) && !/ERR_ABORTED|NS_BINDING_ABORTED/.test(b)));
    if (d.page.length || bad5.length) {
      problems.push(`${what}: ${[...d.page, ...bad5].join(' | ').slice(0, 200)}`);
      rep.fail(d.page.length ? 'high' : 'medium', role, `${label}: ${what}`, 'No uncaught page error / 5xx while using the control', `pageErrors=${d.page.length} 5xx=${bad5.length}`, [...d.page, ...bad5].join(' | '), 'Guard the handler against empty/slow data; return a typed 4xx for an unauthorised call.');
    }
  };

  // Tabs (anchors in a nav[aria-label] or role=tab) — click, confirm it renders, go back.
  const home = page.url();
  const tabLocs = page.locator('nav[aria-label] a:visible, [role="tab"]:visible');
  const tabCount = Math.min(await tabLocs.count().catch(() => 0), 8);
  const tabNames = [];
  for (let i = 0; i < tabCount; i++) tabNames.push((await tabLocs.nth(i).innerText().catch(() => '')).trim().slice(0, 40));
  for (let i = 0; i < tabNames.length; i++) {
    if (!tabNames[i] || NEVER_CLICK.test(tabNames[i])) continue;
    const t = page.locator('nav[aria-label] a:visible, [role="tab"]:visible').nth(i);
    const m = await snapshotLog(log);
    await t.click({ timeout: 4000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    out.tabs++;
    check(`tab "${tabNames[i]}"`, m);
    rep.log({ role, area: label, tab: tabNames[i], action: `open tab ${tabNames[i]}`, method: 'UI', endpoint: tabNames[i], status: null, outcome: 'visible', note: page.url() });
    if (page.url() !== home) { await page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(500); }
  }

  // Native selects: choose each option (up to N), restore the original.
  const sel = page.locator('select:visible');
  const sc = Math.min(await sel.count().catch(() => 0), 10);
  for (let i = 0; i < sc; i++) {
    const s = page.locator('select:visible').nth(i);
    const aria = (await s.getAttribute('aria-label').catch(() => '')) || `select#${i}`;
    const opts = await s.locator('option').evaluateAll((os) => os.map((o) => o.value)).catch(() => []);
    const orig = await s.inputValue().catch(() => '');
    out.selects++;
    for (const v of opts.slice(0, maxSelectOptions)) {
      if (v === orig) continue;
      const m = await snapshotLog(log);
      await s.selectOption(v, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(350);
      out.options++;
      check(`dropdown "${aria}" = ${v.slice(0, 20)}`, m);
    }
    await s.selectOption(orig, { timeout: 3000 }).catch(() => {});
    rep.log({ role, area: label, action: `use dropdown ${aria} (${opts.length} options)`, method: 'UI', endpoint: aria, status: null, outcome: 'visible' });
  }

  // Custom menu triggers: open, list options, Escape.
  const trig = page.locator('[aria-haspopup="menu"]:visible, [aria-haspopup="listbox"]:visible, [role="combobox"]:visible');
  const tc = Math.min(await trig.count().catch(() => 0), 6);
  for (let i = 0; i < tc; i++) {
    const m = await snapshotLog(log);
    await trig.nth(i).click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape').catch(() => {});
    check(`menu trigger #${i}`, m);
  }

  // Safe buttons.
  const btns = page.locator('button:visible, a[role="button"]:visible');
  const total = Math.min(await btns.count().catch(() => 0), maxButtons);
  const names = [];
  for (let i = 0; i < total; i++) {
    const b = btns.nth(i);
    names.push({ text: ((await b.innerText().catch(() => '')) || '').trim().slice(0, 40), title: (await b.getAttribute('title').catch(() => '')) || '', aria: (await b.getAttribute('aria-label').catch(() => '')) || '' });
  }
  for (const n of names) {
    const lbl = n.text || n.title || n.aria;
    if (!lbl || NEVER_CLICK.test(lbl) || /^Branch:/i.test(n.title)) { out.skipped++; continue; }
    const loc = n.text ? page.getByRole('button', { name: n.text, exact: true }).first()
      : n.title ? page.locator(`button[title="${n.title.replace(/"/g, '\\"')}"]`).first()
      : page.getByRole('button', { name: n.aria, exact: true }).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const m = await snapshotLog(log);
    await loc.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    out.buttons++;
    check(`button "${lbl}"`, m);
    rep.log({ role, area: label, action: `press ${lbl}`, method: 'UI', endpoint: lbl, status: null, outcome: 'visible' });
    // back out of any dialog / drawer / navigation
    await page.keyboard.press('Escape').catch(() => {});
    const cancel = page.getByRole('button', { name: /^(cancel|close|discard|keep)$/i }).first();
    if (await cancel.count().catch(() => 0)) await cancel.click({ timeout: 1500 }).catch(() => {});
    if (page.url() !== home && !page.url().startsWith(home.split('?')[0] + '/')) { await page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(400); }
  }
  out.problems = problems.length;
  return out;
}

// Open a stored-session browser page; returns { browser, ctx, page, log } like lib.openState
// but with a longer default navigation budget.
export async function newBrowser() { return chromium.launch(); }
