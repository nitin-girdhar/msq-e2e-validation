// CONCURRENCY: two authorized editors change the SAME lead field at the same
// time. This probes whether the second write silently clobbers the first with
// no conflict signal — the classic lost update. We change last_name (free text,
// non-destructive), verify the final value in the DB, and restore it afterwards.
//
// PATCH /api/leads/:id now supports optimistic concurrency via the
// `expected_updated_at` token, so both actors read the lead first and send the
// version they opened — the same thing LeadEditModal does. The token is
// OPTIONAL by design (server-to-server callers may still want last-writer-wins),
// so a caller that omits it is deliberately unguarded and this suite would not
// detect a regression in that path.
//
//   node suites/concurrency/lms-lead-lost-update.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiPatch, apiGet, apiPost, simultaneously } from '../../conc.mjs';
import { dbReachable, one, q, lit } from '../../db.mjs';
import { purgeById } from '../../fixtures.mjs';

const TOOL = 'concurrency';
const LMS = APPS['lms-web'];

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

// A lead in the org shared by our two editors (org_admin + org_manager both on
// FitClass - Gurgaon per roles.json).
const org = roleMeta('org_admin').org;
// NOTE: use last_name, not outcome_comment. outcome_comment only persists
// alongside an outcome (the DB trigger NULLs it otherwise), so a race on that
// field would be testing the outcome rules rather than concurrency.
// A throwaway E2E lead (not a real one): created by tenant_admin, placed in
// org_admin's branch with the tenant's default (sales) campaign type, so both
// editors — org_admin and org_manager (home branch, see auth-setup) — see it.
const seed = await actor('tenant_admin');
const mk = await apiPost(seed, `${LMS}/api/leads`, { first_name: 'E2E-conc', last_name: `Base-${Date.now()}`, email: `e2e.conc.${Date.now()}@example.test` });
await seed.close();
const leadId = mk.body?.data?.id;
if (!leadId) { console.log(`Could not create a fixture lead (${mk.status}) — aborting`); process.exit(0); }
q(`UPDATE lms.marketing_leads SET org_id=(SELECT id FROM entity.organizations WHERE name=${lit(org)} LIMIT 1) WHERE id=${lit(leadId)}`);
const original = one(`SELECT COALESCE(last_name,'') FROM lms.marketing_leads WHERE id=${lit(leadId)}`)[0];
console.log(`Lead ${leadId} in ${org} — baseline last_name="${original}"`);

const A = await actor('org_admin');
const B = await actor('org_manager');
const stamp = Date.now();
const valA = `E2E-A-${stamp}`;
const valB = `E2E-B-${stamp}`;

// Model what a real editor does: open the lead, then save the version you saw.
// Both actors read first, so both hold the SAME updated_at — exactly the state
// two people editing the same record concurrently are in.
const openedA = await apiGet(A, `${LMS}/api/leads/${leadId}`);
const openedB = await apiGet(B, `${LMS}/api/leads/${leadId}`);
console.log(`editors opened the lead: org_admin GET ${openedA.status}, org_manager GET ${openedB.status}`);
if (openedA.status !== 200 || openedB.status !== 200) { console.log('Both editors must be able to open the lead — aborting'); purgeById('lms.marketing_leads', leadId); process.exit(0); }
// The detail DTO may omit updated_at; both editors opened the same row version.
const dbVer = one(`SELECT updated_at FROM lms.marketing_leads WHERE id=${lit(leadId)}`)[0];
const verA = openedA.body?.data?.updated_at ?? dbVer;
const verB = openedB.body?.data?.updated_at ?? dbVer;
const expectedA = new Date(verA).toISOString();
const expectedB = new Date(verB).toISOString();
console.log(`Both editors opened version ${expectedA} (identical: ${expectedA === expectedB})`);

const [ra, rb] = await simultaneously([
  () => apiPatch(A, `${LMS}/api/leads/${leadId}`, { last_name: valA, expected_updated_at: expectedA }),
  () => apiPatch(B, `${LMS}/api/leads/${leadId}`, { last_name: valB, expected_updated_at: expectedB }),
]);
console.log(`org_admin PATCH -> ${ra.status}; org_manager PATCH -> ${rb.status}`);

// Settle, then read the source of truth.
await new Promise((r) => setTimeout(r, 500));
const finalRow = one(`SELECT COALESCE(last_name,'') FROM lms.marketing_leads WHERE id=${lit(leadId)}`);
const finalVal = finalRow ? finalRow[0] : '(gone)';
console.log(`DB final last_name="${finalVal}"`);

const bothAccepted = ra.status < 300 && rb.status < 300;
const conflictSignalled = [ra.status, rb.status].includes(409);

if (bothAccepted && !conflictSignalled) {
  record(TOOL, {
    severity: 'medium',
    role: 'org_admin + org_manager (concurrent)',
    page: 'LMS Lead edit (PATCH /api/leads/:id)',
    scenario: 'Two authorized users edit the same lead field simultaneously',
    expected: 'The second concurrent write should be rejected or merged with a conflict signal (409 / optimistic-lock), OR the UI should warn the loser their change was overwritten',
    actual: `Both writes returned 2xx with no conflict. Final DB value is "${finalVal}" — one user's change was silently lost (last-writer-wins). No updated_at/If-Match/version guard exists on the lead update path.`,
    evidence: JSON.stringify({ leadId, valA, valB, statusA: ra.status, statusB: rb.status, finalVal }),
    proposedSolution: 'Add optimistic concurrency to PATCH /api/leads/:id: accept the row\'s last-seen updated_at (or a version column) and make the UPDATE ... WHERE id=:id AND updated_at=:expected; return 409 when 0 rows change so the client can reload and re-apply. Surface a "this lead changed since you opened it" prompt in LeadEditModal.',
  });
  console.log('RECORDED: silent lost update (no optimistic locking).');
} else {
  console.log(`No lost-update defect: bothAccepted=${bothAccepted} conflictSignalled=${conflictSignalled}`);
}

// Cleanup — restore original value via the winning editor.
purgeById('lms.marketing_leads', leadId); // throwaway fixture (soft-delete is the floor for leads)
await A.close(); await B.close();
console.log('done.');
