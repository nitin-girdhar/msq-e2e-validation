// UI write round trip — real writes THROUGH THE BROWSER, verified in Postgres,
// performed as every role and graded by the role's LIVE capabilities.
//
// The deep crawl deliberately never submits a form, and the matrix suites write
// through the API. Neither proves the thing a user actually does: open the
// screen, fill the form, press Save — and that the row lands. This does, for the
// four primary write surfaces, as every login (tenant A ladder read_only ->
// super_admin, plus tenant B's actors):
//
//   S1 LMS   Leads grid -> Edit -> change stage (+ outcome / follow-up time) + note -> Save Changes
//            capability lms.leads.edit*          DB: marketing_leads.stage_id + note in a lead child table
//   S2 HR    Leave -> Apply leave -> type/dates/reason -> Submit request
//            capability hr.leave.request.create  DB: hr.leave_requests row with the reason
//   S3 Tasks Tasks -> quick-add -> Enter
//            capability tasks.create             DB: task.tasks row with the title
//   S4 Admin Team -> New user -> name/email/department/role -> Create user
//            capability admin.team.manage        DB: iam.users row (+ user_org_mapping)
//   S5 two browsers edit the SAME lead and press Save at the same moment
//
// Grading per role x surface (each outcome also journalled for openissues.md):
//   has cap, UI allows, 2xx, row changed                -> pass
//   has cap, control hidden / page redirected           -> high   (blocked legitimate user)
//   has cap, 2xx but DB unchanged                       -> high   (silent no-op)
//   has cap, 4xx/5xx                                    -> high
//   no cap, control hidden / redirected                 -> pass
//   no cap, control visible, server refuses             -> medium (UI invites a dead end)
//   no cap, write lands                                 -> high/critical (privilege escalation)
//
// Everything created is E2E-marked and purged in finally (leads/users FK-aware).
//
//   node suites/ui/ui-write-roundtrip.mjs            # all surfaces
//   node suites/ui/ui-write-roundtrip.mjs lms,todo   # a subset
import { openAs, APPS, GATEWAY, record, cfg, roleMeta, CROSS_TENANT } from '../../lib.mjs';
import { actor, apiPost, apiGet } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { purgeById, purgeE2eUsers, leaveTypeFor, seedLeaveBalance } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const only = (process.argv[2] || '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const stamp = Date.now();

const ACTORS = [
  ...cfg.roles.map((r) => ({ key: r.role, email: r.email, org: r.org, role: r.role })),
  ...CROSS_TENANT.map((a) => ({ key: a.stateKey, email: a.email, org: a.org, role: a.role })),
].filter((a) => !process.env.E2E_ACTORS || process.env.E2E_ACTORS.split(',').includes(a.key));
const userIdOf = (email) => scalar(`SELECT id FROM iam.users WHERE email=${lit(email.toLowerCase())} LIMIT 1`);
const orgIdOf = (name) => scalar(`SELECT id FROM entity.organizations WHERE name=${lit(name)} AND NOT is_deleted LIMIT 1`);

let findings = 0;
const fail = (tool, severity, role, page, scenario, expected, actual, evidence, fix) => {
  findings++;
  record(tool, { severity, role, tool, page, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 500), proposedSolution: fix });
};
const journal = (tool, role, area, action, status, outcome, verified, expected, note) =>
  logAction({ tool, role, area, action, method: 'UI', endpoint: area, status, outcome, verified, expected, note });

// Grade one role x surface. `visible` = the control was reachable in the UI.
function grade({ tool, page, key, action, has, visible, status, changed, evidence, fixHidden, fixNoop, fixOver }) {
  const outcome = !visible ? 'hidden' : status == null ? 'error' : outcomeOf(status, changed);
  journal(tool, key, page, action, status ?? null, outcome, visible ? changed : null, has ? 'allowed' : 'hidden/denied',
    `${has ? 'has' : 'lacks'} capability; control ${visible ? 'visible' : 'hidden'}${status != null ? `; HTTP ${status}` : ''}${changed != null ? `; DB changed=${changed}` : ''}`);
  if (has) {
    if (!visible) return fail(tool, 'high', key, page, `${action} — control not reachable`, 'Control visible for a role that holds the capability', 'Hidden or redirected away', evidence, fixHidden);
    if (status == null) return fail(tool, 'high', key, page, `${action} — no write request sent`, 'Pressing the button issues the write', 'No matching request within 15 s', evidence, 'Check the form validation / disabled state and the submit handler.');
    if (status >= 400) return fail(tool, status >= 500 ? 'high' : 'high', key, page, `${action} — server refused a permitted user`, '2xx', `HTTP ${status}`, evidence, 'Page guard, service guard and capability disagree for this role.');
    if (!changed) return fail(tool, 'high', key, page, `${action} — 2xx but nothing persisted`, 'Row written / changed in Postgres', 'DB unchanged', evidence, fixNoop);
  } else if (visible) {
    if (status != null && status < 300 && changed) return fail(tool, key.includes('read_only') ? 'critical' : 'high', key, page, `${action} — succeeded without the capability`, 'Hidden, or refused by the server', `HTTP ${status} and the row changed`, evidence, fixOver);
    if (status != null && status >= 500) return fail(tool, 'high', key, page, `${action} — 5xx for a role without the capability`, '403 (or hidden control)', `HTTP ${status}`, evidence, 'Refuse with ForbiddenError before the handler runs.');
    return fail(tool, 'medium', key, page, `${action} — control shown to a role without the capability`, 'Control hidden (capability-gated in the UI)', `Visible${status != null ? `; server answered ${status}` : ''}`, evidence, 'Gate the control on the same capability the service checks (useCapability).');
  }
}

// Live capabilities AND the session's current branch: the fixture lead must sit
// in the branch the grid is scoped to (a multi-branch user's session need not be
// on the roles.json branch — the grid sends org_ids=[session org]).
async function sessionOf(key) {
  const a = await actor(key).catch(() => null);
  if (!a) return null;
  try {
    const caps = await sessionCaps(a);
    const me = await apiGet(a, `${GATEWAY}/auth/me`);
    return { caps, orgName: me.body?.data?.user?.org_name ?? null };
  } finally { await a.close(); }
}
const hasAny = (caps, list) => !!caps && list.some((c) => caps.has(c));

// Wait for the first response that matches, while running the UI action.
async function withWrite(page, match, fn, timeout = 15000) {
  const wait = page.waitForResponse((r) => match(r.request().method(), r.url()), { timeout }).catch(() => null);
  await fn();
  const r = await wait;
  if (!r) return { status: null, url: null, body: null };
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status(), url: r.url(), body };
}
const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1500); };
const leftApp = (page, prefix) => !new URL(page.url()).pathname.startsWith(prefix);

// ── S1 LMS lead edit ──────────────────────────────────────────────────────────
const createdLeads = [];
const seeders = {};
// Created by the tenant_admin OF THE ACTOR'S OWN TENANT: a lead picks up the
// creator's tenant defaults (campaign type), so seeding every fixture as
// super_admin (homed in tenant B) produced cross-tenant rows RLS rightly hid.
const seederKeyFor = (orgName) => {
  const tenant = scalar(`SELECT tenant_id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
  const tb = CROSS_TENANT.find((x) => x.role === 'tenant_admin');
  const tbTenant = tb ? scalar(`SELECT tenant_id FROM entity.organizations WHERE name=${lit(tb.org)} LIMIT 1`) : null;
  return tenant && tenant === tbTenant ? tb.stateKey : 'tenant_admin';
};
async function fixtureLead(ownerEmail, orgName, tag) {
  const sk = seederKeyFor(orgName);
  const seeder = (seeders[sk] ??= await actor(sk));
  const last = `UI-${tag}-${stamp}`;
  const r = await apiPost(seeder, `${APPS['lms-web']}/api/leads`, {
    first_name: 'E2E-UI', last_name: last, email: `e2e.ui.${tag}.${stamp}@example.test`,
    phone: `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  });
  const id = r.body?.data?.id ?? scalar(`SELECT id FROM lms.marketing_leads WHERE last_name=${lit(last)} LIMIT 1`);
  if (!id) return null;
  createdLeads.push(id);
  // Put it in the actor's branch, assigned to the actor, newest — so it is on the grid's first screen.
  const org = orgIdOf(orgName), uid = userIdOf(ownerEmail);
  // The campaign type the owner's department works (1.49.0 RLS shows a typed
  // lead only to that department); untyped when the department owns none.
  const ct = scalar(`SELECT ct.id FROM marketing.campaign_types ct
      JOIN entity.organizations o ON o.tenant_id = ct.tenant_id AND o.id = ${lit(org)}
      JOIN iam.user_org_mapping m ON m.user_id = ${lit(uid)} AND m.org_id = o.id AND m.is_active
      JOIN iam.user_roles ur ON ur.id = m.role_id
     WHERE ct.department_id = ur.department_id ORDER BY ct.is_default DESC LIMIT 1`);
  q(`UPDATE lms.marketing_leads SET org_id=${lit(org)}, assigned_user_id=${lit(uid)}, campaign_type_id=${ct ? lit(ct) : 'NULL'},
       created_at=now(), updated_at=now() WHERE id=${lit(id)}`);
  return { id, last };
}
// Where lead notes may land (status log, interactions, follow-ups, the lead itself).
const NOTE_COLS = rows(`SELECT table_schema||'.'||table_name, column_name FROM information_schema.columns
  WHERE table_schema='lms' AND table_name IN ('lead_status_log','lead_interactions','lead_follow_ups','marketing_leads')
    AND data_type IN ('text','character varying')`, ['t', 'c']);
const noteLanded = (leadId, marker) => NOTE_COLS.some(({ t, c }) => Number(scalar(
  `SELECT COUNT(*) FROM ${t} WHERE ${t.endsWith('marketing_leads') ? 'id' : 'lead_id'}=${lit(leadId)} AND ${c} LIKE ${lit(`%${marker}%`)}`)) > 0);
const stageOf = (id) => scalar(`SELECT COALESCE(stage_id::text,'')||'/'||COALESCE(outcome_id::text,'') FROM lms.marketing_leads WHERE id=${lit(id)}`);

async function openLeadEditor(page, last) {
  await page.goto(`${APPS['lms-web']}/dashboard/leads`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (leftApp(page, '/lms')) return { visible: false, why: `redirected to ${page.url()}` };
  const row = page.locator('.ag-center-cols-container .ag-row', { hasText: last }).first();
  for (let i = 0; i < 6 && !(await row.count()); i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(700); }
  if (!(await row.count())) return { visible: false, why: 'fixture lead not on the grid' };
  const idx = await row.getAttribute('row-index');
  const edit = page.locator(`.ag-row[row-index="${idx}"] button[title="Edit"]`).first();
  if (!(await edit.count())) return { visible: false, why: 'no Edit button on the row' };
  await edit.click();
  await page.waitForTimeout(1500);
  const save = page.getByRole('button', { name: /save changes/i });
  if (!(await save.count())) return { visible: false, why: 'Edit opened no editable form' };
  return { visible: true };
}
// Change stage/outcome, set a follow-up if asked, type the note, press Save.
async function fillLeadEdit(page, marker, pick = 1) {
  const dlg = page.locator('[role="dialog"]').filter({ has: page.getByRole('button', { name: /save changes/i }) }).last();
  const first = dlg.locator('select').first();
  const vals = await first.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean)).catch(() => []);
  const cur = await first.inputValue().catch(() => '');
  const choices = vals.filter((v) => v !== cur);
  if (choices.length) { await first.selectOption(choices[Math.min(pick, choices.length) - 1]); await page.waitForTimeout(1200); }
  const sels = dlg.locator('select');
  for (let i = 1; i < await sels.count(); i++) {
    const v = await sels.nth(i).locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean)).catch(() => []);
    if (v.length && !(await sels.nth(i).inputValue().catch(() => ''))) await sels.nth(i).selectOption(v[0]).catch(() => {});
  }
  const dt = dlg.locator('input[type="datetime-local"]');
  if (await dt.count()) { const x = new Date(Date.now() + 2 * 864e5); x.setMinutes(0, 0, 0); await dt.first().fill(x.toISOString().slice(0, 16)).catch(() => {}); }
  const ta = dlg.locator('textarea');
  if (await ta.count()) await ta.first().fill(marker);
  return dlg.getByRole('button', { name: /save changes/i });
}
const leadWrite = (m, u) => m !== 'GET' && /\/api\/leads\/[0-9a-f-]{36}/.test(u);

async function s1(a, has) {
  const PAGE = 'LMS > Leads > Edit lead';
  const lead = await fixtureLead(a.email, a.org, a.key);
  if (!lead) return fail('lms', 'info', a.key, PAGE, 'Create fixture lead', 'created', 'not created', '', 'Precondition.');
  const { browser, page } = await openAs(a.key);
  try {
    const before = stageOf(lead.id);
    const o = await openLeadEditor(page, lead.last);
    if (!o.visible) return grade({ tool: 'lms', page: PAGE, key: a.key, action: 'edit a lead (stage + note) and save', has, visible: false, evidence: o.why, fixHidden: 'Leads grid Edit must render for lms.leads.edit.* holders on their own leads.' });
    const marker = `E2E-UI-note-${a.key}-${stamp}`;
    const save = await fillLeadEdit(page, marker);
    const w = await withWrite(page, leadWrite, () => save.click());
    await page.waitForTimeout(1500);
    const changed = stageOf(lead.id) !== before || noteLanded(lead.id, marker);
    grade({ tool: 'lms', page: PAGE, key: a.key, action: 'edit a lead (stage + note) and save', has, visible: true, status: w.status, changed,
      evidence: `lead=${lead.id} before=${before} after=${stageOf(lead.id)} ${JSON.stringify(w.body ?? '').slice(0, 200)}`,
      fixNoop: 'The PATCH handler returned 2xx without writing stage/note — check leads.service update field whitelist.',
      fixOver: 'leads.router PATCH must requireCapability(lms.leads.edit.*) scoped by ownership.' });
  } finally { await browser.close(); }
}

// ── S2 HR apply leave ────────────────────────────────────────────────────────
const createdLeave = [];
async function s2(a, has, idx) {
  const PAGE = 'HR > Leave > Apply leave';
  const type = leaveTypeFor(a.email);
  const seedNote = `E2E-UI-seed-${a.key}-${stamp}`;
  seedLeaveBalance(a.email, type, 3, seedNote);
  const { browser, page } = await openAs(a.key);
  try {
    await page.goto(`${APPS['hr-web']}/leave`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const btn = page.getByRole('button', { name: /apply leave/i }).first();
    const visible = !leftApp(page, '/hrms') && new URL(page.url()).pathname.endsWith('/leave') && (await btn.count()) > 0;
    if (!visible) return grade({ tool: 'hr', page: PAGE, key: a.key, action: 'apply for leave', has, visible: false, evidence: `landed on ${page.url()}`, fixHidden: 'hr-web /leave must render Apply leave for hr.leave.request.create holders.' });
    await btn.click();
    await page.locator('#al-type').waitFor({ timeout: 10000 }).catch(() => {});
    const types = await page.locator('#al-type option').evaluateAll((os) => os.filter((o) => o.value).length).catch(() => 0);
    if (!types) {
      journal('hr', a.key, PAGE, 'apply for leave', null, 'no-op', null, 'allowed', 'Apply form offers no leave type (no active policy for this branch)');
      if (has) fail('hr', 'info', a.key, PAGE, 'apply for leave — no leave type offered', 'At least one leave type with an active policy', 'Leave type list empty', `branch ${a.org}`, 'Tenant configuration: add a leave policy for this branch.');
      return;
    }
    const opt = await page.locator('#al-type option').evaluateAll((os, t) => (os.find((o) => o.textContent.toLowerCase().includes(t)) || os.find((o) => o.value))?.value ?? null, type).catch(() => null);
    if (opt) await page.locator('#al-type').selectOption(opt);
    // Mid-week (Tue-Thu) so "working days" is never 0 on a weekly off.
    const d = new Date(); d.setDate(d.getDate() + 45 + idx * 7); while (![2, 3, 4].includes(d.getDay())) d.setDate(d.getDate() + 1);
    const day = d.toISOString().slice(0, 10);
    await page.locator('#al-start').fill(day); await page.locator('#al-end').fill(day);
    const reason = `E2E-UI-leave-${a.key}-${stamp}`;
    await page.locator('#al-reason').fill(reason);
    await page.waitForTimeout(1500);
    const submit = page.getByRole('button', { name: /submit request/i });
    const disabled = await submit.isDisabled().catch(() => true);
    const w = disabled ? { status: null } : await withWrite(page, (m, u) => m === 'POST' && /\/hr\/leave\/requests(\?|$)/.test(u), () => submit.click());
    const id = scalar(`SELECT id FROM hr.leave_requests WHERE reason=${lit(reason)} LIMIT 1`);
    if (id) createdLeave.push(id);
    grade({ tool: 'hr', page: PAGE, key: a.key, action: 'apply for leave', has, visible: true, status: w.status, changed: !!id,
      evidence: `type=${type} day=${day} submitDisabled=${disabled} ${JSON.stringify(w.body ?? '').slice(0, 200)}`,
      fixNoop: 'createLeaveRequest returned 2xx without a row.', fixOver: 'leave.router POST /leave/requests must requireCapability(HR_LEAVE_REQUEST_CREATE).' });
  } finally {
    await browser.close();
    q(`DELETE FROM hr.leave_ledger WHERE note=${lit(seedNote)}`);
  }
}

// ── S3 Tasks quick-add ───────────────────────────────────────────────────────
async function s3(a, has) {
  const PAGE = 'Tasks > Quick-add';
  const { browser, page } = await openAs(a.key);
  try {
    await page.goto(`${APPS['todo-web']}/tasks`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const input = page.locator('input[placeholder*="Quick-add"]').first();
    const visible = !leftApp(page, '/todo') && (await input.count()) > 0;
    if (!visible) return grade({ tool: 'todo', page: PAGE, key: a.key, action: 'quick-add a task', has, visible: false, evidence: `landed on ${page.url()}`, fixHidden: 'todo-web must render quick-add for tasks.create holders.' });
    const title = `E2E-UI-task-${a.key}-${stamp}`;
    await input.fill(title);
    const w = await withWrite(page, (m, u) => m === 'POST' && /\/api\/tasks(\?|$)/.test(u), () => input.press('Enter'));
    await page.waitForTimeout(1000);
    const n = Number(scalar(`SELECT COUNT(*) FROM task.tasks WHERE title=${lit(title)}`));
    grade({ tool: 'todo', page: PAGE, key: a.key, action: 'quick-add a task', has, visible: true, status: w.status, changed: n > 0,
      evidence: JSON.stringify(w.body ?? '').slice(0, 200), fixNoop: 'tasks POST returned 2xx without a row.', fixOver: 'tasks.router POST must requireCapability(TASKS_CREATE).' });
  } finally {
    await browser.close();
    q(`DELETE FROM task.tasks WHERE title LIKE ${lit(`E2E-UI-task-${a.key}-${stamp}%`)}`);
  }
}

// ── S4 Admin Team -> New user ───────────────────────────────────────────────
async function s4(a, has) {
  const PAGE = 'Admin > Team > New user';
  const { browser, page } = await openAs(a.key);
  const email = `ui-${a.key.replace(/_/g, '-')}-${stamp}@e2e.local`;
  try {
    await page.goto(`${APPS['admin-web']}/dashboard/team`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const btn = page.getByRole('button', { name: /^new user$/i }).first();
    const restricted = /access restricted/i.test(await page.locator('body').innerText().catch(() => ''));
    const visible = !restricted && !leftApp(page, '/admin') && (await btn.count()) > 0;
    if (!visible) return grade({ tool: 'admin', page: PAGE, key: a.key, action: 'create a user from the Team screen', has, visible: false, evidence: restricted ? 'Access restricted panel' : `landed on ${page.url()}`, fixHidden: 'admin-web Team must offer New user to admin.team.manage holders.' });
    await btn.click();
    await page.locator('#cu-first-name').waitFor({ timeout: 10000 }).catch(() => {});
    await page.locator('#cu-first-name').fill('E2E');
    await page.locator('#cu-last-name').fill(`UI ${a.key}`);
    await page.locator('#cu-email').fill(email);
    const pickFirst = async (sel) => {
      const v = await page.locator(sel + ' option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })).filter((o) => o.v)).catch(() => []);
      // Least-privileged role on offer, so the throwaway user never outranks anything.
      const low = v.find((o) => /read.?only/i.test(o.t)) ?? v.at(-1);
      if (low) await page.locator(sel).selectOption(low.v).catch(() => {});
      await page.waitForTimeout(600);
    };
    if (await page.locator('#uf-department').count()) await pickFirst('#uf-department');
    if (await page.locator('#uf-branch-role').count()) await pickFirst('#uf-branch-role');
    // Never email a throwaway: untick "send notification" when present.
    for (const cb of await page.locator('[role="dialog"] input[type="checkbox"]').all()) {
      const lbl = (await cb.evaluate((el) => el.closest('label')?.innerText || '').catch(() => '')).toLowerCase();
      if (/email|notif|send/.test(lbl) && await cb.isChecked().catch(() => false)) await cb.uncheck().catch(() => {});
    }
    const create = page.getByRole('button', { name: /^create user$/i });
    const w = await withWrite(page, (m, u) => m === 'POST' && /\/api\/users(\?|$)/.test(u), () => create.click());
    await page.waitForTimeout(1000);
    const id = scalar(`SELECT id FROM iam.users WHERE email=${lit(email)} LIMIT 1`);
    const mapped = id ? Number(scalar(`SELECT COUNT(*) FROM iam.user_org_mapping WHERE user_id=${lit(id)} AND is_active`)) : 0;
    grade({ tool: 'admin', page: PAGE, key: a.key, action: 'create a user from the Team screen', has, visible: true, status: w.status, changed: !!id && mapped > 0,
      evidence: `email=${email} mapped=${mapped} ${JSON.stringify(w.body ?? '').slice(0, 200)}`,
      fixNoop: 'createUser returned 2xx but the user or its branch mapping is missing.', fixOver: 'users.router POST must requireCapability(ADMIN_TEAM_MANAGE).' });
  } finally {
    await browser.close();
    purgeE2eUsers(email);
  }
}

// ── S5 two browsers, one lead, simultaneous Save ────────────────────────────
async function s5() {
  const PAGE = 'LMS > Leads > Edit lead (two users at once)';
  // Two editors in the SAME tenant and branch (super_admin's save 404s by the
  // cross-tenant mapping defect, which would mask the race).
  const A = 'org_admin', B = 'org_manager';
  const lead = await fixtureLead(roleMeta(A).email, roleMeta(A).org, 'conc');
  if (!lead) return;
  const sa = await openAs(A), sb = await openAs(B);
  try {
    const [oa, ob] = await Promise.all([openLeadEditor(sa.page, lead.last), openLeadEditor(sb.page, lead.last)]);
    if (!oa.visible || !ob.visible) { fail('concurrency', 'info', `${A} + ${B}`, PAGE, 'Open the same lead in two browsers', 'both editors open', `${oa.why ?? 'ok'} / ${ob.why ?? 'ok'}`, '', 'Precondition.'); return; }
    const ma = `E2E-UI-concA-${stamp}`, mb = `E2E-UI-concB-${stamp}`;
    const [ba, bb] = await Promise.all([fillLeadEdit(sa.page, ma, 1), fillLeadEdit(sb.page, mb, 2)]);
    const [wa, wb] = await Promise.all([withWrite(sa.page, leadWrite, () => ba.click()), withWrite(sb.page, leadWrite, () => bb.click())]);
    await sa.page.waitForTimeout(1500);
    const na = noteLanded(lead.id, ma), nb = noteLanded(lead.id, mb);
    const ok = [wa.status, wb.status].filter((s) => s && s < 300).length;
    const conflict = [wa.status, wb.status].some((s) => s === 409 || s === 412);
    logAction({ tool: 'concurrency', role: `${A} + ${B}`, area: PAGE, action: 'two users save different stages + notes on one lead at the same moment', method: 'UI', endpoint: 'Leads > Edit',
      status: `${wa.status}/${wb.status}`, outcome: [wa.status, wb.status].some((s) => s >= 500) ? 'error' : 'allowed', verified: na && nb, note: `notes landed A=${na} B=${nb}; final=${stageOf(lead.id)}` });
    if ([wa.status, wb.status].some((s) => s >= 500)) fail('concurrency', 'high', `${A} + ${B}`, PAGE, 'Simultaneous Save on one lead', '2xx or clean 409', `HTTP ${wa.status} / ${wb.status}`, '', 'A concurrent update must not 500; wrap in a transaction with a row lock.');
    else if (ok === 2 && (!na || !nb)) fail('concurrency', 'high', `${A} + ${B}`, PAGE, 'Simultaneous Save on one lead', 'Both notes kept (history is append-only)', `note A=${na}, note B=${nb} — a note was lost`, stageOf(lead.id), 'Status-log/note writes must be inserts, never overwrites of a single column.');
    else if (ok === 2 && !conflict) fail('concurrency', 'medium', `${A} + ${B}`, PAGE, 'Simultaneous Save on one lead (stale editor)', 'Second writer warned (409 / version check) that the lead changed under them',
      `Both saves 2xx; last writer silently wins the stage (final ${stageOf(lead.id)})`, '', 'Send updated_at as an If-Match / version and reject a stale PATCH with 409 so the UI can reload.');
  } finally { await sa.browser.close(); await sb.browser.close(); }
}

// ── run ─────────────────────────────────────────────────────────────────────
try {
  for (const [i, a] of ACTORS.entries()) {
    const sess = await sessionOf(a.key);
    const caps = sess?.caps;
    if (!caps) { console.log(`skip ${a.key}: no session`); continue; }
    if (sess.orgName) a.org = sess.orgName;
    console.log(`\n── ${a.key} (${caps.size} caps)`);
    const steps = [
      ['lms', () => s1(a, hasAny(caps, ['lms.leads.edit', 'lms.leads.edit.own', 'lms.leads.edit.team', 'lms.leads.edit.any']))],
      ['hr', () => s2(a, caps.has('hr.leave.request.create'), i)],
      ['todo', () => s3(a, caps.has('tasks.create'))],
      ['admin', () => s4(a, caps.has('admin.team.manage'))],
    ];
    for (const [tag, run] of steps) {
      if (!want(tag)) continue;
      try { await run(); console.log(`   ${tag} done`); } catch (e) {
        fail(tag, 'info', a.key, `UI round trip (${tag})`, 'Run the UI scenario', 'completes', `harness error: ${e.message.slice(0, 160)}`, '', 'Harness — inspect the selector.');
      }
    }
  }
  if (want('concurrency')) await s5().catch((e) => console.log('S5 error', e.message));
} finally {
  for (const id of createdLeads) { try { purgeById('lms.marketing_leads', id); } catch {} }
  for (const id of createdLeave) {
    q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_requests WHERE id=${lit(id)}`);
  }
  for (const a of Object.values(seeders)) await a?.close();
  console.log(`\nui-write-roundtrip: ${findings} finding(s); purged ${createdLeads.length} lead(s), ${createdLeave.length} leave request(s).`);
}
