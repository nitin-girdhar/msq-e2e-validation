// Attendance / roster / punch-hub surface x EVERY role + the other tenant, graded by each login's
// LIVE capability (matrix.mjs runRoleMatrix: expectation = the session's own /auth/me capability
// list, never a rank), then capability on/off toggling with the UI checked both ways.
//
// PART A  role matrix, 17 endpoints (GET: real calls; writes: capability-gate probes whose body is
//         deliberately invalid AFTER the gate, so a role holding the capability gets a 4xx/2xx-noop
//         and a role without it gets 403 — nothing is ever written). Per response also:
//           * cross-tenant scan: no user id of another tenant may appear in any body
//           * org fence: roster / planner people all belong to the session's branch
// PART B  capability toggling (tenant-scoped override rows, journalled, ALWAYS restored in finally):
//           planner / swap request / roster view / swap approve / admin override / muster /
//           parent cascade (revoking hr.attendance.admin must take hr.attendance.admin.override with it)
//         for each: allowed -> revoke -> restore, measuring propagation time, API status AND the UI
//         (nav link, page redirect, buttons) at each step; plus console errors / 4xx-5xx / leaked text.
//
//   node suites/hr/hr-attendance-role-matrix.mjs            # both parts
//   node suites/hr/hr-attendance-role-matrix.mjs matrix     # Part A only
//   node suites/hr/hr-attendance-role-matrix.mjs toggle     # Part B only
import { ROLES, CROSS_TENANT, APPS, openAs } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { setOverride, restoreAll, loadJournal, resolvedCapabilities } from '../../capability.mjs';
import { leakOf } from '../../fixtures.mjs';
import { logAction } from '../../journal.mjs';
import { dbReachable, rows, scalar, lit } from '../../db.mjs';
import { req, me, bug, TOOL, findingCount, addDays, todayIso, mondayOf, sleep } from './_att-kit.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const only = process.argv[2] || '';
const HR = APPS['hr-web'];
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const ALL = [...ROLES, ...CROSS_TENANT.map((c) => c.stateKey)];
const month = todayIso().slice(0, 7);
const today = todayIso();
const farMonday = addDays(mondayOf(todayIso()), 70);

// ── tenant / branch ground truth ────────────────────────────────────────────
const userTenant = new Map(rows(`SELECT u.id::text, o.tenant_id::text FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id`, ['id', 't']).map((r) => [r.id, r.t]));
const userOrgs = new Map(rows(`SELECT ep.user_id::text, ep.org_id::text FROM hr.employee_profiles ep WHERE NOT ep.is_deleted`, ['id', 'o']).map((r) => [r.id, r.o]));
const meCache = new Map();
const meOf = async (a) => { if (!meCache.has(a.stateKey)) meCache.set(a.stateKey, await me(a)); return meCache.get(a.stateKey); };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// After a call: tenant-leak + org-fence scan of the body.
async function scan(a, role, endpoint, res, { orgFenced = false } = {}) {
  const m = await meOf(a);
  if (res.status >= 200 && res.status < 300 && role !== 'super_admin') {
    const s = JSON.stringify(res.body ?? '');
    const foreign = [...new Set(s.match(UUID) ?? [])].filter((id) => userTenant.has(id) && userTenant.get(id) !== m.tenant_id);
    if (foreign.length) bug('critical', role, endpoint, 'Cross-tenant leak in a response body', 'Only users of the caller\'s tenant appear', `${foreign.length} user id(s) of another tenant in the body, e.g. ${foreign[0]}`, s.slice(0, 200), 'Fence every query by org/tenant in the service transaction (withServiceTx paths must filter by ctx.org_id).');
    if (orgFenced) {
      const people = res.body?.data?.people ?? [];
      const strays = people.filter((p) => userOrgs.get(p.user_id) && userOrgs.get(p.user_id) !== m.org_id);
      if (strays.length) bug('critical', role, endpoint, 'Roster shows people of another branch', 'Only the session branch', `${strays.length} of ${people.length} people belong to another branch`, strays[0].user_id, 'ep.org_id = ctx.org_id in getRoster / getWeek.');
    }
  }
  const leak = leakOf(res.body);
  if (leak) bug('medium', role, endpoint, 'Error body leaks backend internals', 'Message only', leak, JSON.stringify(res.body).slice(0, 200), 'Return the AppError message only.');
  return res;
}
// Writes: normalise "got past the capability gate" to 200 so runRoleMatrix can grade by capability.
const gateOf = (r) => (r.status === 401 || r.status === 403 ? r : r.status >= 500 ? r : { ...r, status: 200, raw: r.status });

async function partA() {
  console.log('PART A — role matrix (live capability), 17 endpoints x', ALL.length, 'logins');
  const wk = farMonday;
  const E = [
    { action: 'open the team roster', endpoint: 'GET /hr/attendance/roster', cap: 'hr.attendance.roster.view', area: 'My team', tab: 'Roster', act: (a, r) => req(a, 'GET', '/hr/attendance/roster').then((x) => scan(a, r, 'GET /hr/attendance/roster', x, { orgFenced: true })) },
    { action: 'list swaps I am part of', endpoint: 'GET /hr/attendance/swaps', cap: 'hr.attendance.view', area: 'My team', tab: 'Swap desk', act: (a, r) => req(a, 'GET', '/hr/attendance/swaps').then((x) => scan(a, r, 'GET /hr/attendance/swaps', x)) },
    { action: 'open the swap approval queue', endpoint: 'GET /hr/attendance/swaps/queue', cap: 'hr.attendance.swap.approve', area: 'My team', tab: 'Swaps awaiting approval', act: (a, r) => req(a, 'GET', '/hr/attendance/swaps/queue').then((x) => scan(a, r, 'GET /hr/attendance/swaps/queue', x)) },
    { action: 'request a swap (gate probe: unknown peer)', endpoint: 'POST /hr/attendance/swaps', cap: 'hr.attendance.swap.request', area: 'My team', tab: 'Swap desk', act: (a) => req(a, 'POST', '/hr/attendance/swaps', { peer_id: UNKNOWN, swap_date: addDays(today, 40), reason: 'E2E-gate' }).then(gateOf) },
    { action: 'answer a swap (gate probe: unknown id)', endpoint: 'POST /hr/attendance/swaps/:id/respond', cap: 'hr.attendance.swap.request', area: 'My team', tab: 'Swap desk', act: (a) => req(a, 'POST', `/hr/attendance/swaps/${UNKNOWN}/respond`, { accept: false }).then(gateOf) },
    { action: 'withdraw a swap (gate probe: unknown id)', endpoint: 'POST /hr/attendance/swaps/:id/cancel', cap: 'hr.attendance.swap.request', area: 'My team', tab: 'Swap desk', act: (a) => req(a, 'POST', `/hr/attendance/swaps/${UNKNOWN}/cancel`).then(gateOf) },
    { action: 'approve a swap (gate probe: unknown id)', endpoint: 'POST /hr/attendance/swaps/:id/approve', cap: 'hr.attendance.swap.approve', area: 'My team', tab: 'Swaps awaiting approval', act: (a) => req(a, 'POST', `/hr/attendance/swaps/${UNKNOWN}/approve`, {}).then(gateOf) },
    { action: 'reject a swap (gate probe: unknown id)', endpoint: 'POST /hr/attendance/swaps/:id/reject', cap: 'hr.attendance.swap.approve', area: 'My team', tab: 'Swaps awaiting approval', act: (a) => req(a, 'POST', `/hr/attendance/swaps/${UNKNOWN}/reject`, { comment: 'E2E-gate' }).then(gateOf) },
    { action: 'open the roster planner week', endpoint: 'GET /hr/attendance/planner/week', cap: 'hr.attendance.roster.manage', area: 'Roster planner', tab: 'Week', act: (a, r) => req(a, 'GET', '/hr/attendance/planner/week', undefined, { from: today }).then((x) => scan(a, r, 'GET /hr/attendance/planner/week', x, { orgFenced: true })) },
    { action: 'edit planner cells (gate probe: empty people list)', endpoint: 'PUT /hr/attendance/planner/cells', cap: 'hr.attendance.roster.manage', area: 'Roster planner', tab: 'Cells', act: (a) => req(a, 'PUT', '/hr/attendance/planner/cells', { user_ids: [], from: addDays(today, 40), to: addDays(today, 40), shift_id: null }).then(gateOf) },
    { action: 'set a shift requirement (gate probe: unknown shift)', endpoint: 'PUT /hr/attendance/planner/requirements', cap: 'hr.attendance.roster.manage', area: 'Roster planner', tab: 'Requirements', act: (a) => req(a, 'PUT', '/hr/attendance/planner/requirements', { shift_id: UNKNOWN, required_headcount: 1 }).then(gateOf) },
    { action: 'publish a roster (gate probe: a non-Monday)', endpoint: 'POST /hr/attendance/planner/publish', cap: 'hr.attendance.roster.manage', area: 'Roster planner', tab: 'Publish', act: (a) => req(a, 'POST', '/hr/attendance/planner/publish', { week_start: addDays(wk, 2) }).then(gateOf) },
    { action: 'bulk reallocate (gate probe: same shift both sides)', endpoint: 'POST /hr/attendance/planner/reallocate', cap: 'hr.attendance.roster.manage', area: 'Roster planner', tab: 'Bulk reallocate', act: (a) => req(a, 'POST', '/hr/attendance/planner/reallocate', { from_shift_id: UNKNOWN, to_shift_id: UNKNOWN, from: addDays(today, 40), to: addDays(today, 41) }).then(gateOf) },
    { action: 'add a manual punch (gate probe: time in the future)', endpoint: 'POST /hr/attendance/admin/manual-punch', cap: 'hr.attendance.admin.override', area: 'Attendance > Team', tab: 'Day view', act: (a) => req(a, 'POST', '/hr/attendance/admin/manual-punch', { user_id: UNKNOWN, event_type: 'check_in', occurred_at: new Date(Date.now() + 864e5).toISOString(), reason: 'E2E-gate' }).then(gateOf) },
    { action: 'bulk-regularize (gate probe: unknown person)', endpoint: 'POST /hr/attendance/admin/bulk-regularize', cap: 'hr.attendance.admin.override', area: 'Attendance > Team', tab: 'Day view', act: (a) => req(a, 'POST', '/hr/attendance/admin/bulk-regularize', { user_ids: [UNKNOWN], work_date: today, status_name: 'present', reason: 'E2E-gate' }).then(gateOf) },
    { action: 'nudge (gate probe: unknown person)', endpoint: 'POST /hr/attendance/admin/nudge', cap: 'hr.attendance.admin.override', area: 'Attendance > Team', tab: 'Day view', act: (a) => req(a, 'POST', '/hr/attendance/admin/nudge', { user_ids: [UNKNOWN], work_date: today }).then(gateOf) },
    { action: 'read my punch log', endpoint: 'GET /hr/attendance/me/punches', cap: 'hr.attendance.view', area: 'Attendance', tab: 'Biometric & geofence logs', act: (a, r) => req(a, 'GET', '/hr/attendance/me/punches', undefined, { month }).then((x) => scan(a, r, 'GET /hr/attendance/me/punches', x)) },
    { action: 'read my nudges', endpoint: 'GET /hr/attendance/me/nudges', cap: 'hr.attendance.view', area: 'Attendance', tab: 'Dashboard', act: (a, r) => req(a, 'GET', '/hr/attendance/me/nudges').then((x) => scan(a, r, 'GET /hr/attendance/me/nudges', x)) },
    { action: 'open the combined attendance (muster) report', endpoint: 'GET /hr/attendance/reports/muster', cap: 'hr.reports.attendance.view', area: 'Reports', tab: 'Combined attendance', act: (a, r) => req(a, 'GET', '/hr/attendance/reports/muster', undefined, { month, format: 'json' }).then((x) => scan(a, r, 'GET /hr/attendance/reports/muster', x)) },
    { action: 'open the month-end readiness checklist', endpoint: 'GET /hr/payroll/admin/readiness', cap: 'hr.reports.payroll.manage', area: 'Reports', tab: 'Month-end sign-off', act: (a, r) => req(a, 'GET', '/hr/payroll/admin/readiness', undefined, { month }).then((x) => scan(a, r, 'GET /hr/payroll/admin/readiness', x)) },
  ];
  const summary = [];
  for (const e of E) {
    console.log(`\n— ${e.action} [${e.cap}] —`);
    const res = await runRoleMatrix({
      tool: TOOL, action: e.action, endpoint: e.endpoint, area: e.area, tab: e.tab,
      capability: e.cap, roles: ALL, act: e.act,
    });
    summary.push({ ep: e.endpoint, over: res.filter((r) => r.expected === false && r.succeeded).map((r) => r.role), under: res.filter((r) => r.expected === true && !r.succeeded).map((r) => r.role), five: res.filter((r) => r.status >= 500).map((r) => r.role) });
  }
  console.log('\nPART A summary (endpoint | over-permitted | under-permitted | 5xx)');
  for (const s of summary) console.log(`  ${s.ep.padEnd(48)} | ${s.over.join(',') || '-'} | ${s.under.join(',') || '-'} | ${s.five.join(',') || '-'}`);
}

// ── Part B: capability toggling ─────────────────────────────────────────────
const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1200); };
const pathOf = (page) => new URL(page.url()).pathname;
async function waitUntil(fn, ms = 25000, step = 700) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return Date.now() - t0; } catch {} await sleep(step); }
  return -1;
}
const navLink = (page, name) => page.getByRole('link', { name }).count();

async function partB() {
  console.log('\nPART B — capability toggling (API + UI), tenant-scoped overrides, always restored');
  const pend = loadJournal();
  if (pend) { console.log(`  restoring ${pend} override(s) left by a previous run`); restoreAll(); }
  const tenantId = scalar(`SELECT t.id FROM entity.tenants t JOIN entity.organizations o ON o.tenant_id=t.id WHERE o.name='Gurugram - Sector 69' LIMIT 1`);
  const denied = (r) => r.status === 401 || r.status === 403;

  const CASES = [
    {
      name: 'roster planner', role: 'fitness_manager', roleName: 'fitness_manager', cap: 'hr.attendance.roster.manage',
      api: (a) => req(a, 'GET', '/hr/attendance/planner/week', undefined, { from: today }),
      ui: async (page) => {
        await page.goto(`${HR}/planner`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const pageOk = pathOf(page).endsWith('/planner') && (await page.getByRole('button', { name: /publish roster/i }).count()) > 0;
        await page.goto(`${HR}/dashboard`, { waitUntil: 'domcontentloaded' }); await settle(page);
        return [['planner page opens (Publish roster visible)', pageOk], ['"Roster planner" nav link', (await navLink(page, /^roster planner$/i)) > 0]];
      },
    },
    {
      name: 'swap request', role: 'fitness_trainer', roleName: 'fitness_trainer', cap: 'hr.attendance.swap.request',
      api: (a) => req(a, 'POST', '/hr/attendance/swaps', { peer_id: UNKNOWN, swap_date: addDays(today, 40), reason: 'E2E-gate' }).then(gateOf),
      ui: async (page) => {
        await page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const here = pathOf(page).endsWith('/team');
        return [['"Request swap" button', here && (await page.getByRole('button', { name: /^request swap$/i }).count()) > 0], ['"+ New swap ticket" button', here && (await page.getByRole('button', { name: /new swap ticket/i }).count()) > 0]];
      },
    },
    {
      name: 'roster view', role: 'fitness_trainer', roleName: 'fitness_trainer', cap: 'hr.attendance.roster.view',
      api: (a) => req(a, 'GET', '/hr/attendance/roster'),
      ui: async (page) => {
        await page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const open = pathOf(page).endsWith('/team') && (await page.getByText(/my team/i).count()) > 0;
        await page.goto(`${HR}/dashboard`, { waitUntil: 'domcontentloaded' }); await settle(page);
        return [['/team page opens', open], ['"My team" nav link', (await navLink(page, /^my team$/i)) > 0]];
      },
    },
    {
      name: 'swap approve', role: 'fitness_manager', roleName: 'fitness_manager', cap: 'hr.attendance.swap.approve',
      api: (a) => req(a, 'GET', '/hr/attendance/swaps/queue'),
      ui: async (page) => {
        await page.goto(`${HR}/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
        return [['"Swaps awaiting approval" section', pathOf(page).endsWith('/team') && (await page.getByText(/swaps awaiting approval/i).count()) > 0]];
      },
    },
    {
      name: 'attendance admin override', role: 'fitness_manager', roleName: 'fitness_manager', cap: 'hr.attendance.admin.override',
      api: (a) => req(a, 'POST', '/hr/attendance/admin/nudge', { user_ids: [UNKNOWN], work_date: today }).then(gateOf),
      ui: async (page) => {
        await page.goto(`${HR}/attendance/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const here = pathOf(page).endsWith('/attendance/team');
        return [['"Bulk regularize" toolbar button', here && (await page.getByRole('button', { name: /bulk regularize/i }).count()) > 0], ['"Add a punch" row action', here && (await page.getByRole('button', { name: /add a punch/i }).count()) > 0]];
      },
    },
    {
      name: 'attendance reports (muster)', role: 'fitness_manager', roleName: 'fitness_manager', cap: 'hr.reports.attendance.view',
      api: (a) => req(a, 'GET', '/hr/attendance/reports/muster', undefined, { month, format: 'json' }),
      ui: async (page) => {
        await page.goto(`${HR}/reports`, { waitUntil: 'domcontentloaded' }); await settle(page);
        const body = await page.locator('body').innerText().catch(() => '');
        const here = pathOf(page).endsWith('/reports');
        const errorShown = /permission|forbidden|not allowed|failed to/i.test(body);
        return [['"Combined attendance" renders without an error banner', here && !errorShown]];
      },
    },
    {
      name: 'PARENT cascade: hr.attendance.admin', role: 'fitness_manager', roleName: 'fitness_manager', cap: 'hr.attendance.admin',
      // Denying the parent must take its subtree (admin.override) with it, but not a sibling (roster.manage).
      api: (a) => req(a, 'POST', '/hr/attendance/admin/nudge', { user_ids: [UNKNOWN], work_date: today }).then(gateOf),
      sibling: (a) => req(a, 'GET', '/hr/attendance/planner/week', undefined, { from: today }),
      ui: async (page) => {
        await page.goto(`${HR}/attendance/team`, { waitUntil: 'domcontentloaded' }); await settle(page);
        return [['"Bulk regularize" toolbar button', pathOf(page).endsWith('/attendance/team') && (await page.getByRole('button', { name: /bulk regularize/i }).count()) > 0]];
      },
    },
  ];

  for (const c of CASES) {
    console.log(`\n— ${c.name}: ${c.role} / ${c.cap} —`);
    let a, ui;
    const log = (phase, what, status, outcome, verified, expected, note) => logAction({ tool: TOOL, role: c.role, area: `Capability toggle: ${c.name}`, tab: phase, action: what, method: 'UI/API', endpoint: c.cap, status, outcome, verified, expected, note });
    try {
      a = await actor(c.role);
      const phase = async (label, wantAllowed) => {
        const r = await c.api(a);
        const gotAllowed = !denied(r);
        let sib = null;
        if (c.sibling) sib = await c.sibling(a);
        ui = await openAs(c.role);
        let checks = [];
        try { checks = await c.ui(ui.page); } catch (e) { checks = [[`UI probe failed: ${String(e.message).slice(0, 80)}`, null]]; }
        const body = await ui.page.locator('body').innerText().catch(() => '');
        const leak = leakOf(body);
        const fiveXX = ui.log.badRequests.filter((x) => /^5\d\d /.test(x));
        const errs = ui.log.pageErrors;
        await ui.browser.close(); ui = null;
        console.log(`  ${label.padEnd(8)} API ${r.status} ${gotAllowed ? 'allowed' : 'DENIED'} | UI ${checks.map(([n, v]) => `${n}=${v === null ? '?' : v ? 'shown' : 'hidden'}`).join('; ')}${sib ? ` | sibling ${sib.status}` : ''}`);
        log(label, 'API gate', r.status, gotAllowed ? 'allowed' : 'denied', gotAllowed === wantAllowed, wantAllowed ? 'allowed' : 'denied', '');
        for (const [n, v] of checks) log(label, `UI: ${n}`, null, v === null ? 'unknown' : v ? 'visible' : 'hidden', v === null ? null : v === wantAllowed, wantAllowed ? 'visible' : 'hidden', '');
        if (r.status >= 500) bug('high', c.role, c.cap, `${label}: API 5xx`, 'clean 2xx/4xx', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'See service log.');
        if (fiveXX.length) bug('high', c.role, `UI ${c.name}`, `${label}: the page triggered a 5xx`, 'no server errors from UI', fiveXX.slice(0, 3).join(' | '), '', 'Fix the failing endpoint or guard the call.');
        if (errs.length) bug('medium', c.role, `UI ${c.name}`, `${label}: uncaught page error`, 'no page errors', errs[0], '', 'Guard the render path.');
        if (leak) bug('medium', c.role, `UI ${c.name}`, `${label}: backend internals visible on the page`, 'friendly message only', leak, '', 'Map errors to user-facing text.');
        return { r, checks, gotAllowed, sib, forbidden: ui?.log?.badRequests ?? [] };
      };

      const b = await phase('before', true);
      if (!b.gotAllowed || b.checks.some(([, v]) => v === false)) { console.log('  (precondition not met for this role/tenant — toggle skipped)'); bug('info', c.role, c.cap, `${c.name}: precondition`, 'role holds the capability and the UI shows the control', `API ${b.r.status}; UI ${JSON.stringify(b.checks)}`, '', 'Tenant data/config: the toggle cannot be graded.'); continue; }

      setOverride(tenantId, c.roleName, c.cap, false);
      const msDeny = await waitUntil(async () => denied(await c.api(a)));
      console.log(`  revoked -> API denies after ${msDeny < 0 ? 'NEVER (25 s)' : `${msDeny} ms`}`);
      if (msDeny < 0) bug('high', c.role, c.cap, `${c.name}: revoked capability still honoured by the API`, '403 within the cache-invalidation window (~15 s)', 'Still allowed after 25 s', '', 'The NOTIFY trigger / session capability cache is not invalidating, or the service reads a stale JWT capability list.');
      const rv = await phase('revoked', false);
      if (rv.gotAllowed) bug('critical', c.role, c.cap, `${c.name}: API still allows after the capability was revoked`, '403', `HTTP ${rv.r.status}`, JSON.stringify(rv.r.body).slice(0, 200), 'requireCapability must read the live capability list.');
      for (const [n, v] of rv.checks) if (v === true) bug('medium', c.role, `UI ${c.name}`, `${n} still shown after the capability was revoked`, 'Control/page/nav hidden for a role without the capability', 'Still visible (API now answers 403: a dead end)', `capability ${c.cap}`, 'Gate the control on the same capability the service checks (can(actor, CAPABILITY.…)); the page guard must read the live session.');
      if (c.sibling) {
        const sibOk = rv.sib && !denied(rv.sib);
        console.log(`  sibling hr.attendance.roster.manage after parent denial -> ${rv.sib?.status} (${sibOk ? 'unaffected, as expected' : 'ALSO DENIED'})`);
        if (!sibOk) bug('high', c.role, c.cap, 'Parent denial over-reaches into a sibling capability', 'only the denied subtree is lost', `roster.manage -> ${rv.sib?.status}`, '', 'iam.fn_role_capability_matrix parent cascade should apply to descendants only.');
      }

      restoreAll();
      const msBack = await waitUntil(async () => !denied(await c.api(a)));
      console.log(`  restored -> API allows again after ${msBack < 0 ? 'NEVER (25 s)' : `${msBack} ms`}`);
      if (msBack < 0) bug('high', c.role, c.cap, `${c.name}: restoring the capability does not re-enable the API`, 'allowed again within ~15 s', 'still denied', '', 'Capability cache invalidation on DELETE of the override row.');
      const af = await phase('restored', true);
      for (const [n, v] of af.checks) if (v === false) bug('high', c.role, `UI ${c.name}`, `${n} did not come back after the capability was restored`, 'visible again', 'still hidden', '', 'The UI reads a stale session; check the server-side session refresh.');
      const eff = resolvedCapabilities(tenantId, c.roleName).get(c.cap);
      console.log(`  resolver after restore: ${c.cap} = ${eff}`);
    } catch (e) {
      console.log(`  harness error: ${String(e.message).slice(0, 160)}`);
      bug('info', c.role, c.cap, `${c.name}: toggle run`, 'completes', `harness error: ${String(e.message).slice(0, 140)}`, '', 'Harness — inspect the selector.');
    } finally {
      restoreAll();
      try { await ui?.browser.close(); } catch {}
      try { await a?.close(); } catch {}
    }
  }
  const stray = Number(scalar(`SELECT COUNT(*) FROM iam.role_capabilities rc JOIN iam.capabilities c ON c.id=rc.capability_id WHERE rc.tenant_id=${lit(tenantId)} AND c.key IN ('hr.attendance.roster.manage','hr.attendance.swap.request','hr.attendance.roster.view','hr.attendance.swap.approve','hr.attendance.admin.override','hr.reports.attendance.view','hr.attendance.admin') AND rc.is_granted=false`));
  console.log(`\nPART B cleanup: tenant override rows still denying one of the toggled capabilities: ${stray}`);
}

try {
  if (!only || only === 'matrix') await partA();
  if (!only || only === 'toggle') await partB();
} finally {
  restoreAll();
}
console.log(`\nhr-attendance-role-matrix: ${findingCount()} finding(s).`);
