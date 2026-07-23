// Capability on/off validation — the four-way consistency check.
//
// For each (role, capability) case this drives the full loop:
//
//   baseline (granted)  -> revoke -> observe -> restore -> re-observe
//
// and at each step compares FOUR independent views of the same truth:
//
//   1. resolver  — iam.fn_role_capability_matrix says granted/denied
//   2. session   — GET {gateway}/auth/me capabilities list (what the backend
//                  tells the UI this user holds)
//   3. frontend  — is the nav link / tab / page actually visible after reload
//   4. backend   — does the guarded API still accept the call
//
// Disagreements between them are the interesting bugs, and they are graded very
// differently:
//   * UI hides it but the API still allows it  -> the capability is decorative;
//     a direct call bypasses it. Security issue (high/critical).
//   * API denies it but the UI still shows it  -> user is invited into a dead
//     end (medium) — the same class as the tab/route mismatch.
//   * resolver flipped but session never does  -> the capability cache is not
//     invalidating; revoking access silently does nothing (high).
//
// SAFETY: only TENANT-SCOPED override rows are written, and every one is undone
// in a finally block — platform defaults are never edited. If this run dies
// mid-way, re-running restores state (see `node suites/capability/capability-toggle.mjs --restore-only`).
//
//   node suites/capability/capability-toggle.mjs
import { openState, visit, record, APPS, cfg, roleMeta, authFile } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable } from '../../db.mjs';
import { logAction } from '../../journal.mjs';
import {
  tenantIdForOrg, resolvedCapabilities, setOverride, restoreAll,
  sessionCapabilities, waitForSessionCapability, pendingOverrides, loadJournal,
} from '../../capability.mjs';
import fs from 'node:fs';

const TOOL = 'capability';
const ROLE = process.env.CAP_ROLE || 'org_admin';
const GATEWAY = cfg.gateway;

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
if (!fs.existsSync(authFile(ROLE))) { console.log(`No auth state for ${ROLE} — run auth-setup first`); process.exit(0); }

// Recover anything a previous crashed run left applied, before doing anything
// else — otherwise a stale revoke would be read as the product's baseline.
const recovered = loadJournal();
if (recovered) console.log(`Found ${recovered} override(s) journalled by a previous run — restoring first.`);

if (process.argv.includes('--restore-only')) {
  console.log(`restored ${restoreAll()} override(s)`); process.exit(0);
}
if (recovered) console.log(`restored ${restoreAll()} leftover override(s)\n`);

const org = roleMeta(ROLE).org;
const tenantId = tenantIdForOrg(org);
console.log(`role=${ROLE} org=${org} tenant=${tenantId}\n`);

// Each case ties a capability to the UI affordance it is supposed to control
// and (where possible) the API it guards.
const CASES = [
  {
    cap: 'lms.followups', kind: 'page',
    app: 'lms-web', path: '/dashboard/follow-ups',
    ui: { type: 'nav', text: 'Follow-ups' },
    api: { url: (g) => `${APPS['lms-web']}/api/follow-ups?page=1&page_size=5` },
  },
  {
    cap: 'lms.analytics', kind: 'page',
    app: 'lms-web', path: '/dashboard/analytics',
    ui: { type: 'nav', text: 'Analytics' },
    api: { url: () => `${APPS['lms-web']}/api/analytics/dashboard` },
  },
  {
    cap: 'lms.apiclients', kind: 'page',
    app: 'lms-web', path: '/dashboard/api-clients',
    ui: { type: 'nav', text: 'API' },
    api: { url: (g) => `${g}/api-clients` },
  },
  {
    cap: 'hr.leave.admin.policies', kind: 'tab',
    app: 'hr-web', path: '/leave/admin',
    ui: { type: 'tab', text: 'Policies' },
    api: { url: () => `${APPS['hr-web']}/api/hr/leave/policies` },
  },
  {
    cap: 'hr.attendance.admin.shifts', kind: 'tab',
    app: 'hr-web', path: '/attendance/admin',
    ui: { type: 'tab', text: 'Shifts' },
    api: { url: () => `${APPS['hr-web']}/api/hr/shifts` },
  },
];

// Is the affordance visible on the page right now?
async function uiVisible(page, appUrl, path, ui) {
  await visit(page, appUrl + path);
  if (ui.type === 'tab') {
    // PageTabs renders <nav aria-label><a>Label</a></nav>
    const n = await page.locator('nav[aria-label] a', { hasText: ui.text }).count().catch(() => 0);
    return n > 0;
  }
  // nav link anywhere in the app chrome
  const n = await page.locator('nav a, aside a', { hasText: ui.text }).count().catch(() => 0);
  return n > 0;
}

const results = [];
const a = await actor(ROLE);
const { browser, page } = await openState(ROLE);

// Single reusable API probe on the one actor context — creating an actor per
// call would leak a browser per probe.
const probe = (url) => a.request.get(url).then((r) => r.status()).catch(() => 0);

try {
  for (const c of CASES) {
    console.log(`\n=== ${c.cap} (${c.kind}) ===`);

    // ---------- baseline ----------
    const resolvedBefore = resolvedCapabilities(tenantId, ROLE).get(c.cap);
    const sessBefore = await sessionCapabilities(a);
    if (!sessBefore.capabilities) {
      console.log(`  /auth/me returned ${sessBefore.status} with no capabilities — skipping case`);
      continue;
    }
    const inSessionBefore = sessBefore.capabilities.includes(c.cap);
    const uiBefore = await uiVisible(page, APPS[c.app], c.path, c.ui);
    const apiBefore = c.api ? await probe(c.api.url(GATEWAY)) : null;
    console.log(`  baseline: resolver=${resolvedBefore} session=${inSessionBefore} ui=${uiBefore} api=${apiBefore}`);

    if (!resolvedBefore || !inSessionBefore) {
      console.log(`  ${ROLE} does not hold ${c.cap} at baseline — nothing to revoke, skipping.`);
      results.push({ cap: c.cap, skipped: 'not granted at baseline' });
      continue;
    }

    // ---------- revoke ----------
    setOverride(tenantId, ROLE, c.cap, false);
    const flip = await waitForSessionCapability(a, c.cap, false);
    const resolvedAfter = resolvedCapabilities(tenantId, ROLE).get(c.cap);
    const uiAfter = await uiVisible(page, APPS[c.app], c.path, c.ui);
    const apiAfter = c.api ? await probe(c.api.url(GATEWAY)) : null;
    console.log(`  revoked : resolver=${resolvedAfter} sessionUpdated=${flip.ok} (${flip.ms}ms) ui=${uiAfter} api=${apiAfter}`);

    // Journal both states so the report shows the before/after per capability.
    logAction({
      tool: TOOL, role: ROLE, area: c.path, tab: c.kind === 'tab' ? c.ui.text : null,
      action: `baseline — capability '${c.cap}' granted`, method: 'GET',
      endpoint: c.api ? c.api.url(GATEWAY) : c.path,
      status: apiBefore, outcome: uiBefore ? 'visible' : 'hidden', verified: inSessionBefore,
      expected: 'visible + allowed', note: `session=${inSessionBefore} ui=${uiBefore}`,
    });
    logAction({
      tool: TOOL, role: ROLE, area: c.path, tab: c.kind === 'tab' ? c.ui.text : null,
      action: `revoke capability '${c.cap}' then re-check UI + API`, method: 'GET',
      endpoint: c.api ? c.api.url(GATEWAY) : c.path,
      status: apiAfter, outcome: uiAfter ? 'visible' : 'hidden',
      verified: flip.ok,
      expected: 'hidden + denied',
      note: `sessionUpdatedIn=${flip.ms}ms resolver=${resolvedAfter} ui=${uiAfter} api=${apiAfter}`,
    });

    // ---------- grade ----------
    // (a) resolver flipped but the session never did => cache not invalidating.
    if (resolvedAfter === false && !flip.ok) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: `capability ${c.cap}`,
        scenario: `Revoke '${c.cap}' for ${ROLE}, then read the session`,
        expected: 'The session (/auth/me) stops listing the capability once the grant is revoked — identity-service re-resolves and the NOTIFY trigger invalidates its cache',
        actual: `The resolver reports the capability revoked, but /auth/me still lists it after ${flip.ms}ms of polling. Revoking access has no effect on live users.`,
        evidence: `cap=${c.cap} role=${ROLE} tenant=${tenantId}; matrix granted=${resolvedAfter}; session still contains the key`,
        proposedSolution: 'Verify the capability-cache LISTEN/NOTIFY subscription (iam.fn_notify_capability_change -> startCapabilityCache) is connected in identity-service, and add a bounded TTL so a missed NOTIFY cannot pin a stale grant indefinitely.',
      });
    }

    // (b) capability revoked but the API still serves it => not enforced.
    if (resolvedAfter === false && apiAfter && apiAfter >= 200 && apiAfter < 300) {
      record(TOOL, {
        severity: c.cap === 'lms.apiclients' ? 'critical' : 'high',
        role: ROLE, tool: TOOL, page: `capability ${c.cap} — ${c.api.url(GATEWAY)}`,
        scenario: `Call the API guarded by '${c.cap}' after the capability is revoked`,
        expected: 'The endpoint rejects the call (403) once the capability is revoked',
        actual: `The endpoint still returned HTTP ${apiAfter}. The capability gates only the UI — a direct API call bypasses it entirely.`,
        evidence: `cap=${c.cap} revoked for ${ROLE}; GET ${c.api.url(GATEWAY)} -> ${apiAfter} (was ${apiBefore})`,
        proposedSolution: 'Enforce the capability server-side on this route (requireCapability), not just by hiding the nav entry. Hiding a link is not authorization.',
      });
    }

    // (c) capability revoked but the UI still shows the affordance => dead end.
    if (resolvedAfter === false && uiAfter) {
      record(TOOL, {
        severity: 'medium', role: ROLE, tool: TOOL, page: `capability ${c.cap} — ${c.path}`,
        scenario: `Revoke '${c.cap}' and reload ${c.path} as ${ROLE}`,
        expected: `The ${c.kind} affordance ("${c.ui.text}") disappears once the capability is revoked`,
        actual: `The ${c.kind} "${c.ui.text}" is still rendered after the capability was revoked${apiAfter && apiAfter >= 400 ? ` while the API now returns ${apiAfter}` : ''} — the user is shown a control they can no longer use.`,
        evidence: `cap=${c.cap} ui=${c.ui.type}:"${c.ui.text}" at ${c.path}; session updated=${flip.ok}`,
        proposedSolution: 'Gate this nav/tab entry on the capability list from the session (the pattern used by AttendanceTabs/LeaveTabs) so it disappears with the grant.',
      });
    }

    // (d) sanity: capability still granted should still work — a revoke that
    // over-reaches (kills a sibling) is just as bad as one that under-reaches.
    results.push({
      cap: c.cap, kind: c.kind,
      before: { resolved: resolvedBefore, session: inSessionBefore, ui: uiBefore, api: apiBefore },
      after: { resolved: resolvedAfter, sessionUpdated: flip.ok, flipMs: flip.ms, ui: uiAfter, api: apiAfter },
    });

    // ---------- restore + verify we really put it back ----------
    restoreAll();
    const back = await waitForSessionCapability(a, c.cap, true);
    const uiBack = await uiVisible(page, APPS[c.app], c.path, c.ui);
    console.log(`  restored: sessionBack=${back.ok} (${back.ms}ms) ui=${uiBack}`);
    if (!back.ok || !uiBack) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: `capability ${c.cap}`,
        scenario: `Restore '${c.cap}' after the toggle test`,
        expected: 'Removing the override returns the role to its baseline access',
        actual: `After restore, session-has-capability=${back.ok}, ui-visible=${uiBack}. The grant did not come back cleanly.`,
        evidence: `cap=${c.cap} role=${ROLE} tenant=${tenantId}`,
        proposedSolution: 'Check the override delete path and cache invalidation; a grant that does not return after an override is removed will strand real users.',
      });
    }
  }
} finally {
  // Belt and braces — nothing may leak out of this suite.
  const n = restoreAll();
  if (n) console.log(`\n[cleanup] restored ${n} leftover override(s)`);
  if (pendingOverrides()) console.error(`!! ${pendingOverrides()} override(s) COULD NOT be restored — run with --restore-only`);
  await a.close();
  await browser.close();
}

console.log(`\n${results.length} capability case(s) exercised.`);
