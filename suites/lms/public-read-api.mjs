// Public-facing single-lead read — NEW in msq-lms/msq-core since the last e2e
// pass (00b6a35 "bug fixes" added services/leads-service/.../public-read/;
// msq-core wired GET {gateway}/public/v1/leads/:id with publicApiKeyAuth
// ('leads:read')). Same partner-API-key model as public-report-api.mjs but the
// sharpest case here is different: PublicReadController.getLead deliberately
// returns 404, not 403, for a lead outside the key's branch scope — "same
// shape as a lead in another tenant: a caller with no visibility into this
// branch must not be able to distinguish 'wrong branch' from 'no such lead'."
// That is exactly the kind of thing a later refactor "helpfully" breaks by
// returning a 403 with a differently-shaped body, which then becomes an
// enumeration oracle. This suite asserts the SHAPE, not just the status code.
//
// Actor: org_admin mints a single-org key (their own org, per
// resolveBranchScope) and provides the session actor for setup/cleanup.
//
//   node suites/lms/public-read-api.mjs
import { record, roleMeta, cfg } from '../../lib.mjs';
import { actor, apiPost, apiDelete, readResp } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { chromium } from '@playwright/test';

const TOOL = 'lms';
const GW = cfg.gateway;
const CLIENTS_URL = `${GW}/api-clients`;
const ROLE = 'org_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const orgName = roleMeta(ROLE)?.org ?? 'FitClass - Gurgaon';
const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(orgName)} LIMIT 1`);
if (!orgId) { console.log('Could not resolve org — aborting'); process.exit(0); }

const ownLead = rows(`SELECT id FROM lms.marketing_leads WHERE org_id=${lit(orgId)} AND NOT is_deleted LIMIT 1`, ['id'])[0];
const otherOrgLead = rows(`SELECT id FROM lms.marketing_leads WHERE org_id<>${lit(orgId)} AND NOT is_deleted LIMIT 1`, ['id'])[0];
if (!ownLead) { console.log('No lead in-org to test with — aborting'); process.exit(0); }

async function rawClient() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  return { request: ctx.request, async close() { await browser.close(); } };
}
const apiGetRaw = async (c, url, opts = {}) => readResp(await c.request.get(url, opts));

const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: ROLE, tool: TOOL, page: 'Public lead-read API', scenario, expected, actual,
  evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});

const stamp = Date.now();
const admin = await actor(ROLE);
const raw = await rawClient();
let clientId = null;
try {
  const create = await apiPost(admin, CLIENTS_URL, { name: `E2E-readkey-${stamp}`, scopes: ['leads:read'] });
  clientId = create.body?.data?.id ?? null;
  const rawKey = create.body?.data?.api_key ?? null;
  console.log(`0. mint key                http=${create.status} clientId=${clientId} hasRawKey=${!!rawKey}`);
  if (!rawKey) { console.log('Could not mint an api-client key — aborting'); process.exit(0); }
  const auth = { headers: { Authorization: `Bearer ${rawKey}` } };

  // ── 1. Happy path — own-org lead ──────────────────────────────────────────────
  const own = await apiGetRaw(raw, `${GW}/public/v1/leads/${ownLead.id}`, auth);
  const hasOrgId = own.body && typeof own.body === 'object' && 'org_id' in (own.body.data ?? {});
  console.log(`1. own-org lead            http=${own.status} orgIdLeaked=${hasOrgId}`);
  if (own.status !== 200 || !own.body?.data) {
    fail('high', 'Fetch an in-scope lead via the public read API', 'HTTP 200 with the lead data',
      `HTTP ${own.status}`, JSON.stringify(own.body).slice(0, 200),
      'Confirm the key\'s single org_id resolves via X-Org-Id and getLeadById succeeds for a lead in that org.');
  } else if (hasOrgId) {
    fail('low', 'Public lead payload field-minimization', 'org_id is stripped from the response (const { org_id, ...data } = lead)',
      'org_id present in the public response body', `leadId=${ownLead.id}`,
      'Keep the org_id destructure-and-drop before sending — internal ids should not leak to partner integrations.');
  }

  // ── 2. Cross-org lead → 404, NOT 403, and same shape as a missing lead ───────
  if (otherOrgLead) {
    const missing = await apiGetRaw(raw, `${GW}/public/v1/leads/00000000-0000-0000-0000-000000000000`, auth);
    const cross = await apiGetRaw(raw, `${GW}/public/v1/leads/${otherOrgLead.id}`, auth);
    const sameShape = cross.status === missing.status && JSON.stringify(cross.body) === JSON.stringify(missing.body);
    console.log(`2. cross-org lead          http=${cross.status} (expect 404) sameShapeAsNotFound=${sameShape}`);
    if (cross.status !== 404) {
      fail('critical', 'Fetch a lead that exists but belongs to a DIFFERENT org than the key\'s scope',
        '404 "Lead not found" — indistinguishable from a genuinely missing id',
        `HTTP ${cross.status}`, JSON.stringify(cross.body).slice(0, 200),
        'isBranchAllowed()=false must throw NotFoundError, not ForbiddenError — a 403 here would let a partner enumerate which lead ids exist outside their scope.');
    } else if (!sameShape) {
      fail('medium', 'Out-of-scope lead vs genuinely-missing lead return identical response shapes',
        'Same status + body for a real lead in another org and a random nonexistent id',
        `cross=${JSON.stringify(cross.body).slice(0, 120)} vs missing=${JSON.stringify(missing.body).slice(0, 120)}`,
        `leadId=${otherOrgLead.id}`,
        'Route both the "out of branch scope" and "no such row" cases through the identical NotFoundError("Lead not found") so no body/message difference leaks scope info.');
    }
  } else {
    console.log('2. cross-org lead — skipped, no lead in a second org resolvable');
  }

  // ── 3. Malformed id → 400, not 500 ────────────────────────────────────────────
  const bad = await apiGetRaw(raw, `${GW}/public/v1/leads/not-a-uuid`, auth);
  console.log(`3. malformed id            http=${bad.status} (expect 4xx)`);
  if (bad.status < 400 || bad.status >= 500) {
    fail('low', 'Fetch a lead with a non-UUID id', 'Clean 400 "id must be a valid UUID"',
      `HTTP ${bad.status}`, JSON.stringify(bad.body).slice(0, 200),
      'Keep the UUID_RE validation ahead of any DB call.');
  }

  // ── 4. No key → 401 ────────────────────────────────────────────────────────────
  const noKey = await apiGetRaw(raw, `${GW}/public/v1/leads/${ownLead.id}`);
  console.log(`4. no key                  http=${noKey.status} (expect 401)`);
  if (noKey.status !== 401) {
    fail('high', 'Call the public lead-read endpoint with no API key', '401 "API key required"',
      `HTTP ${noKey.status}`, JSON.stringify(noKey.body), 'publicApiKeyAuth must reject before the route handler runs.');
  }
} finally {
  await admin.close();
  await raw.close();
  if (clientId) await apiDelete(admin, `${CLIENTS_URL}/${clientId}`).catch(() => {});
  console.log(`\ncleaned up api-client key for stamp ${stamp}.`);
}
