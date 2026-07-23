// A2 — wrong password, unknown email, empty fields, whitespace-only.
// Uses ONLY the org_admin account and at most ONE bad-password attempt (lockout
// threshold is 10 failed attempts / 15 min per LOGIN_MAX_FAILED_ATTEMPTS default,
// but other e2e agents share this account's storage state, so we stay well clear).
import { chromium } from '@playwright/test';
import { cfg, record } from '../../lib.mjs';

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

async function scenario(name, fn) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = { consoleErrors: [], badRequests: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const result = await fn(page);

  console.log(`\n[${name}]`);
  console.log('  result:', JSON.stringify(result));
  console.log('  badRequests:', log.badRequests);
  console.log('  consoleErrors:', log.consoleErrors.slice(0, 3));

  await browser.close();
  return { name, result, log };
}

const results = [];

results.push(await scenario('wrong-password', async (page) => {
  await page.locator('#email').fill(cfg.roles[0].email);
  await page.locator('#password').fill('WrongPass@123');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(2000);
  const alert = await page.locator('[role="alert"]').first().innerText().catch(() => null);
  const url = page.url();
  return { alert, url };
}));

results.push(await scenario('unknown-email', async (page) => {
  await page.locator('#email').fill('E2E-nonexistent-user@fitclass.ggn.in');
  await page.locator('#password').fill('SomePassword@123');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(2000);
  const alert = await page.locator('[role="alert"]').first().innerText().catch(() => null);
  const url = page.url();
  return { alert, url };
}));

results.push(await scenario('empty-fields', async (page) => {
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  const emailErr = await page.locator('#email-error').innerText().catch(() => null);
  const pwErr = await page.locator('#password-error').innerText().catch(() => null);
  const url = page.url();
  return { emailErr, pwErr, url };
}));

results.push(await scenario('whitespace-only', async (page) => {
  await page.locator('#email').fill('   ');
  await page.locator('#password').fill('   ');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  const emailErr = await page.locator('#email-error').innerText().catch(() => null);
  const pwErr = await page.locator('#password-error').innerText().catch(() => null);
  const url = page.url();
  return { emailErr, pwErr, url };
}));

// Compare wrong-password vs unknown-email messages — should be identical
// (generic "invalid credentials") per auth.service.ts's anti-enumeration design.
const wp = results[0].result.alert;
const ue = results[1].result.alert;
console.log('\n--- enumeration check ---');
console.log('wrong-password alert:', wp);
console.log('unknown-email alert :', ue);
if (wp && ue && wp !== ue) {
  record('core', {
    severity: 'medium',
    role: 'org_admin',
    page: '/login',
    scenario: 'Error message differs between wrong-password and unknown-email',
    expected: 'Identical generic "Invalid credentials" message for both (auth.service.ts is designed to avoid user enumeration)',
    actual: `wrong-password="${wp}" vs unknown-email="${ue}"`,
    evidence: 'Directly compared both alert texts in the same script run.',
  });
} else if (wp && ue && wp === ue) {
  console.log('OK: messages match (no enumeration signal via error text).');
}

// Any 5xx across all four negative scenarios would be a real bug.
for (const r of results) {
  const serverErrors = r.log.badRequests.filter((b) => /^5\d\d/.test(b));
  if (serverErrors.length) {
    record('core', {
      severity: 'high',
      role: 'org_admin',
      page: '/login',
      scenario: `${r.name}: server error on login attempt`,
      expected: 'No 5xx from a client-side validation/auth failure',
      actual: serverErrors.join('; '),
      evidence: `Captured via page.on('response') during ${r.name} scenario.`,
    });
  }
}

console.log('\nDone.');
