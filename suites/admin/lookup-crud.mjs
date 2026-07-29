// Lookup-Admin write verification.
//
// The crawl only proved these pages RENDER. This proves the console actually
// works end to end, which is what an admin console is for:
//
//   1. every lookup table advertised on the dashboard opens (drill-down) and
//      its rows/options actually populate — an empty dropdown is a dead tool;
//   2. editing a value and saving CHANGES IT — verified twice: the UI reflects
//      the new value after reload, AND the row really changed in Postgres;
//   3. the original value is restored afterwards, so the suite is repeatable.
//
// Runs as super_admin (the only role the console admits).
//
//   node suites/admin/lookup-crud.mjs
import { openState, visit, record, APPS } from '../../lib.mjs';
import { dbReachable, rows as dbRows, q, lit } from '../../db.mjs';

const TOOL = 'admin';
const APP = APPS['lookup-admin'];
const ROLE = 'super_admin';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const { browser, page, log } = await openState(ROLE);
const summary = [];

// ── 1. Discover every lookup table linked from the module nav ──────────────
// The dashboard used to be one flat card grid; it now redirects to
// /dashboard/m/platform and each table lives under its module pane
// (Platform/LMS/HRMS/Tasks/Capabilities — see LookupTableDef.module). Walk the
// left-rail nav to find every module link, then collect the lookup-table cards
// each pane advertises, rather than assuming one page lists everything.
await visit(page, `${APP}/dashboard`);
const moduleHrefs = await page.locator('aside a[href*="/dashboard/m/"]')
  .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].filter(Boolean))
  .catch(() => []);
console.log(`Nav advertises ${moduleHrefs.length} module(s): ${moduleHrefs.join(', ')}`);

if (moduleHrefs.length === 0) {
  record(TOOL, {
    severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / dashboard',
    scenario: 'Read the module-grouped left nav (Platform/LMS/HRMS/Tasks/Capabilities)',
    expected: 'The left rail lists at least the Platform module link (/dashboard/m/platform)',
    actual: 'No aside a[href*="/dashboard/m/"] links found — the module nav is empty or the sidebar markup changed.',
    evidence: `${APP}/dashboard -> ${page.url()}`,
    proposedSolution: 'Confirm AppSidebar received ADMIN_NAV groups and the actor holds admin.lookups.manage/admin.roles.manage.',
  });
}

const links = [];
for (const href of moduleHrefs) {
  await visit(page, APP + href);
  const tableLinks = await page.locator('a[href*="/dashboard/lookups/"]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].filter(Boolean))
    .catch(() => []);
  console.log(`  ${href.padEnd(28)} -> ${tableLinks.length} table(s)`);
  links.push(...tableLinks);
}
const uniqueLinks = [...new Set(links)];
console.log(`Module panes advertise ${uniqueLinks.length} lookup table(s) total`);

for (const href of uniqueLinks) {
  const slug = href.split('/').filter(Boolean).pop();
  const v = await visit(page, APP + href);
  const is404 = /404|could not be found/i.test(v.bodySnippet || '') || v.heading === '404';
  if (is404) {
    // Already reported by the crawl; keep the inventory honest but don't dupe.
    summary.push({ slug, status: '404', rows: 0 });
    console.log(`  ${slug.padEnd(24)} 404 (broken link)`);
    continue;
  }

  // Drill-down: the table must actually render rows, not an empty shell.
  const rowCount = await page.locator('table tbody tr').count().catch(() => 0);
  // Any select/combobox on the page should offer options (a lookup editor with
  // an empty dropdown means its option source is broken).
  const selects = await page.locator('select').count().catch(() => 0);
  let emptySelects = 0;
  for (let i = 0; i < Math.min(selects, 8); i++) {
    const opts = await page.locator('select').nth(i).locator('option').count().catch(() => 0);
    if (opts <= 1) emptySelects++;
  }

  summary.push({ slug, status: 'ok', rows: rowCount, selects, emptySelects });
  console.log(`  ${slug.padEnd(24)} rows=${rowCount} selects=${selects} empty=${emptySelects}`);

  if (rowCount === 0) {
    record(TOOL, {
      severity: 'medium', role: ROLE, tool: TOOL, page: `Lookup Admin / ${slug}`,
      scenario: `Open the '${slug}' lookup table as ${ROLE} and read its rows`,
      expected: 'The lookup table lists its configured values',
      actual: 'The table rendered with zero rows — the drill-down shows no values, so the lookup cannot be reviewed or edited.',
      evidence: `${APP}${href} heading="${v.heading}" body="${(v.bodySnippet || '').slice(0, 160)}"`,
      proposedSolution: 'Check the catalog query/tenant scoping behind this table; if genuinely empty, render an explicit empty-state with a "Add first value" action instead of a bare table.',
    });
  }
  if (emptySelects > 0) {
    record(TOOL, {
      severity: 'medium', role: ROLE, tool: TOOL, page: `Lookup Admin / ${slug}`,
      scenario: `Inspect dropdown option sources on the '${slug}' editor`,
      expected: 'Every dropdown is populated from its lookup source',
      actual: `${emptySelects} of ${selects} dropdown(s) render with no selectable options.`,
      evidence: `${APP}${href}`,
      proposedSolution: 'Ensure the option source for these selects is fetched (and tenant-scoped) before the editor renders; show a loading/empty state rather than an empty control.',
    });
  }
}

// ── 2. Edit-and-save verification on a real, safe lookup row ───────────────
// lead_sources is a plain name/label catalog — safe to rename and restore.
const target = dbRows(
  `SELECT id, name FROM lms.lead_sources WHERE is_active ORDER BY created_at LIMIT 1`,
  ['id', 'name']
)[0];

if (!target) {
  console.log('\nNo lead_sources row to edit — skipping save verification');
} else {
  const original = target.name;
  const edited = `${original}-E2E`;
  console.log(`\nSave test on lms.lead_sources '${original}' (${target.id})`);

  await visit(page, `${APP}/dashboard/lookups/lead-sources`);
  // Find the row and its edit affordance.
  const row = page.locator('table tbody tr', { hasText: original }).first();
  const found = await row.count().catch(() => 0);
  if (!found) {
    console.log('  row not visible in UI — skipping');
  } else {
    await row.getByRole('button', { name: /edit|pencil/i }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
    const input = page.locator('[role="dialog"] input, form input').filter({ hasNot: page.locator('[type=checkbox]') }).first();
    await input.fill(edited, { timeout: 4000 }).catch(() => {});
    await page.getByRole('button', { name: /save|update|submit/i }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // (a) did the backend actually change?
    const dbNow = dbRows(`SELECT name FROM lms.lead_sources WHERE id=${lit(target.id)}`, ['name'])[0]?.name;
    // (b) does the UI show the new value after a full reload?
    await visit(page, `${APP}/dashboard/lookups/lead-sources`);
    const uiShowsEdited = await page.locator('table tbody', { hasText: edited }).count().catch(() => 0);

    console.log(`  DB now="${dbNow}" | UI shows edited=${uiShowsEdited > 0}`);

    if (dbNow !== edited) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: 'Lookup Admin / lead-sources',
        scenario: 'Edit a lookup value and click Save',
        expected: `The row is persisted with the new value ("${edited}")`,
        actual: `Backend still holds "${dbNow}" after saving — the edit did not persist.`,
        evidence: `lms.lead_sources id=${target.id}; attempted "${original}" -> "${edited}"; badRequests=${JSON.stringify(log.badRequests.slice(-4))}`,
        proposedSolution: 'Trace the save handler for this catalog — confirm the PATCH is issued, the id/tenant scope matches, and the response is applied rather than silently swallowed.',
      });
    } else if (!uiShowsEdited) {
      record(TOOL, {
        severity: 'medium', role: ROLE, tool: TOOL, page: 'Lookup Admin / lead-sources',
        scenario: 'Edit a lookup value, save, then reload the table',
        expected: 'The reloaded table shows the newly saved value',
        actual: 'The value was persisted in the database but the reloaded UI still shows the old value — stale cache/revalidation.',
        evidence: `db="${dbNow}" but table did not contain "${edited}" after reload`,
        proposedSolution: 'Invalidate/revalidate the lookup query after a successful mutation (router.refresh() or cache tag invalidation) so the table reflects committed state.',
      });
    } else {
      console.log('  OK: save changed both the database and the UI');
    }

    // restore
    q(`UPDATE lms.lead_sources SET name=${lit(original)} WHERE id=${lit(target.id)}`);
    console.log(`  restored name="${original}"`);
  }
}

await browser.close();
console.log('\ndone.');
