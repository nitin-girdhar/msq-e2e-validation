// Coverage pass: visit /tasks and /tasks/team for every role, record render
// failures, 4xx/5xx, console/page errors, and team-tab visibility.
import { openAs, visit, record, save, APPS, ROLES } from '../../lib.mjs';

const BASE = APPS['todo-web'];
const results = [];

for (const role of ROLES) {
  const { browser, ctx, page, log } = await openAs(role).catch((e) => ({ err: e }));
  if (!browser) {
    results.push({ role, error: String(page?.err || 'openAs failed') });
    continue;
  }

  for (const route of ['/tasks', '/tasks/team']) {
    log.consoleErrors.length = 0;
    log.pageErrors.length = 0;
    log.badRequests.length = 0;

    const v = await visit(page, `${BASE}${route}`);
    const teamTabVisible = await page.locator('a, button', { hasText: 'Team' }).first().isVisible().catch(() => false);

    const entry = {
      role,
      route,
      finalUrl: v.url,
      httpStatus: v.httpStatus,
      redirected: v.redirected,
      looksLikeError: v.looksLikeError,
      heading: v.heading,
      teamTabVisible,
      consoleErrors: [...log.consoleErrors],
      pageErrors: [...log.pageErrors],
      badRequests: [...log.badRequests],
    };
    results.push(entry);

    if (v.looksLikeError) {
      record('todo', {
        severity: 'high',
        role,
        page: route,
        scenario: 'Basic page load',
        expected: 'Page renders without an error banner/message',
        actual: `Body matched error phrase. heading="${v.heading}" snippet="${v.bodySnippet.slice(0, 200)}"`,
        evidence: `httpStatus=${v.httpStatus} finalUrl=${v.url}`,
      });
    }
    if (log.pageErrors.length) {
      record('todo', {
        severity: 'medium',
        role,
        page: route,
        scenario: 'Basic page load',
        expected: 'No uncaught page errors',
        actual: log.pageErrors.join(' | '),
        evidence: `finalUrl=${v.url}`,
      });
    }
    if (log.badRequests.some((b) => /^5\d\d/.test(b))) {
      record('todo', {
        severity: 'high',
        role,
        page: route,
        scenario: 'Basic page load',
        expected: 'No 5xx responses',
        actual: log.badRequests.filter((b) => /^5\d\d/.test(b)).join(' | '),
        evidence: `finalUrl=${v.url}`,
      });
    }
  }

  await browser.close();
}

save('todo', 'coverage', results);
console.log(JSON.stringify(results, null, 2));
