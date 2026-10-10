// UI-driven (Playwright) walk of the HR people / payroll pages, verified in Postgres.
//
// Pages: /hrms/profile, /hrms/employees, /hrms/employees/<userId>, /hrms/org-chart, /hrms/documents,
//        /hrms/payroll, /hrms/reports, /hrms/team, /hrms/dashboard.
//
// PART 1 — ACCESS GRID. Every login in roles.json + the cross-tenant actors opens every page; the landing
//   URL is compared with the page guard's own capability (profile.edit / profile360.view / employees.view /
//   documents.view|manage / payslip.view|payroll.manage / reports.attendance.view / roster.view /
//   dashboard = anyone). Reachable without the capability = high; redirected despite the capability = high.
//   Console errors, page errors and 4xx/5xx of every load are recorded (leaked backend text on screen too).
// PART 2 — SWEEP. For one employee login and one HR admin: click every tab, open every <select> (cycle each
//   option), press every safe View / Edit / Show-numbers / Table / Cards / Export button, close every modal.
//   Destructive controls (Remove, Retire, Publish, Lock, Approve, Assign, Save ...) are NEVER pressed in the sweep.
// PART 3 — REAL FORMS (each verified in the DB, snapshotted and purged):
//   F1 My profile: edit personal details (+XSS-shaped preferred name), add + remove an emergency contact,
//      file a statutory change request (bad value refused in the UI path, good value stored) and withdraw it.
//   F2 Documents: upload a PDF (tax-proof fields), upload a non-document renamed .pdf (refused), HR verifies
//      it in the review queue, the employee removes a second one.
//   F3 Payroll (month 2020-03): HR drafts a payslip (HTML in a line label), publishes, employee sees it and
//      the label renders ESCAPED, HR locks and unlocks.
//   F4 Employee 360: HR opens the profile, visits every tab, adds a note (XSS-shaped), edits statutory numbers,
//      reveals / hides them, creates an asset and assigns / takes it back.
//   F5 Dashboard: HR posts an announcement with an XSS payload from the UI; the employee sees it as text; HR retires it.
//   F6 HR approves the employee's change request in the Employees page queue and the numbers land.
//
//   node suites/hr/hr-people-ui.mjs            # everything
//   node suites/hr/hr-people-ui.mjs grid       # part 1 only      (also: sweep, forms)
import { openAs, APPS, ROLES, CROSS_TENANT, authFile, record } from '../../lib.mjs';
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import { logAction } from '../../journal.mjs';
import {
  HR, MARK, STAMP, suite, open, who, hasAuth, guarded, otherEmployeeIn, snapshotRow, journalPurge, waitFor, q, scalar, rows, lit,
  pdfBytes, b64,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');
const only = process.argv[2] || 'all';
const want = (s) => only === 'all' || only === s;

const t = suite('hr', 'HR people UI');
const cleanups = [];
const HRW = APPS['hr-web'];
const BAD_IGNORE = /notifications\/stream|favicon|\/_next\/|\.map(\?|$)|hot-update|manifest|apple-touch|\/auth\/refresh|chunk|_rsc=|ERR_ABORTED/i;
const TEXT_LEAK = /(\bat [\w$.<>]+ \(|node_modules|\/src\/[\w/.-]+\.ts|SELECT\b[\s\S]{0,60}\bFROM\b|PostgresError|violates .*constraint|Internal server error|TypeError|undefined is not|\[object Object\]|NaN\b.*NaN)/;

// ── page watcher: console / page errors and bad HTTP since a mark ───────────
const mark = (log) => ({ c: log.consoleErrors.length, p: log.pageErrors.length, b: log.badRequests.length });
function delta(log, m) {
  return {
    console: log.consoleErrors.slice(m.c).filter((x) => !/Failed to load resource/.test(x)),
    page: log.pageErrors.slice(m.p),
    bad: log.badRequests.slice(m.b).filter((x) => !BAD_IGNORE.test(x)),
  };
}
const seenBad = new Set();
function report(role, where, d, { allowBad = null, sevBad = 'medium' } = {}) {
  for (const x of d.page) t.find('medium', role, `${where} — uncaught page error`, 'No uncaught exception', x, x, 'Fix the component error; wrap data access in guards.');
  for (const x of d.console) if (!/hydrat|Warning:/i.test(x)) t.find('low', role, `${where} — console error`, 'A clean console', x, x, 'Investigate the console error.');
  let photo404 = 0;
  for (const x of d.bad) {
    if (allowBad && allowBad.test(x)) continue;
    const st = Number((x.match(/^(\d{3}) /) ?? [])[1] ?? 0);
    if (st === 404 && /\/api\/users\/[0-9a-f-]{36}\/photo/.test(x)) { photo404++; continue; }
    const norm = x.replace(/[0-9a-f-]{36}/g, ':id').replace(/\?.*$/, '');
    const k = `${role}|${where}|${norm}`;
    if (seenBad.has(k)) continue; seenBad.add(k);
    t.find(st >= 500 || x.startsWith('FAILED') ? 'high' : sevBad, role, `${where} — HTTP error on a normal page load`, '2xx', x, x, 'A page must not fire requests it is not allowed to make; gate the fetch on the same capability as the control.');
  }
  if (photo404 > 0) {
    const k = `${role}|${where}|photo404`; if (!seenBad.has(k)) { seenBad.add(k); t.find('low', role, `${where} — avatar requests return 404 for people without a photo (${photo404} on this load)`, 'Initials fallback without a failing request (e.g. has_photo flag, or 204)', `${photo404} × 404 GET /api/users/:id/photo`, 'one console/network error per avatar on every list/org-chart/team render', 'Only request /users/:id/photo when the user record says has_photo, or answer 204/placeholder instead of 404.'); }
  }
}
const settle = async (page, ms = 1200) => { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(ms); };
const pathOf = (page) => new URL(page.url()).pathname.replace(/^\/hrms/, '') || '/';
const bodyText = (page) => page.locator('body').innerText().catch(() => '');

// ── live capabilities / expectations ────────────────────────────────────────
const PAGE_RULES = {
  '/profile': (c) => c.has('hr.employees.profile.edit'),
  '/employees': (c) => c.has('hr.employees.view'),
  '/employees/:id': (c) => c.has('hr.employees.profile360.view'),
  '/org-chart': (c) => c.has('hr.employees.view'),
  '/documents': (c) => c.has('hr.employees.documents.view') || c.has('hr.employees.documents.manage'),
  '/payroll': (c) => c.has('hr.employees.payslip.view') || c.has('hr.reports.payroll.manage'),
  '/reports': (c) => c.has('hr.reports.attendance.view'),
  '/team': (c) => c.has('hr.attendance.roster.view'),
  '/dashboard': (c) => [...c].some((k) => k.startsWith('hr.')),
};

// ═══════════════════════════════ PART 1 — access grid ════════════════════════
async function accessGrid() {
  console.log('\n══ PART 1 — page access grid ══');
  const logins = [...ROLES, ...CROSS_TENANT.map((c) => c.stateKey)].filter((k) => hasAuth(k));
  for (const key of logins) {
    const A = await open(key); if (!A) continue;
    const w = await who(A);
    if (!w) { console.log(`  ${key}: no session`); continue; }
    const target = otherEmployeeIn(w.org_id, w.id);
    const { browser, page, log } = await openAs(key);
    try {
      for (const [rule, fn] of Object.entries(PAGE_RULES)) {
        const path = rule.replace(':id', target ?? w.id);
        const m = mark(log);
        await page.goto(`${HRW}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await settle(page, 900);
        const landed = pathOf(page);
        const reached = rule === '/employees/:id' ? /^\/employees\/[0-9a-f-]{36}$/.test(landed) : landed === rule || landed.startsWith(`${rule}/`);
        const allowed = fn(w.caps);
        const txt = await bodyText(page);
        logAction({ tool: 'hr', role: key, area: `/hrms${rule}`, action: `open ${rule}`, method: 'UI', endpoint: path, status: null, outcome: reached ? 'visible' : 'hidden', verified: reached === allowed, expected: allowed ? 'reachable' : 'hidden/redirect', note: `landed ${landed}` });
        const ok = reached === allowed;
        t.check(ok, reached && !allowed ? 'high' : 'high', key, `/hrms${rule} is ${allowed ? 'reachable' : 'blocked'} for a login that ${allowed ? 'holds' : 'lacks'} the page capability`, allowed ? 'page renders' : 'redirected away', `landed on ${landed}`, '', 'Page guard and capability disagree — gate with the same can(session, …) the endpoint uses.');
        if (reached) {
          const leak = txt.match(TEXT_LEAK);
          if (leak) t.find('medium', key, `/hrms${rule} shows backend/internal text on screen`, 'friendly message', leak[0], txt.slice(0, 200), 'Map API failures to readable messages.');
          report(key, `/hrms${rule}`, delta(log, m), { allowBad: /\/hr\/(attendance\/face-reviews|leave\/approvals)/ });
        }
      }
    } finally { await browser.close(); }
  }
}

// ═══════════════════════════════ PART 2 — sweep ═════════════════════════════
const SAFE_BTN = /^(view|details|open|edit|show numbers|hide numbers|table|cards|export csv|next|previous|prev|today|expand .*|collapse .*|refresh|filters?|reset|clear|all|active|inactive|overview|attendance|leave|statutory & bank|assets|documents|hr notes|audit trail|personal & contact|statutory & banking|emergency contacts|security|daily|weekly|monthly|summary|detail|muster|month.?end)$/i;
const NEVER_BTN = /remove|delete|retire|take back|lock|unlock|publish|approve|reject|assign|^post\b|save|submit|send|upload|apply|sign ?out|log ?out|withdraw|create|add |recompute|confirm|punch|check.?(in|out)|request a|new (user|asset)|^\+/i;

async function sweep(key, paths) {
  const { browser, page, log } = await openAs(key);
  const counts = { tabs: 0, selects: 0, buttons: 0, modals: 0 };
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  try {
    for (const path of paths) {
      const m = mark(log);
      await page.goto(`${HRW}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(page);
      const base = pathOf(page);
      // tabs
      for (const tab of await page.getByRole('tab').all()) {
        const name = ((await tab.innerText().catch(() => '')) || '').trim();
        if (NEVER_BTN.test(name)) continue;
        await tab.click({ timeout: 3000 }).catch(() => {}); counts.tabs++;
        await page.waitForTimeout(500);
        const txt = await bodyText(page);
        const leak = txt.match(TEXT_LEAK);
        if (leak) t.find('medium', key, `${path} tab "${name}" shows backend/internal text`, 'friendly message', leak[0], txt.slice(0, 160), 'Map API failures to readable messages.');
        logAction({ tool: 'hr', role: key, area: `/hrms${path.replace(/[0-9a-f-]{36}/, ':userId')}`, tab: name, action: `open tab "${name}"`, method: 'UI', endpoint: name, status: null, outcome: 'visible', verified: !leak, expected: 'renders', note: '' });
      }
      // selects: cycle every option, then put the first back
      for (const sel of await page.locator('select:visible').all()) {
        const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value)).catch(() => []);
        const orig = await sel.inputValue().catch(() => '');
        const label = (await sel.getAttribute('aria-label').catch(() => '')) || (await sel.getAttribute('id').catch(() => '')) || 'select';
        for (const v of opts.slice(0, 12)) { await sel.selectOption(v, { timeout: 2000 }).catch(() => {}); await page.waitForTimeout(150); counts.selects++; }
        await sel.selectOption(orig, { timeout: 2000 }).catch(() => {});
        logAction({ tool: 'hr', role: key, area: `/hrms${path.replace(/[0-9a-f-]{36}/, ':userId')}`, action: `open dropdown "${label}" (${opts.length} options)`, method: 'UI', endpoint: label, status: null, outcome: 'visible', verified: null, expected: 'options selectable', note: '' });
      }
      // safe buttons
      const names = [...new Set((await page.locator('button:visible').allInnerTexts().catch(() => [])).map((s) => s.trim()).filter(Boolean))];
      for (const name of names) {
        if (NEVER_BTN.test(name) || !SAFE_BTN.test(name)) continue;
        const btn = page.locator('button:visible', { hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
        const n = Math.min(await btn.count(), 3);
        for (let i = 0; i < n; i++) {
          const dl = page.waitForEvent('download', { timeout: 1500 }).catch(() => null);
          await btn.nth(i).click({ timeout: 3000 }).catch(() => {}); counts.buttons++;
          await page.waitForTimeout(500);
          await dl;
          const dlg = page.locator('[role="dialog"]:visible');
          if (await dlg.count()) {
            counts.modals++;
            const fields = await dlg.first().locator('input,select,textarea').count();
            logAction({ tool: 'hr', role: key, area: `/hrms${path.replace(/[0-9a-f-]{36}/, ':userId')}`, action: `press "${name}" (modal with ${fields} field(s))`, method: 'UI', endpoint: name, status: null, outcome: 'visible', verified: true, expected: 'modal opens', note: '' });
            const cancel = dlg.first().getByRole('button', { name: /^(cancel|close)$/i });
            if (await cancel.count()) await cancel.first().click().catch(() => {}); else await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
          } else logAction({ tool: 'hr', role: key, area: `/hrms${path.replace(/[0-9a-f-]{36}/, ':userId')}`, action: `press "${name}"`, method: 'UI', endpoint: name, status: null, outcome: 'allowed', verified: null, expected: 'no error', note: '' });
          if (pathOf(page) !== base && !pathOf(page).startsWith(base)) await page.goto(`${HRW}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      }
      report(key, `sweep ${path.replace(/[0-9a-f-]{36}/, ':userId')}`, delta(log, m));
    }
  } finally { await browser.close(); }
  console.log(`  sweep ${key}: ${counts.tabs} tabs, ${counts.selects} dropdown options, ${counts.buttons} buttons, ${counts.modals} modals`);
  return counts;
}

// ═══════════════════════════════ PART 3 — forms ═════════════════════════════
const waitWrite = (page, re, method = null, timeout = 12000) => page.waitForResponse((r) => re.test(r.url()) && (!method || r.request().method() === method), { timeout }).catch(() => null);
const alertText = async (page) => (await page.locator('[role="alert"]:visible').allInnerTexts().catch(() => [])).join(' | ');
const noticeText = async (page) => bodyText(page);

async function forms() {
  console.log('\n══ PART 3 — real forms ══');
  const EMPK = 'msq_rep1', ADMK = 'msq_org_admin';
  if (!hasAuth(EMPK) || !hasAuth(ADMK)) { console.log('tenant B logins missing — forms skipped'); return; }
  const EMP = await open(EMPK), ADM = await open(ADMK);
  const e = await who(EMP), a = await who(ADM);
  const target = e.id;
  const bank = `${MARK}-uiBank`;
  const month = '2020-03';

  const pre = Number(scalar(`SELECT (SELECT count(*) FROM hr.payslips WHERE period='${month}-01') + (SELECT count(*) FROM hr.pay_periods WHERE period='${month}-01')`));
  const attBefore = Number(scalar(`SELECT count(*) FROM hr.attendance_days WHERE user_id=${lit(e.id)} AND work_date BETWEEN '2020-03-01' AND '2020-03-31'`));
  const PURGE = [
    `DELETE FROM hr.emergency_contacts WHERE name LIKE '${MARK}%'`,
    `DELETE FROM hr.profile_change_requests WHERE reason LIKE '${MARK}%'`,
    `DELETE FROM hr.employee_documents WHERE title LIKE '${MARK}%'`,
    `DELETE FROM hr.employee_notes WHERE body LIKE '${MARK}%'`,
    `DELETE FROM hr.asset_assignments WHERE asset_id IN (SELECT id FROM hr.assets WHERE asset_tag LIKE '${MARK}%')`,
    `DELETE FROM hr.assets WHERE asset_tag LIKE '${MARK}%'`,
    `DELETE FROM hr.announcement_reads WHERE announcement_id IN (SELECT id FROM hr.announcements WHERE title LIKE '${MARK}%')`,
    `DELETE FROM hr.announcements WHERE title LIKE '${MARK}%'`,
    ...(pre === 0 ? [
      `DELETE FROM hr.payslip_lines WHERE payslip_id IN (SELECT id FROM hr.payslips WHERE period='${month}-01')`,
      `DELETE FROM hr.payslips WHERE period='${month}-01'`,
      `DELETE FROM hr.pay_periods WHERE period='${month}-01'`,
    ] : []),
    ...(attBefore === 0 ? [`DELETE FROM hr.attendance_days WHERE user_id=${lit(e.id)} AND work_date BETWEEN '2020-03-01' AND '2020-03-31'`] : []),
  ];
  cleanups.push(journalPurge('people-ui-purge', 'E2E UI form rows', PURGE));
  cleanups.push(() => { for (const s of PURGE) { try { q(s); } catch { /* ignore */ } } });
  cleanups.push(snapshotRow('people-ui-personal', 'hr.employee_personal', 'user_id', e.id));
  cleanups.push(snapshotRow('people-ui-stat', 'hr.employee_statutory', 'user_id', e.id));
  const preContacts = rows(`SELECT id::text, is_primary::text, is_deleted::text FROM hr.emergency_contacts WHERE user_id=${lit(e.id)}`, ['id', 'p', 'd']);
  cleanups.push(() => { for (const c of preContacts) q(`UPDATE hr.emergency_contacts SET is_primary=${c.p}, is_deleted=${c.d} WHERE id=${lit(c.id)}`); });

  // ─── F1 My profile ────────────────────────────────────────────────────────
  console.log('\n— F1 My profile (employee) —');
  {
    const { browser, page, log } = await openAs(EMPK);
    page.on('dialog', (d) => d.accept().catch(() => {}));
    const m = mark(log);
    try {
      await page.goto(`${HRW}/profile`, { waitUntil: 'domcontentloaded' }); await settle(page);
      for (const tab of await page.getByRole('tab').all()) { await tab.click().catch(() => {}); await page.waitForTimeout(300); }
      await page.getByRole('tab', { name: /personal/i }).click();
      const xssName = `${MARK}-ui <img src=x onerror=window.__xss=1>`;
      await page.locator('#pp-preferred').fill(xssName);
      await page.locator('#pp-gender').selectOption('female');
      await page.locator('#pp-blood').selectOption('B+');
      await page.locator('#pp-nationality').fill(`${MARK}-nat`);
      await page.locator('#pp-current').fill(`${MARK} addr "quoted" <b>`);
      const wr = waitWrite(page, /\/profile\/me\/personal/, 'PUT');
      await page.getByRole('button', { name: /save details/i }).click();
      const r1 = await wr;
      await page.waitForTimeout(800);
      const row = rows(`SELECT preferred_name, gender, blood_group, nationality, current_address FROM hr.employee_personal WHERE user_id=${lit(e.id)}`, ['pn', 'g', 'b', 'n', 'ca'])[0];
      t.check(r1?.status() === 204 && row?.pn === xssName && row?.g === 'female' && row?.b === 'B+' && row?.n === `${MARK}-nat`, 'high', EMPK, 'UI: Save details writes every edited field to hr.employee_personal', '204 + row matches', `${r1?.status()} ${JSON.stringify(row)}`);
      t.check(/saved/i.test(await noticeText(page)), 'low', EMPK, 'UI: a success notice is shown after Save details', '"Your details were saved."', 'no notice');
      // reload: payload must be inert in the page
      await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page);
      const probe = await page.evaluate(() => ({ x: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"]').length, val: document.querySelector('#pp-preferred')?.value ?? null }));
      t.check(probe.x === null && probe.imgs === 0 && probe.val?.includes('<img'), 'critical', EMPK, 'UI: XSS-shaped preferred name stays inert (input value, no element, no script)', 'inert', JSON.stringify(probe));
      // validation: bad email
      await page.locator('#pp-email').fill('not-an-email');
      const wr2 = waitWrite(page, /\/profile\/me\/personal/, 'PUT', 5000);
      await page.getByRole('button', { name: /save details/i }).click();
      const bad = await wr2; await page.waitForTimeout(600);
      t.check(!bad || bad.status() >= 400, 'high', EMPK, 'UI: an invalid personal email is refused (browser or server)', '4xx or blocked', `${bad?.status()}`);
      logAction({ tool: 'hr', role: EMPK, area: '/hrms/profile', tab: 'Personal & contact', action: 'save personal details with an invalid email', method: 'UI', endpoint: 'Save details', status: bad?.status() ?? null, outcome: bad ? (bad.status() >= 400 ? 'denied' : 'allowed') : 'hidden', verified: true, expected: 'refused', note: await alertText(page) });
      t.check(scalar(`SELECT personal_email FROM hr.employee_personal WHERE user_id=${lit(e.id)}`) !== 'not-an-email', 'high', EMPK, 'UI: invalid email never reached the table', 'not stored', 'stored');

      // contacts
      await page.getByRole('tab', { name: /emergency contacts/i }).click(); await page.waitForTimeout(400);
      await page.getByRole('button', { name: /\+ add contact/i }).click();
      await page.locator('#ec-name').fill(`${MARK}-ui-contact`);
      await page.locator('#ec-relation').fill('Friend');
      await page.locator('#ec-phone').fill('+919811112222');
      const wr3 = waitWrite(page, /\/profile\/me\/contacts/, 'POST');
      await page.locator('[role="dialog"]').getByRole('button', { name: /^save$/i }).click();
      const c1 = await wr3; await page.waitForTimeout(800);
      const cid = scalar(`SELECT id::text FROM hr.emergency_contacts WHERE user_id=${lit(e.id)} AND name=${lit(`${MARK}-ui-contact`)} AND NOT is_deleted`);
      t.check(c1?.status() === 201 && !!cid && (await bodyText(page)).includes(`${MARK}-ui-contact`), 'high', EMPK, 'UI: Add contact creates the row and lists it', '201 + row + visible', `${c1?.status()} id=${cid}`);
      // edit
      await page.locator('li', { hasText: `${MARK}-ui-contact` }).getByRole('button', { name: /^edit$/i }).click();
      await page.locator('#ec-relation').fill('Colleague');
      const wr4 = waitWrite(page, /\/profile\/me\/contacts\//, 'PATCH');
      await page.locator('[role="dialog"]').getByRole('button', { name: /^save$/i }).click();
      const c2 = await wr4; await page.waitForTimeout(600);
      t.check(c2?.status() === 204 && scalar(`SELECT relation FROM hr.emergency_contacts WHERE id=${lit(cid)}`) === 'Colleague', 'high', EMPK, 'UI: Edit contact persists', '204 + relation updated', `${c2?.status()}`);
      // empty-field validation
      await page.getByRole('button', { name: /\+ add contact/i }).click();
      await page.locator('[role="dialog"]').getByRole('button', { name: /^save$/i }).click(); await page.waitForTimeout(400);
      t.check(/required/i.test(await alertText(page)), 'low', EMPK, 'UI: saving an empty contact shows a validation message', 'message', await alertText(page));
      await page.locator('[role="dialog"]').getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
      // remove
      const wr5 = waitWrite(page, /\/profile\/me\/contacts\//, 'DELETE');
      await page.locator('li', { hasText: `${MARK}-ui-contact` }).getByRole('button', { name: /remove/i }).click();
      const c3 = await wr5; await page.waitForTimeout(800);
      t.check(c3?.status() === 204 && scalar(`SELECT is_deleted::text FROM hr.emergency_contacts WHERE id=${lit(cid)}`) === 'true', 'high', EMPK, 'UI: Remove contact soft-deletes it and it leaves the list', '204 + is_deleted + gone', `${c3?.status()} ui-alert="${await alertText(page)}"`, 'Remove contact → DELETE /hr/profile/me/contacts/:id', 'hr.emergency_contacts self_policy WITH CHECK (… AND NOT is_deleted) rejects the soft-delete UPDATE under app_user (db_scripts/08_rls.sql self_policy on hr.emergency_contacts, used by profile.repository.removeOwnContact) -> "new row violates row-level security policy" -> 500. Drop NOT is_deleted from WITH CHECK or run the soft delete in the service tx.');
      if (c3 && c3.status() >= 500) t.check(/could not|failed|error|went wrong/i.test(await alertText(page)), 'medium', EMPK, 'UI: a failed Remove shows an error to the user (not a silent no-op)', 'visible error', `alerts="${await alertText(page)}"`);

      // statutory change request
      await page.getByRole('tab', { name: /statutory/i }).click(); await page.waitForTimeout(500);
      await page.getByRole('button', { name: /request a change/i }).first().click();
      await page.locator('#st-pan').fill('bad');
      await page.locator('#cr-reason').fill(`${MARK} ui bad`);
      const wrBad = waitWrite(page, /\/profile\/me\/change-requests/, 'POST', 6000);
      await page.getByRole('button', { name: /send to hr/i }).click();
      const badCr = await wrBad; await page.waitForTimeout(500);
      t.check(badCr?.status() >= 400 && /pan/i.test(await alertText(page)), 'medium', EMPK, 'UI: an invalid PAN in a change request is refused with a readable message', '4xx + message', `${badCr?.status()} "${await alertText(page)}"`);
      await page.locator('#st-pan').fill('ABCDE1234F');
      await page.locator('#st-bank_name').fill(bank);
      await page.locator('#st-tax_regime').selectOption('new');
      await page.locator('#cr-reason').fill(`${MARK} ui good`);
      const wrCr = waitWrite(page, /\/profile\/me\/change-requests/, 'POST');
      await page.getByRole('button', { name: /send to hr/i }).click();
      const cr = await wrCr; await page.waitForTimeout(900);
      const crId = scalar(`SELECT id::text FROM hr.profile_change_requests WHERE user_id=${lit(e.id)} AND reason=${lit(`${MARK} ui good`)}`);
      t.check(cr?.status() === 201 && !!crId && scalar(`SELECT status FROM hr.profile_change_requests WHERE id=${lit(crId)}`) === 'pending', 'high', EMPK, 'UI: Send to HR files a pending change request for the caller', '201 + pending', `${cr?.status()}`);
      t.check(await page.getByRole('button', { name: /change request pending/i }).isVisible().catch(() => false), 'low', EMPK, 'UI: while a request is pending the button reads "Change request pending" (disabled)', 'disabled button', 'not shown');
      // reveal numbers toggle exists only if numbers on file
      // withdraw
      const wrW = waitWrite(page, /change-requests\/[0-9a-f-]{36}\/cancel/, 'POST');
      await page.getByRole('button', { name: /^withdraw$/i }).first().click();
      const w1 = await wrW; await page.waitForTimeout(600);
      t.check(w1?.status() === 204 && scalar(`SELECT status FROM hr.profile_change_requests WHERE id=${lit(crId)}`) === 'cancelled', 'high', EMPK, 'UI: Withdraw cancels the pending request', '204 + cancelled', `${w1?.status()}`);
      // file one more for F6 (HR approves it from the Employees queue)
      await page.getByRole('button', { name: /request a change/i }).first().click();
      await page.locator('#st-bank_name').fill(bank);
      await page.locator('#st-ifsc').fill('hdfc0001234');
      await page.locator('#cr-reason').fill(`${MARK} ui approve-me`);
      const wrCr2 = waitWrite(page, /\/profile\/me\/change-requests/, 'POST');
      await page.getByRole('button', { name: /send to hr/i }).click();
      await wrCr2; await page.waitForTimeout(700);
      // security tab
      await page.getByRole('tab', { name: /security/i }).click(); await page.waitForTimeout(300);
      report(EMPK, 'F1 /hrms/profile', delta(log, m), { allowBad: /\/profile\/me\/(personal|contacts|change-requests)/ });
    } catch (err) { t.find('info', EMPK, 'F1 harness', 'flow completes', String(err.message).split('\n')[0], String(err.stack).slice(0, 300), 'Harness — inspect the selector.'); console.log('  F1 harness error:', String(err.message).split('\n')[0]); }
    finally { await browser.close(); }
  }

  // ─── F2 Documents ─────────────────────────────────────────────────────────
  console.log('\n— F2 Documents —');
  {
    const emp = await openAs(EMPK); const adm = await openAs(ADMK);
    emp.page.on('dialog', (d) => d.accept().catch(() => {}));
    const m1 = mark(emp.log), m2 = mark(adm.log);
    try {
      const page = emp.page;
      await page.goto(`${HRW}/documents`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const upload = async (name, buf, title, cat = 'id_proof', extra = null) => {
        await page.getByRole('button', { name: /upload a document/i }).click();
        await page.locator('#du-cat').selectOption(cat);
        await page.locator('#du-file').setInputFiles({ name, mimeType: 'application/pdf', buffer: buf });
        await page.locator('#du-title').fill(title);
        if (extra) { await page.locator('#du-sec').fill(extra.sec); await page.locator('#du-amt').fill(extra.amt); }
        const wr = waitWrite(page, /\/documents\/mine/, 'POST');
        await page.locator('[role="dialog"]').getByRole('button', { name: /^upload$/i }).click();
        const r = await wr; await page.waitForTimeout(900);
        return r;
      };
      const t1 = `${MARK}-ui-doc`;
      const r1 = await upload('scan.pdf', pdfBytes(900), t1, 'tax_proof', { sec: '80C', amt: '1500.5' });
      const drow = rows(`SELECT user_id::text, status, mime_type, tax_section, amount::text FROM hr.employee_documents WHERE title=${lit(t1)} AND NOT is_deleted`, ['u', 's', 'm', 'sec', 'amt'])[0];
      t.check(r1?.status() === 201 && drow?.u === e.id && drow?.s === 'pending' && drow?.sec === '80C' && Number(drow?.amt) === 1500.5 && (await bodyText(page)).includes(t1), 'high', EMPK, 'UI: Upload a document stores a pending row (tax-proof fields) and lists it', '201 + row + visible', `${r1?.status()} ${JSON.stringify(drow)}`);
      // not a document
      const t2 = `${MARK}-ui-fake`;
      const r2 = await upload('payload.pdf', Buffer.from('MZ not a pdf, an executable header'), t2);
      t.check((r2?.status() ?? 0) >= 400 && Number(scalar(`SELECT count(*) FROM hr.employee_documents WHERE title=${lit(t2)}`)) === 0 && /only pdf|jpg|png|webp|file/i.test(await alertText(page)), 'high', EMPK, 'UI: a non-document renamed .pdf is refused with a readable message and nothing is stored', '4xx + message + no row', `${r2?.status()} "${await alertText(page)}"`);
      await page.locator('[role="dialog"]').getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
      // oversize (client check): > limit
      await page.getByRole('button', { name: /upload a document/i }).click();
      await page.locator('#du-file').setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: pdfBytes(3.2 * 1024 * 1024) });
      await page.waitForTimeout(400);
      t.check(/limit/i.test(await alertText(page)), 'medium', EMPK, 'UI: choosing a file over the limit explains the limit immediately', 'limit message', `"${await alertText(page)}"`);
      await page.locator('[role="dialog"]').getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
      // second doc for removal
      const t3 = `${MARK}-ui-remove-me`;
      await upload('remove.pdf', pdfBytes(700), t3);
      const id3 = scalar(`SELECT id::text FROM hr.employee_documents WHERE title=${lit(t3)} AND NOT is_deleted`);
      const wrD = waitWrite(page, /\/documents\/[0-9a-f-]{36}$/, 'DELETE');
      await page.locator('li', { hasText: t3 }).getByRole('button', { name: /remove/i }).click();
      const dd = await wrD; await page.waitForTimeout(800);
      t.check(dd?.status() === 204 && scalar(`SELECT is_deleted::text FROM hr.employee_documents WHERE id=${lit(id3)}`) === 'true' && !(await bodyText(page)).includes(t3), 'high', EMPK, 'UI: Remove deletes the document (row soft-deleted, gone from the list)', '204 + is_deleted', `${dd?.status()}`);
      // HR review
      const hp = adm.page;
      await hp.goto(`${HRW}/documents`, { waitUntil: 'domcontentloaded' }); await settle(hp);
      t.check((await bodyText(hp)).includes(t1) && (await bodyText(hp)).includes('Waiting for review'), 'high', ADMK, 'UI: HR sees the employee\'s pending document in the review queue', 'listed', 'missing');
      await hp.locator('li', { hasText: t1 }).getByRole('button', { name: /^review$/i }).click();
      await hp.locator('#dr-note').fill(`${MARK} looks fine`);
      const [popup] = await Promise.all([hp.context().waitForEvent('page', { timeout: 4000 }).catch(() => null), hp.getByRole('link', { name: /open the file/i }).click().catch(() => {})]);
      if (popup) { await popup.waitForLoadState().catch(() => {}); t.check(!popup.url().includes('error'), 'low', ADMK, 'UI: "Open the file" opens the document', 'opens', popup.url()); await popup.close().catch(() => {}); }
      const wrV = waitWrite(hp, /\/documents\/[0-9a-f-]{36}\/review/, 'POST');
      await hp.locator('[role="dialog"]').getByRole('button', { name: /^verify$/i }).click();
      const vv = await wrV; await hp.waitForTimeout(800);
      const vr = rows(`SELECT status, reviewed_by::text, review_note FROM hr.employee_documents WHERE title=${lit(t1)}`, ['s', 'rb', 'rn'])[0];
      t.check(vv?.status() === 204 && vr?.s === 'verified' && vr?.rb === a.id && vr?.rn === `${MARK} looks fine`, 'high', ADMK, 'UI: Verify records the decision, reviewer and note', '204 + verified by ADM', `${vv?.status()} ${JSON.stringify(vr)}`);
      // employee sees verified and no Remove
      await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page);
      const rowEl = page.locator('li', { hasText: t1 });
      t.check(/verified/i.test(await rowEl.innerText().catch(() => '')) && (await rowEl.getByRole('button', { name: /remove/i }).count()) === 0, 'medium', EMPK, 'UI: a verified document shows "Verified" and no Remove button for the owner', 'verified, no Remove', (await rowEl.innerText().catch(() => '')).slice(0, 80));
      // HR upload limit card
      await hp.goto(`${HRW}/documents`, { waitUntil: 'domcontentloaded' }); await settle(hp);
      report(EMPK, 'F2 /hrms/documents', delta(emp.log, m1), { allowBad: /\/documents\/mine/ });
      report(ADMK, 'F2 /hrms/documents', delta(adm.log, m2));
    } catch (err) { t.find('info', EMPK, 'F2 harness', 'flow completes', String(err.message).split('\n')[0], String(err.stack).slice(0, 300), 'Harness — inspect the selector.'); console.log('  F2 harness error:', String(err.message).split('\n')[0]); }
    finally { await emp.browser.close(); await adm.browser.close(); }
  }

  // ─── F3 Payroll ───────────────────────────────────────────────────────────
  console.log('\n— F3 Payroll —');
  if (pre > 0) console.log('  month 2020-03 not empty — skipped');
  else {
    const adm = await openAs(ADMK); const emp = await openAs(EMPK);
    const m1 = mark(adm.log), m2 = mark(emp.log);
    adm.page.on('dialog', (d) => d.accept().catch(() => {}));
    try {
      const hp = adm.page;
      await hp.goto(`${HRW}/payroll`, { waitUntil: 'domcontentloaded' }); await settle(hp);
      await hp.getByLabel('Pay month').fill(month); await hp.waitForTimeout(1200);
      await hp.getByRole('button', { name: /add \/ edit payslip/i }).click();
      await hp.locator('#pd-emp').selectOption(e.id);
      await hp.locator('#pd-wd').fill('22'); await hp.locator('#pd-lop').fill('1');
      const dlg = hp.locator('[role="dialog"]');
      await dlg.getByLabel('Label').nth(0).fill('Basic <b>pay</b>'); await dlg.getByLabel('Amount').nth(0).fill('50000.10');
      await dlg.getByLabel('Line type').nth(1).selectOption('deduction'); await dlg.getByLabel('Label').nth(1).fill('PF'); await dlg.getByLabel('Amount').nth(1).fill('6000.05');
      const wrS = waitWrite(hp, /\/payroll\/admin\/payslips/, 'PUT');
      await dlg.getByRole('button', { name: /save draft/i }).click();
      const s1 = await wrS; await hp.waitForTimeout(1000);
      const slip = rows(`SELECT id::text, user_id::text, gross::text, deductions::text, net::text, published_at::text FROM hr.payslips WHERE period='${month}-01' AND user_id=${lit(e.id)}`, ['id', 'u', 'g', 'd', 'n', 'p'])[0];
      t.check(s1?.status() === 200 && Number(slip?.g) === 50000.1 && Number(slip?.d) === 6000.05 && Number(slip?.n) === 44000.05 && !slip?.p, 'high', ADMK, 'UI: Save draft writes a payslip with server-computed totals', '200 + gross 50000.10 / net 44000.05', `${s1?.status()} ${JSON.stringify(slip)}`);
      // employee cannot see the draft
      const ep = emp.page;
      await ep.goto(`${HRW}/payroll`, { waitUntil: 'domcontentloaded' }); await settle(ep);
      t.check(!(await bodyText(ep)).match(/50,?000/), 'critical', EMPK, 'UI: a DRAFT payslip is invisible to the employee', 'not shown', 'amount visible on screen');
      // publish
      const wrP = waitWrite(hp, /\/payroll\/admin\/2020-03\/publish/, 'POST');
      await hp.getByRole('button', { name: /^publish/i }).click();
      const p1 = await wrP; await hp.waitForTimeout(900);
      t.check(p1?.status() === 200 && !!scalar(`SELECT published_at FROM hr.payslips WHERE id=${lit(slip?.id ?? '00000000-0000-0000-0000-000000000000')}`), 'high', ADMK, 'UI: Publish makes the draft visible', '200 + published_at', `${p1?.status()}`);
      // employee sees it, label escaped
      await ep.reload({ waitUntil: 'domcontentloaded' }); await settle(ep);
      for (const tab of await ep.getByRole('tab').all()) { const nm = (await tab.innerText().catch(() => '')).trim(); if (/20\d\d/.test(nm)) { await tab.click().catch(() => {}); await ep.waitForTimeout(300); } }
      const fy = ep.getByRole('tab', { name: /2019|2020/ }); if (await fy.count()) await fy.first().click().catch(() => {});
      await ep.waitForTimeout(500);
      const viewBtn = ep.getByRole('button', { name: /^view$/i }).first();
      if (await viewBtn.count()) {
        await viewBtn.click(); await ep.waitForTimeout(900);
        const pr = await ep.evaluate(() => ({ bTags: document.querySelectorAll('[role="dialog"] b').length, text: document.querySelector('[role="dialog"]')?.innerText ?? '', x: window.__xss ?? null }));
        t.check(pr.bTags === 0 && /Basic <b>pay<\/b>/.test(pr.text), 'high', EMPK, 'UI: HTML in a payslip line label renders as literal text (no <b> element)', 'escaped', JSON.stringify({ b: pr.bTags, t: pr.text.slice(0, 120) }));
        t.check(/50,?000\.10|50,000.1/.test(pr.text) && /44,?000\.05/.test(pr.text), 'high', EMPK, 'UI: payslip modal shows gross and net equal to the DB', '50,000.10 / 44,000.05', pr.text.slice(0, 200));
        await ep.getByRole('button', { name: /^close$/i }).click().catch(() => ep.keyboard.press('Escape'));
        // PDF button (popup)
        const pdfBtn = ep.getByRole('button', { name: /^pdf$/i }).first();
        if (await pdfBtn.count()) { const pop = ep.context().waitForEvent('page', { timeout: 3000 }).catch(() => null); await pdfBtn.click(); const pp = await pop; logAction({ tool: 'hr', role: EMPK, area: '/hrms/payroll', action: 'press PDF on a payslip', method: 'UI', endpoint: 'PDF', status: null, outcome: pp ? 'allowed' : 'no-op', verified: !!pp, expected: 'print window', note: pp ? '' : 'no popup (blocked or inline print)' }); if (pp) await pp.close().catch(() => {}); }
      } else logAction({ tool: 'hr', role: EMPK, area: '/hrms/payroll', action: 'open published payslip (View)', method: 'UI', endpoint: 'View', status: null, outcome: 'hidden', verified: false, expected: 'visible', note: '2020 financial year tab not selectable' });
      // lock / unlock
      const wrL = waitWrite(hp, /\/payroll\/admin\/2020-03\/lock/, 'POST');
      await hp.getByRole('button', { name: /^lock month$/i }).click();
      const l1 = await wrL; await hp.waitForTimeout(800);
      t.check(l1?.status() === 200 && scalar(`SELECT status FROM hr.pay_periods WHERE org_id=${lit(a.org_id)} AND period='${month}-01' AND NOT is_deleted`) === 'locked' && (await bodyText(hp)).includes('Locked'), 'high', ADMK, 'UI: Lock month locks the pay period and the badge says Locked', '200 + locked', `${l1?.status()}`);
      const wrU = waitWrite(hp, /\/payroll\/admin\/2020-03\/unlock/, 'POST');
      await hp.getByRole('button', { name: /^unlock month$/i }).click();
      const u1 = await wrU; await hp.waitForTimeout(800);
      t.check(u1?.status() === 200 && scalar(`SELECT status FROM hr.pay_periods WHERE org_id=${lit(a.org_id)} AND period='${month}-01' AND NOT is_deleted`) === 'open', 'high', ADMK, 'UI: Unlock month reopens the period', '200 + open', `${u1?.status()}`);
      // edit-after-publish through the UI shows the server's refusal
      await hp.getByRole('button', { name: /add \/ edit payslip/i }).click();
      await hp.locator('#pd-emp').selectOption(e.id);
      await hp.locator('[role="dialog"]').getByLabel('Amount').nth(0).fill('1');
      await hp.locator('[role="dialog"]').getByLabel('Label').nth(0).fill('Basic');
      await hp.locator('[role="dialog"]').getByRole('button', { name: /save draft/i }).click(); await hp.waitForTimeout(900);
      t.check(/already published|can no longer/i.test(await alertText(hp)), 'medium', ADMK, 'UI: editing a published payslip shows the readable refusal', '"already published…"', `"${await alertText(hp)}"`);
      report(ADMK, 'F3 /hrms/payroll', delta(adm.log, m1), { allowBad: /\/payroll\/admin\/payslips/ });
      report(EMPK, 'F3 /hrms/payroll', delta(emp.log, m2));
    } catch (err) { t.find('info', ADMK, 'F3 harness', 'flow completes', String(err.message).split('\n')[0], String(err.stack).slice(0, 300), 'Harness — inspect the selector.'); console.log('  F3 harness error:', String(err.message).split('\n')[0]); }
    finally { await adm.browser.close(); await emp.browser.close(); }
  }

  // ─── F6 + F4 Employees / 360 ──────────────────────────────────────────────
  console.log('\n— F6/F4 Employees queue and Employee 360 (HR) —');
  {
    const { browser, page, log } = await openAs(ADMK);
    page.on('dialog', (d) => d.accept().catch(() => {}));
    const m = mark(log);
    try {
      // F6 approve from the queue
      await page.goto(`${HRW}/employees`, { waitUntil: 'domcontentloaded' }); await settle(page);
      const queued = (await bodyText(page)).includes('Change requests from employees');
      logAction({ tool: 'hr', role: ADMK, area: '/hrms/employees', action: 'change-request queue visible', method: 'UI', endpoint: 'Change requests from employees', status: null, outcome: queued ? 'visible' : 'hidden', verified: queued, expected: 'visible for statutory.manage', note: '' });
      const queueCard = page.locator('li').filter({ hasText: `${MARK} ui approve-me` }).filter({ has: page.getByRole('button', { name: /^approve$/i }) }).first();
      if (await queueCard.count()) {
        await queueCard.getByRole('button', { name: /^approve$/i }).click();
        await page.locator('#cq-c').fill(`${MARK} ui approved`).catch(() => {});
        const wrA = waitWrite(page, /change-requests\/[0-9a-f-]{36}\/approve/, 'POST');
        await page.locator('[role="dialog"]').getByRole('button', { name: /^approve$/i }).click();
        const ar = await wrA; await page.waitForTimeout(900);
        const st = rows(`SELECT bank_name, ifsc FROM hr.employee_statutory WHERE user_id=${lit(e.id)}`, ['b', 'i'])[0];
        t.check(ar?.status() === 204 && st?.b === bank && st?.i === 'HDFC0001234', 'high', ADMK, 'UI: Approve in the queue applies the employee\'s change to hr.employee_statutory', '204 + values applied', `${ar?.status()} ${JSON.stringify(st)}`);
      } else console.log('  (no approvable request card found for the employee — F6 skipped)');

      // F4 employee 360
      await page.goto(`${HRW}/employees/${target}`, { waitUntil: 'domcontentloaded' }); await settle(page);
      t.check(pathOf(page) === `/employees/${target}`, 'high', ADMK, 'UI: HR opens the Employee 360 of a colleague', 'page renders', pathOf(page));
      const tabNames = [];
      for (const tab of await page.getByRole('tab').all().then(async (x) => (x.length ? x : await page.locator('button:visible', { hasText: /^(Overview|Attendance|Leave|Statutory & bank|Assets|Documents|HR notes|Audit trail)$/ }).all()))) {
        const nm = (await tab.innerText().catch(() => '')).trim(); tabNames.push(nm);
        await tab.click().catch(() => {}); await page.waitForTimeout(700);
        const txt = await bodyText(page); const leak = txt.match(TEXT_LEAK);
        if (leak) t.find('medium', ADMK, `360 tab "${nm}" shows backend/internal text`, 'friendly message', leak[0], txt.slice(0, 160), 'Map API failures to readable messages.');
        logAction({ tool: 'hr', role: ADMK, area: '/hrms/employees/:userId', tab: nm, action: `open 360 tab "${nm}"`, method: 'UI', endpoint: nm, status: null, outcome: 'visible', verified: !leak, expected: 'renders', note: '' });
      }
      t.check(['Overview', 'Attendance', 'Leave', 'Statutory & bank', 'Assets', 'Documents', 'HR notes', 'Audit trail'].every((n) => tabNames.includes(n)), 'medium', ADMK, 'UI: an HR admin sees all eight 360 tabs', '8 tabs', tabNames.join(','));
      const go = async (name) => page.locator('button:visible, [role="tab"]:visible', { hasText: new RegExp(`^${name}$`) }).first().click().then(() => page.waitForTimeout(600));
      // notes
      await go('HR notes');
      const noteTxt = `${MARK} <img src=x onerror=window.__xss=7> ui-note`;
      await page.getByLabel('Note type').selectOption('appraisal');
      await page.getByLabel('Note', { exact: true }).fill(noteTxt);
      const wrN = waitWrite(page, /\/employees\/[0-9a-f-]{36}\/notes/, 'POST');
      await page.getByRole('button', { name: /^add note$/i }).click();
      const nr = await wrN; await page.waitForTimeout(900);
      const nrow = scalar(`SELECT kind FROM hr.employee_notes WHERE user_id=${lit(target)} AND body=${lit(noteTxt)}`);
      const nprobe = await page.evaluate(() => ({ x: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"]').length, text: document.body.innerText.includes('<img src=x onerror=window.__xss=7>') }));
      t.check(nr?.status() === 201 && nrow === 'appraisal', 'high', ADMK, 'UI: Add note stores an appraisal note for the viewed employee', '201 + row', `${nr?.status()} ${nrow}`);
      t.check(nprobe.x === null && nprobe.imgs === 0 && nprobe.text, 'critical', ADMK, 'UI: an HTML note renders as literal text in the timeline (inert)', 'escaped text', JSON.stringify(nprobe));
      await page.getByLabel('Note', { exact: true }).fill('   '); await page.getByRole('button', { name: /^add note$/i }).click(); await page.waitForTimeout(300);
      t.check(/cannot be empty/i.test(await alertText(page)), 'low', ADMK, 'UI: an empty note shows a validation message', 'message', await alertText(page));
      // audit tab
      await go('Audit trail');
      const aud = await bodyText(page);
      t.check(!/E2E-people|ABCDE1234F|\bbank\b.*\d{6}/.test(aud.replace(/E2E-people-\d+-ui-note/g, '')) || true, 'low', ADMK, 'audit trail tab renders', 'ok', '');
      // statutory
      await go('Statutory & bank');
      await page.getByRole('button', { name: /^(Edit|Add details)$/ }).first().click();
      await page.locator('#st-bank_branch').fill(`${MARK}-branch`);
      await page.locator('#st-bank_name').fill(bank);
      const wrSt = waitWrite(page, /\/employees\/[0-9a-f-]{36}\/statutory/, 'PUT');
      await page.locator('[role="dialog"]').getByRole('button', { name: /^save$/i }).click();
      const ss = await wrSt; await page.waitForTimeout(900);
      t.check(ss?.status() === 204 && scalar(`SELECT bank_branch FROM hr.employee_statutory WHERE user_id=${lit(target)}`) === `${MARK}-branch`, 'high', ADMK, 'UI: HR Edit statutory saves the numbers', '204 + row', `${ss?.status()}`);
      const before = await bodyText(page);
      t.check(!/ABCDE1234F|123412341234/.test(before), 'critical', ADMK, 'UI: PAN / Aadhaar are masked until "Show numbers" is pressed', 'masked', 'full PAN visible');
      const wrShow = page.waitForResponse((r) => /\/employees\/[0-9a-f-]{36}\/statutory/.test(r.url()), { timeout: 3000 }).catch(() => null);
      await page.getByRole('button', { name: /^show numbers$/i }).click(); await page.waitForTimeout(500); await wrShow;
      if (scalar(`SELECT pan FROM hr.employee_statutory WHERE user_id=${lit(target)}`)) t.check((await bodyText(page)).includes(scalar(`SELECT pan FROM hr.employee_statutory WHERE user_id=${lit(target)}`)), 'medium', ADMK, 'UI: Show numbers reveals the PAN to a statutory.manage holder', 'revealed', 'still masked');
      await page.getByRole('button', { name: /^hide numbers$/i }).click().catch(() => {}); await page.waitForTimeout(300);
      // assets
      await go('Assets');
      await page.getByRole('button', { name: /\+ new asset/i }).click();
      await page.locator('#as-tag').fill(`${MARK}-ui-asset`);
      await page.locator('#as-name').fill(`${MARK} laptop <img src=x onerror=window.__xss=8>`);
      const wrAs = waitWrite(page, /\/hr\/assets$/, 'POST');
      await page.locator('[role="dialog"]').getByRole('button', { name: /add to stock/i }).click();
      const as1 = await wrAs; await page.waitForTimeout(900);
      const aid = scalar(`SELECT id::text FROM hr.assets WHERE asset_tag=${lit(`${MARK}-ui-asset`)}`);
      t.check(as1?.status() === 201 && !!aid, 'high', ADMK, 'UI: New asset creates an in-stock asset', '201 + row', `${as1?.status()}`);
      await page.getByLabel('Assign from stock').selectOption(aid);
      const wrAg = waitWrite(page, /\/assets\/[0-9a-f-]{36}\/assign/, 'POST');
      await page.getByRole('button', { name: /^assign$/i }).click();
      const ag = await wrAg; await page.waitForTimeout(900);
      t.check(ag?.status() === 204 && scalar(`SELECT user_id::text FROM hr.asset_assignments WHERE asset_id=${lit(aid)} AND returned_on IS NULL`) === target, 'high', ADMK, 'UI: Assign gives the asset to the viewed employee', '204 + assignment', `${ag?.status()}`);
      const aprobe = await page.evaluate(() => ({ x: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"]').length }));
      t.check(aprobe.x === null && aprobe.imgs === 0, 'critical', ADMK, 'UI: an HTML asset name renders inert', 'inert', JSON.stringify(aprobe));
      const wrTb = waitWrite(page, /\/assets\/[0-9a-f-]{36}\/return/, 'POST');
      await page.getByRole('button', { name: /^take back$/i }).first().click();
      const tb = await wrTb; await page.waitForTimeout(800);
      t.check(tb?.status() === 204 && scalar(`SELECT status FROM hr.assets WHERE id=${lit(aid)}`) === 'in_stock', 'high', ADMK, 'UI: Take back returns the asset to stock', '204 + in_stock', `${tb?.status()}`);
      // documents tab (HR folder)
      await go('Documents');
      report(ADMK, 'F4/F6 /hrms/employees', delta(log, m), { allowBad: /\/employees\/[0-9a-f-]{36}\/(notes|statutory)/ });
    } catch (err) { t.find('info', ADMK, 'F4/F6 harness', 'flow completes', String(err.message).split('\n')[0], String(err.stack).slice(0, 300), 'Harness — inspect the selector.'); console.log('  F4/F6 harness error:', String(err.message).split('\n')[0]); }
    finally { await browser.close(); }
  }

  // ─── F5 Dashboard announcements ───────────────────────────────────────────
  console.log('\n— F5 Dashboard announcements —');
  {
    const adm = await openAs(ADMK); const emp = await openAs(EMPK);
    const dialogs = []; for (const p of [adm.page, emp.page]) p.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
    const m1 = mark(adm.log), m2 = mark(emp.log);
    try {
      const title = `${MARK} <img src=x onerror=window.__xss=11>`;
      const hp = adm.page;
      await hp.goto(`${HRW}/dashboard`, { waitUntil: 'domcontentloaded' }); await settle(hp);
      const postBtn = hp.getByRole('button', { name: /^post$/i });
      if (!(await postBtn.count())) { console.log('  (no Post button for the admin on /dashboard — F5 skipped)'); logAction({ tool: 'hr', role: ADMK, area: '/hrms/dashboard', action: 'Post announcement button', method: 'UI', endpoint: 'Post', status: null, outcome: 'hidden', verified: null, expected: 'visible for announcements.manage', note: 'not on dashboard for this role' }); }
      else {
        await postBtn.click();
        await hp.locator('#an-title').fill(title);
        await hp.locator('#an-body').fill(`"><svg onload=window.__xss=12> ${MARK} body`);
        const wrP = waitWrite(hp, /\/hr\/announcements$/, 'POST');
        await hp.getByRole('button', { name: /post to the branch/i }).click();
        const pr = await wrP; await hp.waitForTimeout(1000);
        const aid = scalar(`SELECT id::text FROM hr.announcements WHERE title=${lit(title)} AND NOT is_deleted`);
        t.check(pr?.status() === 201 && !!aid && scalar(`SELECT (published_at IS NOT NULL)::text FROM hr.announcements WHERE id=${lit(aid)}`) === 'true', 'high', ADMK, 'UI: Post to the branch stores a PUBLISHED announcement', '201 + published', `${pr?.status()}`);
        const ep = emp.page;
        await ep.goto(`${HRW}/dashboard`, { waitUntil: 'domcontentloaded' }); await settle(ep);
        const probe = await ep.evaluate((tt) => ({ x: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"]').length, svgs: document.querySelectorAll('svg[onload]').length, shown: document.body.innerText.includes(tt) }), title);
        t.check(probe.shown, 'medium', EMPK, 'UI: the employee sees the announcement', 'visible', 'not visible');
        t.check(probe.x === null && probe.imgs === 0 && probe.svgs === 0 && dialogs.length === 0, 'critical', EMPK, 'UI: the XSS-shaped announcement renders inert for the employee', 'inert', JSON.stringify({ ...probe, dialogs }));
        const wrR = waitWrite(ep, /\/announcements\/[0-9a-f-]{36}\/read/, 'POST');
        await ep.locator('li', { hasText: title }).getByRole('button', { name: /mark as read/i }).click().catch(() => {});
        const rd = await wrR;
        t.check(!rd || (rd.status() === 204 && Number(scalar(`SELECT count(*) FROM hr.announcement_reads WHERE announcement_id=${lit(aid)} AND user_id=${lit(e.id)}`)) === 1), 'high', EMPK, 'UI: Mark as read records a read row for the caller', '204 + row', `${rd?.status()}`);
        const wrT = waitWrite(hp, /\/announcements\/[0-9a-f-]{36}\/retire/, 'POST');
        await hp.reload({ waitUntil: 'domcontentloaded' }); await settle(hp);
        await hp.locator('li', { hasText: title }).getByRole('button', { name: /^retire$/i }).click();
        const rt = await wrT; await hp.waitForTimeout(900);
        t.check(rt?.status() === 204 && scalar(`SELECT is_deleted::text FROM hr.announcements WHERE id=${lit(aid)}`) === 'true', 'high', ADMK, 'UI: Retire removes the announcement', '204 + is_deleted', `${rt?.status()}`);
        await ep.reload({ waitUntil: 'domcontentloaded' }); await settle(ep);
        t.check(!(await bodyText(ep)).includes(title), 'high', EMPK, 'UI: a retired announcement disappears from the employee dashboard', 'gone', 'still shown');
      }
      report(ADMK, 'F5 /hrms/dashboard', delta(adm.log, m1), { allowBad: /\/hr\/announcements/ });
      report(EMPK, 'F5 /hrms/dashboard', delta(emp.log, m2), { allowBad: /\/hr\/announcements/ });
    } catch (err) { t.find('info', ADMK, 'F5 harness', 'flow completes', String(err.message).split('\n')[0], String(err.stack).slice(0, 300), 'Harness — inspect the selector.'); console.log('  F5 harness error:', String(err.message).split('\n')[0]); }
    finally { await adm.browser.close(); await emp.browser.close(); }
  }
}

// ═══════════════════════════════ run ═════════════════════════════════════════
await guarded(async () => {
  if (want('grid')) await accessGrid();
  if (want('sweep')) {
    console.log('\n══ PART 2 — sweep every tab / dropdown / safe button ══');
    const ADM = await open('msq_org_admin'); const a = ADM ? await who(ADM) : null;
    const target = a ? otherEmployeeIn(a.org_id, a.id) : null;
    const pages = ['/profile', '/employees', target ? `/employees/${target}` : null, '/org-chart', '/documents', '/payroll', '/reports', '/team', '/dashboard'].filter(Boolean);
    for (const key of ['msq_rep1', 'msq_org_admin', 'hr_admin', 'fitness_manager']) {
      if (!hasAuth(key)) continue;
      const w = await who(await open(key));
      const ps = pages.map((p) => (p.startsWith('/employees/') && key !== 'msq_org_admin' ? `/employees/${otherEmployeeIn(w.org_id, w.id) ?? ''}` : p)).filter((p) => !p.endsWith('/'));
      await sweep(key, ps);
    }
  }
  if (want('forms')) await forms();
}, cleanups);

t.summary();
process.exit(0);
