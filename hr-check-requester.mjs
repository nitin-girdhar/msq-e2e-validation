import { openAs, APPS } from './lib.mjs';
const BASE = APPS['hr-web'];
const reasonText = process.argv[2];
const { browser, page } = await openAs('sales_representative');
await page.goto(`${BASE}/leave`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
const rowText = await page.locator('tr', { hasText: reasonText }).innerText().catch(() => '');
console.log('requester row:', rowText.replace(/\n/g, ' | '));
await browser.close();
