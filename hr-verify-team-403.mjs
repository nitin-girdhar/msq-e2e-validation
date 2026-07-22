import { openAs, APPS } from './lib.mjs';

const BASE = APPS['hr-web'];

for (const role of ['org_manager', 'sales_representative']) {
  const { browser, page, log } = await openAs(role);
  await page.goto(`${BASE}/attendance/team`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const alerts = await page.locator('[role="alert"], .text-red-700, .text-red-600').allInnerTexts().catch(() => []);
  const body = await page.locator('body').innerText().catch(() => '');
  console.log(`--- ${role} ---`);
  console.log('alerts:', alerts);
  console.log('badRequests:', log.badRequests);
  console.log('body snippet:', body.slice(0, 500).replace(/\n+/g, ' | '));
  await browser.close();
}
