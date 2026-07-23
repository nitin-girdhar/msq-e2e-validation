import { openAs, APPS } from '../../lib.mjs';
const BASE = APPS['hr-web'];
const { browser, page } = await openAs('org_admin');
try {
  await page.goto(`${BASE}/attendance/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.locator('#re-lat').fill('28.4595');
  await page.locator('#re-lng').fill('77.0266');
  const saveBtn = page.getByRole('button', { name: /save changes/i });
  await saveBtn.click();
  await page.waitForTimeout(1200);
  console.log('notice:', await page.locator('text=saved').isVisible().catch(() => false));
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  console.log('lat value after reload:', await page.locator('#re-lat').inputValue().catch(() => ''));
  console.log('lng value after reload:', await page.locator('#re-lng').inputValue().catch(() => ''));
} finally {
  await browser.close();
}
