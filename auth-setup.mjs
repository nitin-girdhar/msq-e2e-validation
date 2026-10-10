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
async function login({ stateKey, email, sessionOrg }) {
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
    // The gateway allows 10 logins/min per IP and this loop logs in ~20
    // accounts from one IP. A 429 leaves the form on /login and used to be
    // reported as 'stuck-on-login'; wait out Retry-After and resubmit instead.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);

      await page.locator('#email').fill(email);
      await page.locator('#password').fill(cfg.password);
      const loginResp = page.waitForResponse((r) => /\/api\/auth\/login$/.test(new URL(r.url()).pathname), { timeout: 20000 }).catch(() => null);
      await page.locator('button[type="submit"]').click();
      const r = await loginResp;
      if (!r || r.status() !== 429) break;
      const waitS = Math.min(Math.max(Number(r.headers()['retry-after']) || 15, 2), 65);
      console.log(`   ${stateKey}: login rate-limited (429), waiting ${waitS}s`);
      await page.waitForTimeout(waitS * 1000 + 250);
    }

    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (/select-branch/.test(page.url())) {
      branchPicker = true;
      // Any branch is a valid login for test purposes — the old regex
      // (/fitclass|msquare|itc/i) matched only the fictional seed's org
      // names; against real branch names (e.g. "Gurugram - Sector 69") it
      // matched nothing, the click silently no-op'd, and the user was left
      // stranded on /select-branch with an incomplete session (breaks every
      // subsequent API call with 401 "Invalid token").
      // The HOME branch ("· Default", SelectBranchList is_home), not the first
      // option: the list is alphabetical, so a multi-branch user (org_manager is
      // mapped to 4) landed on a non-home branch, where hr-web correctly moves
      // them off /leave (apply is home-branch only) — which the suites then read
      // as "Apply leave hidden from a permitted user".
      const home = page.locator('button, [role="option"], li').filter({ hasText: /· Default/ }).first();
      // roles.json `sessionOrg` overrides the home branch for a login whose home is unusable
      // (hr_admin is homed in the INACTIVE Fitclass - Head Office: every branch-pinned HR
      // action then 404s "not found in this org"). Cycle 9.
      const wanted = sessionOrg ? page.locator('button, [role="option"], li').filter({ hasText: sessionOrg }).first() : null;
      const option = wanted && (await wanted.count()) ? wanted : (await home.count()) ? home : page.locator('button, [role="option"], li').first();
      await option.click({ timeout: 10000 }).catch(() => {});
      // networkidle alone is flaky under load (many browsers/dev-servers
      // contending for CPU): the org-switch fetch + client-side navigation
      // can start after the idle check already passed, leaving the click
      // apparently "successful" but the page still on /select-branch. Wait
      // for the URL to actually change first (retrying the click once if it
      // doesn't), then settle on networkidle.
      const left = await page.waitForURL((u) => !/select-branch/.test(u.pathname), { timeout: 12000 }).then(() => true).catch(() => false);
      if (!left) {
        await option.click({ timeout: 10000 }).catch(() => {});
        await page.waitForURL((u) => !/select-branch/.test(u.pathname), { timeout: 15000 }).catch(() => {});
      }
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
  ...cfg.roles.map((r) => ({ stateKey: r.role, email: r.email, sessionOrg: r.sessionOrg })),
  ...(cfg.secondaryActors ?? []).map((a) => ({ stateKey: a.actor, email: a.email })),
  // Tenant B — required by the cross-tenant isolation suite.
  ...(cfg.crossTenantActors ?? []).map((a) => ({ stateKey: a.stateKey, email: a.email })),
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
