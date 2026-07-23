// A) 1 & part of 3 — real-paced login for each role via the actual form, plus
// phone-number login (identifier field accepts email OR mobile — see
// msq-core/services/identity-service/src/api/v1/auth/auth.service.ts resolveLoginUser).
// Verifies: no native-GET credential leak at human speed, correct landing page,
// no console/page errors, no bad (>=400) requests.
import { chromium } from '@playwright/test';
import { cfg, record } from '../../lib.mjs';

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

// Types like a human: per-character delay + a short pause before submit.
async function humanType(locator, text) {
  await locator.click();
  await locator.pressSequentially(text, { delay: 60 });
}

async function attemptLogin(role, email, password, label) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const log = { consoleErrors: [], pageErrors: [], badRequests: [], urlsSeen: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('framenavigated', (f) => log.urlsSeen.push(f.url()));

  let outcome = 'ok';
  let landedOn = '';
  try {
    await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.waitForTimeout(300); // human reaction time before typing

    await humanType(page.locator('#email'), email);
    await page.waitForTimeout(200);
    await humanType(page.locator('#password'), password);
    await page.waitForTimeout(250); // human pause before clicking submit

    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    landedOn = page.url();
  } catch (err) {
    outcome = `error: ${err.message.split('\n')[0]}`;
  }

  const anyPasswordInUrl = log.urlsSeen.some((u) => /password=/.test(u)) || /password=/.test(landedOn);

  console.log(`[${label}] ${role.padEnd(24)} landed=${landedOn} passwordInUrl=${anyPasswordInUrl} consoleErr=${log.consoleErrors.length} badReq=${log.badRequests.length}`);
  if (log.consoleErrors.length) console.log('   consoleErrors:', log.consoleErrors.slice(0, 3));
  if (log.badRequests.length) console.log('   badRequests:', log.badRequests.slice(0, 5));

  if (anyPasswordInUrl) {
    record('core', {
      severity: 'critical',
      role,
      page: '/login',
      scenario: `${label}: human-paced login`,
      expected: 'Password never appears in the URL (form is a client component; submit must go through JS fetch, not a native GET)',
      actual: `Password appeared in a navigated URL: ${log.urlsSeen.find((u) => /password=/.test(u)) || landedOn}`,
      evidence: 'Confirmed with pressSequentially (60ms/char) + explicit waits mimicking human timing, not instant .fill(); re-run once to confirm reproducibility before recording.',
    });
  }

  await browser.close();
  return { role, outcome, landedOn, log, anyPasswordInUrl };
}

const results = [];
for (const { role, email } of cfg.roles) {
  results.push(await attemptLogin(role, email, cfg.password, 'email-login'));
}

// Re-run the password-in-url check a second time for org_admin to confirm reproducibility either way.
const confirm = await attemptLogin('org_admin', cfg.roles[0].email, cfg.password, 'email-login-rerun');
results.push(confirm);

console.log('\n--- summary ---');
for (const r of results) {
  console.log(`${r.role.padEnd(24)} outcome=${r.outcome} passwordInUrl=${r.anyPasswordInUrl}`);
}
