// Role-matrix helper.
//
// The existing write tests each run as one or two hardcoded roles, so "can this
// role actually do this?" was never answered for most of the ladder. This runs
// ONE action as EVERY role and asserts the outcome against an expectation
// expressed as a rank threshold, then reports the two failure directions
// separately because they are very different bugs:
//
//   * under-permitted — a role that SHOULD be able to act gets 403/404. Broken
//     feature for a legitimate user.
//   * OVER-permitted — a role that should NOT be able to act succeeds. That is
//     a privilege escalation, and it is graded high/critical.
//
// Each role gets its own request (no shared sessions), and an optional verify()
// re-reads the backend so we grade on what actually persisted, not on the HTTP
// status alone — a 2xx that changed nothing is not "allowed".
import { ROLES, roleMeta, record, authFile } from './lib.mjs';
import { actor } from './conc.mjs';
import { logAction, outcomeOf } from './journal.mjs';
import fs from 'node:fs';

// Run `act(actorHandle)` as every role.
//
//   opts.minRank   – roles at/above this rank are expected to succeed
//   opts.allow     – explicit role allowlist (overrides minRank when given)
//   opts.verify    – optional () => boolean, "did it really take effect?"
//   opts.cleanup   – optional (role) => void, run after each role's attempt
//   opts.severityOver – severity for over-permitted (default 'high')
export async function runRoleMatrix({
  tool, action, endpoint, act,
  minRank = null, allow = null,
  verify = null, cleanup = null,
  severityOver = 'high', severityUnder = 'medium',
  roles = ROLES,
  // Reporting context: which page/tab this action belongs to, so the final
  // report can be grouped tool -> page -> tab -> action.
  area = null, tab = null,
}) {
  const expected = (role) => {
    if (allow) return allow.includes(role);
    const meta = roleMeta(role);
    return minRank != null && meta ? meta.rank >= minRank : null; // null = no expectation
  };

  const results = [];
  for (const role of roles) {
    if (!fs.existsSync(authFile(role))) continue;
    let a;
    try { a = await actor(role); } catch { continue; }
    let status = 0, body = null, persisted = null;
    try {
      const res = await act(a, role);
      status = res?.status ?? 0;
      body = res?.body ?? null;
      if (verify) persisted = await verify(role);
    } catch (e) {
      status = -1; body = String(e.message).slice(0, 160);
    } finally {
      try { if (cleanup) await cleanup(role); } catch {}
      await a.close();
    }

    // "Succeeded" means 2xx AND (if we can check) it actually persisted.
    const httpOk = status >= 200 && status < 300;
    const succeeded = verify ? (httpOk && persisted === true) : httpOk;
    const exp = expected(role);
    const rank = roleMeta(role)?.rank ?? '?';
    results.push({ role, rank, status, succeeded, expected: exp, persisted });

    const verdict = exp === null ? 'observed'
      : succeeded === exp ? 'ok'
      : succeeded ? 'OVER-PERMITTED' : 'under-permitted';
    console.log(`  ${role.padEnd(24)} rank=${String(rank).padStart(4)} http=${String(status).padStart(4)} ${verify ? `persisted=${persisted} ` : ''}${verdict}`);

    // Journal every attempt — the report needs the successes too, not just the
    // failures, to answer "what did each role actually do here?".
    const [mth, ep] = String(endpoint).split(/\s+/, 2);
    logAction({
      tool, role, area, tab, action,
      method: /^(GET|POST|PATCH|PUT|DELETE)$/i.test(mth) ? mth.toUpperCase() : 'API',
      endpoint: ep || endpoint,
      status, outcome: outcomeOf(status, verify ? persisted : null),
      verified: verify ? persisted : null,
      expected: exp === null ? 'observed only' : exp ? 'allowed' : 'denied',
      note: verdict === 'ok' ? '' : verdict,
    });

    if (exp === null) continue;
    if (succeeded && !exp) {
      record(tool, {
        severity: severityOver, role, tool,
        page: endpoint,
        scenario: `${role} (rank ${rank}) attempts: ${action}`,
        expected: allow
          ? `Only ${allow.join(', ')} may perform this action; ${role} should be rejected`
          : `Only roles at rank >= ${minRank} may perform this action; ${role} is rank ${rank} and should be rejected`,
        actual: `The action SUCCEEDED (HTTP ${status}${verify ? `, change persisted in the backend` : ''}) — ${role} can perform an action above its privilege level.`,
        evidence: JSON.stringify({ role, rank, status, persisted, body: typeof body === 'string' ? body.slice(0, 200) : body }).slice(0, 500),
        proposedSolution: `Enforce the rank/capability check server-side for ${endpoint} (hiding the control in the UI is not authorization). Add a regression test pinning ${role} to a 403 here.`,
      });
    } else if (!succeeded && exp) {
      record(tool, {
        severity: severityUnder, role, tool,
        page: endpoint,
        scenario: `${role} (rank ${rank}) attempts: ${action}`,
        expected: `${role} is at/above the required rank and should be able to perform this action`,
        actual: `The action FAILED (HTTP ${status}${verify && httpOk ? ', returned 2xx but nothing persisted' : ''}) — a legitimate user is blocked from a feature they should have.`,
        evidence: JSON.stringify({ role, rank, status, persisted, body: typeof body === 'string' ? body.slice(0, 200) : body }).slice(0, 500),
        proposedSolution: `Check the capability grant for ${role} and the guard on ${endpoint}; the UI gate and the service gate may be reading different ranks (a recurring issue in this codebase).`,
      });
    }
  }

  const over = results.filter((r) => r.expected === false && r.succeeded).map((r) => r.role);
  const under = results.filter((r) => r.expected === true && !r.succeeded).map((r) => r.role);
  console.log(`  => over-permitted: ${over.join(', ') || 'none'} | under-permitted: ${under.join(', ') || 'none'}`);
  return results;
}
