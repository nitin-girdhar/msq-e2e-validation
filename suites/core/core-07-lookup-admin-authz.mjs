// B8 — lookup-admin (the /sa super-admin console) authorization.
//
// msq-core/apps/lookup-admin/app/dashboard/layout.tsx gates the ENTIRE
// dashboard on canOpenLookupAdmin(session) — the admin.lookups.manage
// capability AND the super_admin rank. Since c2fba5e ("SA console guard") a
// signed-in non-super-admin is NOT redirected any more (that looped: /login saw
// a valid session and bounced back); the layout renders an in-place
// "Access restricted" panel instead. So "denied" = bounced to /login OR that
// panel, and "bypass" = any console content rendered for a lower role.
//
// super_admin is in roles.json now and is the positive control: it MUST get in,
// otherwise a guard that refused everyone would look like a pass.
import { openAs, APPS, record, cfg } from '../../lib.mjs';

const targets = [
  '/dashboard/m/platform', '/dashboard/users', '/dashboard/lookups/lead-stage',
  '/dashboard/meta-campaigns', '/dashboard/meta-lead-inbox', '/dashboard/lead-pull',
  '/dashboard/lead-assignment-rerun', '/dashboard/capabilities/matrix', '/dashboard/campaign-types',
];

for (const { role } of cfg.roles) {
  const { browser, page, log } = await openAs(role);
  for (const t of targets) {
    const url = `${APPS['lookup-admin']}${t}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log(`  nav error: ${e.message}`));
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const finalUrl = page.url();
    const body = await page.locator('body').innerText().catch(() => '');
    const denied = /\/login/.test(finalUrl) || /access restricted/i.test(body);
    console.log(`${role.padEnd(26)} ${t.padEnd(36)} denied=${denied}`);

    if (role === 'super_admin') {
      if (denied) {
        record('core', {
          severity: 'high', role, page: t,
          scenario: 'super_admin is refused by the lookup-admin console',
          expected: 'canOpenLookupAdmin(session) is true for super_admin (rank 1000 + admin.lookups.manage)',
          actual: `Denied on ${finalUrl}`,
          evidence: body.slice(0, 200),
          proposedSolution: 'Check the admin.lookups.manage grant for super_admin in iam.fn_role_capability_matrix and the session rank.',
        });
      }
    } else if (!denied) {
      record('core', {
        severity: 'critical', role, page: t,
        scenario: `lookup-admin authorization bypass: ${role} (not super_admin) reached ${t}`,
        expected: 'The layout renders "Access restricted" (or bounces to /login) for anyone failing canOpenLookupAdmin',
        actual: `Console content rendered at ${finalUrl}. Body: ${body.slice(0, 200)}`,
        evidence: `Visited ${url} with the ${role} storage state.`,
        proposedSolution: 'Keep canOpenLookupAdmin in app/dashboard/layout.tsx and make sure no page under /dashboard is exported outside that layout.',
      });
    }
  }
  if (log.badRequests.some((b) => /^5\d\d /.test(b))) console.log('   5xx:', log.badRequests.filter((b) => /^5\d\d /.test(b)).slice(0, 5));
  await browser.close();
}

console.log('\nDone.');
