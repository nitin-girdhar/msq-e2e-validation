// Deep-crawl engine.
//
// Given an authenticated page, this walks ONE route exhaustively: every tab,
// every dropdown/select, and every button — clicking the safe ones (tabs,
// View, filters, dropdown-open), OPENING (but not submitting) create/edit
// forms so their validation and render is exercised, and merely NOTING
// destructive controls (Delete/Deactivate) without firing them. Real writes
// are the job of the action helpers in actions.mjs, which pair a UI change
// with a db.mjs backend assertion; the crawler is the breadth pass that proves
// nothing throws when a role touches a control it can see.
//
// Every interaction is wrapped so one bad element never aborts the sweep, and
// errors (console, pageerror, 4xx/5xx, leaked backend error banners) are
// captured as a delta around each action so a failure can be attributed to the
// specific control that triggered it.
import { visit, record } from './lib.mjs';

// Button intent classification by visible text.
const RX = {
  // Session-ending / account controls are NEVER clicked — clicking sign-out
  // mid-crawl logs the role out and every subsequent route bounces to /login.
  logout: /\b(log\s?out|sign\s?out|logout|signout|switch account|switch branch|change branch)\b/i,
  destructive: /\b(delete|remove|deactivate|disable|revoke|archive|discard|reset password|terminate)\b/i,
  // Controls that act IMMEDIATELY on click, with no form in between — the
  // super-admin Meta console (Sync campaigns / Pull leads / Apply run / Remap /
  // Retry / Ignore), lead-assignment Re-run, CAPI resend, key rotation,
  // transfers, face-review Clear. They used to fall through to 'other', which
  // IS clicked; on production-refresh data that means real Meta Graph calls
  // and real leads re-assigned or ignored. Inventoried, never fired — the
  // dedicated suites exercise these through the API, deliberately.
  sideEffect: /\b(sync|pull|fetch leads|retry|ignore|remap|apply(?! for)|re-?run|run now|run|import|transfer|clear|resend|notify|send|publish|rotate|regenerate|enroll|activate|enable|mark (as )?(done|complete|read)|move|merge|restore|test rules?)\b/i,
  openForm: /\b(add|create|new|edit|update|invite|assign|reassign|adjust|configure|apply for|request|punch|check ?in|check ?out|regulari[sz])\b/i,
  submit: /\b(save|submit|confirm|approve|reject|create account|send|update)\b/i,
  safe: /\b(view|details|open|filter|search|export|download|refresh|next|prev|previous|show|expand|collapse|sort|today|month|week|day|team|mine|all)\b/i,
};

const ERROR_BANNER_RX =
  /insufficient|not the approver|forbidden|unauthorized|access denied|internal server error|something went wrong|failed to (load|fetch|save|update|create)|you are not|not allowed|permission denied/i;

// Snapshot the error counters so callers can diff before/after an action.
export const mark = (log) => ({
  console: log.consoleErrors.length,
  page: log.pageErrors.length,
  bad: log.badRequests.length,
});

export function delta(log, m) {
  return {
    consoleErrors: log.consoleErrors.slice(m.console),
    pageErrors: log.pageErrors.slice(m.page),
    badRequests: log.badRequests.slice(m.bad),
  };
}

// Any visible on-page banner that reads like a leaked backend/authorization
// error. Surfacing a raw server error string to the user is itself a defect.
async function leakedErrorBanner(page) {
  const nodes = page.locator('[role="alert"], .alert, [class*="error" i], [data-testid*="error" i]');
  const n = Math.min(await nodes.count().catch(() => 0), 10);
  for (let i = 0; i < n; i++) {
    const t = (await nodes.nth(i).innerText().catch(() => '')).trim();
    if (t && ERROR_BANNER_RX.test(t)) return t.slice(0, 240);
  }
  return null;
}

// Discover in-page tabs.
//
// These products render tabs through the shared PageTabs component as
//   <nav aria-label="..."><a href="/route" aria-current="page">Label</a></nav>
// i.e. ANCHORS, not role="tab" or buttons. (An earlier selector looked for
// `nav[aria-label] button` and therefore matched nothing.)
//
// We inventory rather than click: each tab is just a link to a route the crawl
// already visits, so clicking only navigates away and disrupts the rest of this
// route's control sweep. The inventory is the valuable part — a tab only exists
// when the capability behind it is granted (see AttendanceTabs/LeaveTabs/
// TasksTabs), so "which tabs does this role see" is an authorization signal we
// can later cross-check against which routes that role can actually load.
async function crawlTabs(page, log, ctx) {
  const tabs = page.locator(
    'nav[aria-label] a, [role="tab"], [role="tablist"] a, [role="tablist"] button, .tabs a, .tabs button'
  );
  const count = Math.min(await tabs.count().catch(() => 0), 12);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const t = tabs.nth(i);
    const [label, href, current] = await Promise.all([
      t.innerText().catch(() => ''),
      t.getAttribute('href').catch(() => null),
      t.getAttribute('aria-current').catch(() => null),
    ]);
    const clean = (label || '').trim().slice(0, 40);
    const key = `${clean}|${href ?? ''}`;
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push({ label: clean, href, active: current === 'page' });
  }
  return out;
}

// Open each dropdown/select, enumerate its options, then dismiss it.
async function crawlDropdowns(page, log, ctx) {
  const opened = [];
  // Native selects — read option labels directly.
  const selects = page.locator('select');
  const sc = Math.min(await selects.count().catch(() => 0), 20);
  for (let i = 0; i < sc; i++) {
    const opts = await selects.nth(i).locator('option').allInnerTexts().catch(() => []);
    opened.push({ type: 'select', options: opts.slice(0, 30) });
  }
  // Custom comboboxes / menu triggers.
  const combos = page.locator('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], button[aria-expanded]');
  const cc = Math.min(await combos.count().catch(() => 0), 12);
  for (let i = 0; i < cc; i++) {
    const el = combos.nth(i);
    const m = mark(log);
    await el.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(120);
    const optionEls = page.locator('[role="option"], [role="menuitem"], [role="listbox"] li');
    const opts = await optionEls.allInnerTexts().catch(() => []);
    opened.push({ type: 'combobox', options: opts.slice(0, 30) });
    await page.keyboard.press('Escape').catch(() => {});
    const d = delta(log, m);
    if (d.pageErrors.length) {
      record(ctx.tool, {
        severity: 'medium', role: ctx.role, tool: ctx.tool, page: `${ctx.label} > dropdown#${i}`,
        scenario: `Open dropdown/combobox #${i} as ${ctx.role}`,
        expected: 'Dropdown opens and lists options without throwing',
        actual: `pageErrors=${d.pageErrors.length}`,
        evidence: JSON.stringify(d).slice(0, 400),
        proposedSolution: 'Guard the option-loading path (empty/loading/error states) so opening the control never throws.',
      });
    }
  }
  return opened;
}

// Classify and exercise buttons. Safe/openForm buttons are actually clicked
// (openForm ones are cancelled out); destructive ones are only inventoried.
async function crawlButtons(page, log, ctx) {
  const inventory = { safe: [], openForm: [], destructive: [], sideEffect: [], submit: [], other: [] };
  const buttons = page.locator('button:visible, a[role="button"]:visible, [role="button"]:visible');
  const total = Math.min(await buttons.count().catch(() => 0), 18);
  const labels = [];
  const titles = [];
  for (let i = 0; i < total; i++) {
    const t = (await buttons.nth(i).innerText().catch(() => '')).trim().slice(0, 40);
    labels.push(t);
    titles.push(await buttons.nth(i).getAttribute('title').catch(() => null));
  }
  for (let i = 0; i < labels.length; i++) {
    const rawLabel = labels[i];
    const label = rawLabel || `btn#${i}`;
    // The shell's BranchSwitcher chip (title="Branch: <name>") is labelled with
    // the branch NAME, so text classification cannot see it. Choosing a branch
    // calls /auth/switch-org, which revokes the stored session's jti — every
    // later route for this role would bounce to /login. Treat it as a session
    // control.
    const isBranchSwitch = /^Branch:/i.test(titles[i] || '');
    const kind = (isBranchSwitch || RX.logout.test(label)) ? 'logout'
      : RX.destructive.test(label) ? 'destructive'
      : RX.sideEffect.test(label) ? 'sideEffect'
      : RX.openForm.test(label) ? 'openForm'
      : RX.submit.test(label) ? 'submit'
      : RX.safe.test(label) ? 'safe' : 'other';
    (inventory[kind] ??= []).push(label);

    // Never auto-fire: destructive, side-effecting, submit, logout/account controls.
    if (kind === 'destructive' || kind === 'sideEffect' || kind === 'submit' || kind === 'logout') continue;
    // Skip icon-only buttons with no accessible text — a name:'' match would
    // resolve to an arbitrary button (often the avatar/sign-out menu).
    if (!rawLabel || !rawLabel.trim()) continue;

    // Re-locate by text each time — the DOM may have changed after prior clicks.
    const btn = page.getByRole('button', { name: label, exact: false }).first();
    if (!(await btn.count().catch(() => 0))) continue;
    const m = mark(log);
    await btn.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);

    if (kind === 'openForm') {
      // A modal/dialog/drawer should appear; capture it, then back out cleanly.
      const dialog = page.locator('[role="dialog"], [aria-modal="true"], .modal');
      const appeared = await dialog.first().isVisible().catch(() => false);
      const d = delta(log, m);
      if (!appeared && (d.pageErrors.length || d.badRequests.some((b) => /^5\d\d /.test(b)))) {
        record(ctx.tool, {
          severity: 'medium', role: ctx.role, tool: ctx.tool, page: `${ctx.label} > '${label}'`,
          scenario: `Click '${label}' (opens a create/edit form) as ${ctx.role}`,
          expected: 'A form/dialog opens with no errors',
          actual: `no dialog appeared; pageErrors=${d.pageErrors.length} bad=${d.badRequests.length}`,
          evidence: JSON.stringify(d).slice(0, 400),
          proposedSolution: 'Ensure the trigger opens its form even on slow/empty data, or hide it for roles that cannot use it.',
        });
      }
      // Dismiss modal.
      await page.keyboard.press('Escape').catch(() => {});
      const cancel = page.getByRole('button', { name: /cancel|close|discard/i }).first();
      if (await cancel.count().catch(() => 0)) await cancel.click({ timeout: 2000 }).catch(() => {});
    } else {
      const banner = await leakedErrorBanner(page);
      const d = delta(log, m);
      if (banner || d.pageErrors.length) {
        record(ctx.tool, {
          severity: banner ? 'medium' : 'high', role: ctx.role, tool: ctx.tool, page: `${ctx.label} > '${label}'`,
          scenario: `Click '${label}' as ${ctx.role}`,
          expected: 'Action completes with no page error or leaked backend error banner',
          actual: banner ? `Leaked error banner: "${banner}"` : `pageErrors=${d.pageErrors.length}`,
          evidence: JSON.stringify(d).slice(0, 400),
          proposedSolution: banner
            ? 'Translate backend errors to friendly messages and/or hide the control from roles the API rejects.'
            : 'Add an error boundary around this action and fix the throwing handler.',
        });
      }
    }
  }
  return inventory;
}

// Crawl one route end-to-end and return a coverage summary object.
export async function crawlRoute(page, log, { appUrl, route, tool, role }) {
  const url = appUrl + route.path;
  const ctx = { tool, role, label: route.label };
  const m0 = mark(log);
  const v = await visit(page, url);

  // Page-load level check — a route that 5xxs or leaks an error on entry.
  const d0 = delta(log, m0);
  const entryBanner = await leakedErrorBanner(page);
  if (v.looksLikeError || entryBanner || d0.pageErrors.length || d0.badRequests.some((b) => /^5\d\d /.test(b))) {
    record(tool, {
      severity: d0.pageErrors.length ? 'high' : 'medium',
      role, tool, page: route.label,
      scenario: `Load ${route.path} as ${role}`,
      expected: 'Route renders (or cleanly redirects) with no page/5xx error and no leaked backend error text',
      actual: entryBanner ? `Leaked error banner: "${entryBanner}"` : v.looksLikeError ? `Error-looking body: "${v.bodySnippet}"` : `pageErrors=${d0.pageErrors.length} bad=${d0.badRequests.length}`,
      evidence: JSON.stringify({ url: v.url, heading: v.heading, ...d0 }).slice(0, 700),
      proposedSolution: 'If the role should not reach this route, redirect server-side before render; if it should, resolve the failing request and surface a friendly empty/permission state instead of a raw error.',
    });
  }

  const tabs = await crawlTabs(page, log, ctx).catch(() => []);
  const dropdowns = await crawlDropdowns(page, log, ctx).catch(() => []);
  const buttons = await crawlButtons(page, log, ctx).catch(() => ({}));

  return {
    role, tool, route: route.id, path: route.path, url: v.url,
    httpStatus: v.httpStatus, heading: v.heading, redirected: v.redirected,
    tabs, dropdownCount: dropdowns.length,
    buttons: Object.fromEntries(Object.entries(buttons).map(([k, arr]) => [k, arr.length])),
    buttonInventory: buttons,
  };
}
