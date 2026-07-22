// A6 — Open-redirect guard for ?callbackUrl=. resolveCallback() in
// msq-core/apps/auth-web/src/lib/callback.ts only honors an ABSOLUTE callback
// whose origin is in allowedRedirectOrigins() (auth/lms/hr/task origins from
// NEXT_PUBLIC_*_URL). Everything else falls back to defaultDestination().
// A relative path is only honored when origins.length === 0 (pure single-host
// dev with no cross-app origins configured) — here origins ARE configured
// (localhost:3000/3001/3002/3003), so even a same-origin-looking relative path
// like `/evil` should fall back too. We test both the unauthenticated
// (/login) and authenticated (/select-branch never seen; already-signed-in
// redirect) code paths.
import { chromium } from '@playwright/test';
import { cfg, record } from './lib.mjs';

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

const EVIL = 'https://evil.example.com/steal';

// --- Scenario 1: unauthenticated visit to /login?callbackUrl=<evil> ---
{
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${cfg.apps['auth-web']}/login?callbackUrl=${encodeURIComponent(EVIL)}`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  const formHtml = await page.locator('form').innerHTML().catch(() => '');
  const submitHref = await page.evaluate(() => {
    // The callbackUrl is passed as a React prop, not rendered into the DOM
    // directly, so we log in and see where it actually navigates.
    return null;
  });
  await page.locator('#email').fill(cfg.roles[0].email);
  await page.locator('#password').fill(cfg.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const finalUrl = page.url();
  console.log('[unauthenticated evil callbackUrl] final landing:', finalUrl);

  if (finalUrl.startsWith('https://evil.example.com')) {
    record('core', {
      severity: 'critical',
      role: 'org_admin',
      page: '/login?callbackUrl=https://evil.example.com/steal',
      scenario: 'Open redirect: external callbackUrl honored after login',
      expected: 'resolveCallback() rejects an origin not in allowedRedirectOrigins() and falls back to defaultDestination()',
      actual: `Browser navigated to attacker-controlled origin: ${finalUrl}`,
      evidence: 'Logged in through the real form with ?callbackUrl=https://evil.example.com/steal on the initial /login URL; final page.url() captured post-submit.',
    });
  } else {
    console.log('OK: external callbackUrl NOT honored; fell back to', finalUrl);
  }
  await browser.close();
}

// --- Scenario 2: already-authenticated GET /login?callbackUrl=<evil> (server redirect() path) ---
{
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const statePath = path.join(dir, '.auth', 'org_admin.json');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  const resp = await page.goto(`${cfg.apps['auth-web']}/login?callbackUrl=${encodeURIComponent(EVIL)}`, {
    waitUntil: 'domcontentloaded',
  }).catch((e) => ({ err: e.message }));
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const finalUrl2 = page.url();
  console.log('[authenticated evil callbackUrl, server redirect()] final landing:', finalUrl2);

  if (finalUrl2.startsWith('https://evil.example.com')) {
    record('core', {
      severity: 'critical',
      role: 'org_admin',
      page: '/login?callbackUrl=https://evil.example.com/steal (already authenticated)',
      scenario: 'Open redirect: server-side redirect() honors external callbackUrl for an already-signed-in session',
      expected: 'LoginPage server component (app/login/page.tsx) calls resolveCallback() before redirect(); external origin must fall back',
      actual: `Browser navigated to attacker-controlled origin: ${finalUrl2}`,
      evidence: 'Visited /login?callbackUrl=... using an already-authenticated storage state (org_admin.json), which triggers the immediate server redirect() path in app/login/page.tsx line 29.',
    });
  } else {
    console.log('OK: external callbackUrl NOT honored on the authenticated redirect path either; landed on', finalUrl2);
  }
  await browser.close();
}

// --- Scenario 3: relative-but-unexpected path, e.g. protocol-relative //evil.example.com ---
{
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const protocolRelative = '//evil.example.com/steal';
  await page.goto(`${cfg.apps['auth-web']}/login?callbackUrl=${encodeURIComponent(protocolRelative)}`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.locator('#email').fill(cfg.roles[1].email);
  await page.locator('#password').fill(cfg.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(3000);
  const finalUrl3 = page.url();
  console.log('[protocol-relative //evil callbackUrl] final landing:', finalUrl3);
  if (finalUrl3.includes('evil.example.com')) {
    record('core', {
      severity: 'critical',
      role: 'org_sr_manager',
      page: '/login?callbackUrl=//evil.example.com/steal',
      scenario: 'Open redirect via protocol-relative callbackUrl',
      expected: 'resolveCallback() rejects raw.startsWith("//") explicitly (see callback.ts comment) and falls back',
      actual: `Browser navigated to ${finalUrl3}`,
      evidence: 'Logged in with ?callbackUrl=//evil.example.com/steal through the real form.',
    });
  } else {
    console.log('OK: protocol-relative callbackUrl NOT honored; landed on', finalUrl3);
  }
  await browser.close();
}

console.log('\nDone.');
