// Coverage sweep: for each of the 6 roles, visit each of the 7 nav pages and
// record render status, nav-link visibility, and console/network errors.
import { openAs, visit, record, save, APPS } from './lib.mjs';

const ROLES = ['org_admin', 'org_sr_manager', 'org_manager', 'senior_sales_executive', 'sales_representative', 'read_only'];
const PAGES = [
  { id: 'leads', label: 'Leads', path: '/dashboard/leads' },
  { id: 'follow-ups', label: 'Follow-ups', path: '/dashboard/follow-ups' },
  { id: 'leads-history', label: 'Leads History', path: '/dashboard/leads-history' },
  { id: 'assignments', label: 'Assignments', path: '/dashboard/assignments' },
  { id: 'analytics', label: 'Analytics', path: '/dashboard/analytics' },
  { id: 'users', label: 'Users', path: '/dashboard/users' },
  { id: 'api-clients', label: 'API Tokens', path: '/dashboard/api-clients' },
];

// Expected nav visibility per role, derived from src/config/navigation.ts ROLE_TIERS.
const EXPECTED = {
  org_admin:               ['leads', 'follow-ups', 'leads-history', 'assignments', 'analytics', 'users', 'api-clients'],
  org_sr_manager:          ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
  org_manager:             ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
  senior_sales_executive:  ['leads', 'follow-ups', 'leads-history', 'assignments', 'users'],
  sales_representative:    ['leads', 'follow-ups', 'leads-history'],
  read_only:               ['leads'],
};

const results = [];

for (const role of ROLES) {
  const { browser, page, log } = await openAs(role);

  // 1. Grab rendered nav links (from an already-loaded dashboard page).
  await page.goto(APPS['lms-web'] + '/dashboard/leads', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const navTexts = await page.locator('nav a, aside a').allInnerTexts().catch(() => []);
  const navJoined = navTexts.join(' | ').toLowerCase();

  for (const p of PAGES) {
    const expectedVisible = EXPECTED[role].includes(p.id);
    const navShowsLink = navJoined.includes(p.label.toLowerCase());

    if (navShowsLink !== expectedVisible) {
      record('lms', {
        severity: 'medium',
        role,
        page: p.label,
        scenario: 'nav-link visibility vs. role tier expectation',
        expected: `Nav link '${p.label}' ${expectedVisible ? 'should' : 'should NOT'} be visible for role ${role}`,
        actual: `Nav link '${p.label}' is ${navShowsLink ? 'visible' : 'not visible'}`,
        evidence: `navTexts=${JSON.stringify(navTexts)}`,
      });
    }

    // 2. Direct URL visit regardless of nav visibility, to test the actual page-level gate.
    const before = { console: log.consoleErrors.length, page: log.pageErrors.length, bad: log.badRequests.length };
    const v = await visit(page, APPS['lms-web'] + p.path);
    const newBad = log.badRequests.slice(before.bad);
    const newConsole = log.consoleErrors.slice(before.console);
    const newPageErrors = log.pageErrors.slice(before.page);

    const wasRedirectedToLeads = v.url.includes('/dashboard/leads') && p.id !== 'leads';
    const outcome = v.looksLikeError ? 'error-state'
      : wasRedirectedToLeads ? 'redirected'
      : v.httpStatus && v.httpStatus >= 400 ? `http-${v.httpStatus}`
      : 'rendered';

    results.push({
      role, page: p.label, path: p.path, expectedVisible, navShowsLink,
      outcome, heading: v.heading, httpStatus: v.httpStatus,
      badRequests: newBad.length, consoleErrors: newConsole.length, pageErrors: newPageErrors.length,
    });

    if (expectedVisible && (v.looksLikeError || (v.httpStatus && v.httpStatus >= 400))) {
      record('lms', {
        severity: 'high',
        role, page: p.label,
        scenario: `Direct visit to ${p.path} as ${role} (role should have access)`,
        expected: 'Page renders normally',
        actual: `outcome=${outcome} heading="${v.heading}" httpStatus=${v.httpStatus}`,
        evidence: `bodySnippet=${v.bodySnippet.slice(0,200)} badRequests=${JSON.stringify(newBad.slice(0,3))}`,
      });
    }
    if (!expectedVisible && outcome === 'rendered' && !wasRedirectedToLeads) {
      record('lms', {
        severity: 'high',
        role, page: p.label,
        scenario: `Direct visit to ${p.path} as ${role} (role should NOT have access)`,
        expected: 'Page blocked/redirected (role lacks this tier)',
        actual: `Page rendered directly: heading="${v.heading}"`,
        evidence: `url=${v.url} bodySnippet=${v.bodySnippet.slice(0,200)}`,
      });
    }
    if (newConsole.length || newPageErrors.length || newBad.length) {
      record('lms', {
        severity: newPageErrors.length ? 'high' : 'medium',
        role, page: p.label,
        scenario: `Errors while visiting ${p.path}`,
        expected: 'No console/page errors or failed requests',
        actual: `consoleErrors=${newConsole.length} pageErrors=${newPageErrors.length} badRequests=${newBad.length}`,
        evidence: JSON.stringify({ console: newConsole.slice(0,3), pageErr: newPageErrors.slice(0,3), bad: newBad.slice(0,3) }),
      });
    }
  }

  await browser.close();
  console.log(`done role=${role}`);
}

save('lms', 'coverage', results);
console.log('COVERAGE COMPLETE');
console.table(results.map(r => ({ role: r.role, page: r.page, outcome: r.outcome, nav: r.navShowsLink, bad: r.badRequests, cErr: r.consoleErrors })));
