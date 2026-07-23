import { openAs, APPS } from '../../lib.mjs';
const BASE = APPS['hr-web'];
const { browser, page } = await openAs('org_admin');
await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
const rows = await page.locator('tbody tr').allInnerTexts();
console.log('rows:\n' + rows.map((r) => r.replace(/\n/g, ' | ')).join('\n'));
await browser.close();
