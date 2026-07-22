// Direct API permission-boundary test: bypass the UI entirely and hit the
// lms-web /api/leads/:id PATCH endpoint as low-privilege roles, using their
// already-authenticated storage state (cookies). This checks whether the
// backend actually enforces "read only" / "sales rep can't reassign" or
// whether it's only a UI-level restriction.
import { openAs, record } from './lib.mjs';

async function testRole(role) {
  const { browser, page } = await openAs(role);
  const out = { role };
  try {
    // 1. List leads to get a real lead id + stage options.
    const listRes = await page.request.get('http://localhost:3001/api/leads?page_size=5');
    out.listStatus = listRes.status();
    const listJson = await listRes.json().catch(() => null);
    const lead = listJson?.data?.[0];
    const stageOptions = listJson?.stage_options ?? [];
    out.leadFound = Boolean(lead);
    out.stageOptionsSample = stageOptions.slice(0, 3);
    if (!lead) { out.note = 'No lead returned from list endpoint'; await browser.close(); return out; }

    out.leadId = lead.lead_id;
    out.origStage = lead.stage;

    // Pick a stage_id different from current, from stage_options (array of {id,name} or similar)
    let altStage = null;
    if (Array.isArray(stageOptions) && stageOptions.length) {
      altStage = stageOptions.find(s => (s.name ?? s.value ?? s.id) !== lead.stage) ?? stageOptions[0];
    }
    out.altStageRaw = altStage;

    if (!altStage || !altStage.id) {
      out.note = 'Could not determine a stage_id to PATCH with; skipping direct patch attempt';
      await browser.close();
      return out;
    }

    // 2. Attempt PATCH as this role directly against the API.
    const patchRes = await page.request.patch(`http://localhost:3001/api/leads/${lead.lead_id}`, {
      data: { stage_id: altStage.id, transition_note: `E2E-perm-test-${role}-${Date.now()}` },
      failOnStatusCode: false,
    });
    out.patchStatus = patchRes.status();
    out.patchBody = await patchRes.text().catch(() => '');

    // 3. Re-fetch the lead to see if the stage actually changed.
    const getRes = await page.request.get(`http://localhost:3001/api/leads/${lead.lead_id}`, { failOnStatusCode: false });
    out.getStatus = getRes.status();
    const getJson = await getRes.json().catch(() => null);
    out.stageAfterPatch = getJson?.data?.stage ?? null;
    out.stageActuallyChanged = out.stageAfterPatch !== out.origStage;

  } catch (e) {
    out.exception = e.message;
  } finally {
    await browser.close();
  }
  return out;
}

const roles = process.argv.slice(2);
const targets = roles.length ? roles : ['read_only', 'sales_representative'];
const results = [];
for (const role of targets) {
  const r = await testRole(role);
  console.log(JSON.stringify(r, null, 2));
  results.push(r);
}

for (const r of results) {
  if (r.patchStatus && r.patchStatus < 300 && r.stageActuallyChanged) {
    record('lms', {
      severity: 'critical',
      role: r.role,
      page: 'Leads (API)',
      scenario: `Direct PATCH /api/leads/:id as ${r.role} to change lead stage, bypassing UI`,
      expected: `${r.role} should NOT be able to modify lead data (this role is not in CAN_ASSIGN_ROLES / has view-only nav access)`,
      actual: `PATCH returned ${r.patchStatus} and the lead's stage actually changed from "${r.origStage}" to "${r.stageAfterPatch}" on re-fetch — confirmed the write persisted, not just a 2xx response.`,
      evidence: JSON.stringify(r),
    });
  } else if (r.patchStatus && r.patchStatus >= 400) {
    console.log(`${r.role}: PATCH correctly rejected with status ${r.patchStatus}`);
  }
}
console.log('DONE');
