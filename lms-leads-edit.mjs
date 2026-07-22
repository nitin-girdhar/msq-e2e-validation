// Leads detail interaction test: open a lead, change status dropdown, add a
// transition note, save, then reload and verify the change persisted.
// Runs for org_admin (full perms) and sales_representative / read_only (perm boundary check).
import { openAs, record, APPS } from './lib.mjs';

async function testRole(role) {
  const { browser, page, log } = await openAs(role);
  const out = { role, opened: false, statusOptionsCount: 0, assigneeIsSelect: null, saveAttempted: false, saveSucceeded: null, persisted: null, notes: [] };
  try {
    await page.goto(APPS['lms-web'] + '/dashboard/leads', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Wait for ag-grid rows to render
    const rowLocator = page.locator('.ag-center-cols-container .ag-row');
    await rowLocator.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    const rowCount = await rowLocator.count().catch(() => 0);
    out.notes.push(`rowCount=${rowCount}`);
    if (rowCount === 0) { out.notes.push('No lead rows visible - cannot test edit flow'); await browser.close(); return out; }

    // Edit/History buttons live in the pinned-right column, which ag-grid renders
    // in a SEPARATE container (.ag-pinned-right-cols-container) from the row's
    // other cells, not nested under the same .ag-row element as the center cols.
    // Use the button's title + row-index to correlate instead of row-scoped locator.
    const firstRowIndex = await rowLocator.first().getAttribute('row-index');
    const editBtn = page.locator(`.ag-pinned-right-cols-container .ag-row[row-index="${firstRowIndex}"] button[title="Edit"]`);
    await editBtn.waitFor({ state: 'visible', timeout: 10000 });
    await editBtn.click();

    const modal = page.locator('text=Edit Lead').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    out.opened = await modal.isVisible().catch(() => false);
    if (!out.opened) { out.notes.push('Edit modal did not open'); await browser.close(); return out; }

    // Capture the lead name shown in modal header, for later re-identification
    const leadNameLoc = page.locator('h2:has-text("Edit Lead")').locator('..').locator('span.font-medium').first();
    const leadName = await leadNameLoc.innerText().catch(() => '');
    out.notes.push(`leadName="${leadName}"`);

    // Assignee field: select (can assign) vs read-only div
    const assigneeSelect = page.locator('label:has-text("Assigned To")').locator('..').locator('select, [role="combobox"], input');
    out.assigneeIsSelect = await assigneeSelect.count().catch(() => 0) > 0;

    // Status dropdown - find select under "Status" label
    const statusSelect = page.locator('label:has-text("Status")').locator('..').locator('select').first();
    await statusSelect.waitFor({ state: 'visible', timeout: 5000 });
    const opts = await statusSelect.locator('option').allTextContents();
    out.statusOptionsCount = opts.length;
    const origValue = await statusSelect.inputValue();

    // Pick a different option than current
    const optValues = await statusSelect.locator('option').evaluateAll(els => els.map(e => e.value));
    const candidate = optValues.find(v => v !== origValue);
    if (!candidate) { out.notes.push('No alternate status option available'); await browser.close(); return out; }

    await statusSelect.selectOption(candidate);
    await page.waitForTimeout(300);

    // Fill transition note (required once a field changes)
    const noteBox = page.locator('textarea[placeholder*="Add a note"]');
    if (await noteBox.count().catch(() => 0) > 0) {
      await noteBox.fill(`E2E-test-note-${role}-${Date.now()}`);
    }

    // Some stages require an outcome/follow-up date - handle if present
    const outcomeSelect = page.locator('label:has-text("Reason"), label:has-text("Outcome")').locator('..').locator('select');
    if (await outcomeSelect.count().catch(() => 0) > 0) {
      const oVals = await outcomeSelect.first().locator('option').evaluateAll(els => els.map(e => e.value).filter(Boolean));
      if (oVals.length) await outcomeSelect.first().selectOption(oVals[0]);
    }
    const fuInput = page.locator('label:has-text("Follow-up Due")').locator('..').locator('input[type="datetime-local"]');
    if (await fuInput.count().catch(() => 0) > 0) {
      const val = await fuInput.inputValue();
      if (!val) {
        const d = new Date(Date.now() + 86400000);
        const pad = n => String(n).padStart(2, '0');
        await fuInput.fill(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T10:00`);
      }
    }

    const saveBtn = page.locator('button:has-text("Save Changes")');
    const saveDisabled = await saveBtn.isDisabled().catch(() => true);
    out.notes.push(`saveButtonDisabled=${saveDisabled}`);
    if (saveDisabled) { out.notes.push('Save button disabled - cannot attempt save'); await browser.close(); return out; }

    out.saveAttempted = true;
    const beforeBad = log.badRequests.length;
    await saveBtn.click();
    await page.waitForTimeout(2000);
    const afterBad = log.badRequests.slice(beforeBad);
    out.notes.push(`badRequestsDuringSave=${JSON.stringify(afterBad)}`);

    // Did modal close (success) or show error?
    const stillOpen = await page.locator('text=Edit Lead').first().isVisible().catch(() => false);
    const saveError = await page.locator('text=/Save failed|error/i').isVisible().catch(() => false);
    out.saveSucceeded = !stillOpen && afterBad.length === 0;
    out.notes.push(`stillOpenAfterSave=${stillOpen} errorShown=${saveError}`);

    if (stillOpen) {
      // close it to not block reload check
      const closeBtn = page.locator('button:has-text("Cancel")');
      await closeBtn.click().catch(() => {});
    }

    // Reload and re-open the same lead to verify persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await rowLocator.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

    // find row with matching lead name text, else use first row again
    let targetRow = rowLocator.first();
    if (leadName) {
      const named = page.locator('.ag-center-cols-container .ag-row', { hasText: leadName }).first();
      if (await named.count().catch(() => 0) > 0) targetRow = named;
    }
    const targetRowIndex = await targetRow.getAttribute('row-index');
    const editBtn2 = page.locator(`.ag-pinned-right-cols-container .ag-row[row-index="${targetRowIndex}"] button[title="Edit"]`);
    await editBtn2.click().catch(() => {});
    await page.locator('text=Edit Lead').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const statusSelect2 = page.locator('label:has-text("Status")').locator('..').locator('select').first();
    const newValueAfterReload = await statusSelect2.inputValue().catch(() => null);
    out.notes.push(`origValue=${origValue} setTo=${candidate} afterReload=${newValueAfterReload}`);
    out.persisted = newValueAfterReload === candidate;

  } catch (e) {
    out.notes.push(`EXCEPTION: ${e.message}`);
  } finally {
    out.consoleErrors = log.consoleErrors.slice(0, 10);
    out.pageErrors = log.pageErrors.slice(0, 10);
    await browser.close();
  }
  return out;
}

const roles = process.argv.slice(2);
const targets = roles.length ? roles : ['org_admin'];
const results = [];
for (const role of targets) {
  console.log(`--- testing ${role} ---`);
  const r = await testRole(role);
  console.log(JSON.stringify(r, null, 2));
  results.push(r);
}

// Record findings
for (const r of results) {
  if (r.saveAttempted && r.saveSucceeded && r.persisted === false) {
    record('lms', {
      severity: 'critical',
      role: r.role,
      page: 'Leads',
      scenario: 'Edit lead status, save, reload to verify persistence',
      expected: 'Status change persists after reload',
      actual: `Save appeared to succeed (modal closed, no failed requests) but reload shows original value not the new one. ${JSON.stringify(r.notes)}`,
      evidence: JSON.stringify(r),
    });
  }
  if (r.opened === false) {
    record('lms', {
      severity: 'high',
      role: r.role,
      page: 'Leads',
      scenario: 'Open lead edit modal',
      expected: 'Modal opens for row edit action',
      actual: 'Modal did not open',
      evidence: JSON.stringify(r.notes),
    });
  }
}

console.log('DONE');
