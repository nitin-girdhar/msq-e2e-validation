// HR people / payroll features x EVERY login, graded by LIVE capability, plus capability on/off toggling.
//
// PART A — role matrix (matrix.mjs runRoleMatrix). Each endpoint runs as all roles in roles.json
//   (read_only .. super_admin) AND the cross-tenant actors (CROSS_TENANT). The expectation is read from
//   each login's own /auth/me (live capabilities: tenant overrides + parent-denial cascade included), so a
//   role NAME is never the authorization boundary. Reads: profile/me, statutory, change-requests, org-chart,
//   360 / statutory / attendance / audit tabs, documents (mine/settings/admin), announcements (list/admin),
//   assets (mine / inventory), payroll (payslips / overview / readiness), change-request queue.
//   Writes (verified in Postgres, snapshotted/purged): PUT personal, POST contact, POST announcement draft,
//   POST asset, PUT payslip draft, POST lock, POST HR note, PUT statutory, POST document (then removed),
//   PUT upload limit. OVER-permitted = privilege escalation (high), under-permitted = blocked user (medium),
//   5xx = defect whoever calls.
//
// PART B — capability toggling on tenant B (MSquare, role org_admin, login msq_org_admin). For each
//   capability: revoke via a TENANT-scoped override (capability.mjs setOverride; journalled; restored in
//   finally) -> wait until /auth/me drops it -> the API must DENY (403) AND the UI must HIDE / redirect ->
//   restore -> the API works and the UI shows it again. Tenant A's session capabilities must not move.
//
//   node suites/hr/hr-people-role-matrix.mjs            # A + B
//   node suites/hr/hr-people-role-matrix.mjs matrix     # only part A
//   node suites/hr/hr-people-role-matrix.mjs toggle     # only part B
import { ROLES, CROSS_TENANT, APPS, authFile, openAs } from '../../lib.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import { logAction } from '../../journal.mjs';
import { setOverride, restoreAll, loadJournal, waitForSessionCapability, sessionCapabilities } from '../../capability.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, hasAuth, who, guarded, otherEmployeeIn, snapshotRow, journalPurge, waitFor, q, scalar, rows, lit,
  pdfBytes, b64,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');
const only = process.argv[2] || 'all';

const TOOL = 'hr';
const t = suite('hr', 'HR people role matrix');
const cleanups = [];
const ALL = [...ROLES, ...CROSS_TENANT.map((c) => c.stateKey)].filter((k) => hasAuth(k));
const M = '2019-06', MLOCK = '2019-07';

// ── per-login memo of "who am I / who is a colleague in my branch" ───────────
const ctxCache = new Map();
async function me(a) {
  if (!ctxCache.has(a.stateKey)) {
    const w = await who(a);
    ctxCache.set(a.stateKey, { w, other: otherEmployeeIn(w.org_id, w.id) });
  }
  return ctxCache.get(a.stateKey);
}
const undo = new Map(); // role -> () => void

await guarded(async () => {
  // ══════════ PART A ═══════════════════════════════════════════════════════
  if (only === 'all' || only === 'matrix') {
    const preP = Number(scalar(`SELECT (SELECT count(*) FROM hr.payslips WHERE period IN (${lit(`${M}-01`)})) + (SELECT count(*) FROM hr.pay_periods WHERE period IN (${lit(`${M}-01`)}, ${lit(`${MLOCK}-01`)}))`));
    if (preP > 0) { console.log('test months already have payroll rows — skipping the payroll write rows'); }
    const WRITE_PURGE = [
      `DELETE FROM hr.announcements WHERE title LIKE '${MARK}%'`,
      `DELETE FROM hr.asset_assignments WHERE asset_id IN (SELECT id FROM hr.assets WHERE asset_tag LIKE '${MARK}%')`,
      `DELETE FROM hr.assets WHERE asset_tag LIKE '${MARK}%'`,
      `DELETE FROM hr.employee_notes WHERE body LIKE '${MARK}%'`,
      `DELETE FROM hr.employee_documents WHERE title LIKE '${MARK}%'`,
      `DELETE FROM hr.emergency_contacts WHERE name LIKE '${MARK}%'`,
      ...(preP === 0 ? [
        `DELETE FROM hr.payslip_lines WHERE payslip_id IN (SELECT id FROM hr.payslips WHERE period = '${M}-01')`,
        `DELETE FROM hr.payslips WHERE period = '${M}-01'`,
        `DELETE FROM hr.pay_periods WHERE period IN ('${M}-01', '${MLOCK}-01')`,
      ] : []),
    ];
    cleanups.push(journalPurge('people-matrix-purge', 'E2E role-matrix rows', WRITE_PURGE));
    cleanups.push(() => { for (const s of WRITE_PURGE) q(s); });
    cleanups.push(() => { for (const u of undo.values()) { try { u(); } catch { /* best effort */ } } });

    const READS = [
      ['read own profile', 'GET /hr/profile/me', 'hr.employees.profile.edit', 'My profile', (a) => a.request.get(`${HR}/profile/me`)],
      ['read own statutory', 'GET /hr/profile/me/statutory', 'hr.employees.profile.edit', 'My profile', (a) => a.request.get(`${HR}/profile/me/statutory`)],
      ['list own change requests', 'GET /hr/profile/me/change-requests', 'hr.employees.profile.edit', 'My profile', (a) => a.request.get(`${HR}/profile/me/change-requests`)],
      ['read the org chart', 'GET /hr/employees/org-chart', 'hr.employees.view', 'Org chart', (a) => a.request.get(`${HR}/employees/org-chart`)],
      ['open a colleague\'s 360', 'GET /hr/employees/:userId/profile-360', 'hr.employees.profile360.view', 'Employee 360', async (a) => a.request.get(`${HR}/employees/${(await me(a)).other}/profile-360`)],
      ['read a colleague\'s (masked) statutory', 'GET /hr/employees/:userId/statutory', 'hr.employees.profile360.view', 'Employee 360', async (a) => a.request.get(`${HR}/employees/${(await me(a)).other}/statutory`)],
      ['read a colleague\'s attendance tab', 'GET /hr/employees/:userId/attendance', 'hr.employees.profile360.view', 'Employee 360', async (a) => a.request.get(`${HR}/employees/${(await me(a)).other}/attendance?month=${new Date().toISOString().slice(0, 7)}`)],
      ['read a colleague\'s audit tab', 'GET /hr/employees/:userId/audit', 'hr.employees.notes.manage', 'Employee 360', async (a) => a.request.get(`${HR}/employees/${(await me(a)).other}/audit`)],
      ['list statutory change requests (HR queue)', 'GET /hr/profile/change-requests', 'hr.employees.statutory.manage', 'Employees', (a) => a.request.get(`${HR}/profile/change-requests?status=pending`)],
      ['list own documents', 'GET /hr/documents/mine', 'hr.employees.documents.view', 'Documents', (a) => a.request.get(`${HR}/documents/mine`)],
      ['read the upload limit', 'GET /hr/documents/settings', ['hr.employees.documents.view', 'hr.employees.documents.manage'], 'Documents', (a) => a.request.get(`${HR}/documents/settings`)],
      ['read the document review queue', 'GET /hr/documents/admin/pending', 'hr.employees.documents.manage', 'Documents', (a) => a.request.get(`${HR}/documents/admin/pending`)],
      ['list announcements', 'GET /hr/announcements', 'hr.employees.announcements.view', 'Dashboard', (a) => a.request.get(`${HR}/announcements`)],
      ['list announcements (admin view)', 'GET /hr/announcements/admin', 'hr.employees.announcements.manage', 'Dashboard', (a) => a.request.get(`${HR}/announcements/admin`)],
      ['list my assets', 'GET /hr/assets/mine', 'hr.employees.assets.view', 'My profile', (a) => a.request.get(`${HR}/assets/mine`)],
      ['list the asset inventory', 'GET /hr/assets', 'hr.employees.assets.manage', 'Employee 360', (a) => a.request.get(`${HR}/assets`)],
      ['list my payslips', 'GET /hr/payroll/payslips', 'hr.employees.payslip.view', 'Payroll', (a) => a.request.get(`${HR}/payroll/payslips`)],
      ['open the payroll overview', 'GET /hr/payroll/admin/overview', 'hr.reports.payroll.manage', 'Payroll', (a) => a.request.get(`${HR}/payroll/admin/overview?month=${M}`)],
      ['open payroll readiness', 'GET /hr/payroll/admin/readiness', 'hr.reports.payroll.manage', 'Payroll', (a) => a.request.get(`${HR}/payroll/admin/readiness?month=${M}`)],
    ];
    for (const [action, endpoint, capability, tab, call] of READS) {
      console.log(`\n— ${action} (${Array.isArray(capability) ? capability.join(' | ') : capability}) —`);
      await runRoleMatrix({
        tool: TOOL, action, endpoint, capability, area: 'HR people', tab, roles: ALL, severityOver: 'high',
        act: async (a) => { const r = await call(a); let body = null; try { body = await r.json(); } catch { body = null; } return { status: r.status(), body }; },
      });
    }

    const stamp = (role) => `${MARK}-${role}`;
    const WRITES = [
      {
        action: 'save personal details', endpoint: 'PUT /hr/profile/me/personal', capability: 'hr.employees.profile.edit', tab: 'My profile',
        act: async (a, role) => { const { w } = await me(a); undo.set(`p-${role}`, snapshotRow(`people-matrix-personal-${role}`, 'hr.employee_personal', 'user_id', w.id)); return respOf(a.request.put(`${HR}/profile/me/personal`, { data: { preferred_name: stamp(role) } })); },
        verify: async (role) => { const k = `p-${role}`; const w = [...ctxCache.values()].find((c) => roleOfKey(c.w.key) === role)?.w; return !!w && scalar(`SELECT preferred_name FROM hr.employee_personal WHERE user_id=${lit(w.id)}`) === stamp(role); },
        cleanup: (role) => { undo.get(`p-${role}`)?.(); undo.delete(`p-${role}`); },
      },
      {
        action: 'add an emergency contact', endpoint: 'POST /hr/profile/me/contacts', capability: 'hr.employees.profile.edit', tab: 'My profile',
        act: async (a, role) => { const { w } = await me(a); const pre = rows(`SELECT id::text, is_primary::text FROM hr.emergency_contacts WHERE user_id=${lit(w.id)} AND NOT is_deleted`, ['id', 'p']); undo.set(`c-${role}`, () => { q(`DELETE FROM hr.emergency_contacts WHERE name LIKE ${lit(`${stamp(role)}%`)}`); for (const c of pre) q(`UPDATE hr.emergency_contacts SET is_primary=${c.p} WHERE id=${lit(c.id)}`); }); return respOf(a.request.post(`${HR}/profile/me/contacts`, { data: { name: stamp(role), relation: 'E2E', phone: '+919800000000' } })); },
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.emergency_contacts WHERE name=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => { undo.get(`c-${role}`)?.(); undo.delete(`c-${role}`); },
      },
      {
        action: 'draft an announcement', endpoint: 'POST /hr/announcements', capability: 'hr.employees.announcements.manage', tab: 'Dashboard',
        act: (a, role) => respOf(a.request.post(`${HR}/announcements`, { data: { title: stamp(role), body: 'e2e', publish: false } })),
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.announcements WHERE title=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => q(`DELETE FROM hr.announcements WHERE title=${lit(stamp(role))}`),
      },
      {
        action: 'create an asset', endpoint: 'POST /hr/assets', capability: 'hr.employees.assets.manage', tab: 'Employee 360',
        act: (a, role) => respOf(a.request.post(`${HR}/assets`, { data: { asset_tag: stamp(role), name: 'E2E asset', category: 'other' } })),
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.assets WHERE asset_tag=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => q(`DELETE FROM hr.assets WHERE asset_tag=${lit(stamp(role))}`),
      },
      {
        action: 'add an HR note to a colleague', endpoint: 'POST /hr/employees/:userId/notes', capability: 'hr.employees.notes.manage', tab: 'Employee 360',
        act: async (a, role) => respOf(a.request.post(`${HR}/employees/${(await me(a)).other}/notes`, { data: { kind: 'note', body: stamp(role) } })),
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.employee_notes WHERE body=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => q(`DELETE FROM hr.employee_notes WHERE body=${lit(stamp(role))}`),
      },
      {
        action: 'set a colleague\'s statutory details', endpoint: 'PUT /hr/employees/:userId/statutory', capability: 'hr.employees.statutory.manage', tab: 'Employee 360',
        act: async (a, role) => { const { other } = await me(a); undo.set(`s-${role}`, snapshotRow(`people-matrix-stat-${role}`, 'hr.employee_statutory', 'user_id', other)); return respOf(a.request.put(`${HR}/employees/${other}/statutory`, { data: { bank_name: stamp(role) } })); },
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.employee_statutory WHERE bank_name=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => { undo.get(`s-${role}`)?.(); undo.delete(`s-${role}`); },
      },
      {
        action: 'upload a document (then remove it)', endpoint: 'POST /hr/documents/mine', capability: 'hr.employees.documents.view', tab: 'Documents',
        act: async (a, role) => { const r = await respOf(a.request.post(`${HR}/documents/mine`, { data: { category: 'other', title: stamp(role), file_name: 'e2e.pdf', data_base64: b64(pdfBytes(500)) } })); const id = r.body?.data?.id; if (id) await a.request.delete(`${HR}/documents/${id}`, { failOnStatusCode: false }); return r; },
        verify: async (role) => Number(scalar(`SELECT count(*) FROM hr.employee_documents WHERE title=${lit(stamp(role))}`)) > 0,
        cleanup: (role) => q(`DELETE FROM hr.employee_documents WHERE title=${lit(stamp(role))}`),
      },
      {
        action: 'change the document upload limit', endpoint: 'PUT /hr/documents/settings', capability: 'hr.employees.documents.manage', tab: 'Documents',
        act: async (a, role) => { const { w } = await me(a); undo.set(`d-${role}`, snapshotRow(`people-matrix-docset-${role}`, 'hr.document_settings', 'org_id', w.org_id)); return respOf(a.request.put(`${HR}/documents/settings`, { data: { max_bytes: 204800 } })); },
        verify: async (role) => { const w = [...ctxCache.values()].find((c) => roleOfKey(c.w.key) === role)?.w; return !!w && scalar(`SELECT max_bytes FROM hr.document_settings WHERE org_id=${lit(w.org_id)} AND NOT is_deleted`) === '204800'; },
        cleanup: (role) => { undo.get(`d-${role}`)?.(); undo.delete(`d-${role}`); },
      },
    ];
    if (preP === 0) {
      WRITES.push({
        action: 'draft a colleague\'s payslip', endpoint: 'PUT /hr/payroll/admin/payslips', capability: 'hr.reports.payroll.manage', tab: 'Payroll',
        act: async (a) => respOf(a.request.put(`${HR}/payroll/admin/payslips`, { data: { user_id: (await me(a)).other, month: M, lines: [{ kind: 'earning', label: 'E2E', amount: 1 }] } })),
        verify: async (role) => { const w = [...ctxCache.values()].find((c) => roleOfKey(c.w.key) === role)?.w; return !!w && Number(scalar(`SELECT count(*) FROM hr.payslips WHERE period=${lit(`${M}-01`)} AND created_by=${lit(w.id)}`)) > 0; },
        cleanup: (role) => { q(`DELETE FROM hr.payslip_lines WHERE payslip_id IN (SELECT id FROM hr.payslips WHERE period='${M}-01')`); q(`DELETE FROM hr.payslips WHERE period='${M}-01'`); },
      }, {
        action: 'lock a payroll month', endpoint: 'POST /hr/payroll/admin/:month/lock', capability: 'hr.reports.payroll.manage', tab: 'Payroll',
        act: async (a) => respOf(a.request.post(`${HR}/payroll/admin/${MLOCK}/lock`, { data: {} })),
        verify: async () => Number(scalar(`SELECT count(*) FROM hr.pay_periods WHERE period=${lit(`${MLOCK}-01`)} AND status='locked'`)) > 0,
        cleanup: () => q(`DELETE FROM hr.pay_periods WHERE period='${MLOCK}-01'`),
      });
    }
    for (const w of WRITES) {
      console.log(`\n— ${w.action} (${w.capability}) —`);
      await runRoleMatrix({ tool: TOOL, action: w.action, endpoint: w.endpoint, capability: w.capability, area: 'HR people', tab: w.tab, roles: ALL, act: w.act, verify: w.verify, cleanup: w.cleanup, severityOver: 'high' });
    }
  }

  // ══════════ PART B ═══════════════════════════════════════════════════════
  if (only === 'all' || only === 'toggle') await togglePart();
}, cleanups);

async function respOf(p) { const r = await p; let body = null; try { body = await r.json(); } catch { body = null; } return { status: r.status(), body }; }
function roleOfKey(key) { return key; }

// ───────────────────────────────────────────────────────────────────────────
async function togglePart() {
  console.log('\n══ PART B — capability toggling (tenant B / org_admin) ══');
  const ADM = await open('msq_org_admin'), EMP = await open('msq_rep1'), MGR = await open('fitness_manager');
  if (!ADM) { console.log('msq_org_admin session missing — part B skipped'); return; }
  const a = await who(ADM, { fresh: true });
  const e = EMP ? await who(EMP) : null;
  const target = otherEmployeeIn(a.org_id, a.id) ?? e?.id;
  const tenantId = a.tenant_id;
  const leftovers = loadJournal(); if (leftovers) { console.log(`  restoring ${leftovers} capability override(s) left by a crashed run`); restoreAll(); }
  const mgrCapsBefore = MGR ? [...(await sessionCapabilities(MGR)).capabilities ?? []].sort().join(',') : null;
  // seed an HR note so the notes-visibility toggle has something to hide
  const seed = await t.api(ADM, 'POST', `/employees/${target}/notes`, { body: { kind: 'note', body: `${MARK} toggle-note` }, expect: [201], label: 'seed an HR note for the toggle test' });
  const purge = journalPurge('people-toggle-purge', 'toggle-test notes', [`DELETE FROM hr.employee_notes WHERE body LIKE '${MARK}%'`]);

  const uiProbe = async (path, probe) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { browser, page, log } = await openAs('msq_org_admin');
      try {
        await page.goto(`${APPS['hr-web']}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const res = await page.evaluate(probe);
        return { ...res, path: new URL(page.url()).pathname, errors: log.pageErrors.length };
      } catch (err) {
        if (attempt === 1) return { shown: null, path: 'probe-failed', errors: 0, err: String(err.message).slice(0, 120) };
      } finally { await browser.close().catch(() => {}); }
    }
  };
  const TOGGLES = [
    { cap: 'hr.employees.documents.manage', label: 'document review', api: () => t.api(ADM, 'GET', '/documents/admin/pending', { label: 'GET /documents/admin/pending' }), ok: 200,
      ui: ['/documents', () => ({ shown: /waiting for review/i.test(document.body.innerText) }), 'the "Waiting for review" section'] },
    { cap: 'hr.employees.announcements.manage', label: 'announcement admin', api: () => t.api(ADM, 'GET', '/announcements/admin', { label: 'GET /announcements/admin' }), ok: 200,
      ui: ['/dashboard', () => ({ shown: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Post') }), 'the "Post" button on Announcements'] },
    { cap: 'hr.reports.payroll.manage', label: 'payroll admin', api: () => t.api(ADM, 'GET', `/payroll/admin/overview?month=2019-08`, { label: 'GET /payroll/admin/overview' }), ok: 200,
      ui: ['/payroll', () => ({ shown: [...document.querySelectorAll('button')].some((b) => /^(Lock|Unlock) month$/.test(b.innerText.trim())) }), 'the "Lock month" control'] },
    { cap: 'hr.employees.profile360.view', label: 'Employee 360', api: () => t.api(ADM, 'GET', `/employees/${target}/profile-360`, { label: 'GET /employees/:id/profile-360' }), ok: 200,
      ui: [`/employees/${target}`, () => ({ shown: /\/employees\/[0-9a-f-]{36}$/.test(location.pathname) }), 'the Employee 360 page (revoked => redirected to /employees)'] },
    { cap: 'hr.employees.profile.edit', label: 'My profile', api: () => t.api(ADM, 'GET', '/profile/me', { label: 'GET /profile/me' }), ok: 200,
      ui: ['/profile', () => ({ shown: location.pathname.endsWith('/profile') }), 'the My profile page (revoked => redirected to /dashboard)'] },
    { cap: 'hr.employees.view', label: 'org chart', api: () => t.api(ADM, 'GET', '/employees/org-chart', { label: 'GET /employees/org-chart' }), ok: 200,
      ui: ['/org-chart', () => ({ shown: location.pathname.endsWith('/org-chart') }), 'the org-chart page (revoked => redirected)'] },
    { cap: 'hr.employees.payslip.view', label: 'own payslips', api: () => t.api(ADM, 'GET', '/payroll/payslips', { label: 'GET /payroll/payslips' }), ok: 200,
      ui: ['/payroll', () => ({ shown: /my payslips|your payslips|payslip history|financial year/i.test(document.body.innerText) }), 'the payslip list'], uiOptional: true },
    { cap: 'hr.employees.statutory.manage', label: 'statutory numbers', api: () => t.api(ADM, 'GET', `/profile/change-requests?status=pending`, { label: 'GET /profile/change-requests' }), ok: 200,
      extra: async (revoked) => { const r = await t.api(ADM, 'GET', `/employees/${target}/statutory`, { expect: 'ok', label: `GET /employees/:id/statutory (statutory.manage ${revoked ? 'revoked' : 'held'})` }); const d = r.body?.data; t.check(revoked ? d?.values === null : 'values' in (d ?? {}), 'critical', 'msq_org_admin', revoked ? 'without statutory.manage the 360 statutory view returns values:null (masked only)' : 'with statutory.manage the answer carries `values`', revoked ? 'values null' : 'values key', JSON.stringify(d)?.slice(0, 160), '', 'router: full = can(request.auth, HR_EMPLOYEES_STATUTORY_MANAGE).'); },
      ui: [`/employees/${target}`, () => ({ shown: !!document.body.innerText.match(/Statutory/) }), 'the Employee 360 statutory tab (visible regardless; numbers masked)'] , uiOptional: true },
    { cap: 'hr.employees.notes.manage', label: 'HR notes', api: () => t.api(ADM, 'GET', `/employees/${target}/audit`, { label: 'GET /employees/:id/audit' }), ok: 200,
      extra: async (revoked) => { const r = await t.api(ADM, 'GET', `/employees/${target}/profile-360`, { expect: [200, 403], label: `GET 360 (notes.manage ${revoked ? 'revoked' : 'held'})` }); if (r.status === 200) t.check(revoked ? (r.body.data.notes ?? []).length === 0 : (r.body.data.notes ?? []).some((n) => String(n.body).startsWith(MARK)), 'critical', 'msq_org_admin', revoked ? 'HR notes are NOT returned without notes.manage' : 'HR notes are returned with notes.manage', revoked ? '[]' : 'seeded note present', JSON.stringify(r.body.data.notes)?.slice(0, 160), '', 'getEmployee360(includeNotes = can(NOTES_MANAGE)).'); },
      ui: [`/employees/${target}`, () => ({ shown: [...document.querySelectorAll('[role="tab"],button')].some((b) => /^HR notes$/.test(b.innerText.trim())) }), 'the HR notes tab'] , uiOptional: true },
  ];

  try {
    for (const tg of TOGGLES) {
      console.log(`\n— toggle ${tg.cap} (${tg.label}) —`);
      // baseline
      const base = await tg.api();
      t.check(base.status === tg.ok, 'medium', 'msq_org_admin', `baseline: ${tg.label} API works while ${tg.cap} is held`, `HTTP ${tg.ok}`, `HTTP ${base.status}`);
      if (base.status !== tg.ok) { console.log('  (cap not effective at baseline — skipping)'); continue; }
      const baseUi = await uiProbe(tg.ui[0], tg.ui[1]);
      if (tg.extra) await tg.extra(false);
      // revoke
      setOverride(tenantId, 'org_admin', tg.cap, false);
      const gone = await waitForSessionCapability(ADM, tg.cap, false, { timeoutMs: 20000 });
      t.check(gone.ok, 'high', 'msq_org_admin', `override reaches the live session (${tg.cap} drops from /auth/me)`, 'dropped within 20 s', `still present after ${gone.ms} ms`, '', 'identity-service capability cache must be invalidated by the NOTIFY trigger.');
      if (gone.ok) {
        const denied = await tg.api();
        t.check(denied.status === 403, 'critical', 'msq_org_admin', `revoked ${tg.cap}: ${tg.label} API is DENIED`, '403', `HTTP ${denied.status}`, JSON.stringify(denied.body).slice(0, 160), 'requireCapability must read the live capability set, not a role name.');
        if (tg.extra) await tg.extra(true);
        const goneUi = await uiProbe(tg.ui[0], tg.ui[1]);
        logAction({ tool: TOOL, role: 'msq_org_admin', area: `/hrms${tg.ui[0].replace(target, ':userId')}`, action: `UI after revoking ${tg.cap}: ${tg.ui[2]}`, method: 'UI', endpoint: tg.ui[0], status: null, outcome: goneUi.shown ? 'visible' : 'hidden', verified: !goneUi.shown, expected: 'hidden', note: `landed on ${goneUi.path}` });
        if (!tg.uiOptional) t.check(baseUi.shown === true ? goneUi.shown === false : true, 'high', 'msq_org_admin', `revoked ${tg.cap}: UI hides ${tg.ui[2]}`, 'hidden / redirected', `still shown (landed on ${goneUi.path})`, '', 'Gate the control / page on can(session, CAPABILITY.…) — the same key the API checks.');
        else console.log(`  (UI: ${tg.ui[2]} shown=${goneUi.shown}, baseline shown=${baseUi.shown})`);
        if (!baseUi.shown && !tg.uiOptional) console.log(`  (UI baseline did not show ${tg.ui[2]} — UI half untestable for this login)`);
      }
      // restore
      restoreAll();
      const back = await waitForSessionCapability(ADM, tg.cap, true, { timeoutMs: 20000 });
      t.check(back.ok, 'high', 'msq_org_admin', `restoring the override returns ${tg.cap} to the live session`, 'back within 20 s', `missing after ${back.ms} ms`);
      const again = await tg.api();
      t.check(again.status === tg.ok, 'critical', 'msq_org_admin', `restored ${tg.cap}: ${tg.label} API works again`, `HTTP ${tg.ok}`, `HTTP ${again.status}`);
      const againUi = await uiProbe(tg.ui[0], tg.ui[1]);
      if (!tg.uiOptional && baseUi.shown) t.check(againUi.shown === true, 'high', 'msq_org_admin', `restored ${tg.cap}: UI shows ${tg.ui[2]} again`, 'visible', `hidden (landed on ${againUi.path})`);
      if (tg.extra) await tg.extra(false);
    }
    // tenant isolation of the overrides
    if (MGR) {
      const after = [...(await sessionCapabilities(MGR)).capabilities ?? []].sort().join(',');
      t.check(after === mgrCapsBefore, 'critical', 'fitness_manager', 'tenant-B overrides never changed tenant-A\'s capability set', 'identical', 'changed', after.slice(0, 120), 'Tenant-scoped rows must key on tenant_id.');
    }
  } finally {
    restoreAll();
    try { purge(); } catch { /* best effort */ }
    try { q(`DELETE FROM hr.employee_notes WHERE body LIKE ${lit(`${MARK}%`)}`); } catch { /* ignore */ }
    const left = Number(scalar(`SELECT count(*) FROM iam.role_capabilities rc JOIN iam.capabilities c ON c.id=rc.capability_id WHERE rc.tenant_id=${lit(tenantId)} AND c.key LIKE 'hr.%' AND rc.updated_at > now() - interval '30 minutes' AND NOT rc.is_granted`));
    console.log(`  tenant-B hr.* revoked overrides still present: ${left}`);
  }
}

t.summary();
process.exit(0);
