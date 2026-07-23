import { openAs, record, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const role = 'sales_representative';

const browser0 = await runFor(role);
await browser0.close();

async function runFor(role) {
  const { browser, page, log } = await openAs(role);
  try {
    await page.goto(`${BASE}/leave`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

    // Open apply modal
    const applyBtn = page.getByRole('button', { name: /apply leave/i });
    await applyBtn.click({ timeout: 10000 }).catch((e) => console.log('apply btn click failed', e.message));
    await page.waitForTimeout(500);
    console.log('modal body snippet:', (await page.locator('body').innerText().catch(() => '')).slice(0, 500));

    const typeSelect = page.locator('#al-type');
    await typeSelect.waitFor({ timeout: 10000 }).catch(() => {});
    const options = await typeSelect.locator('option').allTextContents().catch(() => []);
    console.log('leave type options:', options);
    if (options.length <= 1) {
      record('hr', {
        severity: 'medium',
        role,
        page: '/leave',
        scenario: 'Apply leave modal - leave type dropdown',
        expected: 'At least one selectable leave type policy configured for the org',
        actual: `Dropdown options: ${JSON.stringify(options)}`,
        evidence: 'Re-checked: dropdown rendered with only the placeholder option.',
      });
      await page.keyboard.press('Escape').catch(() => {});
      return browser;
    }

    // pick the first real option (index 1)
    const val = await typeSelect.locator('option').nth(1).getAttribute('value');
    await typeSelect.selectOption(val);

    const start = new Date();
    start.setDate(start.getDate() + 10);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const iso = (d) => d.toISOString().slice(0, 10);

    await page.locator('#al-start').fill(iso(start));
    await page.locator('#al-end').fill(iso(end));

    const reasonText = `E2E-leave-request-${Date.now()}`;
    await page.locator('#al-reason').fill(reasonText);

    // wait for preview to compute
    await page.waitForTimeout(1500);

    const submitBtn = page.getByRole('button', { name: /submit request/i });
    const disabled = await submitBtn.isDisabled().catch(() => true);
    console.log('submit disabled?', disabled);
    if (disabled) {
      const bodyTxt = await page.locator('body').innerText().catch(() => '');
      record('hr', {
        severity: 'medium',
        role,
        page: '/leave',
        scenario: 'Apply leave - submit blocked',
        expected: 'A valid future date range + selected type should allow submission',
        actual: 'Submit button stayed disabled after filling type, dates and reason',
        evidence: bodyTxt.slice(0, 600),
      });
      await page.keyboard.press('Escape').catch(() => {});
      return browser;
    }

    await submitBtn.click();
    await page.waitForTimeout(2000);

    const successAlert = await page.locator('text=Leave request submitted').isVisible().catch(() => false);
    console.log('success alert visible?', successAlert);

    // reload and check persistence
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1000);
    const rowVisible = await page.locator(`text=${reasonText}`).isVisible().catch(() => false);
    console.log('row visible after reload?', rowVisible);

    if (!rowVisible) {
      record('hr', {
        severity: 'high',
        role,
        page: '/leave',
        scenario: 'Apply leave then reload - persistence check',
        expected: `After submitting a leave request with reason "${reasonText}", it should appear in "My requests" after reload`,
        actual: `Request row with reason "${reasonText}" NOT found in the table after reload. Success alert was ${successAlert ? '' : 'NOT '}shown at submit time.`,
        evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 800),
      });
    } else {
      console.log('PASS: leave request persisted after reload');
      // Now test cancel
      const row = page.locator('tr', { hasText: reasonText }).first();
      const cancelBtn = row.getByRole('button', { name: /cancel/i });
      const hasCancelBtn = await cancelBtn.isVisible().catch(() => false);
      if (hasCancelBtn) {
        await cancelBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(800);
        const statusText = await page.locator('tr', { hasText: reasonText }).innerText().catch(() => '');
        console.log('row after cancel + reload:', statusText.replace(/\n/g, ' | '));
        if (!/cancel/i.test(statusText)) {
          record('hr', {
            severity: 'high',
            role,
            page: '/leave',
            scenario: 'Cancel leave request then reload - persistence check',
            expected: 'Row status should show Cancelled after cancel + reload',
            actual: `Row text after reload: "${statusText}"`,
            evidence: statusText,
          });
        } else {
          console.log('PASS: cancel persisted after reload');
        }
      } else {
        console.log('No cancel button visible on the newly-created row (may be expected if not pending).');
      }
    }

    console.log('badRequests:', log.badRequests);
    console.log('consoleErrors:', log.consoleErrors);
    console.log('pageErrors:', log.pageErrors);
    if (log.pageErrors.length) {
      record('hr', {
        severity: 'medium',
        role,
        page: '/leave',
        scenario: 'Apply leave flow - JS errors',
        expected: 'No uncaught page errors during apply-leave flow',
        actual: log.pageErrors.join(' | '),
        evidence: 'captured via page.on(pageerror)',
      });
    }
  } catch (e) {
    console.log('SCRIPT ERROR', e.message);
  }
  return browser;
}
