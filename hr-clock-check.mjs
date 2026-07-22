import { openAs, APPS } from './lib.mjs';
const BASE = APPS['hr-web'];
const { browser, page } = await openAs('senior_sales_executive');
const [resp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/attendance'), { timeout: 20000 }).catch(() => null),
  page.goto(`${BASE}/attendance`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
]);
console.log('response url:', resp ? resp.url() : 'none');
console.log('response Date header:', resp ? resp.headers()['date'] : 'none');
console.log('client Date.now ISO:', new Date().toISOString());
await browser.close();
