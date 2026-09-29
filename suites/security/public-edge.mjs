// Public edge — everything reachable WITHOUT a user session.
//
// The gateway's unauthenticated surface grew since the last pass: partner API
// reads (/public/v1/branches, /users, /locations/*), key rotation, four Meta
// webhook routes, and the JWKS endpoint. None had a test. This proves, against
// the running gateway:
//
//   1. API-key SCOPE is enforced per route  — a branches:read key cannot read
//      /users or /locations (403), and no key at all is 401.
//   2. BRANCH BINDING of a single-org key   — /branches returns only that org.
//   3. FIELD MINIMIZATION                   — no password/hash/token material in
//      /public/v1/users, ever (critical if present).
//   4. KEY ROTATION                         — after POST /api-clients/:id/rotate
//      the old key is dead (401) and the new one works; rotating mints a new
//      row, so cleanup revokes the NEW id.
//   5. WEBHOOKS                             — /intake/webhook without/with a
//      wrong X-Api-Key is 401; Meta verify with a wrong verify_token must not
//      echo hub.challenge; a Meta POST with a forged signature must not be
//      accepted and must not 5xx (that route does a DB read + AES decrypt
//      BEFORE it can reject, which is why it is rate-limited).
//   6. JWKS                                 — publishes PUBLIC key params only;
//      a private component (d, p, q, dp, dq, qi) is a critical key leak.
//   7. EDGE HEADERS + CORS                  — nosniff / DENY / no-referrer on
//      responses; a foreign Origin is never reflected with credentials.
//
//   node suites/security/public-edge.mjs
import { roleMeta, GATEWAY, GATEWAY_DIRECT } from '../../lib.mjs';
import { actor, apiPost, apiDelete, readResp } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import { finder, isOk, leakOf } from '../../fixtures.mjs';
import { request as pwRequest } from '@playwright/test';
import { LOCAL_ENV } from '../../localenv.mjs';

const TOOL = 'security';
const ROLE = 'org_admin';
const fail = finder(TOOL, 'Public edge (API keys, webhooks, JWKS)');

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta(ROLE)?.org ?? '')} LIMIT 1`);
const tenantId = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgId)}`);
if (!orgId) { console.log('Could not resolve org — aborting'); process.exit(0); }

const raw = await pwRequest.newContext();
const get = async (url, headers = {}) => readResp(await raw.get(url, { headers, failOnStatusCode: false, maxRedirects: 0 }));
const post = async (url, data, headers = {}) => readResp(await raw.post(url, { data, headers, failOnStatusCode: false }));
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

let admin = await actor(ROLE);
let minterRole = ROLE;
const minted = []; // client ids to revoke
const stamp = Date.now();
async function mint(scopes) {
  // org_admin mints a key pinned to its own branch. When the tenant does not
  // grant org_admin platform.api_tokens (tenant config, not a defect), fall
  // back to tenant_admin with org_ids=[orgId] — the same single-branch binding.
  const body = { name: `E2E-edge-${scopes.join('+')}-${stamp}`, scopes, ...(minterRole === 'tenant_admin' ? { org_ids: [orgId] } : {}) };
  let r = await apiPost(admin, `${GATEWAY}/api-clients`, body);
  if (r.status === 403 && minterRole === ROLE) {
    fail('info', ROLE, 'Mint partner API keys as org_admin', '201 if the tenant grants platform.api_tokens to org_admin', 'HTTP 403 — not granted in this tenant',
      JSON.stringify(r.body).slice(0, 200), 'Tenant configuration; the capability gate works. Falling back to tenant_admin with a single-branch key.');
    await admin.close(); admin = await actor('tenant_admin'); minterRole = 'tenant_admin';
    r = await apiPost(admin, `${GATEWAY}/api-clients`, { ...body, org_ids: [orgId] });
  }
  const id = r.body?.data?.id; const key = r.body?.data?.api_key;
  if (id) minted.push(id);
  return { status: r.status, id, key, body: r.body };
}

try {
  // ── 1–3. Scope, binding, minimization ──────────────────────────────────────
  const br = await mint(['branches:read']);
  const us = await mint(['users:read']);
  console.log(`mint branches:read http=${br.status}  users:read http=${us.status}`);
  if (!br.key || !us.key) {
    fail('high', ROLE, 'Mint partner API keys as org_admin', '201 with a one-time api_key', `branches=${br.status} users=${us.status}`,
      JSON.stringify(br.body).slice(0, 200), 'POST /api-clients must return the raw key once; check the api-clients capability grant for org_admin.');
  } else {
    const noKey = await get(`${GATEWAY}/public/v1/branches`);
    if (noKey.status !== 401) fail('high', 'anonymous', 'GET /public/v1/branches with no API key', '401', `HTTP ${noKey.status}`, JSON.stringify(noKey.body).slice(0, 200), 'publicApiKeyAuth must reject before the handler.');

    const junk = await get(`${GATEWAY}/public/v1/branches`, bearer(`msq_${'x'.repeat(40)}`));
    if (junk.status !== 401) fail('high', 'anonymous', 'GET /public/v1/branches with a forged key', '401', `HTTP ${junk.status}`, JSON.stringify(junk.body).slice(0, 200), 'Reject unknown key prefixes/hashes with 401 (constant time).');

    const branches = await get(`${GATEWAY}/public/v1/branches`, bearer(br.key));
    const list = Array.isArray(branches.body?.data) ? branches.body.data : [];
    const foreign = list.filter((b) => b.id && b.id !== orgId);
    console.log(`branches (own key)  http=${branches.status} rows=${list.length} foreign=${foreign.length}`);
    if (!isOk(branches.status)) {
      fail('high', ROLE, 'Read /public/v1/branches with a branches:read key', '200 with the key\'s branch', `HTTP ${branches.status}`, JSON.stringify(branches.body).slice(0, 200), 'Check public-read.controller branches handler and the X-Org-Id binding from publicScopeHeaders().');
    } else if (foreign.length) {
      const otherTenant = foreign.filter((b) => scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(b.id)}`) !== tenantId);
      fail(otherTenant.length ? 'critical' : 'high', ROLE, 'A single-branch API key lists other branches',
        `Only the key's own branch (${orgId})`, `${foreign.length} other branch(es) returned${otherTenant.length ? `, ${otherTenant.length} from ANOTHER TENANT` : ''}`,
        JSON.stringify(foreign.slice(0, 3)).slice(0, 300), 'Apply the key\'s org_id (publicScopeHeaders X-Org-Id) as a filter in listBranches — scope_all_orgs=false must narrow to one org.');
    }

    for (const [p, label] of [['/public/v1/users', 'users'], ['/public/v1/locations/countries', 'locations']]) {
      const r = await get(`${GATEWAY}${p}`, bearer(br.key));
      console.log(`${label.padEnd(10)} with branches key http=${r.status} (expect 403)`);
      if (isOk(r.status)) fail('high', ROLE, `A branches:read key reads ${p}`, '403 — missing scope', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), `publicApiKeyAuth('${label === 'users' ? 'users:read' : 'locations:read'}') must check the key's scopes, not just its validity.`);
    }

    const users = await get(`${GATEWAY}/public/v1/users`, bearer(us.key));
    const secretKey = JSON.stringify(users.body ?? '').match(/"(password[a-z_]*|pwd[a-z_]*|[a-z_]*hash|token|jti|mfa[a-z_]*|otp[a-z_]*)"\s*:/i);
    console.log(`users (users key)   http=${users.status} secretField=${secretKey ? secretKey[1] : 'none'}`);
    if (secretKey) fail('critical', ROLE, '/public/v1/users exposes credential material', 'Field-minimized DTO: no password/hash/token fields', `field "${secretKey[1]}" present`, JSON.stringify(users.body).slice(0, 300), 'Select explicit columns in public-read.repository listUsers; never spread the iam.users row.');
    const uList = Array.isArray(users.body?.data) ? users.body.data : [];
    const xUsers = uList.filter((u) => u.id && scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.id=${lit(u.id)}`) !== tenantId);
    if (xUsers.length) fail('critical', ROLE, '/public/v1/users returns users of another tenant', `Only tenant ${tenantId}`, `${xUsers.length} foreign user(s)`, JSON.stringify(xUsers.slice(0, 2)).slice(0, 300), 'Scope listUsers by the key\'s tenant_id (and org when bound).');

    // ── 4. Rotation ──────────────────────────────────────────────────────────
    const rot = await apiPost(admin, `${GATEWAY}/api-clients/${br.id}/rotate`, {});
    const newKey = rot.body?.data?.api_key; const newId = rot.body?.data?.id;
    if (newId && !minted.includes(newId)) minted.push(newId);
    const oldAfter = await get(`${GATEWAY}/public/v1/branches`, bearer(br.key));
    const newAfter = newKey ? await get(`${GATEWAY}/public/v1/branches`, bearer(newKey)) : { status: 0 };
    console.log(`rotate http=${rot.status} old-key=${oldAfter.status} (expect 401) new-key=${newAfter.status} (expect 200)`);
    if (!isOk(rot.status)) fail('medium', ROLE, 'Rotate an API key', '2xx with a new one-time api_key', `HTTP ${rot.status}`, JSON.stringify(rot.body).slice(0, 200), 'Check rotateApiClient / its capability gate.');
    else {
      if (oldAfter.status !== 401) fail('critical', ROLE, 'The PREVIOUS key still works after rotation', '401 immediately — rotation is how a leaked key is killed', `old key → HTTP ${oldAfter.status}`, `client=${br.id}`, 'rotateApiClient must revoke the previous row in the same transaction, and the gateway key cache must not outlive a revocation.');
      if (!isOk(newAfter.status)) fail('high', ROLE, 'The NEW key does not work after rotation', '200', `new key → HTTP ${newAfter.status}`, `newId=${newId}`, 'The rotated row must carry the old scopes/org binding and be active.');
    }
  }

  // ── 5. Webhooks ────────────────────────────────────────────────────────────
  const intakeNo = await post(`${GATEWAY_DIRECT}/intake/webhook`, { first_name: 'e2e' });
  const intakeBad = await post(`${GATEWAY_DIRECT}/intake/webhook`, { first_name: 'e2e' }, { 'X-Api-Key': 'wrong-key' });
  console.log(`intake webhook no-key=${intakeNo.status} wrong-key=${intakeBad.status} (expect 401/401)`);
  for (const [lbl, r] of [['no key', intakeNo], ['wrong key', intakeBad]]) {
    if (r.status !== 401) fail(isOk(r.status) ? 'critical' : 'high', 'anonymous', `POST /intake/webhook with ${lbl}`, '401 Invalid or missing API key', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Keep the safeEqual(X-Api-Key, WEBHOOK_API_KEY) check ahead of the proxy.');
  }

  const challenge = `e2e${stamp}`;
  const verify = await get(`${GATEWAY_DIRECT}/meta/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=${challenge}`);
  const echoed = JSON.stringify(verify.body ?? '').includes(challenge);
  console.log(`meta verify (wrong token) http=${verify.status} echoed=${echoed}`);
  if (echoed || isOk(verify.status)) fail('critical', 'anonymous', 'Meta webhook subscription verify with a WRONG verify_token', '403 and no echo of hub.challenge', `HTTP ${verify.status}, challenge echoed=${echoed}`, JSON.stringify(verify.body).slice(0, 200), 'Only echo hub.challenge when hub.verify_token matches the configured token (constant-time compare).');
  else if (verify.status >= 500) fail('high', 'anonymous', 'Meta webhook verify with a wrong token 5xxs', '4xx', `HTTP ${verify.status}`, JSON.stringify(verify.body).slice(0, 200), 'Handle the no-config / mismatch path as a 403, not an exception.');

  const forged = { object: 'page', entry: [{ id: '0', time: Math.floor(stamp / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: `e2e-${stamp}`, page_id: '0', form_id: '0' } }] }] };
  for (const [url, lbl] of [[`${GATEWAY_DIRECT}/meta/webhook`, 'shared'], [`${GATEWAY_DIRECT}/meta/webhook/00000000-0000-4000-8000-000000000000`, 'per-integration']]) {
    const r = await post(url, forged, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
    console.log(`meta POST forged sig (${lbl}) http=${r.status}`);
    if (isOk(r.status)) fail('critical', 'anonymous', `Meta webhook (${lbl}) accepts a payload with a forged X-Hub-Signature-256`, '401/403 — HMAC must verify against the app secret before anything is stored', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'Verify the HMAC over the RAW body (proxyToRaw) before enqueueing; reject on mismatch.');
    else if (r.status >= 500) fail('high', 'anonymous', `Meta webhook (${lbl}) 5xxs on a forged signature`, '401/403/404', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'An unknown integration id or a bad signature is a client error; map it to 4xx so floods do not page on-call.');
    const leak = leakOf(r.body); if (leak) fail('medium', 'anonymous', `Meta webhook (${lbl}) leaks internals on rejection`, 'Generic error body', leak, url, 'Return a fixed { success:false, error } body.');
  }

  // ── 6. JWKS ────────────────────────────────────────────────────────────────
  const jwks = await get(`${GATEWAY_DIRECT}/.well-known/jwks.json`);
  const keys = Array.isArray(jwks.body?.keys) ? jwks.body.keys : [];
  const priv = keys.filter((k) => ['d', 'p', 'q', 'dp', 'dq', 'qi'].some((f) => f in k));
  console.log(`jwks http=${jwks.status} keys=${keys.length} privateParams=${priv.length}`);
  if (priv.length) fail('critical', 'anonymous', 'JWKS publishes PRIVATE key material', 'Only kty/n/e/kid/alg/use', `private params on ${priv.length} key(s)`, JSON.stringify(Object.keys(priv[0])), 'Export with the public key only (crypto.createPublicKey(...).export({ format: "jwk" })); rotate the signing key immediately.');
  // No RS256 key configured (JWT_PUBLIC_KEY unset, HS256 only) => an empty
  // JWKS is the correct answer for this environment, not a defect.
  const rsConfigured = !!(LOCAL_ENV.JWT_PUBLIC_KEY || LOCAL_ENV.JWT_PRIVATE_KEY);
  if (!isOk(jwks.status) || !keys.length) fail(isOk(jwks.status) && !rsConfigured ? 'info' : 'medium', 'anonymous', 'JWKS endpoint is empty or failing', '200 with at least one RS256 key', `HTTP ${jwks.status}, keys=${keys.length}`, JSON.stringify(jwks.body).slice(0, 200), 'Other apps verify CRM tokens against this; an empty set breaks them.');

  // ── 7. Headers + CORS ──────────────────────────────────────────────────────
  const h = await raw.get(`${GATEWAY_DIRECT}/health`, { failOnStatusCode: false });
  const hdr = h.headers();
  const missing = [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer']]
    .filter(([k, v]) => String(hdr[k] || '').toLowerCase() !== v.toLowerCase()).map(([k]) => k);
  if (missing.length) fail('medium', 'anonymous', 'Gateway security headers missing', 'nosniff, DENY, no-referrer on every response (onSend hook)', `missing/wrong: ${missing.join(', ')}`, JSON.stringify(hdr).slice(0, 300), 'Keep the onSend header hook registered before any route in api-gateway/src/server.ts.');

  const evil = 'https://evil.example.com';
  const pre = await raw.fetch(`${GATEWAY_DIRECT}/leads`, { method: 'OPTIONS', headers: { Origin: evil, 'Access-Control-Request-Method': 'GET' }, failOnStatusCode: false });
  const acao = pre.headers()['access-control-allow-origin'];
  console.log(`CORS preflight from evil origin -> ACAO=${acao ?? '(none)'}`);
  if (acao === evil || acao === '*') fail('critical', 'anonymous', 'CORS reflects an arbitrary Origin on a credentialed API', `No Access-Control-Allow-Origin for ${evil}`, `ACAO=${acao}`, JSON.stringify(pre.headers()).slice(0, 300), 'Set @fastify/cors origin to the exact configured web origin; never reflect the request Origin with credentials:true.');
} finally {
  for (const id of minted) await apiDelete(admin, `${GATEWAY}/api-clients/${id}`).catch(() => {});
  await admin.close();
  await raw.dispose();
  console.log(`\nrevoked ${minted.length} throwaway API client(s).`);
}
