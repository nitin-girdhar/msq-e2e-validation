import { openAs, visit, record, save, APPS, ROLES } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const PAGES = [
  '/',
  '/attendance',
  '/attendance/admin',
  '/attendance/team',
  '/leave',
  '/leave/admin',
  '/leave/approvals',
];

const results = [];

for (const role of ROLES) {
  let browser;
  try {
    const opened = await openAs(role);
    browser = opened.browser;
    const { page, log } = opened;
    for (const p of PAGES) {
      log.consoleErrors.length = 0;
      log.pageErrors.length = 0;
      log.badRequests.length = 0;
      const url = BASE + p;
      const res = await visit(page, url).catch((e) => ({ err: e.message }));
      const entry = {
        role,
        page: p,
        finalUrl: res.url,
        httpStatus: res.httpStatus,
        redirected: res.redirected,
        looksLikeError: res.looksLikeError,
        heading: res.heading,
        consoleErrors: [...log.consoleErrors],
        pageErrors: [...log.pageErrors],
        badRequests: [...log.badRequests],
      };
      results.push(entry);
      console.log(`[${role}] ${p} -> ${res.url} status=${res.httpStatus} err=${res.looksLikeError} bad=${log.badRequests.length}`);

      if (res.looksLikeError) {
        record('hr', {
          severity: 'high',
          role,
          page: p,
          scenario: 'route sweep',
          expected: 'Page renders without an error state',
          actual: `Body matched error phrase. Heading: "${res.heading}"`,
          evidence: res.bodySnippet,
        });
      }
      if (log.badRequests.length) {
        record('hr', {
          severity: 'medium',
          role,
          page: p,
          scenario: 'route sweep - network',
          expected: 'No 4xx/5xx or failed requests while loading the page',
          actual: log.badRequests.join(' | ').slice(0, 500),
          evidence: `finalUrl=${res.url}`,
        });
      }
    }
    await browser.close();
  } catch (e) {
    console.log(`ROLE ${role} FAILED: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  }
}

save('hr', 'sweep-raw', results);
console.log('DONE sweep');
