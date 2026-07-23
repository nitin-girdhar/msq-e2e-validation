// CONCURRENCY: two authorized editors change the SAME lead field at the same
// time. PATCH /api/leads/:id has no optimistic-lock guard (no updated_at / If-
// Match / version check on the write), so this probes whether the second write
// silently clobbers the first with no conflict signal — the classic lost
// update. We change outcome_comment (free text, non-destructive), verify the
// final value in the DB, and restore it afterwards.
//
//   node suites/concurrency/lms-lead-lost-update.mjs
import { APPS, record, roleMeta } from '../../lib.mjs';
import { actor, apiPatch, apiGet, simultaneously } from '../../conc.mjs';
import { dbReachable, one, lit } from '../../db.mjs';

const TOOL = 'concurrency';
const LMS = APPS['lms-web'];

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

// A lead in the org shared by our two editors (org_admin + org_manager both on
// FitClass - Gurgaon per roles.json).
const org = roleMeta('org_admin').org;
const row = one(`SELECT l.id, COALESCE(l.outcome_comment,'')
  FROM lms.marketing_leads l JOIN entity.organizations o ON o.id=l.org_id
  WHERE o.name=${lit(org)} AND l.is_active AND NOT l.is_deleted
  ORDER BY l.created_at DESC LIMIT 1`);
if (!row) { console.log(`No editable lead found in ${org} — aborting`); process.exit(0); }
const [leadId, original] = row;
console.log(`Lead ${leadId} in ${org} — baseline outcome_comment="${original}"`);

const A = await actor('org_admin');
const B = await actor('org_manager');
const stamp = Date.now();
const valA = `E2E-A-${stamp}`;
const valB = `E2E-B-${stamp}`;

const [ra, rb] = await simultaneously([
  () => apiPatch(A, `${LMS}/api/leads/${leadId}`, { outcome_comment: valA }),
  () => apiPatch(B, `${LMS}/api/leads/${leadId}`, { outcome_comment: valB }),
]);
console.log(`org_admin PATCH -> ${ra.status}; org_manager PATCH -> ${rb.status}`);

// Settle, then read the source of truth.
await new Promise((r) => setTimeout(r, 500));
const finalRow = one(`SELECT COALESCE(outcome_comment,'') FROM lms.marketing_leads WHERE id=${lit(leadId)}`);
const finalVal = finalRow ? finalRow[0] : '(gone)';
console.log(`DB final outcome_comment="${finalVal}"`);

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
await apiPatch(A, `${LMS}/api/leads/${leadId}`, { outcome_comment: original }).catch(() => {});
await A.close(); await B.close();
console.log('done.');
