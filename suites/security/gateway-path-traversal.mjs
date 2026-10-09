// Gateway path-param traversal — a logged-in user must not be able to steer a proxied request
// onto a service's secret-only /internal/* route.
//
// The gateway attaches X-Internal-Secret to every request it proxies, and the /internal/* routes
// of leads-service and hr-service (and meta-conversion-api's /capi/auto-trigger) take tenant /
// org / actor from the BODY. Route handlers build the upstream path from a path param, and
// find-my-way decodes %2F / %3F / %23 inside a param, so
//   POST /leads/..%2Finternal%2Fleads%2Fknown-contacts%23/transfer
// used to reach POST /api/v1/internal/leads/known-contacts with the gateway's secret.
//
// Three fences, each proven here against the running stack:
//   A. gateway preValidation hook  — a param with / \ ? # or a dot segment is a 400, on every
//      service's routes and every method
//   B. proxy.ts buildUpstreamUrl   — the built upstream path must resolve to itself (unit-tested
//      in api-gateway/src/lib/__tests__/upstream-url.test.ts; here: ordinary routes still proxy)
//   C. internal routes             — called from INSIDE the gateway container with the real
//      secret: accepted without a user identity (service-to-service), 401 as soon as the call
//      carries X-User-Id (what every gateway-proxied user request carries), 401 without the secret
//
// The service-to-service happy paths themselves (identity -> hr profile sync, identity -> leads
// reassign) are exercised end to end by suites/admin/team-user-contracts.mjs and
// suites/admin/user-management.mjs; the gateway-fronted /public/leads* routes, which DO carry a
// user context and must keep working, by suites/security/public-api-v2.mjs.
//
// Non-destructive by construction: the leads probe targets the read-only known-contacts oracle
// with a random tenant, and every write route is sent a body its schema rejects — so even on a
// stack where the hole is open, nothing is written.
//
// A traversal probe passes when the gateway answers 400 itself, or when the edge in front of it
// normalised the path away (404/405). It fails when the response came from the internal route:
// any 2xx, or the upstream's own 401 / 422.
//
//   node suites/security/gateway-path-traversal.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GATEWAY, authFile, HR_EMPLOYEE } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { req, anon, reporter, isOk } from '../../kit.mjs';

const rep_ = reporter('security', 'Gateway path traversal');
const { fail, log } = rep_;
const ROLE = HR_EMPLOYEE;
if (!fs.existsSync(authFile(ROLE))) { console.log(`${ROLE} login required - aborting`); process.exit(0); }

const ID = '99999999-9999-4999-8999-999999999999';
const T = GATEWAY;
const enc = (s) => s.replace(/\//g, '%2F').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/\\/g, '%5C');
const KC = { tenant_id: ID, emails: ['x@example.test'], phone_keys: [] };

// [label, method, url, body]
const PROBES = [
  // leads-service internal routes
  ['leads -> /internal/leads/known-contacts (fragment cut)', 'POST', `${T}/leads/${enc('../internal/leads/known-contacts#')}/transfer`, KC],
  ['leads -> /internal/leads/known-contacts (query cut)', 'POST', `${T}/leads/${enc('../internal/leads/known-contacts?x=')}/transfer`, KC],
  ['leads -> backslash dot segment', 'POST', `${T}/leads/${enc('..\\internal\\leads\\known-contacts#')}/transfer`, KC],
  ['leads -> /internal/leads/reassign-org (empty body)', 'POST', `${T}/leads/${enc('../internal/leads/reassign-org#')}/transfer`, {}],
  ['leads -> /internal/campaign-reclassify (empty body)', 'POST', `${T}/leads/${enc('../internal/campaign-reclassify#')}/transfer`, {}],
  // hr-service internal route, from two different HR routes
  ['hr -> /internal/employees/sync (empty body)', 'POST', `${T}/hr/documents/${enc('../internal/employees/sync#')}/review`, {}],
  ['hr -> /internal/employees/sync via a leave route', 'POST', `${T}/hr/leave/requests/${enc('../../internal/employees/sync#')}/approve`, {}],
  // meta-conversion-api secret-only route
  ['meta -> /capi/auto-trigger (empty body)', 'POST', `${T}/meta/lead-pull/runs/${enc('../../capi/auto-trigger#')}/discard`, {}],
  // other services and methods: the hook is global, not per route
  ['identity -> sibling route via PATCH', 'PATCH', `${T}/users/${enc('../auth/change-password#')}`, {}],
  ['identity -> sibling route via DELETE', 'DELETE', `${T}/users/${enc('../users#')}`, undefined],
  ['admin -> sibling route', 'GET', `${T}/roles/${enc('../tenants')}/capabilities`, undefined],
  ['tasks -> sibling route via dot segment', 'GET', `${T}/tasks/${enc('../task-lists')}/comments`, undefined],
  ['tasks -> encoded slash only', 'GET', `${T}/tasks/a${enc('/')}b`, undefined],
  ['tasks -> encoded question mark only', 'GET', `${T}/tasks/${ID}${enc('?scope=org')}/comments`, undefined],
  ['bare dot-dot param', 'GET', `${T}/tasks/../comments`, undefined],
];

const refused = (r) => (r.status === 400 && /invalid (path parameter|request path)/i.test(r.body?.error ?? '')) || r.status === 404 || r.status === 405;

async function runProbes(a, role, probes) {
  for (const [label, method, url, body] of probes) {
    const r = await req(a, method, url, body === undefined ? {} : { data: body });
    const ok = refused(r);
    log({ role, action: `traversal probe: ${label}`, method, endpoint: url.replace(T, ''), status: r.status, verified: ok, expected: '400 from the gateway (or 404 if the edge normalised it)' });
    if (isOk(r.status)) {
      fail('critical', role, `Path traversal reached an upstream route: ${label}`, '400 Invalid path parameter', `HTTP ${r.status}`, r.text.slice(0, 300), 'api-gateway rejectUnsafePathParams hook + buildUpstreamUrl in lib/proxy.ts.');
    } else if (!ok) {
      fail('high', role, `Path traversal was not refused by the gateway: ${label}`, '400 Invalid path parameter', `HTTP ${r.status} ${r.text.slice(0, 120)}`, r.text.slice(0, 300), 'The request was forwarded upstream; only the upstream route\'s own check stopped it.');
    }
  }
}

const a = await actor(ROLE);
const nobody = await anon();
try {
  // ── A. the gateway refuses the crafted param ──────────────────────────────────────────────
  console.log('== A. traversal probes (logged-in user) ==');
  await runProbes(a, ROLE, PROBES);

  // Pre-login routes carry the secret too (no user context), so the hook must run before auth.
  console.log('\n== A. traversal probes (no session) ==');
  await runProbes(nobody, 'anonymous', [
    // The public Meta webhook route takes a path param and proxies WITH the secret and WITHOUT a
    // user identity - so the internal routes' X-User-Id fence would not stop this one; only the
    // gateway guard does. It used to reach meta-conversion-api's /capi/auto-trigger unauthenticated.
    ['meta webhook POST -> /capi/auto-trigger (empty body)', 'POST', `${T}/meta/webhook/${enc('../capi/auto-trigger#')}`, {}],
    ['meta webhook GET -> sibling route', 'GET', `${T}/meta/webhook/${enc('../pages')}`, undefined],
    ['public branding key -> identity internal-secret route', 'GET', `${T}/public/branding/${enc('../../auth/me#')}`, undefined],
    ['public branding asset slot', 'GET', `${T}/public/branding/${ID}/assets/${enc('../../../users')}`, undefined],
  ]);

  // ── B. ordinary routes still proxy ────────────────────────────────────────────────────────
  console.log('\n== B. controls: the guard does not break real routes ==');
  const controls = [
    ['uuid param', 'GET', `${T}/tasks/${ID}`],
    ['uuid param + static suffix', 'GET', `${T}/tasks/${ID}/comments`],
    ['uuid param with a real query string', 'GET', `${T}/tasks/${ID}/comments?page=1&page_size=5`],
    ['no param, query string', 'GET', `${T}/tasks?scope=own&page=1&page_size=5`],
    ['static route', 'GET', `${T}/auth/me`],
  ];
  for (const [label, method, url] of controls) {
    const c = await req(a, method, url);
    const ok = c.status !== 400 && c.status > 0 && c.status < 500;
    log({ role: ROLE, action: `control: ${label}`, method, endpoint: url.replace(T, ''), status: c.status, verified: ok, expected: 'proxied (not 400, not 5xx)' });
    if (!ok) fail('high', ROLE, `Path guard broke an ordinary route: ${label}`, '2xx/403/404 from the service', `HTTP ${c.status}`, c.text.slice(0, 200), 'isSafePathParam / buildUpstreamUrl in api-gateway/src/lib/upstream-url.ts.');
  }
  const me = await req(a, 'GET', `${T}/auth/me`);
  if (!isOk(me.status)) fail('high', ROLE, 'GET /auth/me no longer proxies', '200', `HTTP ${me.status}`, me.text.slice(0, 160), '');

  // ── C. the internal routes' own fence ─────────────────────────────────────────────────────
  // From inside the gateway container: it holds the real secret and the service URLs, exactly
  // what a steered request would have carried.
  console.log('\n== C. internal routes: service-to-service only ==');
  try {
    const js = `
      const s=process.env.INTERNAL_SERVICE_SECRET;
      const U={hr:process.env.HR_SERVICE_URL,leads:process.env.LEADS_SERVICE_URL,meta:process.env.META_SERVICE_URL};
      const routes=[
        ['hr','/api/v1/internal/employees/sync',{}],
        ['leads','/api/v1/internal/leads/reassign-org',{}],
        ['leads','/api/v1/internal/leads/known-contacts',${JSON.stringify(KC)}],
        ['leads','/api/v1/internal/campaign-reclassify',{}],
        ['meta','/api/v1/capi/auto-trigger',{}],
      ];
      const call=async(svc,p,b,h)=>{ if(!U[svc]) return null; try{ const r=await fetch(U[svc]+p,{method:'POST',headers:Object.assign({'content-type':'application/json'},h),body:JSON.stringify(b)}); await r.text(); return r.status; }catch(e){ return -1; } };
      (async()=>{
        const out=[];
        for(const [svc,p,b] of routes){
          out.push({svc,p,
            s2s: await call(svc,p,b,{'x-internal-secret':s}),
            proxied: await call(svc,p,b,{'x-internal-secret':s,'x-user-id':'${ID}','x-org-id':'${ID}','x-platform-role':'user'}),
            nosecret: await call(svc,p,b,{}),
            wrong: await call(svc,p,b,{'x-internal-secret':'wrong'}),
          });
        }
        console.log(JSON.stringify(out));
      })();`;
    const out = JSON.parse(execFileSync('docker', ['exec', 'msq-api-gateway-1', 'node', '-e', js], { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim());
    for (const r of out) {
      if (r.s2s === null) { console.log(`  (${r.svc} URL not set in the gateway container - ${r.p} skipped)`); continue; }
      const ep = `${r.svc} ${r.p}`;
      // A user-proxied call is refused even with the right secret.
      log({ role: 'gateway-proxied user', action: 'internal route called with the secret AND a user identity', method: 'POST', endpoint: ep, status: r.proxied, verified: r.proxied === 401, expected: '401' });
      if (r.proxied !== 401) fail(isOk(r.proxied) ? 'critical' : 'high', 'gateway-proxied user', `Internal route accepts a request carrying X-User-Id: ${ep}`, '401', `HTTP ${r.proxied}`, JSON.stringify(r), 'authenticateInternal (hr) / authenticateServiceToService (leads) / handleAutoTrigger (meta) must refuse x-user-id.');
      // The secret is still required.
      log({ role: 'anonymous', action: 'internal route without / with a wrong secret', method: 'POST', endpoint: ep, status: r.nosecret, verified: r.nosecret === 401 && r.wrong === 401, expected: '401 / 401' });
      if (r.nosecret !== 401 || r.wrong !== 401) fail('critical', 'anonymous', `Internal route reachable without the internal secret: ${ep}`, '401', `none=${r.nosecret} wrong=${r.wrong}`, JSON.stringify(r), 'Shared-secret check.');
      // A real service-to-service call (secret, no user identity) still gets past auth: the
      // schema-rejected bodies answer 4xx-but-not-401, known-contacts answers 200.
      const through = r.s2s !== 401 && r.s2s !== 403 && r.s2s > 0;
      log({ role: 'service', action: 'internal route called service-to-service (secret, no user identity)', method: 'POST', endpoint: ep, status: r.s2s, verified: through, expected: 'past auth (200 or a validation 4xx/5xx, never 401)' });
      if (!through) fail('high', 'service', `Service-to-service call to an internal route is refused: ${ep}`, 'not 401/403', `HTTP ${r.s2s}`, JSON.stringify(r), 'The X-User-Id rule must not block callers that send only the secret (identity-service, gateway known-contacts, meta-conversion-api).');
    }
  } catch (e) {
    console.log(`  (gateway container probe skipped: ${String(e.message).split('\n')[0]})`);
    log({ role: 'service', action: 'internal-route fence (in-container probe)', method: 'POST', endpoint: '/internal/*', status: null, verified: false, expected: 'probe ran', note: 'docker exec msq-api-gateway-1 failed - section C NOT covered in this run' });
  }
} finally {
  await a.close().catch(() => {});
  await nobody.close?.().catch(() => {});
}
console.log(`\ngateway path traversal: ${rep_.state.actions} checks, ${rep_.state.findings} findings`);
