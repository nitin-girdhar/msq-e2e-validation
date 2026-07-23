// A7 — Cross-product SSO: after login (via shared storage state, cookie domain
// "localhost" with no port restriction — see .auth/*.json), navigate to
// lms/hr/todo and confirm no re-login is required.
import { chromium } from '@playwright/test';
import { APPS, record, dir } from '../../lib.mjs';
import path from 'node:path';
const statePath = path.join(dir, '.auth', 'org_admin.json');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: statePath });
const page = await ctx.newPage();
const log = { consoleErrors: [], badRequests: [] };
page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

const targets = [
  { app: 'lms-web', path: '/dashboard/leads' },
  { app: 'hr-web', path: '/leave' },
  { app: 'todo-web', path: '/tasks' },
];

for (const t of targets) {
  const url = `${APPS[t.app]}${t.path}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log(`  nav error: ${e.message}`));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const finalUrl = page.url();
  const requiredLogin = /\/login/.test(finalUrl);
  console.log(`${t.app.padEnd(10)} ${url} -> ${finalUrl}  reLoginRequired=${requiredLogin}`);
  if (requiredLogin) {
    record('core', {
      severity: 'high',
      role: 'org_admin',
      page: `${t.app}${t.path}`,
      scenario: 'Cross-product SSO broken: product app required re-login despite valid auth-web session',
      expected: 'Shared fc_session cookie (domain=localhost, no port scoping) grants access without re-authenticating',
      actual: `Navigating to ${url} redirected to ${finalUrl}`,
      evidence: 'Used the org_admin storage state saved by auth-setup.mjs (already authenticated against auth-web) directly against the product app origin.',
    });
  }
}

console.log('\nconsoleErrors:', log.consoleErrors.slice(0, 5));
console.log('badRequests:', log.badRequests.slice(0, 10));
await browser.close();
console.log('\nDone.');
