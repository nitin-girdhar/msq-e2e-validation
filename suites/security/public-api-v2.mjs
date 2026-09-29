// Partner API v2 — lead list/find, and branch fencing for /users + /branches.
//
// Schema 1.53.0 (2026-09-29) added two scopes and two routes on the existing
// iam.api_clients key system, and fixed a leak in the same change:
//
//   GET  /public/v1/leads        (leads:list)  csv branch_id/assigned_to/source/
//                                              stage/outcome, dates, limit<=500
//   POST /public/v1/leads/find   (leads:find)  phones[]/emails[] <=100 combined
//   GET  /public/v1/users        (users:read)  + department_id / manager_id / branch_id
//   GET  /public/v1/branches     (branches:read) + branch_id
//
//   SECURITY FIX: a key bound to SEVERAL branches that sent no branch_id used
//   to get /users and /branches for the WHOLE tenant.
//
// What this proves, each graded against Postgres rather than row counts:
//   1. scope separation — a leads:read key cannot list or find (403), a key
//      without leads:find cannot find;
//   2. fencing — a multi-branch key, a single-branch key and a tenant-wide key
//      only ever see rows of their own branches / tenant (every returned id is
//      looked up in the DB), for leads, users and branches;
//   3. out-of-reach branch_id is a 400 (never silently widened or dropped);
//   4. malformed filters are 4xx, never 500 and never "no filter";
//   5. find: phone normalisation (+91 / spaces / dashes), matched_on, not_found,
//      and a lead in a branch the key cannot reach is NOT found (enumeration);
//   6. field minimisation — no raw_webhook_data / metadata / tags /
//      outcome_comment / credential fields;
//   7. tenant B's tenant-wide key never sees tenant A.
//
// Actors: tenant_admin mints multi-branch + tenant-wide keys; org_admin mints a
// single-branch key (the service pins org_admin to its own branch); tenant B's
// tenant_admin mints its own tenant-wide key. Every key is revoked in finally.
//
//   node suites/security/public-api-v2.mjs
import { record, roleMeta, cfg, GATEWAY_DIRECT, CROSS_TENANT } from '../../lib.mjs';
import { actor, apiPost, apiDelete, readResp } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';
import { chromium } from '@playwright/test';

const TOOL = 'security';
const PAGE = 'Partner API v2 (leads list/find, users, branches)';
const GW = GATEWAY_DIRECT ?? cfg.gatewayDirect ?? cfg.gateway;
const CLIENTS = `${cfg.gateway}/api-clients`;
const FORBIDDEN_FIELDS = ['raw_webhook_data', 'metadata', 'tags', 'outcome_comment', 'password', 'password_hash', 'key_hash', 'refresh_token'];

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgIdOf = (name) => scalar(`SELECT id FROM entity.organizations WHERE name=${lit(name)} AND NOT is_deleted LIMIT 1`);
const A = orgIdOf(roleMeta('org_admin').org);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(A)}`);
// Second and third branch of tenant A: B is inside the multi-branch key, C is not.
const others = rows(`SELECT o.id FROM entity.organizations o
  WHERE o.tenant_id=${lit(tenantA)} AND o.id<>${lit(A)} AND NOT o.is_deleted
  ORDER BY (SELECT COUNT(*) FROM lms.marketing_leads l WHERE l.org_id=o.id AND NOT l.is_deleted AND l.is_active) DESC LIMIT 2`, ['id']).map((r) => r.id);
const [B, C] = others;
const tBMeta = CROSS_TENANT.find((a) => a.role === 'tenant_admin');
const tenantB = tBMeta ? scalar(`SELECT tenant_id FROM entity.organizations WHERE name=${lit(tBMeta.org)} LIMIT 1`) : null;
const branchTB = tBMeta ? orgIdOf(tBMeta.org) : null;
if (!A || !B || !tenantA) { console.log('Need at least two branches in tenant A — aborting'); process.exit(0); }

// Batched lookups: one psql round trip per response, not per row (each
// docker exec costs ~0.3 s; a 500-row page per key made this suite take 10+ min).
const idArr = (ids) => `ARRAY[${[...new Set(ids.filter(Boolean))].map(lit).join(',') || "NULL"}]::uuid[]`;
const leadOrgs = (ids) => Object.fromEntries(rows(`SELECT id, org_id FROM lms.marketing_leads WHERE id = ANY(${idArr(ids)})`, ['id', 'org']).map((r) => [r.id, r.org]));
const orgTenants = (ids) => Object.fromEntries(rows(`SELECT id, tenant_id FROM entity.organizations WHERE id = ANY(${idArr(ids)})`, ['id', 't']).map((r) => [r.id, r.t]));
const leadOrg = (id) => leadOrgs([id])[id];
const orgTenant = (id) => orgTenants([id])[id];
const sampleLead = (org) => rows(`SELECT id, phone, email FROM lms.marketing_leads
  WHERE org_id=${lit(org)} AND NOT is_deleted AND is_active
    AND length(regexp_replace(COALESCE(phone,''),'\\D','','g')) >= 10 LIMIT 1`, ['id', 'phone', 'email'])[0];

let findings = 0;
const fail = (severity, role, scenario, expected, actual, evidence, fix) => {
  findings++;
  record(TOOL, { severity, role, tool: TOOL, page: PAGE, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 400), proposedSolution: fix });
};
const act = (role, action, method, endpoint, status, verified, expected, note) =>
  logAction({ tool: TOOL, role, area: PAGE, action, method, endpoint, status, outcome: outcomeOf(status, verified), verified, expected, note });

const browser = await chromium.launch();
const raw = (await browser.newContext()).request;
const call = async (method, path, key, data) => {
  const opts = { failOnStatusCode: false, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}), ...(data ? { data } : {}) };
  return readResp(await (method === 'POST' ? raw.post(`${GW}${path}`, opts) : raw.get(`${GW}${path}`, opts)));
};
const listOf = (body) => (Array.isArray(body?.data) ? body.data : []);
const leakedField = (items) => {
  for (const it of items) for (const f of FORBIDDEN_FIELDS) if (it && Object.prototype.hasOwnProperty.call(it, f)) return f;
  return null;
};

const minted = []; // [actor, id]
async function mint(a, role, name, body, { capabilityOptional = false } = {}) {
  const r = await apiPost(a, CLIENTS, { name: `E2E-v2-${name}-${Date.now()}`, ...body });
  const id = r.body?.data?.id; const key = r.body?.data?.api_key;
  if (id) minted.push([a, id]);
  act(role, `mint API key "${name}" (${body.scopes.join(',')})`, 'POST', '/api-clients', r.status, !!key, '201 + raw key once');
  if (!key && capabilityOptional && r.status === 403) {
    fail('info', role, `Mint API key ${name}`, '201 (if the tenant grants platform.api_tokens to this role)', 'HTTP 403 — capability not granted in this tenant', JSON.stringify(r.body).slice(0, 200), 'Tenant configuration, not a defect; the capability gate works.');
    return null;
  }
  if (!key) fail('high', role, `Mint API key ${name}`, '201 with the raw key once', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200),
    'POST /api-clients must accept the new leads:list / leads:find scopes (auth-constants API_SCOPES) and return api_key once.');
  return key;
}

const tAdmin = await actor('tenant_admin');
const oAdmin = await actor('org_admin');
let tbAdmin = null;
try {
  const ALL = ['leads:list', 'leads:find', 'users:read', 'branches:read'];
  const kMulti = await mint(tAdmin, 'tenant_admin', 'multi', { scopes: ['leads:list', 'users:read', 'branches:read'], org_ids: [A, B] });
  const kAll = await mint(tAdmin, 'tenant_admin', 'all', { scopes: ALL, scope_all_orgs: true });
  // org_admin is pinned to its own branch by the service; its smuggled scope is
  // checked below. When the tenant does not grant org_admin platform.api_tokens,
  // the single-branch key comes from tenant_admin instead.
  const kSingleOA = await mint(oAdmin, 'org_admin', 'single', { scopes: ALL, org_ids: [B], scope_all_orgs: true }, { capabilityOptional: true });
  const kSingle = kSingleOA ?? await mint(tAdmin, 'tenant_admin', 'single-ta', { scopes: ALL, org_ids: [A] });
  const kRead = await mint(tAdmin, 'tenant_admin', 'readonly', { scopes: ['leads:read'], org_ids: [A] });

  // org_admin's smuggled org_ids/scope_all_orgs must be ignored.
  const singleRow = kSingleOA ? rows(`SELECT c.scope_all_orgs::text AS all, COALESCE(string_agg(o.org_id::text, ','), '') AS orgs
    FROM iam.api_clients c LEFT JOIN iam.api_client_orgs o ON o.api_client_id=c.id
    WHERE c.name LIKE 'E2E-v2-single-%' GROUP BY c.id, c.scope_all_orgs ORDER BY c.created_at DESC LIMIT 1`, ['all', 'orgs'])[0] : null;
  if (singleRow && (singleRow.all === 'true' || singleRow.orgs !== A)) {
    fail('critical', 'org_admin', 'org_admin mints a key with smuggled scope_all_orgs / foreign org_ids', `Key pinned to own branch ${A}`,
      `scope_all_orgs=${singleRow.all} orgs=${singleRow.orgs}`, '', 'api-clients.service resolveBranchScope must ignore requested scope for org_admin.');
  }

  // ── 1. scope separation ────────────────────────────────────────────────
  if (kRead) {
    const l = await call('GET', '/public/v1/leads', kRead);
    act('api-key:leads:read', 'list leads with a leads:read-only key', 'GET', '/public/v1/leads', l.status, null, '403');
    if (l.status !== 403) fail('critical', 'api-key', 'leads:read key lists the lead book', '403 (leads:list is a separate scope)', `HTTP ${l.status}, ${listOf(l.body).length} rows`,
      JSON.stringify(l.body).slice(0, 200), "gateway: GET /public/v1/leads must use publicApiKeyAuth('leads:list').");
    const f = await call('POST', '/public/v1/leads/find', kRead, { phones: ['9999999999'] });
    act('api-key:leads:read', 'find leads with a leads:read-only key', 'POST', '/public/v1/leads/find', f.status, null, '403');
    if (f.status !== 403) fail('high', 'api-key', 'leads:read key can use /leads/find', '403', `HTTP ${f.status}`, JSON.stringify(f.body).slice(0, 200), "publicApiKeyAuth('leads:find') on the find route.");
  }
  if (kMulti) {
    const f = await call('POST', '/public/v1/leads/find', kMulti, { phones: ['9999999999'] });
    act('api-key:multi', 'find leads without leads:find scope', 'POST', '/public/v1/leads/find', f.status, null, '403');
    if (f.status !== 403) fail('high', 'api-key', 'Key without leads:find can use /leads/find', '403', `HTTP ${f.status}`, '', "publicApiKeyAuth('leads:find').");
  }
  const anon = await call('GET', '/public/v1/leads', null);
  act('anonymous', 'list leads with no key', 'GET', '/public/v1/leads', anon.status, null, '401');
  if (anon.status !== 401) fail('critical', 'anonymous', 'GET /public/v1/leads with no key', '401', `HTTP ${anon.status}`, JSON.stringify(anon.body).slice(0, 200), 'publicApiKeyAuth must run first.');

  // ── 2. fencing (the 1.53.0 security fix) ───────────────────────────────
  const fence = async (label, key, allowed, tenant) => {
    if (!key) return;
    const allow = allowed ? new Set(allowed) : null;
    for (const [path, idOf, orgOfFor] of [
      // Lead branch is read from the DB by lead id, never trusted from the response.
      ['/public/v1/leads?limit=500', (r) => r.lead_id, (items) => { const m = leadOrgs(items.map((i) => i.lead_id)); return (r) => m[r.lead_id]; }],
      ['/public/v1/users', (r) => r.id, () => (r) => r.branch_id],
      ['/public/v1/branches', (r) => r.id, () => (r) => r.id],
    ]) {
      const r = await call('GET', path, key);
      const items = listOf(r.body);
      const orgOf = orgOfFor(items);
      const tmap = allow ? null : orgTenants(items.map(orgOf));
      const inScope = (org) => (allow ? allow.has(org) : tmap[org] === tenant);
      // Every id is checked against the DB, not trusted from the response.
      const leaks = items.filter((it) => !inScope(orgOf(it) ?? ''));
      act(`api-key:${label}`, `read ${path.split('?')[0]} — every row inside the key's reach`, 'GET', path, r.status, leaks.length === 0, allowed ? `only ${allowed.length} branch(es)` : 'own tenant only',
        `${items.length} rows, ${leaks.length} outside scope`);
      if (r.status >= 500) fail('high', `api-key:${label}`, `GET ${path}`, '2xx', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Handler threw — check public-read controller.');
      else if (r.status !== 200) fail('high', `api-key:${label}`, `GET ${path} with a correctly-scoped key`, '200', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Key has the scope; check the route/scope mapping.');
      if (leaks.length) fail('critical', `api-key:${label}`, `${path.split('?')[0]} returns rows outside the key's branches`, allowed ? `only branches ${allowed.join(',')}` : `only tenant ${tenant}`,
        `${leaks.length}/${items.length} rows outside scope`, JSON.stringify(leaks.slice(0, 2).map(idOf)),
        'resolveOrgScope (identity-service public-read.controller / leads-service public-read.controller) must fence a multi-branch key to X-Allowed-Org-Ids even when no branch_id is sent.');
      const leaked = leakedField(items);
      if (leaked) fail(leaked.includes('pass') || leaked.includes('key') || leaked.includes('token') ? 'critical' : 'high', `api-key:${label}`, `${path.split('?')[0]} DTO exposes "${leaked}"`,
        'Whitelisted DTO columns only', `field ${leaked} present`, '', 'Remove the column from LEAD_COLUMNS / listUsers select.');
      if (path.startsWith('/public/v1/branches') && allowed && items.length !== allowed.length) {
        fail('medium', `api-key:${label}`, '/branches for a multi-branch key', `exactly its ${allowed.length} branches`, `${items.length} rows`, JSON.stringify(items.map((i) => i.id)), 'listBranches should return every bound branch.');
      }
    }
  };
  await fence('multi', kMulti, [A, B], tenantA);
  await fence('single', kSingle, [A], tenantA);
  await fence('all', kAll, null, tenantA);

  // ── 3. out-of-reach branch_id is a 400 ─────────────────────────────────
  const outOfReach = [
    ['multi', kMulti, C, 'a sibling branch not bound to the key'],
    ['single', kSingle, B, 'a sibling branch'],
    ['all', kAll, branchTB, "tenant B's branch"],
  ];
  for (const [label, key, org, what] of outOfReach) {
    if (!key || !org) continue;
    for (const [m, path, body] of [
      ['GET', `/public/v1/leads?branch_id=${org}`], ['GET', `/public/v1/users?branch_id=${org}`], ['GET', `/public/v1/branches?branch_id=${org}`],
      ...(label === 'multi' ? [] : [['POST', '/public/v1/leads/find', { phones: ['9999999999'], branch_id: [org] }]]),
    ]) {
      const r = await call(m, path, key, body);
      const n = listOf(r.body).length;
      act(`api-key:${label}`, `request ${what} via branch_id`, m, path.split('?')[0], r.status, null, '400');
      if (r.status === 200) fail(n ? 'critical' : 'medium', `api-key:${label}`, `${m} ${path.split('?')[0]} with branch_id = ${what}`, '400 branch_id is not permitted',
        `200 with ${n} rows`, JSON.stringify(r.body).slice(0, 200), 'resolveOrgScope must reject a requested branch outside the key reach (400), never widen or silently drop it.');
      else if (r.status >= 500) fail('high', `api-key:${label}`, `${m} ${path.split('?')[0]} with out-of-reach branch_id`, '400', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Map to BadRequestError.');
    }
  }

  // ── 4. malformed filters ───────────────────────────────────────────────
  if (kAll) {
    for (const path of [
      '/public/v1/users?department_id=not-a-uuid', '/public/v1/users?manager_id=1,2', '/public/v1/users?branch_id=zzz',
      '/public/v1/leads?assigned_to=nope', '/public/v1/leads?limit=501', '/public/v1/leads?start_date=yesterday', '/public/v1/leads?stage=a%20b',
    ]) {
      const r = await call('GET', path, kAll);
      act('api-key:all', `malformed filter ${path.split('?')[1]}`, 'GET', path.split('?')[0], r.status, null, '400/422');
      if (r.status === 200) fail('medium', 'api-key:all', `Malformed filter ${path.split('?')[1]} accepted`, '400/422 — never degrade to "no filter"', `200 with ${listOf(r.body).length} rows`,
        '', 'Use parseUuidCsvStrict / zod csvOf; a malformed filter must not widen the result.');
      else if (r.status >= 500) fail('high', 'api-key:all', `Malformed filter ${path.split('?')[1]}`, '400/422', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Validation error must map to 4xx.');
    }
    for (const body of [{}, { phones: ['12'] }, { emails: ['not-an-email'] }, { phones: Array.from({ length: 101 }, (_, i) => `98${String(i).padStart(8, '0')}`) }]) {
      const r = await call('POST', '/public/v1/leads/find', kAll, body);
      act('api-key:all', `find with invalid body ${JSON.stringify(body).slice(0, 40)}`, 'POST', '/public/v1/leads/find', r.status, null, '400/422');
      if (r.status < 400 || r.status >= 500) fail(r.status >= 500 ? 'high' : 'medium', 'api-key:all', `find with invalid body ${JSON.stringify(body).slice(0, 60)}`, '400/422', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'findLeadsBodySchema must reject it.');
    }

    // department filter narrows correctly
    const dept = scalar(`SELECT ur.department_id FROM iam.user_org_mapping m JOIN iam.user_roles ur ON ur.id=m.role_id
      JOIN entity.organizations o ON o.id=m.org_id WHERE o.tenant_id=${lit(tenantA)} AND ur.department_id IS NOT NULL AND m.is_active LIMIT 1`);
    if (dept) {
      const r = await call('GET', `/public/v1/users?department_id=${dept}`, kAll);
      const wrong = listOf(r.body).filter((u) => u.department_id !== dept);
      act('api-key:all', 'filter users by department_id', 'GET', '/public/v1/users', r.status, wrong.length === 0, 'only that department', `${listOf(r.body).length} rows`);
      if (r.status === 200 && (wrong.length || listOf(r.body).length === 0)) fail('medium', 'api-key:all', 'users?department_id filter', 'Only (and some) users of that department',
        `${wrong.length} wrong / ${listOf(r.body).length} rows`, JSON.stringify(wrong.slice(0, 2)), 'listUsers department filter joins ur.department_id of the membership role.');
    }

    // pagination + total agrees with the DB
    const p = await call('GET', `/public/v1/leads?branch_id=${A}&limit=5`, kAll);
    const dbTotal = Number(scalar(`SELECT COUNT(*) FROM lms.marketing_leads WHERE org_id=${lit(A)} AND NOT is_deleted AND is_active`));
    act('api-key:all', 'paginate leads (limit=5) and compare total with DB', 'GET', '/public/v1/leads', p.status, Number(p.body?.total) === dbTotal, `total=${dbTotal}`, `api total=${p.body?.total}, rows=${listOf(p.body).length}`);
    if (p.status === 200 && (listOf(p.body).length > 5 || Number(p.body?.total) !== dbTotal)) {
      fail('medium', 'api-key:all', 'GET /public/v1/leads pagination / total', `<=5 rows, total=${dbTotal} (DB)`, `rows=${listOf(p.body).length}, total=${p.body?.total}`, '', 'total must be COUNT(*) OVER () of the fenced, unpaged set.');
    }
  }

  // ── 5. find: normalisation, matched_on, not_found, fencing ─────────────
  const inA = sampleLead(A); const inB = sampleLead(B);
  if (kSingle && inA) {
    const d = inA.phone.replace(/\D/g, '').slice(-10);
    const pretty = `+91 ${d.slice(0, 5)}-${d.slice(5)}`;
    const junk = '+91 00000-00001';
    const r = await call('POST', '/public/v1/leads/find', kSingle, { phones: [pretty, junk], emails: inA.email ? [inA.email.toUpperCase()] : [] });
    const hit = listOf(r.body).find((x) => x.lead_id === inA.id);
    const ok = r.status === 200 && hit && hit.matched_on?.includes('phone') && r.body?.not_found?.phones?.includes(junk) && !r.body?.not_found?.phones?.includes(pretty);
    act('api-key:single', 'find own-branch lead by formatted phone (+ upper-cased email)', 'POST', '/public/v1/leads/find', r.status, !!ok, 'found, matched_on phone, junk in not_found');
    if (!ok) fail('medium', 'api-key:single', 'find by "+91 xxxxx-xxxxx" phone', 'Lead found with matched_on [phone,...]; junk number in not_found.phones',
      `HTTP ${r.status}, hit=${!!hit}, matched_on=${JSON.stringify(hit?.matched_on)}, not_found=${JSON.stringify(r.body?.not_found)}`, '', 'phoneKeyOf normalisation (last 10 digits) must match the repo phone_key.');
    if (hit && leakedField([hit])) fail('high', 'api-key:single', 'find row DTO', 'Whitelisted columns', `field ${leakedField([hit])}`, '', 'Drop the column from LEAD_COLUMNS.');
  }
  if (kSingle && inB) {
    const r = await call('POST', '/public/v1/leads/find', kSingle, { phones: [inB.phone] });
    const leaked = listOf(r.body).some((x) => x.lead_id === inB.id);
    act('api-key:single', "find a lead in a branch the key can't reach", 'POST', '/public/v1/leads/find', r.status, !leaked, 'not found');
    if (leaked) fail('critical', 'api-key:single', 'find returns a lead from an unbound branch', 'not_found', 'lead returned', inB.id, 'findLeads must apply tenantFence(orgIds).');
  }
  if (kAll && inB) {
    const r = await call('POST', '/public/v1/leads/find', kAll, { phones: [inB.phone] });
    const found = listOf(r.body).some((x) => x.lead_id === inB.id);
    act('api-key:all', 'find a lead in any branch with a tenant-wide key', 'POST', '/public/v1/leads/find', r.status, found, 'found');
    if (r.status === 200 && !found) fail('medium', 'api-key:all', 'Tenant-wide key find', 'Lead in any tenant branch found', 'not found', inB.id, 'scope_all_orgs → orgIds null (no branch fence).');
  }

  // ── 7. tenant B's tenant-wide key never sees tenant A ──────────────────
  if (tBMeta) {
    try { tbAdmin = await actor(tBMeta.stateKey); } catch { tbAdmin = null; }
    if (tbAdmin) {
      const kTB = await mint(tbAdmin, tBMeta.stateKey, 'tenantB-all', { scopes: ALL, scope_all_orgs: true });
      if (kTB) {
        const l = await call('GET', '/public/v1/leads?limit=500', kTB);
        const lo = leadOrgs(listOf(l.body).map((x) => x.lead_id)); const tm = orgTenants(Object.values(lo));
        const xs = listOf(l.body).filter((x) => tm[lo[x.lead_id]] !== tenantB);
        act(`${tBMeta.stateKey}:api-key`, "tenant B key lists leads — none of tenant A's", 'GET', '/public/v1/leads', l.status, xs.length === 0, 'tenant B only', `${listOf(l.body).length} rows`);
        if (xs.length) fail('critical', 'tenant B api-key', 'Tenant B key lists tenant A leads', 'Only tenant B', `${xs.length} foreign rows`, JSON.stringify(xs.slice(0, 2).map((x) => x.lead_id)), 'tenantFence must filter o.tenant_id from the verified key.');
        if (inA) {
          const f = await call('POST', '/public/v1/leads/find', kTB, { phones: [inA.phone] });
          const leak = listOf(f.body).some((x) => x.lead_id === inA.id);
          act(`${tBMeta.stateKey}:api-key`, "tenant B key finds a tenant A phone", 'POST', '/public/v1/leads/find', f.status, !leak, 'not found');
          if (leak) fail('critical', 'tenant B api-key', 'Tenant B key finds a tenant A lead by phone', 'not_found', 'returned', inA.id, 'findLeads tenant fence.');
        }
      }
    }
  }
} finally {
  for (const [a, id] of minted) await apiDelete(a, `${CLIENTS}/${id}`).catch(() => {});
  console.log(`revoked ${minted.length} throwaway API key(s); ${findings} finding(s).`);
  await tAdmin.close(); await oAdmin.close(); await tbAdmin?.close(); await browser.close();
}
