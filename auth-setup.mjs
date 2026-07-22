// Logs in every seeded role through the real UI and saves a Playwright
// storageState per role into .auth/. Run once before any exploration script.
//
// Two things this must get right:
//  1. Hydration — LoginForm is a client component; clicking submit before React
//     attaches causes a native GET (credentials land in the URL). We wait for a
//     React fiber on the <form> before touching it.
//  2. /select-branch — users mapped to >1 org and rank < 90 are routed through a
//     branch picker before the product app.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8'));
const authDir = path.join(dir, '.auth');
fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(path.join(dir, 'results'), { recursive: true });

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

const results = [];

for (const { role, email } of cfg.roles) {
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

    // Either the branch picker or the destination product app.
    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (/select-branch/.test(page.url())) {
      branchPicker = true;
      const option = page.locator('button, [role="option"], li').filter({ hasText: /fitclass|itc/i }).first();
      await option.click({ timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    landedOn = page.url();
    if (/\/login/.test(landedOn)) status = 'stuck-on-login';
    if (/password=/.test(landedOn)) status = 'CREDENTIALS-IN-URL';
    await ctx.storageState({ path: path.join(authDir, `${role}.json`) });
  } catch (err) {
    status = `failed: ${err.message.split('\n')[0]}`;
  }

  results.push({ role, email, status, landedOn, branchPicker, consoleErrors: errors.slice(0, 10) });
  console.log(`${role.padEnd(24)} ${status.padEnd(16)} branch=${branchPicker ? 'Y' : 'n'} ${landedOn}`);
  if (errors.length) console.log(`   console errors (${errors.length}): ${errors[0]?.slice(0, 200)}`);
  await browser.close();
}

fs.writeFileSync(path.join(dir, 'results', 'auth-setup.json'), JSON.stringify(results, null, 2));
console.log('\nSaved storage states to .auth/');
