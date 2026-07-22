// The core scenario: open a lead, change dropdowns, add a comment, save,
// then RELOAD and verify the change actually persisted.
import { openAs, visit, record, save, APPS } from './lib.mjs';

const role = process.argv[2] ?? 'org_admin';
const { browser, page, log } = await openAs(role);
const out = { role, steps: [] };
const step = (name, detail) => { out.steps.push({ name, ...detail }); console.log(`[${name}]`, JSON.stringify(detail).slice(0, 300)); };

try {
  await visit(page, APPS['lms-web'] + '/dashboard/leads');
  await page.waitForTimeout(3000); // let the grid populate

  const editBtns = page.locator('button[title="Edit"]');
  const count = await editBtns.count();
  step('edit-buttons-found', { count });

  if (count === 0) {
    record('lms', {
      severity: 'high', role, page: 'Leads', scenario: 'Locate row Edit action',
      expected: 'Edit buttons render on lead rows', actual: 'No button[title="Edit"] found',
      evidence: 'Confirmed after 3s settle on /dashboard/leads',
    });
  } else {
    // Identify which lead row we are editing so we can re-find it after reload.
    await editBtns.first().click();
    await page.waitForTimeout(1500);

    const dialogText = await page.locator('body').innerText();
    const nameMatch = dialogText.match(/Lead Details[\s\S]{0,200}/);
    step('modal-opened', { snippet: (nameMatch?.[0] ?? dialogText.slice(0, 200)).replace(/\n/g, ' | ').slice(0, 200) });

    const selects = page.locator('select');
    const nSel = await selects.count();
    const selInfo = [];
    for (let i = 0; i < nSel; i++) {
      const opts = await selects.nth(i).locator('option').allTextContents();
      selInfo.push({ i, options: opts.slice(0, 12), optionCount: opts.length });
    }
    step('dropdowns', { count: nSel, selInfo });

    // Flag any dropdown that renders with no real choices.
    selInfo.forEach((s) => {
      if (s.optionCount <= 1) {
        record('lms', {
          severity: 'medium', role, page: 'Leads > Edit modal',
          scenario: `Dropdown #${s.i} has no selectable options`,
          expected: 'Dropdown offers choices', actual: `optionCount=${s.optionCount} (${s.options.join(',')})`,
          evidence: 'Observed with modal open',
        });
      }
    });

    // Change the Status dropdown to a different value.
    let chosen = null;
    if (nSel > 0) {
      const statusSel = selects.first();
      const values = await statusSel.locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
      const current = await statusSel.inputValue();
      const target = values.find((v) => v.v && v.v !== current);
      if (target) {
        await statusSel.selectOption(target.v);
        chosen = target;
        step('status-changed', { from: current, to: target });
        await page.waitForTimeout(1200); // outcome list is dependent on status
      }
    }

    // Fill every visible textarea with a traceable comment.
    const marker = `E2E-note-${Date.now()}`;
    const ta = page.locator('textarea');
    if (await ta.count()) { await ta.first().fill(marker); step('comment-typed', { marker }); }

    // Dependent Outcome dropdown may have appeared after the status change.
    const selsAfter = await page.locator('select').count();
    if (selsAfter > 1) {
      const outcome = page.locator('select').nth(1);
      const ovals = await outcome.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      if (ovals.length) { await outcome.selectOption(ovals[0]).catch(() => {}); step('outcome-selected', { value: ovals[0] }); }
    }

    const saveBtn = page.locator('button', { hasText: /save changes/i }).first();
    const disabled = await saveBtn.isDisabled().catch(() => null);
    step('save-button', { disabled });
    await saveBtn.click();
    await page.waitForTimeout(3500);

    const afterSave = await page.locator('body').innerText();
    const errBanner = afterSave.match(/save failed[^\n]*|required[^\n]*/i);
    const modalStillOpen = /Save Changes/i.test(afterSave);
    step('after-save', { modalStillOpen, errBanner: errBanner?.[0] ?? null, bad: log.badRequests.slice(-5) });

    // RELOAD and check persistence of the note.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.locator('button[title="Edit"]').first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const reloaded = await page.locator('body').innerText();
    const persisted = reloaded.includes(marker);
    step('persistence', { marker, persisted, statusTarget: chosen?.t ?? null });

    if (!modalStillOpen && !persisted) {
      record('lms', {
        severity: 'high', role, page: 'Leads > Edit modal',
        scenario: 'Change status + add note, save, reload',
        expected: `Note "${marker}" persists and is visible after reload`,
        actual: 'Save closed the modal with no error, but the note was not present after reload',
        evidence: `badRequests=${JSON.stringify(log.badRequests.slice(-5))}`,
      });
    }
  }
} catch (e) {
  step('EXCEPTION', { message: String(e.message).split('\n')[0] });
} finally {
  out.log = { console: log.consoleErrors, pageErrors: log.pageErrors, bad: log.badRequests.filter((b) => !b.includes('ERR_ABORTED')) };
  save('lms', `writepath-${role}`, out);
  await browser.close();
}
