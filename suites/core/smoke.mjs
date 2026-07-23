import { openAs, visit, APPS } from '../../lib.mjs';
const { browser, page, log } = await openAs('org_admin');
console.log(JSON.stringify(await visit(page, APPS['lms-web'] + '/dashboard/leads'), null, 2));
console.log('consoleErrors', log.consoleErrors.length, 'bad', log.badRequests.slice(0,3));
await browser.close();
