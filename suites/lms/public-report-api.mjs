// Public-facing lead report — NEW in msq-lms/msq-core since the last e2e pass
// (1807c39 "feat: public facing leads URL", msq-core cfb6e21 same name). Adds
// GET {gateway}/public/v1/lead-report, authenticated by a PARTNER API KEY (not
// a session), scoped to a tenant or a single branch, rendering an HTML report
// (services/leads-service/.../public-report.render.ts) meant to be opened
// directly in a browser (hence the `?key=` query fallback alongside the
// Authorization/X-Api-Key headers — see extractKey in public-auth.ts). Zero
// harness coverage previously; nothing in the harness had ever minted a public
// API key and called the gateway's /public/v1/* surface.
//
// Threat model exercised: this is a credential a partner keeps in a script or
// a bookmarked URL, so the checks that matter are auth/scope enforcement, not
// UI. Covers: no key (401), garbage key (401), key missing the required scope
// (403, proving scope is enforced per-endpoint not just per-key-exists), and
// the happy path via BOTH the Authorization header and the `?key=` query
// fallback the browser-open case relies on.
//
// Not covered here (recorded as an info finding): the multi-branch/tenant-wide
// key path (empty X-Org-Id, ?branch_id= validated against X-Allowed-Org-Ids /
// X-Scope-All-Orgs) — org_admin-minted keys are always single-org
// (resolveBranchScope in api-clients.service.ts), so exercising that branch
// needs a tenant_admin/super_admin-minted scope_all_orgs key against a tenant
// with 2+ orgs; left for a follow-up suite.
//
// Actor: org_admin mints the key (their own org only) and is also the normal
// session actor for setup/cleanup queries.
//
//   node suites/lms/public-report-api.mjs
import { record, roleMeta, cfg } from '../../lib.mjs';
import { actor, apiPost, apiDelete, readResp } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import { chromium } from '@playwright/test';

const TOOL = 'lms';
const GW = cfg.gateway;
const REPORT_URL = `${GW}/public/v1/lead-report`;
const CLIENTS_URL = `${GW}/api-clients`;
const ROLE = 'org_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgName = roleMeta(ROLE)?.org ?? 'FitClass - Gurgaon';
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
if (!orgId) { console.log('Could not resolve org — aborting'); process.exit(0); }

// A key-less request context (this IS the partner: no session cookie at all).
async function rawClient() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  return { request: ctx.request, async close() { await browser.close(); } };
}
const apiGetRaw = async (c, url, opts = {}) => readResp(await c.request.get(url, opts));

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: ROLE, tool: TOOL, page: 'Public lead-report API', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const stamp = Date.now();
const admin = await actor(ROLE);
const raw = await rawClient();
let clientId = null;
let rawKey = null;
let scopelessClientId = null;
try {
  // ── Setup: mint a single-org key with lead-report:read ────────────────────────
  const create = await apiPost(admin, CLIENTS_URL, { name: `E2E-report-key-${stamp}`, scopes: ['lead-report:read'] });
  clientId = create.body?.data?.id ?? null;
  rawKey = create.body?.data?.api_key ?? null;
  console.log(`0. mint key                http=${create.status} clientId=${clientId} hasRawKey=${!!rawKey}`);
  if (!rawKey) { console.log('Could not mint an api-client key — aborting'); process.exit(0); }

  // ── 1. No key at all → 401 ─────────────────────────────────────────────────────
  const noKey = await apiGetRaw(raw, REPORT_URL);
  console.log(`1. no key                  http=${noKey.status} (expect 401)`);
  if (noKey.status !== 401) {
    fail('high', 'Call the public lead-report endpoint with no API key', '401 "API key required"',
      `HTTP ${noKey.status}`, JSON.stringify(noKey.body), 'Keep publicApiKeyAuth rejecting an absent key/Authorization header before any downstream call.');
  }

  // ── 2. Garbage key → 401 ───────────────────────────────────────────────────────
  const badKey = await apiGetRaw(raw, REPORT_URL, { headers: { Authorization: 'Bearer not-a-real-key' } });
  console.log(`2. garbage key             http=${badKey.status} (expect 401)`);
  if (badKey.status !== 401) {
    fail('high', 'Call the public lead-report endpoint with an invalid API key', '401 "Invalid API key"',
      `HTTP ${badKey.status}`, JSON.stringify(badKey.body), 'hashApiKey(raw) must fail to resolve any client row for a garbage key — confirm no timing/enumeration leak either.');
  }

  // ── 3. Key WITHOUT the lead-report:read scope → 403 ───────────────────────────
  const scopeless = await apiPost(admin, CLIENTS_URL, { name: `E2E-noscope-key-${stamp}`, scopes: ['branches:read'] });
  scopelessClientId = scopeless.body?.data?.id ?? null;
  const scopelessKey = scopeless.body?.data?.api_key;
  if (scopelessKey) {
    const wrongScope = await apiGetRaw(raw, REPORT_URL, { headers: { Authorization: `Bearer ${scopelessKey}` } });
    console.log(`3. wrong-scope key         http=${wrongScope.status} (expect 403)`);
    if (wrongScope.status !== 403) {
      fail('critical', 'Call the lead-report endpoint with a valid key that lacks lead-report:read',
        '403 "API key is missing required scope: lead-report:read"',
        `HTTP ${wrongScope.status}`, JSON.stringify(wrongScope.body).slice(0, 200),
        'Enforce client.scopes.includes(requiredScope) per-route — a valid, active key must not grant every scope.');
    }
  }

  // ── 4. Happy path — Authorization: Bearer header ──────────────────────────────
  const ok = await apiGetRaw(raw, REPORT_URL, { headers: { Authorization: `Bearer ${rawKey}` } });
  const htmlOk = typeof ok.body === 'string' && /<html|<!doctype/i.test(ok.body);
  console.log(`4. valid key (header)      http=${ok.status} looksLikeHtml=${htmlOk}`);
  if (ok.status !== 200 || !htmlOk) {
    fail('high', 'Fetch the lead report with a valid, correctly-scoped API key (Authorization header)',
      'HTTP 200 with an HTML report page', `HTTP ${ok.status}, htmlOk=${htmlOk}`,
      typeof ok.body === 'string' ? ok.body.slice(0, 200) : JSON.stringify(ok.body).slice(0, 200),
      'Confirm buildTenantReport + renderPublicReportHtml succeed for a normal single-org key.');
  }

  // ── 5. Happy path — ?key= query fallback (the browser-open use case) ─────────
  const okQuery = await apiGetRaw(raw, `${REPORT_URL}?key=${encodeURIComponent(rawKey)}`);
  console.log(`5. valid key (?key= param) http=${okQuery.status} (expect 200)`);
  if (okQuery.status !== 200) {
    fail('medium', 'Open the report link with the key in the URL (?key=), no custom header',
      'HTTP 200 — this is the documented fallback for a bookmarked/emailed report link',
      `HTTP ${okQuery.status}`, JSON.stringify(okQuery.body).slice(0, 200),
      'Keep the query-param fallback in extractKey(); a partner cannot set custom headers by opening a URL in a browser.');
  }

  record(TOOL, {
    severity: 'info', role: 'n/a', tool: TOOL, page: 'Public lead-report API — coverage note',
    scenario: 'Multi-branch / tenant-wide key scoping (empty X-Org-Id, ?branch_id= vs X-Allowed-Org-Ids/X-Scope-All-Orgs)',
    expected: 'A follow-up suite exercises a tenant_admin/super_admin-minted scope_all_orgs key against a 2+-org tenant',
    actual: 'Not exercised — org_admin-minted keys are always resolveBranchScope-restricted to their own single org, so this run never produces a multi-org key to test branch_id gating with.',
    evidence: 'public-report.controller.ts resolveScope(): headerOrg short-circuits before ?branch_id= is even read for a single-org key.',
    proposedSolution: 'Add a tenant_admin actor + scope_all_orgs key to specifically test the branch_id-not-in-X-Allowed-Org-Ids 400 path.',
  });
} finally {
  await admin.close();
  await raw.close();
  if (clientId) await apiDelete(admin, `${CLIENTS_URL}/${clientId}`).catch(() => {});
  if (scopelessClientId) await apiDelete(admin, `${CLIENTS_URL}/${scopelessClientId}`).catch(() => {});
  console.log(`\ncleaned up api-client key(s) for stamp ${stamp}.`);
}
