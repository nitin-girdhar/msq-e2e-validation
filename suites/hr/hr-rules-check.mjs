import { openAs, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const { browser, page, log } = await openAs('org_admin');
await page.goto(`${BASE}/attendance/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log('body after 3s:', (await page.locator('body').innerText().catch(() => '')).slice(0, 600).replace(/\n+/g, ' | '));
console.log('badRequests:', log.badRequests);
console.log('consoleErrors:', log.consoleErrors);
console.log('pageErrors:', log.pageErrors);
await browser.close();
