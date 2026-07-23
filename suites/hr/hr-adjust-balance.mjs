import { openAs, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const { browser, page, log } = await openAs('org_admin');
try {
  await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^adjustment$/i }).click();
  await page.waitForTimeout(500);

  const userSelect = page.locator('#af-user');
  await userSelect.waitFor({ timeout: 10000 });
  // Wait for the user list fetch to actually populate the <select> (avoid racing the request).
  await page.waitForFunction(
    () => document.querySelectorAll('#af-user option').length > 1,
    { timeout: 10000 },
  ).catch(() => console.log('WARN: user dropdown never grew past placeholder within 10s'));
  const opts = await userSelect.locator('option').allTextContents();
  console.log('user options:', opts);
  // Find "Bina Eapen" (sales_representative per earlier logs) or fallback to 2nd option
  const target = opts.find((o) => /Bina Eapen/i.test(o)) || opts[1];
  console.log('targeting user:', target);
  await userSelect.selectOption({ label: target });

  await page.locator('#af-type').fill('casual');
  await page.locator('#af-amount').fill('10');
  await page.locator('#af-note').fill('E2E-adjustment-seed-balance');

  await page.getByRole('button', { name: /review adjustment/i }).click();
  await page.waitForTimeout(300);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/hr/leave/adjustment') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    page.getByRole('button', { name: /confirm adjustment/i }).click(),
  ]);
  console.log('adjustment POST status:', resp ? resp.status() : 'none', 'body:', resp ? await resp.text().catch(() => '') : '');
  await page.waitForTimeout(800);
  console.log('notice visible?', await page.locator('text=Ledger adjustment recorded').isVisible().catch(() => false));
  console.log('badRequests:', log.badRequests);
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  await browser.close();
}
