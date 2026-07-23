import { openAs, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const { browser, page, log } = await openAs('org_admin');
try {
  await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  const createBtn = page.getByRole('button', { name: /create \/ revise policy/i });
  await createBtn.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  await page.locator('#pf-type').fill('sick');
  await page.locator('#pf-freq').selectOption('none');
  await page.locator('#pf-amount').fill('0');
  await page.locator('#pf-levels').fill('1');
  // push applicable_from a day later to avoid any unique constraint collision with existing rows
  const d = new Date(); d.setDate(d.getDate() + 2);
  await page.locator('#pf-from').fill(d.toISOString().slice(0, 10));

  const saveBtn = page.getByRole('button', { name: /save policy/i });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/hr/leave/policies') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    saveBtn.click(),
  ]);
  console.log('status:', resp ? resp.status() : 'none');
  console.log('body:', resp ? (await resp.text().catch(() => '')) : '');
  const formError = await page.locator('[role="alert"]').innerText().catch(() => '(none)');
  console.log('form alert text:', formError);
} finally {
  await browser.close();
}
