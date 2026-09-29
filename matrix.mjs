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
import { ROLES, roleMeta, record, authFile, GATEWAY } from './lib.mjs';
import { actor, apiGet } from './conc.mjs';
import { logAction, outcomeOf } from './journal.mjs';
import fs from 'node:fs';

// The capabilities this session actually holds, as identity-service resolves
// them right now (tenant overrides, parent-denial cascade and all). This is
// exactly what the services' requireCapability() checks, so it is the honest
// expectation for a capability-gated endpoint — a rank threshold is not: role
// names and ranks are not the authorization boundary on this platform.
export async function sessionCaps(a) {
  const me = await apiGet(a, `${GATEWAY}/auth/me`).catch(() => null);
  const caps = me?.body?.data?.user?.capabilities;
  return Array.isArray(caps) ? new Set(caps) : null;
}

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
  // Capability key (or array = any-of) the endpoint is gated on. Each role's
  // expectation is read from its own /auth/me at run time. Roles listed in
  // `observe` (default super_admin, whose platform bypasses differ per
  // service) are logged but not graded.
  capability = null, observe = ['super_admin'],
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

  const capLabel = capability ? (Array.isArray(capability) ? capability.join(' | ') : capability) : null;
  const results = [];
  for (const role of roles) {
    if (!fs.existsSync(authFile(role))) continue;
    let a;
    try { a = await actor(role); } catch { continue; }
    let status = 0, body = null, persisted = null;
    let capExpected;
    if (capability) {
      const caps = await sessionCaps(a);
      const keys = Array.isArray(capability) ? capability : [capability];
      capExpected = observe.includes(role) || !caps ? null : keys.some((k) => caps.has(k));
    }
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
    const exp = capability ? capExpected : expected(role);
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

    // A 5xx is a defect whoever the caller is: a denied role must get a clean
    // 403, an allowed one a 2xx. The classic cause here is a role that resolves
    // without platform.write, so withRoleTx opens a READ ONLY transaction and
    // the INSERT dies as PG 25006 -> bare 500 (custom tenant roles, 2026-09-28).
    if (status >= 500) {
      record(tool, {
        severity: 'high', role, tool, page: endpoint,
        scenario: `${role} (rank ${rank}) attempts: ${action} — server error`,
        expected: 'A clean 2xx (allowed) or 4xx (denied / invalid) — never a 5xx',
        actual: `HTTP ${status}`,
        evidence: JSON.stringify({ role, rank, status, body: typeof body === 'string' ? body.slice(0, 200) : body }).slice(0, 500),
        proposedSolution: 'Grep the service log for this request. "cannot execute INSERT in a read-only transaction" means the role lacks platform.write (check iam.fn_role_capability_matrix); otherwise map the thrown error to an AppError subclass instead of a plain Error.',
      });
    }
    if (exp === null) continue;
    if (succeeded && !exp) {
      record(tool, {
        severity: severityOver, role, tool,
        page: endpoint,
        scenario: `${role} (rank ${rank}) attempts: ${action}`,
        expected: capability
          ? `${role}'s session does not hold ${capLabel}; the action should be rejected`
          : allow
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
        expected: capability
          ? `${role}'s session holds ${capLabel}, so the action should succeed`
          : `${role} is at/above the required rank and should be able to perform this action`,
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
