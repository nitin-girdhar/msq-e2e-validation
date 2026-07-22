import { openAs, APPS, record } from './lib.mjs';

const BASE = APPS['hr-web'];
const reasonText = `E2E-regularization-${Date.now()}`;

async function submitRegularization() {
  const { browser, page } = await openAs('read_only');
  try {
    await page.goto(`${BASE}/attendance`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    // Click on day "10" of the current month (a past, likely unmarked day)
    const dayCell = page.getByText('10', { exact: true }).first();
    await dayCell.click({ timeout: 10000 });
    await page.waitForTimeout(500);
    const reqBtn = page.getByRole('button', { name: /request regularization/i });
    const canReq = await reqBtn.isVisible().catch(() => false);
    console.log('Can request regularization for day 10?', canReq);
    if (!canReq) {
      console.log('Day not regularizable (already marked); skipping.');
      await page.getByRole('button', { name: /^close$/i }).click().catch(() => {});
      return false;
    }
    await reqBtn.click();
    await page.waitForTimeout(400);
    await page.locator('#rg-status').selectOption('present');
    await page.locator('#rg-reason').fill(reasonText);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/attendance/regularizations') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
      page.getByRole('button', { name: /submit request/i }).click(),
    ]);
    console.log('regularization POST:', resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(800);
    const rowVisible = await page.locator(`text=${reasonText}`).isVisible().catch(() => false);
    console.log('regularization visible in "My regularizations" after reload?', rowVisible);
    if (!rowVisible) {
      record('hr', {
        severity: 'high',
        role: 'read_only',
        page: '/attendance',
        scenario: 'Submit a regularization request then reload - persistence check',
        expected: 'New regularization request should appear in "My regularizations" list after reload',
        actual: `POST response=${resp ? resp.status() : 'none'}; row visible after reload=${rowVisible}`,
        evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 700),
      });
    } else {
      console.log('PASS: regularization request persisted');
    }
    return true;
  } finally {
    await browser.close();
  }
}

async function approveAsAdmin() {
  const { browser, page } = await openAs('org_admin');
  try {
    await page.goto(`${BASE}/attendance/team`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const row = page.locator('tr, li, div', { hasText: reasonText }).last();
    const visible = await row.isVisible().catch(() => false);
    console.log('org_admin sees pending regularization?', visible);
    if (!visible) {
      record('hr', {
        severity: 'medium',
        role: 'org_admin',
        page: '/attendance/team',
        scenario: 'org_admin (HR-admin rank) should see all pending regularizations org-wide',
        expected: 'The regularization submitted by read_only should appear in the pending queue',
        actual: 'Not found in the pending queue',
        evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 600),
      });
      return;
    }
    const reviewBtn = row.getByRole('button', { name: /review|approve/i }).first();
    await reviewBtn.click({ timeout: 8000 }).catch((e) => console.log('review click failed:', e.message));
    await page.waitForTimeout(500);
    console.log('decision modal body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 600).replace(/\n+/g, ' | '));
    const approveBtn = page.getByRole('button', { name: /^approve$/i });
    if (await approveBtn.isVisible().catch(() => false)) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => /regularizations\/.*\/approve/.test(r.url()), { timeout: 15000 }).catch(() => null),
        approveBtn.click(),
      ]);
      console.log('approve response:', resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(800);
      const stillPending = await page.locator(`text=${reasonText}`).isVisible().catch(() => false);
      console.log('still shown in pending queue after reload (expect false)?', stillPending);
    }
  } finally {
    await browser.close();
  }
}

const submitted = await submitRegularization();
if (submitted) await approveAsAdmin();
