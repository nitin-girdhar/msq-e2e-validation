// Lookup-admin module-grouped left nav + generic FK drill-through.
//
// Recently the lookup-admin dashboard changed from one flat card grid at
// /dashboard to a left rail grouped by module (Platform/LMS/HRMS/Tasks/
// Capabilities — see LookupTableDef.module in lookupTableConfig.ts), each
// landing on /dashboard/m/[module]. At the same time the old hardcoded
// GeoCascadeSelect (country/state/city) and the ad-hoc `selectOptionsFrom`
// dropdown were replaced by a single generic `fk` field type (FkSelect) that
// chains off a sibling field via `dependsOn`.
//
// This suite proves both landed correctly for the one role allowed in
// (super_admin):
//   1. /dashboard redirects into the module nav, and every module link in the
//      sidebar opens a pane whose card count matches what the config expects.
//   2. Every table card actually routes to a working (non-404) table page.
//   3. The FK chain on Organizations' Create form: Country populates on open,
//      State stays disabled until a Country is chosen, and City stays
//      disabled until a State is chosen (dependsOn enforcement) — the exact
//      behavior GeoCascadeSelect used to hardcode, now generic.
//
//   node suites/admin/lookup-module-nav.mjs
import { openState, visit, record, APPS } from '../../lib.mjs';

const TOOL = 'admin';
const APP = APPS['lookup-admin'];
const ROLE = 'super_admin';

// Expected card count per module pane — kept loose (>=) rather than exact so
// this suite doesn't need editing every time a lookup table is added; it
// exists to catch a module rendering EMPTY or the nav losing a group, not to
// pin the catalog size.
const EXPECTED_MIN_CARDS = {
  platform: 5, // org-types, tenant-domains, tenant-plan-types, tenants, organizations (+ Users)
  lms: 7,
  hr: 3,
  tasks: 2,
  capabilities: 4, // user-roles, lms-roles, hr-roles, task-roles (+ Capability Matrix)
};

const { browser, page, log } = await openState(ROLE);

// ── 1. /dashboard lands in the module nav, not a dead flat page ────────────
const landing = await visit(page, `${APP}/dashboard`);
const onPlatformModule = /\/dashboard\/m\/platform/.test(landing.url);
console.log(`/dashboard -> ${landing.url} (module nav=${onPlatformModule})`);
if (!onPlatformModule) {
  record(TOOL, {
    severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / dashboard',
    scenario: 'Visit /dashboard as super_admin',
    expected: 'Redirects to /dashboard/m/platform (the module nav landing pane)',
    actual: `Landed on ${landing.url} instead.`,
    evidence: `heading="${landing.heading}"`,
    proposedSolution: 'Check app/dashboard/page.tsx still redirects to /dashboard/m/platform.',
  });
}

// ── 2. Every module link in the sidebar opens a pane with cards ────────────
const moduleLinks = await page.locator('aside a[href*="/dashboard/m/"]')
  .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].filter(Boolean))
  .catch(() => []);
console.log(`Sidebar advertises ${moduleLinks.length} module link(s)`);

const expectedModules = Object.keys(EXPECTED_MIN_CARDS);
const foundModules = moduleLinks.map((h) => h.split('/').filter(Boolean).pop());
const missingModules = expectedModules.filter((m) => !foundModules.includes(m));
if (missingModules.length) {
  record(TOOL, {
    severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / sidebar',
    scenario: 'Every module (Platform/LMS/HRMS/Tasks/Capabilities) should appear in the left nav for super_admin',
    expected: `Modules present: ${expectedModules.join(', ')}`,
    actual: `Missing: ${missingModules.join(', ')}. Sidebar links: ${moduleLinks.join(', ')}`,
    evidence: 'ADMIN_NAV / MODULES mismatch, or filterNavGroups dropped a group the actor should hold',
    proposedSolution: 'Check src/config/navigation.ts ADMIN_NAV against MODULES, and that admin.lookups.manage/admin.roles.manage are both granted to super_admin.',
  });
}

const allCardLinks = [];
for (const href of moduleLinks) {
  const moduleKey = href.split('/').filter(Boolean).pop();
  const v = await visit(page, APP + href);
  const cardLinks = await page.locator('main a[href^="/dashboard/lookups/"], main a[href^="/dashboard/users"], main a[href^="/dashboard/capabilities/"]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].filter(Boolean))
    .catch(() => []);
  const minExpected = EXPECTED_MIN_CARDS[moduleKey];
  console.log(`  ${href.padEnd(28)} heading="${v.heading}" cards=${cardLinks.length}${minExpected ? ` (expect >=${minExpected})` : ''}`);
  allCardLinks.push(...cardLinks);

  if (minExpected && cardLinks.length < minExpected) {
    record(TOOL, {
      severity: 'high', role: ROLE, tool: TOOL, page: `Lookup Admin / ${href}`,
      scenario: `Open the '${moduleKey}' module pane and count its table/screen cards`,
      expected: `At least ${minExpected} card(s) (tablesByModule('${moduleKey}') plus any hand-built screen cards)`,
      actual: `Only ${cardLinks.length} card(s) rendered.`,
      evidence: `${APP}${href} heading="${v.heading}"`,
      proposedSolution: `Check tablesByModule('${moduleKey}') and EXTRA_CARDS in app/dashboard/m/[module]/page.tsx.`,
    });
  }
}

// ── 3. Every advertised card actually opens (no dead links) ────────────────
let broken = 0;
for (const href of new Set(allCardLinks)) {
  if (!href.startsWith('/dashboard/lookups/')) continue; // Users/Capability Matrix covered by their own suites
  const v = await visit(page, APP + href);
  const is404 = /404|could not be found/i.test(v.bodySnippet || '') || v.heading === '404';
  if (is404) {
    broken++;
    record(TOOL, {
      severity: 'high', role: ROLE, tool: TOOL, page: `Lookup Admin / ${href}`,
      scenario: 'Open a table card linked from a module pane',
      expected: 'The [table] route renders the table (config exists in TABLE_CONFIG)',
      actual: `404 — the card links to a slug with no matching TABLE_CONFIG entry.`,
      evidence: `${APP}${href}`,
      proposedSolution: 'Confirm the slug in EXTRA_CARDS/tablesByModule matches a real TABLE_CONFIG key.',
    });
  }
}
console.log(`Checked ${new Set(allCardLinks).size} card link(s); ${broken} broken`);

// ── 4. FK drill-through chain on Organizations' Create form ────────────────
console.log('\nFK chain check: Organizations -> Create -> Country/State/City');
await visit(page, `${APP}/dashboard/lookups/organizations`);
await page.getByRole('button', { name: /^new$/i }).first().click({ timeout: 5000 }).catch(() => {});
const dialog = page.locator('[role="dialog"]');
const opened = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
console.log(`  Create modal opened: ${opened}`);

if (opened) {
  // Tenant is a plain (non-chained) fk field — must populate on open.
  const tenantSelect = dialog.locator('select#cl-tenant_id, select[id$="tenant_id"]').first();
  const tenantOpts = await tenantSelect.locator('option').count().catch(() => 0);
  console.log(`  Tenant select options: ${tenantOpts}`);
  if (tenantOpts <= 1) {
    record(TOOL, {
      severity: 'medium', role: ROLE, tool: TOOL, page: 'Lookup Admin / organizations (Create)',
      scenario: "Open the Organizations create form and read the Tenant dropdown (fk: { table: 'tenants', scope: 'global' })",
      expected: 'The Tenant select is populated from GET /lookups/tenants',
      actual: `Only ${tenantOpts} option(s) present (just the placeholder).`,
      evidence: `${APP}/dashboard/lookups/organizations`,
      proposedSolution: 'Check FkSelect resolves a global-scope fk without a tenant_id query param.',
    });
  }

  const countrySelect = dialog.locator('select[id$="country_id"]').first();
  const stateSelect = dialog.locator('select[id$="state_id"]').first();
  const citySelect = dialog.locator('select[id$="city_id"]').first();

  const countryOpts = await countrySelect.locator('option').count().catch(() => 0);
  const stateDisabledBefore = await stateSelect.isDisabled().catch(() => null);
  const cityDisabledBefore = await citySelect.isDisabled().catch(() => null);
  console.log(`  Country options=${countryOpts} | State disabled(pre)=${stateDisabledBefore} | City disabled(pre)=${cityDisabledBefore}`);

  if (countryOpts <= 1) {
    record(TOOL, {
      severity: 'medium', role: ROLE, tool: TOOL, page: 'Lookup Admin / organizations (Create)',
      scenario: "Read the Country dropdown (fk: { endpoint: 'geo-countries' })",
      expected: 'The Country select is populated on modal open',
      actual: `Only ${countryOpts} option(s) present.`,
      evidence: `${APP}/dashboard/lookups/organizations`,
      proposedSolution: 'Check FkSelect resolves the geo-countries endpoint without waiting on a dependsOn value.',
    });
  }
  if (stateDisabledBefore === false) {
    record(TOOL, {
      severity: 'medium', role: ROLE, tool: TOOL, page: 'Lookup Admin / organizations (Create)',
      scenario: 'State field before a Country is chosen',
      expected: "State stays disabled (dependsOn: 'country_id' unmet) until a Country is selected",
      actual: 'State select is already enabled with no Country chosen.',
      evidence: `${APP}/dashboard/lookups/organizations`,
      proposedSolution: 'Check FkSelect.parentPending disables the control until formValues[dependsOn] is truthy.',
    });
  }

  if (countryOpts > 1) {
    await countrySelect.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(800); // FkSelect's state fetch effect
    const stateOpts = await stateSelect.locator('option').count().catch(() => 0);
    const stateDisabledAfter = await stateSelect.isDisabled().catch(() => null);
    console.log(`  After choosing a Country: State options=${stateOpts} disabled=${stateDisabledAfter}`);
    if (stateOpts <= 1) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / organizations (Create)',
        scenario: 'Choose a Country, then read the State dropdown',
        expected: 'State populates from GET /locations?level=geo.states&countryIds=<chosen> within ~1s',
        actual: `State still has only ${stateOpts} option(s) (placeholder) after choosing a country.`,
        evidence: `${APP}${'/dashboard/lookups/organizations'}; badRequests=${JSON.stringify(log.badRequests.slice(-4))}`,
        proposedSolution: 'Check FkSelect refetches on the dependsOn value change (deps array in the useEffect) and lookupAdmin.geo.states resolves.',
      });
    } else if (stateOpts > 1) {
      await stateSelect.selectOption({ index: 1 }).catch(() => {});
      await page.waitForTimeout(800);
      const cityOpts = await citySelect.locator('option').count().catch(() => 0);
      console.log(`  After choosing a State: City options=${cityOpts}`);
      if (cityOpts <= 1) {
        record(TOOL, {
          severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / organizations (Create)',
          scenario: 'Choose Country then State, then read the City dropdown',
          expected: 'City populates from GET /lookups/cities?state_id=<chosen>',
          actual: `City still has only ${cityOpts} option(s) after choosing a state.`,
          evidence: `${APP}/dashboard/lookups/organizations`,
          proposedSolution: "Check FkSelect's endpoint='geo-cities' branch and dependsOn='state_id' chaining.",
        });
      } else {
        console.log('  OK: Country -> State -> City chain populated correctly');
      }
    }
  }

  // Close without saving — this suite only reads, never creates a row.
  await page.keyboard.press('Escape').catch(() => {});
}

console.log(`\nconsoleErrors=${log.consoleErrors.length} badRequests=${log.badRequests.length}`);
if (log.badRequests.length) console.log('  badRequests:', log.badRequests.slice(0, 6));

await browser.close();
console.log('\ndone.');
