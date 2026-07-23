// B8 — lookup-admin authorization. msq-core/apps/lookup-admin/app/dashboard/layout.tsx
// gates the ENTIRE dashboard behind `session.rank < RANKS.SUPER_ADMIN` (rank 100,
// see packages/platform-authz/src/ranks.ts) -> redirect('/login?error=forbidden').
// None of the 6 seeded roles.json roles are super_admin (max is org_admin, rank 80,
// see db_scripts/07_seed_lookup_data.sql user_roles ranks), so EVERY role should be
// denied. This checks that denial actually holds for all 6 roles (a broken gate
// here would be a critical authz bug — this app manages platform-wide lookup data).
import { openAs, APPS, record } from '../../lib.mjs';
import { cfg } from '../../lib.mjs';

const targets = ['/dashboard', '/dashboard/users', '/dashboard/lookups/lead_stage'];

for (const { role } of cfg.roles) {
  const { browser, page, log } = await openAs(role);
  for (const t of targets) {
    const url = `${APPS['lookup-admin']}${t}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log(`  nav error: ${e.message}`));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const finalUrl = page.url();
    const denied = /\/login/.test(finalUrl);
    const body = await page.locator('body').innerText().catch(() => '');
    console.log(`${role.padEnd(24)} ${t.padEnd(28)} -> ${finalUrl}  denied=${denied}`);

    if (!denied) {
      record('core', {
        severity: 'critical',
        role,
        page: t,
        scenario: `lookup-admin authorization bypass: ${role} (not super_admin) reached a dashboard page`,
        expected: 'dashboard/layout.tsx redirects any session with rank < RANKS.SUPER_ADMIN (100) to /login?error=forbidden',
        actual: `Landed on ${finalUrl} instead of being redirected to login. Body snippet: ${body.slice(0, 200)}`,
        evidence: `Visited ${url} using the ${role} storage state (rank well below 100) via openAs().`,
      });
    }
  }
  console.log(`  consoleErrors=${log.consoleErrors.length} badRequests=${log.badRequests.length}`);
  if (log.badRequests.length) console.log('   badRequests:', log.badRequests.slice(0, 5));
  await browser.close();
}

console.log('\nDone.');
