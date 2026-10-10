// Capability keys added or retired by the 2026-10-09 catalogue regeneration (cycle 9).
//
// Each NEW key is toggled OFF and ON for a real login through a tenant-scoped override
// (capability.mjs, journalled and restored), and the route it guards is driven both ways:
//
//   K1 hr.employees.statutory.view      GET /hr/employees/:id/statutory      off -> 403, on -> 200
//      (+ hr.employees.statutory.manage) view without manage -> masked only (values null)
//   K2 hr.leave.admin.tenant_wide       PUT /hr/leave/settings scope=tenant  off -> 403, on -> 2xx
//      (the write re-sends the CURRENT tenant value, so a pass changes nothing)
//   K3 hr.attendance.admin.tenant_wide  PUT /hr/attendance/rules/admin scope=tenant, key OFF -> 403
//      (negative only: a permitted call would write defaults; the tenant row is snapshotted and
//      restored if the guard ever lets it through)
//   K4 lms.leads.assign.bulk            POST /assignments/bulk (empty body)  off -> 403, on -> 400/422
//   K5 admin.api_tokens.tenant_wide     POST /api-clients scope_all_orgs     off -> pinned to own branch
//   K6 lms.leads.export                 Export button on the Leads grid      off -> hidden, on -> shown
//
// Plus two catalogue checks:
//   K7 retired keys (hr.leave.reject, lms.dashboard, *.edit.own …) are not in iam.capabilities
//      and no session holds them
//   K8 a login holding only hr.leave.admin.* / hr.attendance.admin.* can open admin-web
//      (canOpenAdminConsole was widened to agree with admin-web's layout guard)
//
//   node suites/capability/capability-keys-c9.mjs
import { APPS, GATEWAY, openState, visit } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { sessionCaps } from '../../matrix.mjs';
import { dbReachable, q, scalar, rows, lit } from '../../db.mjs';
import { req, reporter, isOk, sleep } from '../../kit.mjs';
import { setOverride, restoreAll, tenantIdForOrg, waitForSessionCapability } from '../../capability.mjs';
import { cfg } from '../../lib.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('capability', 'Capability keys (cycle 9 catalogue)');
const { fail, log } = rep;
const MARK = `E2Ec9${String(Date.now()).slice(-6)}`;
const roleOf = (key) => cfg.roles.find((r) => r.role === key) ?? (cfg.crossTenantActors ?? []).find((r) => r.stateKey === key);
const tenantOf = (key) => tenantIdForOrg(roleOf(key)?.org);
const roleNameOf = (key) => roleOf(key)?.role ?? key;
const open = (k) => actor(k).catch(() => null);

// Toggle a key for the actor's role, then wait until /auth/me agrees (NOTIFY-driven cache).
async function toggle(a, key, capKey, granted) {
  setOverride(tenantOf(key), roleNameOf(key), capKey, granted);
  const r = await waitForSessionCapability(a, capKey, granted).catch(() => null);
  return r;
}

const cleanup = [];
try {
  // ── K1 statutory view / manage ───────────────────────────────────────────
  {
    const key = 'hr_admin';
    const a = await open(key);
    // An employee of the actor's SESSION branch: employeeInOrg() 404s anyone else, and hr_admin is
    // homed in a branch of its own (fitclass-tenant-config-traps).
    const me = a ? (await req(a, 'GET', `${GATEWAY}/auth/me`)).body?.data?.user : null;
    const target = me?.org_id ? scalar(`SELECT p.user_id FROM hr.employee_profiles p JOIN iam.users u ON u.id=p.user_id WHERE p.org_id=${lit(me.org_id)} AND p.user_id<>${lit(me.id)} AND NOT p.is_deleted AND u.is_active AND NOT u.is_deleted LIMIT 1`) : null;
    if (a && !target) log({ role: key, action: 'statutory skipped (no colleague in the session branch)', status: null, outcome: 'visible' });
    if (a && target) {
      try {
        const url = `${GATEWAY}/hr/employees/${target}/statutory`;
        const caps = await sessionCaps(a);
        if (!caps?.has('hr.employees.profile360.view')) {
          log({ role: key, action: 'statutory view skipped (no hr.employees.profile360.view)', endpoint: 'GET /hr/employees/:id/statutory', status: null, outcome: 'visible' });
        } else {
          await toggle(a, key, 'hr.employees.statutory.view', false);
          let r = await req(a, 'GET', url);
          log({ role: key, area: 'Employee 360', tab: 'Statutory', action: 'view statutory with statutory.view OFF', endpoint: 'GET /hr/employees/:id/statutory', status: r.status, verified: r.status === 403, expected: '403' });
          if (isOk(r.status)) fail('high', key, 'Statutory details readable with hr.employees.statutory.view revoked', '403', `HTTP ${r.status}`, r.text.slice(0, 200), 'statutory.router.ts GET /employees/:userId/statutory must keep viewStatutory in its preHandler.');
          else if (r.status >= 500) fail('high', key, 'Statutory view (cap off) crashed', '403', `HTTP ${r.status}`, r.text.slice(0, 200), '');

          await toggle(a, key, 'hr.employees.statutory.view', true);
          await toggle(a, key, 'hr.employees.statutory.manage', false);
          r = await req(a, 'GET', url);
          const masked = r.body?.data?.masked !== undefined && r.body?.data?.values === null;
          log({ role: key, area: 'Employee 360', tab: 'Statutory', action: 'view statutory with view ON, manage OFF', endpoint: 'GET /hr/employees/:id/statutory', status: r.status, verified: isOk(r.status) && masked, expected: '200 masked, values null' });
          if (!isOk(r.status)) fail('medium', key, 'Statutory view refused with hr.employees.statutory.view granted', '200 (masked)', `HTTP ${r.status}`, r.text.slice(0, 200), 'The 360 page and statutory.router disagree.');
          else if (!masked) fail('critical', key, 'Unmasked statutory numbers returned without hr.employees.statutory.manage', 'values: null', JSON.stringify(r.body?.data ?? {}).slice(0, 200), 'statutory.router: `full = can(auth, STATUTORY_MANAGE)` must decide values.');

          await toggle(a, key, 'hr.employees.statutory.manage', true);
          r = await req(a, 'GET', url);
          log({ role: key, area: 'Employee 360', tab: 'Statutory', action: 'view statutory with view+manage ON', endpoint: 'GET /hr/employees/:id/statutory', status: r.status, verified: isOk(r.status), expected: '200 with values' });
          if (!isOk(r.status)) fail('medium', key, 'Statutory view refused with view+manage granted', '200', `HTTP ${r.status}`, r.text.slice(0, 200), '');
        }
      } finally { restoreAll(); await a.close(); }
    }
  }

  // ── K2 leave tenant_wide (positive + negative, value-preserving) ─────────
  for (const key of ['hr_admin', 'tenant_admin']) {
    const a = await open(key); if (!a) continue;
    try {
      const caps = await sessionCaps(a);
      if (!caps?.has('hr.leave.admin.cycle.manage')) { log({ role: key, action: 'leave settings skipped (no hr.leave.admin.cycle.manage)', endpoint: 'PUT /hr/leave/settings', status: null, outcome: 'visible' }); continue; }
      const tid = tenantOf(key);
      const cur = scalar(`SELECT leave_cycle_start_month FROM hr.hr_settings WHERE tenant_id=${lit(tid)} AND org_id IS NULL LIMIT 1`) || '4';
      const body = { leave_cycle_start_month: Number(cur), scope: 'tenant' };
      for (const on of [false, true]) {
        await toggle(a, key, 'hr.leave.admin.tenant_wide', on);
        const r = await req(a, 'PUT', `${GATEWAY}/hr/leave/settings`, { data: body });
        const ok = on ? isOk(r.status) : r.status === 403;
        log({ role: key, area: 'Leave Admin', tab: 'Cycle / Settings', action: `write tenant-wide leave year (tenant_wide ${on ? 'ON' : 'OFF'})`, method: 'PUT', endpoint: '/hr/leave/settings', status: r.status, verified: ok, expected: on ? '2xx' : '403' });
        if (!ok) fail(on ? 'medium' : 'high', key, `Tenant-wide leave settings with hr.leave.admin.tenant_wide ${on ? 'granted' : 'revoked'}`, on ? '2xx' : '403', `HTTP ${r.status}`, r.text.slice(0, 200), on ? 'canSetTenantLeaveDefaults should read the capability, not a role name.' : 'leave.service updateSettings must refuse scope=tenant without hr.leave.admin.tenant_wide.');
      }
    } finally { restoreAll(); await a.close(); }
  }

  // ── K3 attendance tenant_wide (negative, snapshot-guarded) ───────────────
  {
    const key = 'hr_admin';
    const a = await open(key);
    if (a) {
      try {
        const caps = await sessionCaps(a);
        if (caps?.has('hr.attendance.admin.rules.update')) {
          const tid = tenantOf(key);
          const snap = scalar(`SELECT row_to_json(ar)::text FROM hr.attendance_rules ar WHERE tenant_id=${lit(tid)} AND org_id IS NULL AND NOT is_deleted LIMIT 1`);
          await toggle(a, key, 'hr.attendance.admin.tenant_wide', false);
          const r = await req(a, 'PUT', `${GATEWAY}/hr/attendance/rules/admin`, { data: { scope: 'tenant' } });
          const after = scalar(`SELECT row_to_json(ar)::text FROM hr.attendance_rules ar WHERE tenant_id=${lit(tid)} AND org_id IS NULL AND NOT is_deleted LIMIT 1`);
          const changed = (snap ?? '') !== (after ?? '');
          log({ role: key, area: 'Attendance Admin', tab: 'Rules', action: 'write tenant-wide attendance rules (tenant_wide OFF)', method: 'PUT', endpoint: '/hr/attendance/rules/admin', status: r.status, verified: r.status === 403 && !changed, expected: '403, tenant row unchanged' });
          if (isOk(r.status) || changed) {
            fail('critical', key, 'Tenant-wide attendance rules written without hr.attendance.admin.tenant_wide', '403 and no change', `HTTP ${r.status}, changed=${changed}`, r.text.slice(0, 200), 'attendance.service updateRules: canSetTenantAttendanceDefaults(ctx) must gate scope=tenant.');
            if (snap) {
              const cols = rows(`SELECT column_name FROM information_schema.columns WHERE table_schema='hr' AND table_name='attendance_rules' AND column_name NOT IN ('id')`, ['c']).map((x) => x.c);
              q(`UPDATE hr.attendance_rules t SET (${cols.join(',')}) = (SELECT ${cols.map((c) => 's.' + c).join(',')} FROM json_populate_record(NULL::hr.attendance_rules, ${lit(snap)}::json) s) WHERE t.id = (${lit(snap)}::json->>'id')::uuid`);
            }
          } else if (r.status >= 500) fail('high', key, 'Tenant-wide attendance rules (cap off) crashed', '403', `HTTP ${r.status}`, r.text.slice(0, 200), '');
        } else log({ role: key, action: 'attendance rules skipped (no rules.update)', endpoint: 'PUT /hr/attendance/rules/admin', status: null, outcome: 'visible' });
      } finally { restoreAll(); await a.close(); }
    }
  }

  // ── K4 bulk assign ───────────────────────────────────────────────────────
  for (const key of ['org_admin', 'org_manager']) {
    const a = await open(key); if (!a) continue;
    try {
      for (const on of [false, true]) {
        await toggle(a, key, 'lms.leads.assign.bulk', on);
        const r = await req(a, 'POST', `${GATEWAY}/assignments/bulk`, { data: { lead_ids: [], assigned_to: null } });
        const ok = on ? (r.status === 400 || r.status === 422) : r.status === 403;
        log({ role: key, area: 'Bulk Assign', action: `bulk assign, empty body (assign.bulk ${on ? 'ON' : 'OFF'})`, method: 'POST', endpoint: '/assignments/bulk', status: r.status, verified: ok, expected: on ? '400/422 (validation)' : '403' });
        if (!ok) fail(on ? 'medium' : 'high', key, `Bulk assign gate with lms.leads.assign.bulk ${on ? 'granted' : 'revoked'}`, on ? '400/422' : '403', `HTTP ${r.status}`, r.text.slice(0, 200), 'assignments.router.ts POST /assignments/bulk requireCapability(LMS_LEADS_ASSIGN_BULK) must run before validation.');
      }
    } finally { restoreAll(); await a.close(); }
  }

  // ── K5 api-clients tenant_wide ───────────────────────────────────────────
  // tenant_admin holds admin.api_tokens.manage (org_admin does not, by tenant config); revoking its
  // tenant_wide key must pin an all-branch request to its own branch.
  for (const key of ['tenant_admin', 'msq_tenant_admin']) {
    const a = await open(key);
    if (a) {
      try {
        const caps = await sessionCaps(a);
        if (!caps?.has('admin.api_tokens.manage')) {
          log({ role: key, action: 'api-client create skipped (no admin.api_tokens.manage)', endpoint: 'POST /api-clients', status: null, outcome: 'visible' });
        } else {
          // The session branch, not roles.json's: tenant_admin is homed in Head Office (fitclass-tenant-config-traps).
          const home = (await req(a, 'GET', `${GATEWAY}/auth/me`)).body?.data?.user?.org_id;
          for (const on of [false, true]) {
            await toggle(a, key, 'admin.api_tokens.tenant_wide', on);
            const r = await req(a, 'POST', `${GATEWAY}/api-clients`, { data: { name: `${MARK} ${on ? 'wide' : 'branch'}`, scopes: ['lead-report:read'], scope_all_orgs: true } });
            const id = r.body?.data?.id ?? r.body?.data?.client?.id;
            if (id) cleanup.push(`DELETE FROM iam.api_client_orgs WHERE api_client_id=${lit(id)}`, `DELETE FROM iam.api_clients WHERE id=${lit(id)}`);
            if (!isOk(r.status) || !id) {
              log({ role: key, area: 'API Tokens', action: `create all-branch token (tenant_wide ${on ? 'ON' : 'OFF'})`, method: 'POST', endpoint: '/api-clients', status: r.status, verified: null, expected: '2xx' });
              if (r.status >= 500) fail('high', key, 'API token create crashed', '2xx/4xx', `HTTP ${r.status}`, r.text.slice(0, 200), '');
              continue;
            }
            const all = scalar(`SELECT scope_all_orgs FROM iam.api_clients WHERE id=${lit(id)}`) === 't';
            const orgs = rows(`SELECT org_id FROM iam.api_client_orgs WHERE api_client_id=${lit(id)}`, ['o']).map((x) => x.o);
            const pinned = !all && orgs.length === 1 && orgs[0] === home;
            const ok = on ? true : pinned;
            log({ role: key, area: 'API Tokens', action: `create all-branch token (tenant_wide ${on ? 'ON' : 'OFF'}) -> all=${all} orgs=${orgs.length}`, method: 'POST', endpoint: '/api-clients', status: r.status, verified: ok, expected: on ? 'as requested' : 'pinned to own branch' });
            if (!ok) fail('critical', key, 'Branch-scoped admin minted an all-branch API token', 'scope_all_orgs=false, org_ids=[home]', `scope_all_orgs=${all}, orgs=${orgs.length}`, '', 'api-clients.controller isBranchScoped/resolveBranchScope must override client-supplied scope.');
          }
        }
      } finally { restoreAll(); await a.close(); }
    }
  }

  // ── K6 lms.leads.export (UI gate) ────────────────────────────────────────
  {
    const key = 'org_admin';
    const a = await open(key);
    const { browser, page } = await openState(key);
    try {
      for (const on of [false, true]) {
        await toggle(a, key, 'lms.leads.export', on);
        await visit(page, `${APPS['lms-web']}/dashboard`);
        await page.waitForTimeout(2500);
        const n = await page.getByRole('button', { name: /export|download/i }).count().catch(() => 0);
        const ok = on ? n > 0 : n === 0;
        log({ role: key, area: 'Leads', tab: 'Grid', action: `Export button visible=${n > 0} (leads.export ${on ? 'ON' : 'OFF'})`, status: null, outcome: 'visible', verified: ok, expected: on ? 'shown' : 'hidden' });
        if (!ok) fail(on ? 'medium' : 'high', key, `Leads Export button ${on ? 'hidden with' : 'shown without'} lms.leads.export`, on ? 'shown' : 'hidden', `count=${n}`, '', 'LeadDashboardShell.tsx: `can(actor, CAPABILITY.LMS_LEADS_EXPORT)`; export is client-side, so the button IS the boundary for bulk data egress.');
      }
    } finally { restoreAll(); await browser.close(); await a?.close(); }
  }

  // ── K7 retired keys ──────────────────────────────────────────────────────
  {
    const RETIRED = ['lms.dashboard', 'lms.dashboard.view', 'hr.leave.reject', 'hr.attendance.regularization.reject', 'hr.leave.admin.holidays.view', 'lms.history.detail.view',
      'hr.attendance.view.org', 'hr.attendance.view.own', 'hr.leave.view.own', 'hr.leave.view.team', 'lms.history.view.team', 'lms.leads.edit.any', 'lms.leads.edit.own', 'lms.leads.edit.team', 'tasks.edit.own', 'tasks.edit.team', 'tasks.view.own'];
    const live = rows(`SELECT key FROM iam.capabilities WHERE key IN (${RETIRED.map(lit).join(',')}) AND is_active`, ['k']).map((x) => x.k);
    log({ role: 'db', area: 'Catalogue', action: `retired keys still active: ${live.length}`, status: null, outcome: 'visible', verified: live.length === 0 });
    if (live.length) fail('medium', 'db', 'Retired capability keys are still active in iam.capabilities', 'none', live.join(', '), '', 'Deactivate them (reference_data/02_capabilities.sql) so no grant UI offers a dead key.');
    for (const key of ['tenant_admin', 'org_admin', 'hr_admin', 'sales_representative', 'msq_tenant_admin']) {
      const a = await open(key); if (!a) continue;
      try {
        const caps = await sessionCaps(a);
        const held = RETIRED.filter((k) => caps?.has(k));
        log({ role: key, area: 'Catalogue', action: `session holds retired keys: ${held.length}`, endpoint: 'GET /auth/me', status: 200, verified: held.length === 0 });
        if (held.length) fail('low', key, 'Session carries retired capability keys', 'none', held.join(', '), '', 'Stale role_capabilities rows for retired nodes.');
      } finally { await a.close(); }
    }
  }

  // ── K8 HR-admin-only holders reach admin-web ─────────────────────────────
  for (const key of ['hr_admin', 'tenant_admin', 'sales_representative']) {
    const a = await open(key); if (!a) continue;
    const caps = await sessionCaps(a); await a.close();
    const qualifies = [...(caps ?? [])].some((k) => k.startsWith('admin.') || k.startsWith('hr.leave.admin.') || k.startsWith('hr.attendance.admin.'));
    const { browser, page } = await openState(key);
    try {
      await visit(page, `${APPS['admin-web']}/`);
      await page.waitForTimeout(1500);
      const url = page.url();
      const inside = url.includes('/admin') && !/\/login|forbidden|403|unauthor/i.test(url);
      const ok = qualifies ? inside : !inside || (await page.getByText(/access restricted|no admin screens|not (allowed|authori[sz]ed)|no access|forbidden/i).count()) > 0;
      log({ role: key, area: 'Admin console', action: `open admin-web (qualifies=${qualifies}) -> ${url.replace(/^https?:\/\/[^/]+/, '')}`, status: null, outcome: 'visible', verified: ok, expected: qualifies ? 'admitted' : 'refused' });
      if (!ok) fail('medium', key, qualifies ? 'Admin console refused a holder of admin.* / hr.*.admin.*' : 'Admin console admitted a login with no admin capability', qualifies ? 'admitted' : 'refused', url, '', 'canOpenAdminConsole (rbac) and admin-web layout guard must agree.');
    } finally { await browser.close(); }
  }
} finally {
  const n = restoreAll();
  for (const s of cleanup) { try { q(s); } catch { /* best effort */ } }
  console.log(`restored ${n} override(s); ${rep.state.actions} actions, ${rep.state.findings} findings`);
  await sleep(10);
}
