// Issue #2 regression — revoking lms.apiclients must block the API IMMEDIATELY.
//
// The api-clients endpoints mint/rotate/delete integration credentials. Their
// server-side capability check read the process-level capability cache (5-minute
// TTL, LISTEN/NOTIFY invalidation). When the LISTEN subscription wasn't
// established, a revoke was ignored for up to 5 minutes and GET /api-clients kept
// returning 200 — the capability's whole promise defeated within that window.
//
// The fix resolves the capability FRESH (hasCapabilityFresh, bypassing the TTL
// cache) on these endpoints. This asserts that: revoke lms.apiclients for
// org_admin, then WITHOUT any wait/poll call GET {gateway}/api-clients and require
// a 403 on the very first call — no TTL grace. Restored in a finally block.
//
//   node suites/capability/apiclients-fresh-revoke.mjs
import { record, roleMeta, cfg } from '../../lib.mjs';
import { actor, apiGet } from '../../conc.mjs';
import { dbReachable } from '../../db.mjs';
import { tenantIdForOrg, resolvedCapabilities, setOverride, restoreAll, pendingOverrides } from '../../capability.mjs';

const TOOL = 'capability';
const ROLE = 'org_admin';
const CAP = 'lms.apiclients';
const URL = `${cfg.gateway}/api-clients`;

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const org = roleMeta(ROLE).org;
const tenantId = tenantIdForOrg(org);
const a = await actor(ROLE);
let failures = 0;

try {
  // Baseline: the role must actually hold the capability, else there's nothing to revoke.
  const before = await apiGet(a, `${URL}?page=1&page_size=1`);
  const grantedBefore = resolvedCapabilities(tenantId, ROLE).get(CAP);
  console.log(`baseline: resolver=${grantedBefore} GET ${URL} -> ${before.status}`);
  if (!grantedBefore || before.status >= 400) {
    console.log(`  ${ROLE} does not hold ${CAP} (or API already blocked) — cannot exercise the revoke path.`);
    process.exit(0);
  }

  // Revoke, then IMMEDIATELY call — no waitForSessionCapability, no sleep. This is
  // the whole point: a fresh-resolving endpoint must deny on the first call.
  setOverride(tenantId, ROLE, CAP, false);
  const after = await apiGet(a, `${URL}?page=1&page_size=1`);
  console.log(`revoked (no wait): GET ${URL} -> ${after.status} (expect 403)`);

  if (after.status !== 403) {
    failures++;
    record(TOOL, {
      severity: 'critical', role: ROLE, tool: TOOL, page: `capability ${CAP} — ${URL}`,
      scenario: `Revoke '${CAP}' for ${ROLE}, then call GET /api-clients with NO TTL wait`,
      expected: 'The very first call after revoke returns 403 — credential endpoints resolve the capability fresh, not from the TTL cache',
      actual: `HTTP ${after.status} on the first post-revoke call. The revoke is not honored immediately; a stale cache still authorizes credential management.`,
      evidence: `cap=${CAP} role=${ROLE} tenant=${tenantId}; GET ${URL} -> ${after.status} (was ${before.status})`,
      proposedSolution: 'Keep requireApiClientCapability on hasCapabilityFresh (cache-bypassing) and ensure the capability-cache LISTEN subscription is asserted at identity-service boot.',
    });
  }
} finally {
  const n = restoreAll();
  if (n) console.log(`[cleanup] restored ${n} override(s)`);
  if (pendingOverrides()) console.error(`!! ${pendingOverrides()} override(s) COULD NOT be restored — run capability-toggle.mjs --restore-only`);
  await a.close();
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
