// Super-admin console (/sa) — the Meta ops screens, lead-pull, assignment
// re-run, CAPI events, catalogs and tenant modules added since the last pass
// (8b15c3c "screens for meta leads fetch", 13e0237, 1.44–1.51).
//
//   1. RENDER    — as super_admin every new screen loads with no error banner,
//                  no page error and no 5xx. Nothing is clicked: these screens
//                  are full of immediate-action buttons (Sync / Pull / Apply /
//                  Retry / Ignore / Re-run) that call Meta or re-assign real
//                  leads — crawl.mjs now inventories those, never fires them.
//   2. EDGE DENY — the SA-only ACTIONS refuse org_admin / tenant_admin at the
//                  gateway (superAdminGuard) with 403. Bodies are deliberately
//                  invalid, so a missing edge guard shows up as a 400 from the
//                  service (graded high) rather than as a real re-run.
//   3. MODULES   — PUT /tenants/:id/modules on a tenant that does not exist is
//                  a 4xx (not a 500, not rows for a phantom tenant); and the
//                  entitlement actually bites: switching tenant B's `tasks`
//                  module off makes its user's task API 403 (gateway caches
//                  entitlement 60 s, so this polls), and switching it back on
//                  restores access. Journalled — a crash cannot leave tenant B
//                  without Tasks (restore.mjs replays it).
//   4. DRIFT     — GET /catalogs/drift entries are surfaced as findings: each
//                  one is a tenant catalog that diverged from the platform.
//
//   node suites/admin/sa-console.mjs
import { openState, visit, APPS, GATEWAY, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPut } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, journalRestore, runRestore, restorePending } from '../../fixtures.mjs';
import { mark, delta } from '../../crawl.mjs';
import fs from 'node:fs';

const TOOL = 'lookup';
const fail = finder(TOOL, 'Super-admin console');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
if (!fs.existsSync(authFile('super_admin'))) { console.log('super_admin login required — aborting'); process.exit(0); }
const pending = restorePending('tenant-modules');
if (pending.length) console.log(`restored tenant modules left by a previous run: ${pending.join(', ')}`);

const tenantA = scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email='root@root.com'`);
const SCREENS = [
  '/dashboard/meta-ad-accounts', '/dashboard/meta-campaigns', '/dashboard/meta-lead-inbox', '/dashboard/meta-mappings',
  '/dashboard/lead-pull', '/dashboard/lead-assignment-rerun', '/dashboard/campaign-types', '/dashboard/catalogs',
  '/dashboard/lookups/lead-stage/capi-events', '/dashboard/capabilities/matrix', '/dashboard/users',
  ...(tenantA ? [`/dashboard/tenants/${tenantA}/modules`] : []),
];

// ── 1. Render every new screen as super_admin ────────────────────────────────
{
  const { browser, page, log } = await openState('super_admin');
  try {
    for (const s of SCREENS) {
      const m = mark(log);
      const v = await visit(page, `${APPS['lookup-admin']}${s}`);
      await page.waitForTimeout(800);
      const d = delta(log, m);
      const fivexx = d.badRequests.filter((b) => /^5\d\d /.test(b));
      const bounced = /\/login/.test(v.url) || /access restricted/i.test(v.bodySnippet);
      console.log(`1. ${s.padEnd(44)} ${bounced ? 'BOUNCED' : 'ok'} pageErrors=${d.pageErrors.length} 5xx=${fivexx.length}${v.looksLikeError ? ' ERROR-TEXT' : ''}`);
      if (bounced) fail('high', 'super_admin', `super_admin cannot open ${s}`, 'The screen renders for super_admin', `Landed on ${v.url}`, v.bodySnippet.slice(0, 200), 'Check canOpenLookupAdmin and the ADMIN_NAV capability for this screen.');
      else if (fivexx.length || d.pageErrors.length || v.looksLikeError) fail(fivexx.length || d.pageErrors.length ? 'high' : 'medium', 'super_admin', `${s} loads with errors`, 'No 5xx, no uncaught page error, no error text', `5xx=${fivexx.length} pageErrors=${d.pageErrors.length}`, JSON.stringify({ fivexx: fivexx.slice(0, 4), pageErrors: d.pageErrors.slice(0, 2), body: v.bodySnippet.slice(0, 160) }), 'Open the screen as super_admin with the network tab open; the failing call is in the evidence. Empty-state handling (no Meta integration configured yet) is the common trigger.');
    }
  } finally { await browser.close(); }
}

// ── 2. SA actions are refused at the edge for tenant staff ───────────────────
const NIL = '00000000-0000-4000-8000-000000000000';
const ACTIONS = [
  ['POST', '/lead-assignment/rerun', { e2e_invalid: true }],
  ['POST', '/meta/campaigns/sync', { e2e_invalid: true }],
  ['POST', '/meta/ad-accounts/sync', { e2e_invalid: true }],
  ['POST', '/meta/lead-pull/runs', { e2e_invalid: true }],
  ['POST', `/meta/lead-pull/runs/${NIL}/apply`, { e2e_invalid: true }],
  ['POST', `/meta/lead-pull/runs/${NIL}/remap`, { e2e_invalid: true }],
  ['POST', `/meta/lead-inbox/${NIL}/retry`, {}],
  ['POST', `/meta/lead-inbox/${NIL}/ignore`, {}],
  ['POST', '/meta/page-org-map', { e2e_invalid: true }],
  ['PUT', `/tenants/${tenantA ?? NIL}/modules`, { modules: 'not-an-array' }],
  ['PUT', '/lookups/lead-stage-capi-events', { e2e_invalid: true }],
];
for (const role of ['tenant_admin', 'org_admin']) {
  if (!fs.existsSync(authFile(role))) continue;
  const a = await actor(role);
  try {
    for (const [m, p, body] of ACTIONS) {
      const r = m === 'PUT' ? await apiPut(a, `${GATEWAY}${p}`, body) : await apiPost(a, `${GATEWAY}${p}`, body);
      if (r.status === 403) continue;
      console.log(`2. ${role} ${m} ${p} -> ${r.status} (expect 403)`);
      if (isOk(r.status)) fail('critical', role, `${role} performs super-admin action ${m} ${p}`, '403 at the gateway (withSuperAdmin)', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Register the route with withSuperAdmin in api-gateway/src/server.ts AND keep the service-side rank check.');
      else if (r.status !== 401) fail('high', role, `${m} ${p} reaches the service for a non-super-admin`, '403 from superAdminGuard before proxying', `HTTP ${r.status} (the request got past the edge and was only stopped by validation)`, JSON.stringify(r.body).slice(0, 200), 'Add superAdminGuard to this route; validation is not authorization — a valid body would have run the action.');
    }
  } finally { await a.close(); }
}

// ── 3. Tenant modules ────────────────────────────────────────────────────────
const sa = await actor('super_admin');
try {
  const phantom = await apiPut(sa, `${GATEWAY}/tenants/${NIL}/modules`, { modules: ['lms'] });
  const phantomRows = Number(scalar(`SELECT COUNT(*) FROM entity.tenant_modules WHERE tenant_id=${lit(NIL)}`) ?? 0);
  console.log(`3. PUT modules for a non-existent tenant http=${phantom.status} rows=${phantomRows}`);
  if (isOk(phantom.status) || phantomRows) fail('medium', 'super_admin', 'Tenant modules can be written for a tenant that does not exist', '404 Tenant not found', `HTTP ${phantom.status}, rows=${phantomRows}`, NIL, 'tenant-modules.service put(): check the tenant exists first; also the four setActive calls run in four separate transactions — wrap them in one so a mid-way failure cannot half-apply a plan change.');
  else if (phantom.status >= 500) fail('medium', 'super_admin', 'PUT /tenants/:id/modules 5xxs for an unknown tenant', '404', `HTTP ${phantom.status}`, JSON.stringify(phantom.body).slice(0, 200), 'Validate the tenant id against entity.tenants before the FK does it for you.');

  const b = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)));
  const tenantB = b ? scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(b.email)}`) : null;
  if (tenantB) {
    const before = rows(`SELECT module, is_active::text FROM entity.tenant_modules WHERE tenant_id=${lit(tenantB)}`, ['module', 'active']);
    const activeBefore = before.filter((r) => r.active === 'true').map((r) => r.module);
    const user = await actor(b.stateKey);
    const tasksUrl = `${APPS['todo-web']}/api/tasks/mine`;
    const baseline = await apiGet(user, tasksUrl);
    console.log(`3b. tenant B modules=[${activeBefore.join(',')}] tasks baseline http=${baseline.status}`);
    if (activeBefore.includes('tasks') && isOk(baseline.status)) {
      journalRestore('tenant-modules-B', 'entity.tenant_modules for tenant B', before.map((r) =>
        `UPDATE entity.tenant_modules SET is_active=${r.active === 'true'}, updated_at=NOW() WHERE tenant_id=${lit(tenantB)} AND module=${lit(r.module)}`));
      const poll = async (want, label) => {
        const t0 = Date.now(); let last = 0;
        while (Date.now() - t0 < 90000) {
          last = (await apiGet(user, tasksUrl)).status;
          if (want(last)) return { ok: true, s: Math.round((Date.now() - t0) / 1000), last };
          await new Promise((r) => setTimeout(r, 5000));
        }
        console.log(`   ${label}: gave up after 90s (last=${last})`);
        return { ok: false, s: 90, last };
      };
      try {
        const off = await apiPut(sa, `${GATEWAY}/tenants/${tenantB}/modules`, { modules: activeBefore.filter((m) => m !== 'tasks') });
        const blocked = isOk(off.status) ? await poll((s) => s === 403, 'tasks off') : { ok: false, last: off.status };
        console.log(`3c. tasks OFF http=${off.status} -> task API blocked=${blocked.ok} after ${blocked.s}s (last ${blocked.last})`);
        if (isOk(off.status) && !blocked.ok) fail('high', b.stateKey, 'Disabling a tenant\'s Tasks module does not block its task API', `403 on ${tasksUrl} within the 60 s entitlement cache window`, `still HTTP ${blocked.last} after 90 s`, `tenant=${tenantB}`, 'productGuard reads getActiveTenantModulesByTenantId (60 s cache); check the product map has /tasks -> task and that the cache key is the tenant id. An unlicensed tenant keeping product access is a billing/entitlement leak.');
        const on = await apiPut(sa, `${GATEWAY}/tenants/${tenantB}/modules`, { modules: activeBefore });
        const back = isOk(on.status) ? await poll(isOk, 'tasks on') : { ok: false, last: on.status };
        console.log(`3d. tasks ON  http=${on.status} -> task API restored=${back.ok} after ${back.s}s`);
        if (!back.ok) fail('high', b.stateKey, 'Re-enabling a tenant\'s Tasks module does not restore access', `2xx on ${tasksUrl} within 90 s`, `HTTP ${back.last}`, `tenant=${tenantB}`, 'Re-enabling must flip is_active back and expire the entitlement cache; users are otherwise locked out after a plan fix.');
      } finally {
        runRestore('tenant-modules-B');
      }
    }
    await user.close();
  }

  // ── 4. Catalog drift ───────────────────────────────────────────────────────
  const drift = await apiGet(sa, `${GATEWAY}/catalogs/drift`);
  const entries = Array.isArray(drift.body?.data) ? drift.body.data : (drift.body?.data?.items ?? []);
  console.log(`4. catalog drift http=${drift.status} entries=${entries.length}`);
  if (drift.status >= 500) fail('medium', 'super_admin', 'GET /catalogs/drift 5xxs', '200', `HTTP ${drift.status}`, JSON.stringify(drift.body).slice(0, 200), 'Check catalog-drift.repository against the current schema.');
  for (const e of entries.slice(0, 25)) {
    fail('medium', 'super_admin', `Catalog drift: ${e.catalog ?? e.table ?? e.slug ?? 'catalog'} ${e.tenant_name ?? e.tenant_id ?? ''}`.trim(),
      'Tenant catalogs match the platform catalog (no missing / extra / renamed entries)', JSON.stringify(e).slice(0, 300), JSON.stringify(e).slice(0, 500),
      'Open lookup-admin → Catalogs and reconcile; drift here is how a tenant ends up with a stage/source the code does not know about (silent routing and report gaps).');
  }
} finally {
  await sa.close();
}
