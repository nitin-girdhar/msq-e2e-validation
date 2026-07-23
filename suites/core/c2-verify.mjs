// C2 verification: the page guard and the service must now AGREE.
// Before Tier C these pages rendered (guard passed on platform rank) and then
// every data call 403'd (service checked a different member_roles rank).
import { openAs, APPS } from '../../lib.mjs';

const CASES = [
  { area: 'tasks', url: APPS['todo-web'] + '/tasks/team', apiHint: '/api/tasks' },
  { area: 'hr',    url: APPS['hr-web']   + '/attendance/team', apiHint: '/api/hr' },
];
const ROLES = ['org_admin', 'org_sr_manager', 'org_manager', 'senior_sales_executive', 'sales_representative', 'read_only'];

for (const c of CASES) {
  console.log(`\n=== ${c.area.toUpperCase()} team page ===`);
  for (const role of ROLES) {
    const { browser, page, log } = await openAs(role);
    await page.goto(c.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3500);
    const url = page.url();
    const body = await page.locator('body').innerText().catch(() => '');
    const redirected = !url.includes(c.url.split('localhost')[1].split('/').slice(1).join('/'));
    const forbid = log.badRequests.filter((b) => /^403/.test(b));
    // The bug signature: page RENDERED but data calls 403'd.
    const rendered = !redirected;
    const bug = rendered && forbid.length > 0;
    const banner = /insufficient rank|not authorized|forbidden/i.test(body);
    console.log(`${role.padEnd(23)} rendered=${rendered ? 'Y' : 'n'} 403s=${String(forbid.length).padStart(2)} leakedBanner=${banner ? 'Y' : 'n'}  ${bug ? '<< DISAGREEMENT' : 'consistent'}`);
    await browser.close();
  }
}
