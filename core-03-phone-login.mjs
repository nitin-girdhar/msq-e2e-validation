// A3 — Phone-number login. There is NO separate phone field in the UI
// (msq-core/apps/auth-web/components/auth/LoginForm.tsx still only has
// #email/#password inputs — the "phone number login" commit (d6d3e9c) only
// touched identity-service + platform-validation, not auth-web). The feature is
// exposed by typing a mobile number into the existing "Email" input: the
// backend's `identifier` field (packages/platform-validation/src/auth.ts,
// auth.service.ts resolveLoginUser) auto-detects non-'@' input as a mobile
// number and normalizes it (packages/platform-validation/src/phone.ts).
//
// Seeded mobiles for org fitclass.ggn.in (org_seq=3, db_scripts/08_seed_tenants_orgs_users.sql):
//   admin           +919811003001
//   srmanager       +919811003004
//   manager         +919811003005
//   senior.exec     +919811003006
//   rep1            +919811003002
//   rep2            +919811003003
//   rep3            +919811003009
//   viewer          +919811003007
import { chromium } from '@playwright/test';
import { cfg, record } from './lib.mjs';

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

async function tryLogin(identifier, password, label) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = { consoleErrors: [], badRequests: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.locator('#email').fill(identifier);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const alert = await page.locator('[role="alert"]').first().innerText().catch(() => null);
  const url = page.url();
  console.log(`[${label}] identifier=${identifier} -> url=${url} alert=${alert} badReq=${log.badRequests.join(',')}`);
  await browser.close();
  return { label, identifier, url, alert, badRequests: log.badRequests };
}

// 1) Valid phone login (org_admin's seeded mobile).
const validPhone = await tryLogin('+919811003001', cfg.password, 'valid-phone-with-plus');
if (!/\/dashboard/.test(validPhone.url) && !/localhost:300[123]/.test(validPhone.url)) {
  record('core', {
    severity: 'high',
    role: 'org_admin',
    page: '/login',
    scenario: 'Valid seeded mobile number (+919811003001, E.164) fails to log in via the Email field',
    expected: 'Login succeeds and lands on the product dashboard (identifier auto-detected as mobile per resolveLoginUser)',
    actual: `Landed on ${validPhone.url}, alert="${validPhone.alert}"`,
    evidence: 'Direct attempt through the real login form; identifier is the seeded org_admin mobile for fitclass.ggn.in (org_seq=3).',
  });
} else {
  console.log('OK: E.164 mobile login succeeded.');
}

// 2) Valid phone, bare 10-digit form (no +91, no leading 0) — normalizeMobile should default to +91.
const validBare = await tryLogin('9811003002', cfg.password, 'valid-phone-bare-10digit-rep1');
console.log('bare-digit result url:', validBare.url, 'alert:', validBare.alert);
if (!/\/dashboard/.test(validBare.url) && !/localhost:300[123]/.test(validBare.url)) {
  record('core', {
    severity: 'medium',
    role: 'sales_representative',
    page: '/login',
    scenario: 'Bare 10-digit mobile (9811003002, no country code) fails to log in',
    expected: 'normalizeMobile() in platform-validation/src/phone.ts defaults bare 10-digit numbers to +91 and logs in successfully',
    actual: `Landed on ${validBare.url}, alert="${validBare.alert}"`,
    evidence: 'Direct attempt through the real login form using rep1 seeded mobile without country code.',
  });
}

// 3) Invalid / malformed phone numbers.
const invalidPhone = await tryLogin('123456', 'WrongPass@123', 'invalid-phone-too-short');
console.log('invalid short number result:', invalidPhone.url, invalidPhone.alert);

const wrongPhone = await tryLogin('+919999999999', cfg.password, 'valid-format-unregistered-phone');
console.log('unregistered-but-valid-format phone result:', wrongPhone.url, wrongPhone.alert);

// Check for 5xx anywhere.
for (const r of [validPhone, validBare, invalidPhone, wrongPhone]) {
  const serverErrors = r.badRequests.filter((b) => /^5\d\d/.test(b));
  if (serverErrors.length) {
    record('core', {
      severity: 'high',
      role: 'n/a',
      page: '/login',
      scenario: `${r.label}: server error on phone login attempt`,
      expected: 'No 5xx for any phone-number identifier shape',
      actual: serverErrors.join('; '),
      evidence: `Captured via page.on('response') during ${r.label}.`,
    });
  }
}

// Compare error messages: invalid-format vs valid-format-but-unregistered vs
// wrong-password-email should all be the SAME generic message (no enumeration
// of which numbers are even well-formed, per resolveLoginUser's design intent).
console.log('\n--- enumeration check (phone) ---');
console.log('invalid-format alert         :', invalidPhone.alert);
console.log('valid-format-unregistered    :', wrongPhone.alert);
if (invalidPhone.alert && wrongPhone.alert && invalidPhone.alert !== wrongPhone.alert) {
  record('core', {
    severity: 'medium',
    role: 'n/a',
    page: '/login',
    scenario: 'Phone login error message differs between malformed and valid-but-unregistered numbers',
    expected: 'Identical generic "Invalid credentials" per resolveLoginUser\'s anti-enumeration design (comment: "a malformed one must fail as generic invalid credentials")',
    actual: `malformed="${invalidPhone.alert}" vs valid-unregistered="${wrongPhone.alert}"`,
    evidence: 'Directly compared alert texts from both attempts in this run.',
  });
} else {
  console.log('OK: no enumeration signal detected between malformed vs unregistered phone numbers.');
}

console.log('\nDone.');
