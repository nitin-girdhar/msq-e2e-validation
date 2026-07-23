// Logs in every seeded role (and the secondary concurrency actors) through the
// real UI and saves a Playwright storageState per login into .auth/. Run once
// before any exploration/crawl script.
//
// Covers the full ladder read_only -> super_admin plus the department roles
// (hr_head, sales_manager, ops_executive, ...) enumerated in roles.json, so a
// single storageState exists for each distinct role the platform ships.
//
// Two things this must get right:
//  1. Hydration — LoginForm is a client component; clicking submit before React
//     attaches causes a native GET (credentials land in the URL). We wait for a
//     React fiber on the <form> before touching it.
//  2. /select-branch — users mapped to >1 org (super_admin, tenant_admin) are
//     routed through a branch picker before the product app.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, dir, authDir, resultsDir } from './lib.mjs';

fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

// One login attempt -> a saved storageState at .auth/<stateKey>.json.
async function login({ stateKey, email }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  let status = 'ok';
  let landedOn = '';
  let branchPicker = false;
  try {
    await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);

    await page.locator('#email').fill(email);
    await page.locator('#password').fill(cfg.password);
    await page.locator('button[type="submit"]').click();

    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (/select-branch/.test(page.url())) {
      branchPicker = true;
      const option = page.locator('button, [role="option"], li').filter({ hasText: /fitclass|msquare|itc/i }).first();
      await option.click({ timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    landedOn = page.url();
    if (/\/login/.test(landedOn)) status = 'stuck-on-login';
    if (/password=/.test(landedOn)) status = 'CREDENTIALS-IN-URL';
    await ctx.storageState({ path: path.join(authDir, `${stateKey}.json`) });
  } catch (err) {
    status = `failed: ${err.message.split('\n')[0]}`;
  }

  const rec = { stateKey, email, status, landedOn, branchPicker, consoleErrors: errors.slice(0, 10) };
  console.log(`${stateKey.padEnd(26)} ${status.padEnd(18)} branch=${branchPicker ? 'Y' : 'n'} ${landedOn}`);
  if (errors.length) console.log(`   console errors (${errors.length}): ${errors[0]?.slice(0, 200)}`);
  await browser.close();
  return rec;
}

// Every distinct role uses its role name as the state key; secondary actors use
// their actor label (rep2, rep3) so concurrency suites can open two same-role
// contexts against distinct users.
let logins = [
  ...cfg.roles.map((r) => ({ stateKey: r.role, email: r.email })),
  ...(cfg.secondaryActors ?? []).map((a) => ({ stateKey: a.actor, email: a.email })),
];

// AUTH_ONLY=org_admin,rep2  → refresh just those storage states (fast re-login
// when a subset of sessions has expired / rotated).
const only = (process.env.AUTH_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
if (only.length) logins = logins.filter((l) => only.includes(l.stateKey));

const results = [];
for (const l of logins) results.push(await login(l));

fs.writeFileSync(path.join(resultsDir, 'auth-setup.json'), JSON.stringify(results, null, 2));
const ok = results.filter((r) => r.status === 'ok').length;
console.log(`\nSaved ${ok}/${results.length} storage states to .auth/`);
if (ok < results.length) {
  console.log('Failures:');
  for (const r of results.filter((r) => r.status !== 'ok')) console.log(`  ${r.stateKey}: ${r.status}`);
}
