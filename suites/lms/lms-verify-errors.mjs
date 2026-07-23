// Verify whether the ERR_ABORTED "bad requests" seen in the coverage sweep are
// real product errors or just an artifact of rapidly navigating away (which
// aborts in-flight SSE/prefetch requests). Visits ONE page, sits idle for 6s
// (no further navigation), then reports what actually failed.
import { openAs, APPS } from '../../lib.mjs';

const page1 = process.argv[2] || '/dashboard/leads';

const { browser, page, log } = await openAs('org_admin');
await page.goto(APPS['lms-web'] + page1, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
console.log(`--- after initial load of ${page1} ---`);
console.log('badRequests so far:', JSON.stringify(log.badRequests, null, 2));
console.log('consoleErrors so far:', JSON.stringify(log.consoleErrors, null, 2));

await page.waitForTimeout(6000); // idle, no navigation
console.log(`--- after 6s idle (no navigation) ---`);
console.log('badRequests total:', JSON.stringify(log.badRequests, null, 2));
console.log('consoleErrors total:', JSON.stringify(log.consoleErrors, null, 2));

await browser.close();
