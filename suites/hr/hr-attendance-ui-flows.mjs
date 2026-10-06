// UI-driven attendance / roster flows (Playwright, hr-web). Real clicks, real forms, then the DB.
//
//   U0  page access by LIVE capability for every login: /attendance, /attendance/team, /team,
//       /planner, /attendance/admin  (open vs redirected is graded against the session's own
//       capabilities; a page that opens for a role without the capability is a dead end, a page
//       that bounces a role WITH it is a blocked user)
//   U1  "exercise every control": click every tab, open every dropdown and step through its
//       options, press every View/Edit/Create/Add/Open/Export/Next/Previous/Today style button,
//       open (and cancel) every modal — on /attendance, /attendance/team, /team, /planner and the
//       attendance admin page. Non-destructive controls only; every console error, 4xx/5xx,
//       uncaught page error and leaked backend text is recorded as a finding.
//   U2  shift-swap desk through the browser, three people:
//         trainer  Request swap modal (empty-form validation, peer dropdown contents, duplicate,
//                  Send request) -> DB row; Withdraw
//         peer     Waiting for your answer -> Accept -> DB pending_manager
//         approver Swaps awaiting approval -> Approve (DB: both rosters swapped) / Reject modal
//                  (comment required, DB: rejected, roster untouched)
//   U3  roster planner through the browser (fitness_manager): cell edit (one day, then a range),
//       Assign shift pattern, Bulk reallocate, "people needed", Publish roster — each verified in
//       hr.shift_assignments / hr.shift_requirements / hr.roster_publications.
//   U4  attendance team page (fitness_manager): select people -> Bulk regularize, Add a punch
//       (verified in hr.attendance_days / hr.attendance_events), the employee-side nudge banner,
//       and the punch-log month filter at a month boundary.
//
// SAFETY: fixtures + snapshots from _att-kit.mjs (journalled first, restored in finally); the
// attendance rows touched are snapshotted into scratch tables and restored. Only E2E-marked data.
//
//   node suites/hr/hr-attendance-ui-flows.mjs             # everything
//   node suites/hr/hr-attendance-ui-flows.mjs u0,u2       # a subset
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { ROLES, CROSS_TENANT, APPS, openAs, authFile } from '../../lib.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { actor } from '../../conc.mjs';
import { leakOf, journalRestore, runRestore, restorePending } from '../../fixtures.mjs';
import { logAction } from '../../journal.mjs';
import { dbReachable, rows, scalar, q, lit } from '../../db.mjs';
import {
  TOOL, API, stamp, req, me, openActors, closeActors, bug, check, weekdays, addDays, todayIso, mondayOf, dowOf, sleep,
  buildFixtures, teardownFixtures, shiftOn, coverCount, swapRow, findingCount, DEV_ROLES, dbSnapshot, isoDaysAgo,
} from './_att-kit.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const only = (process.argv[2] || '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const HR = APPS['hr-web'];
const ADMIN_WEB = APPS['admin-web'];
const ALL = [...ROLES, ...CROSS_TENANT.map((c) => c.stateKey)];

// ── helpers ─────────────────────────────────────────────────────────────────
const settle = async (page, ms = 1200) => { await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}); await page.waitForTimeout(ms); };
const pathOf = (page) => { try { return new URL(page.url()).pathname; } catch { return ''; } };
const NOISE = /notifications\/stream|favicon|_next\/(static|image|webpack)|ERR_ABORTED|\.map(\?|$)|manifest|sw\.js|web-push|\/push\//i;
const act = (role, area, tab, action, endpoint, status, outcome, verified, expected, note = '') =>
  logAction({ tool: TOOL, role, area, tab, action, method: 'UI', endpoint, status, outcome, verified, expected, note });

// Everything the browser reported since `mark` -> findings.
function judge(role, area, ui, mark, { allow4xx = [] } = {}) {
  const bad = ui.log.badRequests.slice(mark.bad).filter((x) => !NOISE.test(x));
  const five = bad.filter((x) => /^(5\d\d|FAILED) /.test(x) && !/ERR_ABORTED/.test(x));
  const four = bad.filter((x) => /^4\d\d /.test(x) && !allow4xx.some((rx) => rx.test(x)));
  if (five.length) bug('high', role, area, 'The page triggered a 5xx', 'No server errors from UI actions', [...new Set(five)].slice(0, 3).join(' | '), '', 'Find the failing request in the service log; return a 4xx AppError or fix the handler.');
  if (four.length) bug('medium', role, area, 'The page triggered an unexpected 4xx', 'No 4xx from a page the role is allowed to use', [...new Set(four)].slice(0, 3).join(' | '), '', 'The UI is calling an endpoint this role may not use (or sending an invalid request): gate the call on the capability, or fix the payload.');
  const errs = ui.log.pageErrors.slice(mark.page);
  if (errs.length) bug('medium', role, area, 'Uncaught page error', 'No uncaught exceptions', errs[0], '', 'Guard the render path / handle the rejected promise.');
  const cons = ui.log.consoleErrors.slice(mark.con).filter((t) => !NOISE.test(t) && !/Failed to load resource/i.test(t));
  if (cons.length) bug('low', role, area, 'Console error', 'A clean console', [...new Set(cons)].slice(0, 2).join(' | ').slice(0, 300), '', 'Fix the logged error.');
}
const markOf = (ui) => ({ bad: ui.log.badRequests.length, page: ui.log.pageErrors.length, con: ui.log.consoleErrors.length });
async function leakCheck(role, area, page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const l = leakOf(body);
  if (l) bug('medium', role, area, 'Backend internals visible on the page', 'Friendly text only', l, body.slice(0, 200), 'Map errors to user-facing messages.');
  return body;
}
const respWait = (page, method, rx, timeout = 15000) => page.waitForResponse((r) => r.request().method() === method && rx.test(r.url()), { timeout }).catch(() => null);
async function clickAndWait(page, locator, method, rx) {
  const w = respWait(page, method, rx);
  await locator.click();
  const r = await w;
  let body = null; try { body = await r?.json(); } catch {}
  return { status: r?.status() ?? null, body };
}

let fx; const A = await openActors({ ...DEV_ROLES, tadmin: 'tenant_admin' });
if (!A.requester || !A.peer || !A.approver) { console.log('required actors unavailable — aborting'); await closeActors(A); process.exit(0); }
if ([A.requester, A.peer, A.approver].some((x) => x.me.org_name !== 'Gurugram - Sector 69')) { console.log('fixture actors are not on Sector 69 — aborting'); await closeActors(A); process.exit(0); }
const key = 'e2e-att-ui';
const orgId = A.approver.me.org_id;
const trainer = A.requester.me, peer = A.peer.me, appr = A.approver.me;

try {
  // ───────────────────────── U0 page access by live capability ─────────────────────────
  if (want('u0')) {
    console.log('U0 — page access by live capability (every login)');
    const PAGES = [
      { path: '/attendance', name: 'Attendance dashboard' },
      { path: '/attendance/team', name: 'Team attendance', cap: 'hr.attendance.view.team', bounce: '/attendance' },
      { path: '/team', name: 'My team (swap desk)', cap: 'hr.attendance.roster.view', bounce: '/dashboard' },
      { path: '/planner', name: 'Roster planner', cap: 'hr.attendance.roster.manage', bounce: '/dashboard' },
      { path: '/attendance/admin', name: 'Attendance admin (redirect)', cap: 'hr.attendance.admin', bounce: '/attendance' },
    ];
    for (const role of ALL) {
      if (!fs.existsSync(authFile(role))) continue;
      const a = await actor(role).catch(() => null); if (!a) continue;
      const caps = await sessionCaps(a); const m = await me(a); await a.close();
      if (!caps) continue;
      let ui; try { ui = await openAs(role); } catch { continue; }
      try {
        for (const p of PAGES) {
          const mark = markOf(ui);
          await ui.page.goto(`${HR}${p.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await settle(ui.page, 900);
          const landed = pathOf(ui.page);
          const inAdminWeb = landed.startsWith(new URL(ADMIN_WEB).pathname) && p.path === '/attendance/admin';
          const opened = p.path === '/attendance/admin' ? inAdminWeb : landed === new URL(HR).pathname + p.path || landed.endsWith(p.path);
          const hasCap = p.cap ? caps.has(p.cap) : null;
          const body = await leakCheck(role, `${p.name} (${p.path})`, ui.page);
          const tag = hasCap === null ? 'any' : hasCap ? 'has cap' : 'no cap';
          act(role, p.name, 'page access', `open ${p.path}`, p.path, null, opened ? 'visible' : 'hidden', hasCap === null ? null : opened === hasCap, hasCap === null ? 'observed' : hasCap ? 'opens' : 'redirects', `${tag}; landed ${landed}`);
          if (hasCap === true && !opened) bug('high', role, `${p.name} (${p.path})`, 'A role that holds the capability is bounced from the page', `Page opens (${p.cap})`, `Redirected to ${landed}`, `home org ${m.org_name}`, 'The page guard and the capability disagree (a multi-branch user on a non-home branch loses punch pages by design; check that first).');
          if (hasCap === false && opened) bug('medium', role, `${p.name} (${p.path})`, 'A role WITHOUT the capability can open the page', `Redirect to ${p.bounce}`, `Page rendered at ${landed}`, `lacks ${p.cap}`, 'Server page guard must use can(session, CAPABILITY.…) like the API; the page then calls a 403 endpoint (dead end).');
          if (hasCap === false && opened) judge(role, `${p.name} (${p.path})`, ui, mark, { allow4xx: [/\b40[13] /] });
          else if (hasCap !== false) judge(role, `${p.name} (${p.path})`, ui, mark);
          if (/something went wrong|unexpected error|application error/i.test(body)) bug('high', role, `${p.name} (${p.path})`, 'Error screen rendered', 'A normal page or a clean redirect', body.slice(0, 120), '', 'Error boundary hit: see the page error above.');
        }
        console.log(`  ${role.padEnd(26)} ${PAGES.map((p) => `${p.path}:${caps.has(p.cap ?? '') ? 'cap' : '-'}`).join(' ')}`);
      } finally { await ui.browser.close(); }
    }
  }

  // Everything below needs the shared fixtures.
  if (want('u1') || want('u2') || want('u3') || want('u4')) {
    restorePending('e2e-att');
    fx = await buildFixtures(A, key);
    // attendance rows touched by U4 (fixture people, last 9 days) — snapshot into scratch tables first.
    const users = [trainer.id, peer.id, appr.id].map(lit).join(',');
    const LO = isoDaysAgo(9);
    const sEv = dbSnapshot(`${key}-att`, 1, 'hr.attendance_events', `user_id IN (${users}) AND occurred_at >= ${lit(LO)}::timestamptz`);
    const sDay = dbSnapshot(`${key}-att`, 2, 'hr.attendance_days', `user_id IN (${users}) AND work_date >= ${lit(LO.slice(0, 10))}::date`);
    journalRestore(`${key}-att`, 'UI flows: attendance rows of the fixture people', [...sEv.stmts, ...sDay.stmts]);
    q(`DELETE FROM hr.attendance_events WHERE user_id IN (${users}) AND occurred_at >= ${lit(LO)}::timestamptz`);
    q(`DELETE FROM hr.attendance_days WHERE user_id IN (${users}) AND work_date >= ${lit(LO.slice(0, 10))}::date`);
  }
  const sA = fx?.shifts.A, sB = fx?.shifts.B, sC = fx?.shifts.C;
  const [d1, d2, d3, d4] = fx ? weekdays(orgId, 4, { ahead: 3, gap: 3 }) : [];

  // ───────────────────────── U1 exercise every control ─────────────────────────────────
  async function exercise(role, pageUrl, label, { maxButtons = 30 } = {}) {
    const ui = await openAs(role);
    const area = `${label} (${pageUrl})`;
    const done = { tabs: 0, selects: 0, options: 0, buttons: 0, dialogs: 0 };
    try {
      ui.page.on('download', (d) => d.cancel().catch(() => {}));
      await ui.page.goto(`${HR}${pageUrl}`, { waitUntil: 'domcontentloaded' }); await settle(ui.page, 2000);
      const mark = markOf(ui);
      if (/^\/(login|auth)/.test(pathOf(ui.page))) { console.log(`  ${label}: redirected to login — skipped`); return; }
      await leakCheck(role, area, ui.page);
      // tabs
      const tabNames = await ui.page.getByRole('tab').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean)).catch(() => []);
      for (const [i, nm] of tabNames.entries()) {
        const t = ui.page.getByRole('tab').nth(i);
        if (!(await t.isVisible().catch(() => false))) continue;
        await t.click({ timeout: 4000 }).catch(() => {}); await settle(ui.page, 700); done.tabs++;
        act(role, area, nm, `click tab "${nm}"`, pageUrl, null, 'visible', true, 'renders', '');
      }
      // dropdowns
      const nSel = await ui.page.locator('select:visible').count();
      for (let i = 0; i < nSel; i++) {
        const sel = ui.page.locator('select:visible').nth(i);
        const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value)).catch(() => []);
        done.selects++;
        for (const v of opts.slice(0, 6)) { await sel.selectOption(v, { timeout: 3000 }).catch(() => {}); await ui.page.waitForTimeout(350); done.options++; }
        act(role, area, null, `open dropdown #${i + 1} and select ${Math.min(opts.length, 6)} option(s)`, pageUrl, null, 'visible', true, 'renders', '');
      }
      // buttons
      const SAFE = /^(view|edit|create|add|new|open|details?|export|today|next|previous|filter|show|refresh|download|org chart|‹|›|\+|request swap|bulk reallocate|assign shift pattern|regularize a missed punch|add a punch|bulk regularize|swap)/i;
      const DENY = /delete|remove|reject|decline|withdraw|approve|publish|accept|send|submit|save|confirm|sign out|log ?out|clear|nudge|assign$|reallocate$|regularize \d/i;
      const names = await ui.page.getByRole('button').evaluateAll((els) => els.filter((e) => e.offsetParent !== null && !e.disabled && !e.closest('[role="dialog"]')).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean)).catch(() => []);
      const uniq = [...new Set(names)].filter((n) => SAFE.test(n) && !DENY.test(n)).slice(0, maxButtons);
      for (const nm of uniq) {
        const b = ui.page.getByRole('button', { name: nm, exact: true }).first();
        if (!(await b.isVisible().catch(() => false)) || (await b.isDisabled().catch(() => true))) continue;
        const before = pathOf(ui.page);
        await b.click({ timeout: 4000 }).catch(() => {}); await ui.page.waitForTimeout(700); done.buttons++;
        const dlg = ui.page.locator('[role="dialog"]').first();
        if (await dlg.isVisible().catch(() => false)) {
          done.dialogs++;
          const title = (await dlg.locator('h1,h2,h3').first().innerText().catch(() => '')).slice(0, 60);
          const dsel = await dlg.locator('select').count();
          for (let i = 0; i < dsel; i++) { const s = dlg.locator('select').nth(i); const os = await s.locator('option').evaluateAll((x) => x.map((o) => o.value)).catch(() => []); for (const v of os.slice(0, 5)) { await s.selectOption(v, { timeout: 2000 }).catch(() => {}); await ui.page.waitForTimeout(250); } }
          await leakCheck(role, `${area} > ${title || nm}`, ui.page);
          act(role, area, title || nm, `press "${nm}" (opens a dialog)`, pageUrl, null, 'visible', true, 'dialog opens', title);
          await ui.page.keyboard.press('Escape'); await ui.page.waitForTimeout(300);
          if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /cancel|close|not yet|back/i }).first().click({ timeout: 2000 }).catch(() => {});
        } else {
          act(role, area, null, `press "${nm}"`, pageUrl, null, 'visible', true, 'responds', '');
        }
        if (pathOf(ui.page) !== before) { await ui.page.goBack().catch(() => {}); await settle(ui.page, 600); }
      }
      judge(role, area, ui, mark);
      console.log(`  ${role.padEnd(18)} ${label.padEnd(28)} tabs=${done.tabs} dropdowns=${done.selects}(${done.options} options) buttons=${done.buttons} dialogs=${done.dialogs}`);
    } finally { await ui.browser.close(); }
  }
  if (want('u1')) {
    console.log('\nU1 — exercise every control');
    // some content to look at: an open swap for the trainer and a pending approval for the approver
    const s1 = await req(A.requester, 'POST', '/hr/attendance/swaps', { peer_id: peer.id, swap_date: d1, reason: `E2E-ui-u1-${stamp}` });
    if (s1.body?.data?.id) await req(A.peer, 'POST', `/hr/attendance/swaps/${s1.body.data.id}/respond`, { accept: true });
    await req(A.approver, 'POST', '/hr/attendance/admin/nudge', { user_ids: [trainer.id], work_date: todayIso() });
    for (const [role, url, label] of [['fitness_trainer', '/attendance', 'Attendance dashboard'], ['fitness_trainer', '/team', 'My team (employee)'], ['fitness_manager', '/team', 'My team (approver)'], ['fitness_manager', '/attendance/team', 'Team attendance'], ['fitness_manager', '/planner', 'Roster planner'], ['tenant_admin', '/attendance/admin', 'Attendance admin']]) {
      try { await exercise(role, url, label); } catch (e) { console.log(`  ${label}: harness error ${String(e.message).slice(0, 100)}`); bug('info', role, `${label} (${url})`, 'Exercise every control', 'completes', `harness error: ${String(e.message).slice(0, 120)}`, '', 'Harness — inspect the selector.'); }
    }
    q(`DELETE FROM hr.shift_swap_requests WHERE reason LIKE 'E2E-ui-u1-%'`);
  }

  // ───────────────────────── U2 swap desk through the browser ──────────────────────────
  if (want('u2')) {
    console.log('\nU2 — shift swap desk, three browsers');
    const area = 'HR > My team > Shift swap desk';
    const tUI = await openAs('fitness_trainer'), pUI = await openAs('org_manager'), aUI = await openAs('fitness_manager');
    try {
      // requester: the Request swap modal
      let mk = markOf(tUI);
      await tUI.page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(tUI.page, 2000);
      const reqBtn = tUI.page.getByRole('button', { name: /^request swap$/i }).first();
      if (!(await reqBtn.count())) { bug('high', 'fitness_trainer', area, 'Request swap button missing', 'Visible for swap.request holders', 'Not found on /team', '', 'TeamRosterShell canRequest.'); }
      else {
        await reqBtn.click(); await tUI.page.locator('#sw-peer').waitFor({ timeout: 8000 });
        // empty submit: client-side message, no request
        let fired = false; tUI.page.on('request', (r) => { if (r.method() === 'POST' && /\/hr\/attendance\/swaps$/.test(r.url())) fired = true; });
        await tUI.page.getByRole('button', { name: /^send request$/i }).click(); await tUI.page.waitForTimeout(600);
        const emptyMsg = await tUI.page.locator('[role="alert"]').first().innerText().catch(() => '');
        check(!fired && /pick a teammate/i.test(emptyMsg), `empty form: "${emptyMsg.slice(0, 50)}", POST fired=${fired}`, ['medium', 'fitness_trainer', area, 'Send an empty swap request', 'Inline validation, no request', `msg="${emptyMsg}" fired=${fired}`, '', 'submit() guard.']);
        // dropdown contents: only teammates, never self / the manager / other branches
        const opts = await tUI.page.locator('#sw-peer option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
        const peerName = peer.name ?? 'Anup Pundir';
        const listed = opts.filter((o) => o.v);
        const badOpt = listed.filter((o) => o.v === trainer.id || o.v === appr.id || (rows(`SELECT 1 FROM hr.employee_profiles WHERE user_id=${lit(o.v)} AND org_id<>${lit(orgId)}`, ['x']).length > 0));
        console.log(`  peer dropdown: ${listed.length} option(s): ${listed.map((o) => o.t).slice(0, 6).join(', ')}`);
        check(listed.some((o) => o.v === peer.id) && badOpt.length === 0, `dropdown lists the peer (${peerName}) and nobody foreign / self / the manager`, ['high', 'fitness_trainer', area, 'Peer dropdown contents', 'teammates only', `${badOpt.length} wrong option(s)`, JSON.stringify(badOpt).slice(0, 150), 'Dropdown is built from the scoped roster.']);
        // a real submit
        await tUI.page.locator('#sw-peer').selectOption(peer.id);
        for (const v of [addDays(todayIso(), 0)]) { await tUI.page.locator('#sw-date').fill(v); await tUI.page.locator('#sw-reason').fill(`E2E-ui-today-${stamp}`); const r0 = await clickAndWait(tUI.page, tUI.page.getByRole('button', { name: /^send request$/i }), 'POST', /\/hr\/attendance\/swaps$/); const msg = await tUI.page.locator('[role="alert"]').first().innerText().catch(() => ''); check(r0.status === 400 && /future|day/i.test(msg) && !leakOf(msg), `today as the swap day -> ${r0.status}, shown: "${msg.slice(0, 70)}"`, ['medium', 'fitness_trainer', area, 'Past/today swap day in the form', 'A friendly 4xx message in the modal', `${r0.status} "${msg}"`, '', 'The modal shows the server message.']); }
        await tUI.page.locator('#sw-date').fill(d1);
        await tUI.page.locator('#sw-reason').fill(`E2E-ui-swap-${stamp}`);
        const sent = await clickAndWait(tUI.page, tUI.page.getByRole('button', { name: /^send request$/i }), 'POST', /\/hr\/attendance\/swaps$/);
        const row = rows(`SELECT id::text, status, manager_id::text FROM hr.shift_swap_requests WHERE reason=${lit(`E2E-ui-swap-${stamp}`)}`, ['id', 'status', 'mgr'])[0];
        act('fitness_trainer', area, 'Request swap', 'submit the Request swap form', 'POST /hr/attendance/swaps', sent.status, sent.status === 201 ? 'allowed' : 'error', !!row, 'allowed (201)', row ? `swap ${row.id}` : 'no row');
        check(sent.status === 201 && row?.status === 'pending_peer' && row.mgr === appr.id, `Send request -> ${sent.status}; DB row ${row?.status}, approver=${row?.mgr === appr.id ? 'fitness_manager' : row?.mgr}`, ['high', 'fitness_trainer', area, 'Request swap through the UI', '201 and a pending_peer row with the manager as approver', JSON.stringify({ sent, row }), '', 'swaps.create.']);
        await tUI.page.waitForTimeout(1500);
        const listedTicket = await tUI.page.locator('body').innerText();
        check(/Anup/i.test(listedTicket) && /pending|waiting|awaiting/i.test(listedTicket), 'the new ticket appears in "All swap activity" with a pending status', ['medium', 'fitness_trainer', area, 'List refresh after create', 'ticket visible', 'not visible', '', 'load() after onDone.']);
        // duplicate through the UI
        await tUI.page.getByRole('button', { name: /^request swap$/i }).first().click(); await tUI.page.locator('#sw-peer').waitFor();
        await tUI.page.locator('#sw-peer').selectOption(peer.id); await tUI.page.locator('#sw-date').fill(d1); await tUI.page.locator('#sw-reason').fill(`E2E-ui-dup-${stamp}`);
        const dup = await clickAndWait(tUI.page, tUI.page.getByRole('button', { name: /^send request$/i }), 'POST', /\/hr\/attendance\/swaps$/);
        const dupMsg = await tUI.page.locator('[role="alert"]').first().innerText().catch(() => '');
        check(dup.status === 409 && /already/i.test(dupMsg) && !leakOf(dupMsg), `duplicate request -> ${dup.status}, modal says "${dupMsg.slice(0, 70)}"`, ['medium', 'fitness_trainer', area, 'Duplicate swap in the UI', '409 with a readable message', `${dup.status} "${dupMsg}"`, '', 'Map ConflictError to the modal alert.']);
        await tUI.page.keyboard.press('Escape');
        // clicking a teammate's cell opens the same modal pre-filled
        const cell = tUI.page.locator('button[title="Request a swap for this day"]').first();
        if (await cell.count()) { await cell.click(); await tUI.page.waitForTimeout(500); const pre = await tUI.page.locator('#sw-peer').inputValue().catch(() => ''); act('fitness_trainer', area, 'Roster', 'click a teammate\'s roster cell', 'modal', null, 'visible', !!pre, 'prefilled modal', `peer preselected=${!!pre}`); await tUI.page.keyboard.press('Escape'); }
      }
      judge('fitness_trainer', area, tUI, mk, { allow4xx: [/\/hr\/attendance\/swaps/] });

      // peer: Accept in the UI
      const swapId = rows(`SELECT id::text FROM hr.shift_swap_requests WHERE reason=${lit(`E2E-ui-swap-${stamp}`)}`, ['id'])[0]?.id;
      if (swapId) {
        mk = markOf(pUI);
        await pUI.page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(pUI.page, 2000);
        const card = pUI.page.locator('li', { hasText: `E2E-ui-swap-${stamp}` }).first();
        const acceptBtn = card.getByRole('button', { name: /^accept$/i });
        if (!(await acceptBtn.count())) bug('high', 'org_manager', area, 'Peer sees no Accept button for a swap addressed to them', '"Waiting for your answer" with Accept/Decline', 'Not found', swapId, 'listMine + the peer filter in TeamRosterShell.');
        else {
          const r = await clickAndWait(pUI.page, acceptBtn, 'POST', /\/swaps\/[0-9a-f-]{36}\/respond$/);
          const st = swapRow(swapId)?.status;
          act('org_manager', area, 'Waiting for your answer', 'press Accept on a swap addressed to me', 'POST .../respond', r.status, r.status === 200 ? 'allowed' : 'error', st === 'pending_manager', 'allowed', `DB status ${st}`);
          check(r.status === 200 && st === 'pending_manager', `Accept -> ${r.status}, DB ${st}`, ['high', 'org_manager', area, 'Peer accepts in the UI', '200 and pending_manager', `${r.status} ${st}`, '', 'swaps.respond.']);
        }
        judge('org_manager', area, pUI, mk, { allow4xx: [/\/hr\/attendance\/swaps/] });

        // approver: Approve in the UI
        mk = markOf(aUI);
        await aUI.page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(aUI.page, 2000);
        const acard = aUI.page.locator('li', { hasText: `E2E-ui-swap-${stamp}` }).first();
        const appBtn = acard.getByRole('button', { name: /^approve$/i });
        if (!(await appBtn.count())) bug('high', 'fitness_manager', area, 'Approver sees no Approve button in "Swaps awaiting approval"', 'Card with Approve/Reject', 'Not found', swapId, 'listQueue + canDecide.');
        else {
          const r = await clickAndWait(aUI.page, appBtn, 'POST', /\/swaps\/[0-9a-f-]{36}\/approve$/);
          const st = swapRow(swapId)?.status;
          const swapped = shiftOn(trainer.id, d1) === sB.name && shiftOn(peer.id, d1) === sA.name && coverCount(trainer.id, d1) === 1;
          act('fitness_manager', area, 'Swaps awaiting approval', 'press Approve', 'POST .../approve', r.status, r.status === 200 ? 'allowed' : 'error', swapped, 'allowed', `DB ${st}; roster swapped=${swapped}`);
          check(r.status === 200 && st === 'approved' && swapped, `Approve -> ${r.status}, DB ${st}, rosters swapped=${swapped}`, ['critical', 'fitness_manager', area, 'Approve in the UI', '200, approved, both rosters exchanged for that day', `${r.status} ${st} swapped=${swapped}`, '', 'swaps.decide.']);
        }
        judge('fitness_manager', area, aUI, mk, { allow4xx: [/\/hr\/attendance\/swaps/] });
      }

      // reject path (API-made request, UI decision) + withdraw path
      const r2 = await req(A.requester, 'POST', '/hr/attendance/swaps', { peer_id: peer.id, swap_date: d2, reason: `E2E-ui-rej-${stamp}` });
      const id2 = r2.body?.data?.id; if (id2) await req(A.peer, 'POST', `/hr/attendance/swaps/${id2}/respond`, { accept: true });
      if (id2) {
        const before = [shiftOn(trainer.id, d2), shiftOn(peer.id, d2)];
        mk = markOf(aUI);
        await aUI.page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(aUI.page, 2000);
        const rc = aUI.page.locator('li', { hasText: `E2E-ui-rej-${stamp}` }).first();
        await rc.getByRole('button', { name: /^reject$/i }).click();
        await aUI.page.locator('#rj-comment').waitFor({ timeout: 6000 });
        let fired = false; aUI.page.on('request', (r) => { if (r.method() === 'POST' && /\/reject$/.test(r.url())) fired = true; });
        await aUI.page.getByRole('button', { name: /^reject$/i }).last().click(); await aUI.page.waitForTimeout(500);
        const msg = await aUI.page.locator('[role="alert"]').first().innerText().catch(() => '');
        check(!fired && /comment is required/i.test(msg), `Reject without a comment is stopped in the form ("${msg.slice(0, 50)}", fired=${fired})`, ['medium', 'fitness_manager', area, 'Reject modal validation', 'Inline error, no request', `fired=${fired} "${msg}"`, '', 'RejectModal.submit guard.']);
        await aUI.page.locator('#rj-comment').fill('E2E ui rejection');
        const rj = await clickAndWait(aUI.page, aUI.page.getByRole('button', { name: /^reject$/i }).last(), 'POST', /\/reject$/);
        const row = swapRow(id2); const same = shiftOn(trainer.id, d2) === before[0] && shiftOn(peer.id, d2) === before[1];
        act('fitness_manager', area, 'Swaps awaiting approval', 'Reject with a comment', 'POST .../reject', rj.status, rj.status === 200 ? 'allowed' : 'error', row?.status === 'rejected' && same, 'allowed', `comment=${row?.approver_comment}`);
        check(rj.status === 200 && row?.status === 'rejected' && row.approver_comment === 'E2E ui rejection' && same, `Reject -> ${rj.status}, DB ${row?.status}, comment stored, rosters untouched=${same}`, ['high', 'fitness_manager', area, 'Reject in the UI', '200, rejected, comment kept, no roster change', JSON.stringify({ rj, row, same }), '', 'swaps.decide(reject).']);
        judge('fitness_manager', area, aUI, mk, { allow4xx: [/\/hr\/attendance\/swaps/] });
      }
      const r3 = await req(A.requester, 'POST', '/hr/attendance/swaps', { peer_id: peer.id, swap_date: d3, reason: `E2E-ui-wd-${stamp}` });
      const id3 = r3.body?.data?.id;
      if (id3) {
        mk = markOf(tUI);
        await tUI.page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(tUI.page, 2000);
        const wb = tUI.page.locator('li', { hasText: `E2E-ui-wd-${stamp}` }).first().getByRole('button', { name: /withdraw/i });
        if (!(await wb.count())) bug('medium', 'fitness_trainer', area, 'No Withdraw control on the requester\'s open swap', 'Withdraw while pending', 'Not found', id3, 'TeamRosterShell activity list.');
        else { const w = await clickAndWait(tUI.page, wb, 'POST', /\/cancel$/); const st = swapRow(id3)?.status; act('fitness_trainer', area, 'All swap activity', 'Withdraw an open swap', 'POST .../cancel', w.status, w.status === 200 ? 'allowed' : 'error', st === 'cancelled', 'allowed', `DB ${st}`); check(w.status === 200 && st === 'cancelled', `Withdraw -> ${w.status}, DB ${st}`, ['high', 'fitness_trainer', area, 'Withdraw in the UI', '200 cancelled', `${w.status} ${st}`, '', 'swaps.cancel.']); }
        judge('fitness_trainer', area, tUI, mk, { allow4xx: [/\/hr\/attendance\/swaps/] });
      }
    } finally { for (const u of [tUI, pUI, aUI]) await u.browser.close(); }
  }

  // ───────────────────────── U3 roster planner through the browser ─────────────────────
  if (want('u3')) {
    console.log('\nU3 — roster planner, real forms');
    const area = 'HR > Roster planner';
    q(`DELETE FROM hr.shift_swap_requests WHERE reason LIKE 'E2E-ui-%'`);
    const ui = await openAs('fitness_manager');
    try {
      const mk = markOf(ui);
      const target = d4; // a working day >= 3 days ahead
      const weeksAhead = Math.round((Date.parse(`${mondayOf(target)}T00:00:00Z`) - Date.parse(`${mondayOf(todayIso())}T00:00:00Z`)) / (7 * 864e5));
      await ui.page.goto(`${HR}/planner`, { waitUntil: 'domcontentloaded' }); await settle(ui.page, 2500);
      // view tabs
      for (const v of ['Day', 'Month', 'Week']) { await ui.page.getByRole('tab', { name: v, exact: true }).click({ timeout: 4000 }).catch(() => {}); await settle(ui.page, 600); act('fitness_manager', area, v, `switch the roster view to ${v}`, '/planner', null, 'visible', true, 'renders'); }
      await ui.page.getByRole('button', { name: /^Today$/ }).click().catch(() => {});
      for (let i = 0; i < weeksAhead; i++) { await ui.page.getByRole('button', { name: /Next week/i }).click(); await settle(ui.page, 500); }
      await ui.page.getByLabel('Search people').fill(trainer.name?.split(' ')[0] ?? 'Kishan'); await settle(ui.page, 900);
      const row = ui.page.locator('tr', { hasText: trainer.name ?? 'Kishan' }).first();
      if (!(await row.count())) throw new Error('fixture person not on the planner grid');
      const dayIdx = (dowOf(target) + 6) % 7;
      const cellBtn = row.locator('button[title="Change this day"]').nth(dayIdx);
      // single-day edit
      await cellBtn.click(); await ui.page.locator('input[name="shift"]').first().waitFor({ timeout: 6000 });
      await ui.page.locator('label', { hasText: sC.name }).locator('input[name="shift"]').check();
      const save1 = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^save$/i }), 'PUT', /planner\/cells$/);
      const got1 = shiftOn(trainer.id, target);
      act('fitness_manager', area, 'Week', 'click a day, choose a shift, Save', 'PUT /planner/cells', save1.status, save1.status === 200 ? 'allowed' : 'error', got1 === sC.name, 'allowed', `DB ${got1}`);
      check(save1.status === 200 && got1 === sC.name && shiftOn(trainer.id, addDays(target, 1)) === sA.name, `cell edit -> ${save1.status}; DB ${target} = ${got1?.slice(8, 9)} and the next day is still A`, ['critical', 'fitness_manager', area, 'Planner cell edit via the UI', 'PUT 200; one-day carve in hr.shift_assignments', JSON.stringify({ save1, got1 }), '', 'planner.apply + applyForPerson.']);
      await settle(ui.page, 900);
      const chip = await row.innerText().catch(() => '');
      check(chip.includes(sC.name), 'the grid re-renders the new shift in the cell');
      // range edit: apply through target+1 (clear)
      await cellBtn.click(); await ui.page.locator('#cm-to').waitFor({ timeout: 6000 });
      await ui.page.locator('label', { hasText: sB.name }).locator('input[name="shift"]').check();
      const nextDay = addDays(target, 1);
      await ui.page.locator('#cm-to').fill(nextDay);
      const save2 = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^save$/i }), 'PUT', /planner\/cells$/);
      check(save2.status === 200 && shiftOn(trainer.id, target) === sB.name && shiftOn(trainer.id, nextDay) === sB.name, `range edit (Apply through ${nextDay}) -> ${save2.status}; both days = B`, ['high', 'fitness_manager', area, 'Planner range edit via the UI', 'both days B', `${save2.status} ${shiftOn(trainer.id, target)} / ${shiftOn(trainer.id, nextDay)}`, '', 'CellModal.save.']);
      // "people needed" (click the shift card)
      await ui.page.locator('button', { hasText: sA.name }).first().click();
      await ui.page.locator('#nd-n').waitFor({ timeout: 6000 });
      await ui.page.locator('#nd-n').fill('4');
      const nd = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^save$/i }), 'PUT', /planner\/requirements$/);
      const need = scalar(`SELECT required_headcount FROM hr.shift_requirements WHERE shift_id=${lit(sA.id)} AND NOT is_deleted`);
      act('fitness_manager', area, 'Capacity cards', 'set "people needed" for a shift', 'PUT /planner/requirements', nd.status, nd.status === 204 ? 'allowed' : 'error', need === '4', 'allowed (204)', `DB ${need}`);
      check(nd.status === 204 && need === '4', `people needed -> ${nd.status}, DB ${need}`, ['high', 'fitness_manager', area, 'Set requirement via the UI', '204 and required_headcount 4', `${nd.status} ${need}`, '', 'NeedModal.save.']);
      // assign shift pattern to the ticked person
      await row.locator('input[type="checkbox"]').first().check();
      await ui.page.getByRole('button', { name: /assign shift pattern/i }).click();
      await ui.page.locator('#pm-shift').waitFor({ timeout: 6000 });
      await ui.page.locator('#pm-shift').selectOption(sA.id);
      await ui.page.locator('#pm-from').fill(target); await ui.page.locator('#pm-to').fill(addDays(target, 2));
      const pat = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^assign$/i }), 'PUT', /planner\/cells$/);
      const patOk = [0, 1, 2].every((i) => shiftOn(trainer.id, addDays(target, i)) === sA.name);
      act('fitness_manager', area, 'Week', 'tick a person, Assign shift pattern', 'PUT /planner/cells', pat.status, pat.status === 200 ? 'allowed' : 'error', patOk, 'allowed', '');
      check(pat.status === 200 && patOk, `assign pattern -> ${pat.status}, three days = A in the DB`, ['high', 'fitness_manager', area, 'Assign shift pattern via the UI', '200 and A for the range', `${pat.status} ${patOk}`, '', 'PatternModal.save.']);
      // bulk reallocate A -> C for the ticked person
      await ui.page.getByRole('button', { name: /^bulk reallocate$/i }).click();
      await ui.page.locator('#ra-from').waitFor({ timeout: 6000 });
      await ui.page.locator('#ra-from').selectOption(sA.id); await ui.page.locator('#ra-to').selectOption(sC.id);
      await ui.page.locator('#ra-d1').fill(target); await ui.page.locator('#ra-d2').fill(addDays(target, 2));
      const ra = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^reallocate$/i }), 'POST', /planner\/reallocate$/);
      const raOk = [0, 1, 2].every((i) => shiftOn(trainer.id, addDays(target, i)) === sC.name);
      act('fitness_manager', area, 'Week', 'Bulk reallocate A -> C', 'POST /planner/reallocate', ra.status, ra.status === 200 ? 'allowed' : 'error', raOk, 'allowed', '');
      check(ra.status === 200 && raOk, `bulk reallocate -> ${ra.status}, three days = C in the DB`, ['high', 'fitness_manager', area, 'Bulk reallocate via the UI', '200 and C for the range', `${ra.status} ${raOk}`, '', 'ReallocateModal.save.']);
      // publish
      const pubBefore = Number(scalar(`SELECT COUNT(*) FROM hr.roster_publications WHERE org_id=${lit(orgId)} AND week_start=${lit(mondayOf(target))} AND NOT is_deleted`));
      await ui.page.getByRole('button', { name: /^publish roster$/i }).click();
      await ui.page.locator('#pb-note').waitFor({ timeout: 6000 });
      await ui.page.locator('#pb-note').fill('E2E ui publish');
      const pub = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^publish$/i }), 'POST', /planner\/publish$/);
      const pubRow = rows(`SELECT note, published_by::text FROM hr.roster_publications WHERE org_id=${lit(orgId)} AND week_start=${lit(mondayOf(target))} AND NOT is_deleted`, ['note', 'by'])[0];
      await settle(ui.page, 900);
      const chipTxt = await ui.page.locator('body').innerText();
      act('fitness_manager', area, 'Week', 'Publish roster with a note', 'POST /planner/publish', pub.status, pub.status === 200 ? 'allowed' : 'error', pubRow?.note === 'E2E ui publish', 'allowed', `rows before ${pubBefore}`);
      check(pub.status === 200 && pubRow?.note === 'E2E ui publish' && pubRow.by === appr.id && /Published/.test(chipTxt), `publish -> ${pub.status}; DB note stored, published_by = session user; header chip says Published`, ['high', 'fitness_manager', area, 'Publish via the UI', '200, row, chip updates', `${pub.status} ${JSON.stringify(pubRow)} chip=${/Published/.test(chipTxt)}`, '', 'PublishModal.save.']);
      await leakCheck('fitness_manager', area, ui.page);
      judge('fitness_manager', area, ui, mk);
    } catch (e) {
      console.log(`  U3 harness error: ${String(e.message).slice(0, 160)}`);
      bug('info', 'fitness_manager', area, 'Planner UI flow', 'completes', `harness error: ${String(e.message).slice(0, 140)}`, '', 'Harness — inspect the selector.');
    } finally { await ui.browser.close(); }
  }

  // ───────────────────────── U4 team attendance + punch hub ───────────────────────────
  if (want('u4')) {
    console.log('\nU4 — team attendance (bulk regularize, add a punch) and the employee punch hub');
    const area = 'HR > Attendance > Team';
    const day = (() => { let d = addDays(todayIso(), -2); while ([0, 6].includes(dowOf(d))) d = addDays(d, -1); return d; })();
    const ui = await openAs('fitness_manager');
    try {
      const mk = markOf(ui);
      await ui.page.goto(`${HR}/attendance/team`, { waitUntil: 'domcontentloaded' }); await settle(ui.page, 2500);
      await ui.page.getByLabel('Select date').fill(day); await settle(ui.page, 1500);
      const tabs = await ui.page.getByRole('tab').evaluateAll((els) => els.map((e) => e.textContent.trim())).catch(() => []);
      for (const [i] of tabs.entries()) { await ui.page.getByRole('tab').nth(i).click({ timeout: 3000 }).catch(() => {}); await ui.page.waitForTimeout(400); }
      if (tabs.length) await ui.page.getByRole('tab').first().click().catch(() => {});
      const pick = async (name) => { const cb = ui.page.getByLabel(`Select ${name}`).first(); if (await cb.count()) { await cb.check({ force: true }).catch(() => {}); return true; } return false; };
      const okSel = (await pick(trainer.name)) && (await pick(peer.name));
      if (!okSel) bug('medium', 'fitness_manager', area, 'Select checkboxes missing for the fixture people', 'Rows selectable for admin.override holders', 'not found', `${trainer.name}/${peer.name}`, '', 'TeamDayView tools.');
      else {
        await ui.page.getByRole('button', { name: /^bulk regularize$/i }).click();
        await ui.page.locator('#br-status').waitFor({ timeout: 6000 });
        const statuses = await ui.page.locator('#br-status option').evaluateAll((os) => os.map((o) => o.value));
        // the dropdown must only offer statuses the server knows
        const known = new Set(rows(`SELECT name FROM hr.attendance_statuses WHERE tenant_id=${lit(fx.tenantId)}`, ['n']).map((r) => r.n));
        check(statuses.every((s) => known.has(s)), `Bulk regularize dropdown offers only real statuses (${statuses.join(', ')})`, ['medium', 'fitness_manager', area, 'Bulk regularize status list', 'every option exists in hr.attendance_statuses', `unknown: ${statuses.filter((s) => !known.has(s)).join(',')}`, '', 'STATUS_CHOICES in RosterTools.tsx must match the tenant statuses.']);
        let fired = false; ui.page.on('request', (r) => { if (r.method() === 'POST' && /bulk-regularize/.test(r.url())) fired = true; });
        await ui.page.getByRole('button', { name: /^regularize 2$/i }).click(); await ui.page.waitForTimeout(500);
        check(!fired && /reason is required/i.test(await ui.page.locator('[role="alert"]').first().innerText().catch(() => '')), 'Bulk regularize without a reason is stopped in the form');
        await ui.page.locator('#br-status').selectOption('wfh'); await ui.page.locator('#br-reason').fill(`E2E-ui-bulk-${stamp}`);
        const br = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^regularize 2$/i }), 'POST', /bulk-regularize$/);
        const dT = rows(`SELECT s.name FROM hr.attendance_days ad JOIN hr.attendance_statuses s ON s.id=ad.status_id WHERE ad.user_id=${lit(trainer.id)} AND ad.work_date=${lit(day)}`, ['n'])[0]?.n;
        const dP = rows(`SELECT s.name FROM hr.attendance_days ad JOIN hr.attendance_statuses s ON s.id=ad.status_id WHERE ad.user_id=${lit(peer.id)} AND ad.work_date=${lit(day)}`, ['n'])[0]?.n;
        act('fitness_manager', area, 'Day view', 'select 2 people, Bulk regularize as wfh', 'POST /admin/bulk-regularize', br.status, br.status === 200 ? 'allowed' : 'error', dT === 'wfh' && dP === 'wfh', 'allowed', `trainer=${dT} peer=${dP}`);
        check(br.status === 200 && dT === 'wfh' && dP === 'wfh', `Bulk regularize -> ${br.status}; DB trainer=${dT}, peer=${dP}`, ['high', 'fitness_manager', area, 'Bulk regularize via the UI', '200, both days wfh', `${br.status} ${dT}/${dP}`, '', 'RosterToolbar.']);
        await settle(ui.page, 1200);
        // add a punch
        const addBtn = ui.page.getByRole('button', { name: /add a punch/i }).first();
        if (await addBtn.count()) {
          await addBtn.click(); await ui.page.locator('#mp-when').waitFor({ timeout: 6000 });
          await ui.page.locator('#mp-type').selectOption('check_in'); await ui.page.locator('#mp-when').fill(`${day}T09:15`); await ui.page.locator('#mp-reason').fill(`E2E-ui-punch-${stamp}`);
          const mp = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^add punch$/i }), 'POST', /manual-punch$/);
          const ev = rows(`SELECT user_id::text, source, device_info->>'reason' FROM hr.attendance_events WHERE device_info->>'reason'=${lit(`E2E-ui-punch-${stamp}`)}`, ['u', 's', 'r'])[0];
          act('fitness_manager', area, 'Day view', 'Add a punch for a person', 'POST /admin/manual-punch', mp.status, mp.status === 201 ? 'allowed' : 'error', !!ev, 'allowed (201)', `source ${ev?.s}`);
          check(mp.status === 201 && ev?.s === 'manual', `Add punch -> ${mp.status}; DB event source=${ev?.s}`, ['high', 'fitness_manager', area, 'Add a punch via the UI', '201 and a manual event row', `${mp.status} ${JSON.stringify(ev)}`, '', 'ManualPunchModal.']);
        }
        // nudge
        const nudgeBtn = ui.page.getByRole('button', { name: /^nudge/i }).first();
        if (await nudgeBtn.count()) {
          const before = Number(scalar(`SELECT COUNT(*) FROM audit.activities WHERE action_type='attendance_nudge' AND created_at > now() - interval '5 minutes'`));
          await ui.page.getByRole('button', { name: /^clear$/i }).click().catch(() => {});
          const nu = await clickAndWait(ui.page, ui.page.getByRole('button', { name: /^nudge/i }).first(), 'POST', /admin\/nudge$/);
          await sleep(1200);
          const after = Number(scalar(`SELECT COUNT(*) FROM audit.activities WHERE action_type='attendance_nudge' AND created_at > now() - interval '5 minutes'`));
          act('fitness_manager', area, 'Day view', 'Nudge people who have not punched', 'POST /admin/nudge', nu.status, nu.status === 200 ? 'allowed' : 'error', after >= before, 'allowed', `${nu.body?.data?.nudged ?? '?'} nudged`);
          check(nu.status === 200, `Nudge -> ${nu.status} (${JSON.stringify(nu.body?.data)})`, ['medium', 'fitness_manager', area, 'Nudge via the UI', '200', `${nu.status}`, '', 'RosterToolbar.nudge.']);
        }
      }
      judge('fitness_manager', area, ui, mk);
    } catch (e) {
      console.log(`  U4 harness error: ${String(e.message).slice(0, 160)}`);
      bug('info', 'fitness_manager', area, 'Team attendance UI flow', 'completes', `harness error: ${String(e.message).slice(0, 140)}`, '', 'Harness — inspect the selector.');
    } finally { await ui.browser.close(); }

    // employee side: nudge banner + punch log month filter at a boundary (timezone fixed to IST)
    {
      const area2 = 'HR > Attendance > Dashboard';
      await req(A.approver, 'POST', '/hr/attendance/admin/nudge', { user_ids: [trainer.id], work_date: todayIso() });
      // an event at 00:30 IST on the 1st of next month sits on the UTC date of the 31st
      const nm = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); })();
      const cm = todayIso().slice(0, 7);
      q(`INSERT INTO hr.attendance_events (user_id, org_id, event_type, occurred_at, source, is_within_geofence) VALUES (${lit(trainer.id)}, ${lit(orgId)}, 'check_in', ${lit(`${nm}T00:30:00+05:30`)}::timestamptz, 'web', TRUE)`);
      const browser = await chromium.launch();
      const ctx = await browser.newContext({ storageState: authFile('fitness_trainer'), timezoneId: 'Asia/Kolkata' });
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message))); page.on('response', (r) => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`); });
      try {
        await page.goto(`${HR}/attendance`, { waitUntil: 'domcontentloaded' }); await settle(page, 2500);
        const banner = await page.getByRole('status').filter({ hasText: /reminded you/i }).count();
        act('fitness_trainer', area2, 'Dashboard', 'see the HR nudge banner', '/attendance', null, banner ? 'visible' : 'hidden', banner > 0, 'banner visible after a nudge', '');
        check(banner > 0, 'the nudge sent by HR shows as a banner on the employee dashboard', ['high', 'fitness_trainer', area2, 'Nudge banner', 'visible after POST /admin/nudge', 'not visible', '', 'NudgeBanner / GET /me/nudges.']);
        // punch log: the boundary punch belongs to NEXT month, must not show under the current month
        const monthInput = page.getByLabel('Month');
        if (await monthInput.count()) {
          await monthInput.fill(cm); await settle(page, 1500);
          const txt = await page.locator('body').innerText();
          const showsBoundary = /00:30|12:30\s*am/i.test(txt) && new RegExp(`\\b1 ${nm.slice(5, 7) === '01' ? 'Jan' : ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(nm.slice(5, 7))]}`, 'i').test(txt);
          act('fitness_trainer', area2, 'Biometric & geofence logs', `punch log for ${cm} with a 00:30 IST punch on ${nm}`, '/attendance', null, showsBoundary ? 'visible' : 'hidden', !showsBoundary, 'the next month\'s punch is not listed', '');
          check(!showsBoundary, `punch log ${cm} does not list the ${nm} 00:30 punch`, ['low', 'fitness_trainer', area2, 'Punch log month filter at a month boundary', `A punch at 00:30 IST on ${nm} belongs to the next month and is not listed under ${cm}`, 'It is listed under the previous month', `event ${nm}T00:30+05:30 = ${nm.slice(0, 8)}-1 UTC`, 'msq-hrms packages/hr-web/src/components/attendance/PunchLog.tsx (~line 43): the filter is `occurred_at.startsWith(month) || localDate.startsWith(month)`; the UTC-prefix half of the OR keeps a punch whose UTC date is still in the previous month. Filter on the org-local date only.']);
        }
        const body = await page.locator('body').innerText();
        const l = leakOf(body); if (l) bug('medium', 'fitness_trainer', area2, 'Backend internals visible', 'friendly text', l, '', '');
        if (errs.length) bug('high', 'fitness_trainer', area2, 'Page error / 5xx on the punch hub', 'none', errs[0], '', '');
      } finally { await browser.close(); }
    }
  }
} finally {
  if (fx) teardownFixtures(fx);
  try { runRestore(`${key}-att`); } catch (e) { console.log(`  !! attendance restore failed: ${String(e.message).split('\n')[0]}`); }
  q(`DELETE FROM hr.shift_swap_requests WHERE reason LIKE 'E2E-%' AND org_id=${lit(orgId)}`);
  q(`DELETE FROM hr.roster_publications WHERE note LIKE 'E2E%'`);
  await closeActors(A);
}
console.log(`\nhr-attendance-ui-flows: ${findingCount()} finding(s).`);
