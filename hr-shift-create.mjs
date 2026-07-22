import { openAs, APPS, record } from './lib.mjs';

const BASE = APPS['hr-web'];
const shiftName = `E2E-shift-${Date.now()}`;
const { browser, page } = await openAs('org_admin');
try {
  await page.goto(`${BASE}/attendance/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^shifts$/i }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /create shift/i }).click();
  await page.waitForTimeout(400);
  await page.locator('#sf-name').fill(shiftName);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/hr/shifts') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    page.getByRole('button', { name: /^save$/i }).click(),
  ]);
  console.log('create shift status:', resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^shifts$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  const rowVisible = await page.locator(`text=${shiftName}`).isVisible().catch(() => false);
  console.log('shift visible after reload?', rowVisible);
  if (!rowVisible) {
    record('hr', {
      severity: 'high',
      role: 'org_admin',
      page: '/attendance/admin (Shifts tab)',
      scenario: 'Create a shift then reload - persistence check',
      expected: 'Newly created shift row appears in the Shifts table after reload',
      actual: `POST response=${resp ? resp.status() : 'none'}; row visible after reload=${rowVisible}`,
      evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 700),
    });
  } else {
    console.log('PASS: shift persisted');
  }
} finally {
  await browser.close();
}
