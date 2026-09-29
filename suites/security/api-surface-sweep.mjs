// API surface sweep — every gateway route, every login, plus anonymous.
//
// The other suites each drive a handful of endpoints deeply. When this pass was
// written, 150 of the gateway's 241 routes were not referenced by ANY suite
// (Meta console, campaign types, lead transfer, HR employees/reports, team
// edit endpoints, analytics reports, task comments...). This is the wide,
// shallow net under all of them. It does not hardcode the route list: it
// PARSES msq-core/services/api-gateway/src/server.ts (including the lookup
// slug maps registered in loops), so a route added tomorrow is swept tomorrow.
//
// For every route it checks, per caller:
//
//   anonymous (no cookie, straight at the gateway), EVERY method
//     -> must be 401. A 2xx is an unauthenticated endpoint (critical).
//        Safe to send writes: authPreHandler rejects before any proxying.
//   every tenant-A role + every tenant-B actor, GET only
//     -> never 5xx; never a leaked stack/SQL/PG error in the body;
//        2xx JSON follows the { success, data } envelope contract.
//   super-admin-only routes (withSuperAdmin at the edge, every admin-service
//   route, the global lookup slugs) -> 403 for everyone below super_admin.
//   tenant-A object routes (/leads/:id, /users/:id, /hr/employees/:userId, ...)
//   called by a TENANT-B actor -> must be denied (critical if served).
//
// Findings are aggregated per endpoint (one finding lists every role that hit
// it), so 16 roles tripping the same 500 read as one bug, not sixteen.
//
//   node suites/security/api-surface-sweep.mjs
import fs from 'node:fs';
import path from 'node:path';
import { dir, cfg, ROLES, CROSS_TENANT, authFile, roleMeta, primaryTenant, save, GATEWAY, GATEWAY_DIRECT } from '../../lib.mjs';
import { actor, readResp } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import { leakOf, isOk, finder } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';
import { request as pwRequest } from '@playwright/test';

const TOOL = 'security';
const fail = finder(TOOL, 'API surface sweep');
const SRC = process.env.E2E_GATEWAY_SRC || path.resolve(dir, '../msq-core/services/api-gateway/src/server.ts');
const SLOW_MS = Number(process.env.E2E_SLOW_MS || 8000);

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
if (!fs.existsSync(SRC)) { console.log(`Gateway source not found at ${SRC} (set E2E_GATEWAY_SRC) — aborting`); process.exit(0); }

// ── 1. Route inventory, parsed from the gateway source ──────────────────────
const src = fs.readFileSync(SRC, 'utf8');
const routes = [];
const RX = /^app\.(get|post|put|patch|delete)\(\s*(['`])([^'`]+)\2\s*,\s*(\{[^}]*\})?/gm;
const matches = [...src.matchAll(RX)];
for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const body = src.slice(m.index, matches[i + 1]?.index ?? m.index + 1500);
  const opts = m[4] || '';
  const guard = /withSuperAdmin/.test(opts) ? 'sa' : /withCommsSend|withAuth/.test(opts) ? 'auth' : 'public';
  const target = (body.match(/config\.(\w+ServiceUrl)/) || [])[1] || null;
  if (m[3].includes('${')) continue; // loop-registered; expanded below
  routes.push({ method: m[1].toUpperCase(), path: m[3], guard, target });
}
// Lookup slugs registered in `for (const [slug, target] of Object.entries(...))`.
for (const [mapName, saRead] of [['GLOBAL_LOOKUP_TARGETS', true], ['TENANT_LOOKUP_TARGETS', false]]) {
  const block = (src.match(new RegExp(`const ${mapName}[^{]*\\{([\\s\\S]*?)\\n\\};`)) || [])[1] || '';
  for (const [, slug, svc] of block.matchAll(/'([a-z0-9-]+)':\s*config\.(\w+)/g)) {
    // Global (admin-service) lookups: super_admin only for every method.
    // Tenant lookups: the owning product service gates WRITES to super_admin;
    // reads also feed ordinary product dropdowns, so GET is not graded.
    routes.push({ method: 'GET', path: `/lookups/${slug}`, guard: 'auth', target: svc, saOnly: saRead });
    routes.push({ method: 'POST', path: `/lookups/${slug}`, guard: 'auth', target: svc, saOnly: true });
    routes.push({ method: 'PATCH', path: `/lookups/${slug}/:id`, guard: 'auth', target: svc, saOnly: true });
  }
}
for (const r of routes) {
  if (r.guard === 'sa' || r.target === 'adminServiceUrl') r.saOnly = true;
}
console.log(`Parsed ${routes.length} gateway routes (${routes.filter((r) => r.saOnly).length} super-admin-only) from ${path.relative(dir, SRC)}`);

// Routes never swept as an authenticated caller:
//  - long-lived streams (SSE never completes a GET)
//  - public/webhook/API-key surface (public-edge.mjs owns those)
//  - calls that reach a third party for a caller who is ALLOWED through
//    (Meta Graph, WhatsApp provider) — the edge-denial half is still swept.
const SKIP_AUTHED = [/^\/notifications\/stream$/, /^\/public\//, /^\/meta\/webhook/, /^\/intake\//, /^\/health$/, /^\/\.well-known\//];
const EXTERNAL_WHEN_ALLOWED = [/^\/leads\/:id\/whatsapp\/templates$/, /^\/meta\/pages/, /^\/meta\/lead-pull\/campaigns$/, /^\/communications\/status$/];
const PUBLIC_BY_DESIGN = [/^\/health$/, /^\/\.well-known\/jwks\.json$/, /^\/auth\/login$/, /^\/auth\/logout$/, /^\/meta\/webhook/, /^\/intake\/webhook$/, /^\/public\//];

// ── 2. Real ids for path params (tenant A), so we test data paths, not 404s ──
const A = primaryTenant();
const orgA = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('org_admin')?.org ?? A?.org)} LIMIT 1`);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgA)}`);
const tryScalar = (sql) => { try { return scalar(sql); } catch { return null; } };
const repId = tryScalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative')?.email ?? '')}`);
const P = {
  lead: tryScalar(`SELECT id FROM lms.marketing_leads WHERE org_id=${lit(orgA)} AND NOT is_deleted AND is_active ORDER BY created_at DESC LIMIT 1`),
  campaign: tryScalar(`SELECT id FROM marketing.ad_campaigns WHERE org_id=${lit(orgA)} LIMIT 1`),
  campaignType: tryScalar(`SELECT id FROM marketing.campaign_types WHERE tenant_id=${lit(tenantA)} LIMIT 1`),
  task: tryScalar(`SELECT id FROM task.tasks WHERE org_id=${lit(orgA)} AND NOT is_deleted ORDER BY created_at DESC LIMIT 1`),
  taskList: tryScalar(`SELECT id FROM task.task_lists WHERE NOT is_deleted ORDER BY created_at DESC LIMIT 1`),
  role: tryScalar(`SELECT role_id FROM iam.users WHERE email=${lit(roleMeta('org_admin')?.email ?? '')}`),
  user: repId,
  tenant: tenantA,
};
const NIL = '00000000-0000-4000-8000-000000000000';
// Which tenant-A object a path's :param names — also marks the route as
// "tenant-A object" for the cross-tenant check.
function bind(p) {
  let tenantObject = false;
  const url = p.replace(/:(\w+)/g, (_, name) => {
    let v = null;
    if (/^\/leads\/:id|^\/assignments\/:id/.test(p) && name === 'id') v = P.lead;
    else if (/^\/campaigns\/:id/.test(p)) v = P.campaign;
    else if (/^\/campaign-types\/:id/.test(p)) v = P.campaignType;
    else if (/^\/users\/:id/.test(p) && name === 'id') v = P.user;
    else if (name === 'userId') v = P.user;
    else if (/^\/tasks\/:id/.test(p)) v = P.task;
    else if (/^\/task-lists\/:id/.test(p)) v = P.taskList;
    else if (/^\/roles\/:id/.test(p)) v = P.role;
    else if (/^\/tenants\/:id/.test(p)) v = P.tenant;
    if (v) tenantObject = true;
    return v || NIL;
  });
  return { url, tenantObject };
}

// ── 3. Sweep ─────────────────────────────────────────────────────────────────
const agg = new Map(); // key -> { route, serverErrors:[], leaks:[], saLeak:[], xTenant:[], envelope:[], slow:[] }
const bucket = (r) => {
  const k = `${r.method} ${r.path}`;
  if (!agg.has(k)) agg.set(k, { route: r, serverErrors: [], leaks: [], saLeak: [], xTenant: [], envelope: [], slow: [], anon: null });
  return agg.get(k);
};
const matrix = [];

async function call(req, method, url, data) {
  const t0 = Date.now();
  const resp = await req.fetch(url, { method, data, failOnStatusCode: false, timeout: 45000, maxRedirects: 0 }).catch((e) => ({ err: e }));
  const ms = Date.now() - t0;
  if (resp.err) return { status: -1, body: String(resp.err.message).slice(0, 200), ms, ctype: '' };
  const ctype = resp.headers()['content-type'] || '';
  const { status, body } = /json/.test(ctype) ? await readResp(resp) : { status: resp.status(), body: (await resp.text().catch(() => '')).slice(0, 400) };
  return { status, body, ms, ctype };
}

// 3a. Anonymous — every method, straight at the gateway (no cookie jar at all).
console.log('\n— anonymous (no session) —');
const anon = await pwRequest.newContext();
for (const r of routes) {
  if (PUBLIC_BY_DESIGN.some((rx) => rx.test(r.path))) continue;
  const { url } = bind(r.path);
  const res = await call(anon, r.method, `${GATEWAY_DIRECT}${url}`, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
  const b = bucket(r); b.anon = res.status;
  matrix.push({ who: 'anonymous', method: r.method, path: r.path, status: res.status, ms: res.ms });
  if (isOk(res.status)) {
    fail('critical', 'anonymous', `${r.method} ${r.path} answers without a session`,
      '401 — every non-public route runs authPreHandler first',
      `HTTP ${res.status} with no cookie / token`, JSON.stringify(res.body).slice(0, 300),
      'Register the route with { ...withAuth } (or withSuperAdmin) in api-gateway/src/server.ts. A route added without a preHandler is public.');
  } else if (res.status >= 500 || res.status === -1) {
    b.serverErrors.push(`anonymous:${res.status}`);
  } else if (![401, 403].includes(res.status)) {
    matrix[matrix.length - 1].note = 'unexpected-anon-status';
  }
}
await anon.dispose();

// 3b. Every login — GET only.
const callers = [
  ...ROLES.map((role) => ({ key: role, role, tenant: 'A' })),
  ...CROSS_TENANT.map((c) => ({ key: c.stateKey, role: c.role, tenant: 'B' })),
];
for (const c of callers) {
  if (!fs.existsSync(authFile(c.key))) { console.log(`skip ${c.key} (no auth state)`); continue; }
  const a = await actor(c.key);
  let n = 0, bad = 0;
  try {
    for (const r of routes.filter((x) => x.method === 'GET')) {
      if (SKIP_AUTHED.some((rx) => rx.test(r.path))) continue;
      const isSA = c.role === 'super_admin';
      if (EXTERNAL_WHEN_ALLOWED.some((rx) => rx.test(r.path)) && (isSA || !r.saOnly)) continue;
      const { url, tenantObject } = bind(r.path);
      const res = await call(a.request, 'GET', `${GATEWAY}${url}`);
      n++;
      const b = bucket(r);
      matrix.push({ who: c.key, role: c.role, tenant: c.tenant, method: 'GET', path: r.path, status: res.status, ms: res.ms });
      logAction({ tool: TOOL, role: c.key, area: 'API surface', action: `GET ${r.path}`, method: 'GET', endpoint: r.path, status: res.status, outcome: outcomeOf(res.status), expected: r.saOnly && !isSA ? 'denied' : 'observed only' });

      if (res.status >= 500 || res.status === -1) { b.serverErrors.push(`${c.key}:${res.status}`); bad++; }
      const leak = res.status >= 400 ? leakOf(res.body) : null;
      if (leak) b.leaks.push(`${c.key}: …${leak}…`);
      if (r.saOnly && !isSA && isOk(res.status)) b.saLeak.push(`${c.key}:${res.status}`);
      if (c.tenant === 'B' && tenantObject && isOk(res.status)) {
        const txt = JSON.stringify(res.body ?? '');
        const anyId = Object.values(P).filter(Boolean).find((id) => txt.includes(id));
        // A 2xx is a LEAK only when it carries tenant-A data. An empty 2xx
        // ([] / {} / null data) reveals nothing and is graded separately (low:
        // should be a 404 for consistency) — the first run graded every empty
        // list critical, which buried the real signal.
        const d = res.body?.data;
        const nonEmpty = Array.isArray(d) ? d.length > 0 : d && typeof d === 'object' ? Object.keys(d).length > 0 : d != null && d !== '';
        (anyId || nonEmpty ? b.xTenant : (b.xTenantEmpty ??= [])).push(`${c.key}:${res.status}${anyId ? ` (body contains tenant-A id ${anyId})` : nonEmpty ? ' (non-empty data)' : ' (empty)'}`);
      }
      if (isOk(res.status) && /json/.test(res.ctype) && (typeof res.body !== 'object' || res.body === null || !('success' in res.body))) {
        b.envelope.push(c.key);
      }
      if (res.ms > SLOW_MS) b.slow.push(`${c.key}:${res.ms}ms`);
    }
  } finally { await a.close(); }
  console.log(`  ${c.key.padEnd(26)} GETs=${n} 5xx=${bad}`);
}

// ── 4. Aggregate into findings ───────────────────────────────────────────────
for (const [k, b] of agg) {
  if (b.serverErrors.length) {
    fail('high', b.serverErrors.map((s) => s.split(':')[0]).slice(0, 12).join(', '), `${k} returns a server error`,
      'A clean 2xx, or a 4xx that says why — never a 5xx',
      `5xx for ${b.serverErrors.length} caller(s): ${b.serverErrors.slice(0, 12).join(', ')}`,
      `target=${b.route.target}`,
      `Reproduce with one of the listed roles and read the ${b.route.target?.replace('Url', '') ?? 'service'} log. Typical roots: a plain \`throw new Error\` (maps to 500 — use an AppError subclass), a role without platform.write (PG 25006 read-only tx), an unparameterised array in a sql\`\` template, or a missing RLS policy for the service login.`);
  }
  if (b.saLeak.length) {
    fail('critical', b.saLeak.map((s) => s.split(':')[0]).join(', '), `${k} (super-admin only) is served to non-super-admin callers`,
      '403 for every rank below super_admin (withSuperAdmin edge guard / admin-service rank check)',
      `2xx for: ${b.saLeak.join(', ')}`, `target=${b.route.target}`,
      'Add superAdminGuard at the gateway AND keep the service-side `rank < RANKS.SUPER_ADMIN` check — the platform console must never be reachable by tenant staff.');
  }
  if (b.xTenant.length) {
    fail('critical', b.xTenant.map((s) => s.split(':')[0]).join(', '), `${k} serves a TENANT-A object to a tenant-B login`,
      '403/404 — a user must never read another tenant\'s records by id',
      `served to: ${b.xTenant.join('; ')}`, `route=${k}`,
      'The lookup is not tenant-scoped: run it inside withRoleTx so RLS applies, or assert the row\'s tenant_id against request.auth.tenant_id before returning it.');
  }
  if (b.xTenantEmpty?.length) {
    fail('low', b.xTenantEmpty.map((s) => s.split(':')[0]).join(', '), `${k} answers 2xx (empty) for a TENANT-A id to a tenant-B login`,
      '404 — same answer as a non-existent id', `${b.xTenantEmpty.join('; ')}`, `route=${k}`,
      'No data leaves the tenant (RLS filters the rows), but resolve the parent first and 404 when it is not visible, so the route cannot be used to probe ids.');
  }
  if (b.leaks.length) {
    fail('medium', b.leaks.map((s) => s.split(':')[0]).slice(0, 8).join(', '), `${k} leaks backend internals in an error response`,
      'A generic, user-safe error message ({ success:false, error })',
      b.leaks[0], b.leaks.slice(0, 3).join(' | '),
      'Route the thrown error through the service error handler (AppError / translatePgError) instead of echoing err.message from the driver.');
  }
  if (b.envelope.length) {
    fail('low', b.envelope.slice(0, 6).join(', '), `${k} breaks the response envelope contract`,
      '{ "success": true, "data": … } on every JSON 2xx (skills/nodejs-typescript §10)',
      `2xx JSON without a success key for ${b.envelope.length} caller(s)`, k,
      'Wrap the controller reply in { success: true, data } — clients branch on success.');
  }
  if (b.slow.length) {
    fail('low', b.slow.map((s) => s.split(':')[0]).slice(0, 6).join(', '), `${k} is slow (> ${SLOW_MS} ms)`,
      `Responds within ${SLOW_MS} ms on the local stack`, b.slow.slice(0, 6).join(', '), k,
      'EXPLAIN ANALYZE the underlying view/query for this role; missing index or an N+1 in the repository is the usual cause.');
  }
}

save(TOOL, 'api-surface', { routes: routes.length, generatedAt: new Date().toISOString(), matrix });
const t = [...agg.values()];
console.log(`\nswept ${routes.length} routes · 5xx on ${t.filter((b) => b.serverErrors.length).length} · SA leaks ${t.filter((b) => b.saLeak.length).length} · cross-tenant ${t.filter((b) => b.xTenant.length).length} · leaks ${t.filter((b) => b.leaks.length).length}`);
console.log('matrix -> results/security-api-surface.json');
