// A4 — Logout, then confirm protected pages redirect to login, and that the
// session cookie is actually cleared (not just the client-side redirect).
//
// IMPORTANT: uses a FRESH login (own JWT/jti), NOT the shared .auth/*.json
// storage states — /auth/logout revokes the session's jti server-side, and
// other e2e agents rely on those shared storage states staying valid.
import { chromium } from '@playwright/test';
import { cfg, APPS, record } from './lib.mjs';

async function waitForHydration(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
  }, null, { timeout: 20000 });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const log = { consoleErrors: [], badRequests: [] };
page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

// Fresh login as read_only (own session, safe to revoke).
const { email } = cfg.roles.find((r) => r.role === 'read_only');
await page.goto(`${cfg.apps['auth-web']}/login`, { waitUntil: 'domcontentloaded' });
await waitForHydration(page);
await page.locator('#email').fill(email);
await page.locator('#password').fill(cfg.password);
await page.locator('button[type="submit"]').click();
await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 25000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
console.log('Fresh login landed on:', page.url());

const cookiesBefore = await ctx.cookies();
const sessionCookieBefore = cookiesBefore.find((c) => c.name === 'fc_session');
console.log('Session cookie present before logout:', !!sessionCookieBefore);

// Confirm protected page is reachable pre-logout.
await page.goto(`${APPS['lms-web']}/dashboard/leads`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
console.log('Pre-logout protected page ->', page.url());

// Logout via auth-web's real API. Use the context-level request API (shares
// cookies with the browsing context) instead of page.evaluate(fetch(...)) —
// navigating to /login while already authenticated triggers login/page.tsx's
// server redirect() to the product app FIRST, which would silently move the
// page to a different origin (lms-web:3001) before the fetch runs, making any
// relative-URL fetch hit the wrong origin's /api/auth/logout.
const logoutRes = await ctx.request.post(`${cfg.apps['auth-web']}/api/auth/logout`);
const logoutResp = { status: logoutRes.status(), ok: logoutRes.ok() };
console.log('Logout API call result:', JSON.stringify(logoutResp));

const cookiesAfter = await ctx.cookies();
const sessionCookieAfter = cookiesAfter.find((c) => c.name === 'fc_session');
console.log('Session cookie present after logout:', !!sessionCookieAfter, sessionCookieAfter ? `value="${sessionCookieAfter.value.slice(0, 20)}..."` : '(absent)');

if (sessionCookieAfter && sessionCookieAfter.value) {
  record('core', {
    severity: 'critical',
    role: 'read_only',
    page: '/api/auth/logout',
    scenario: 'Session cookie not cleared after logout',
    expected: 'fc_session cookie removed or emptied (clearedSessionCookieOptions sets maxAge:0) after POST /auth/logout',
    actual: `Cookie still present with a non-empty value after logout call (status ${logoutResp.status})`,
    evidence: 'Compared ctx.cookies() before and after calling the real /api/auth/logout endpoint in the same browser context, using a freshly logged-in session (not a shared storage state).',
  });
} else {
  console.log('OK: session cookie cleared after logout.');
}

// Now confirm a protected product page redirects to login (not merely
// client-rendered as if authenticated).
await page.goto(`${APPS['lms-web']}/dashboard/leads`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
const afterLogoutUrl = page.url();
console.log('After logout, visiting lms dashboard ->', afterLogoutUrl);

const redirectedToLogin = /\/login/.test(afterLogoutUrl);
if (!redirectedToLogin) {
  record('core', {
    severity: 'critical',
    role: 'read_only',
    page: '/dashboard/leads (lms-web)',
    scenario: 'Protected page accessible after logout',
    expected: 'Redirect to /login (or auth-web login with callbackUrl) once session cookie is cleared',
    actual: `Landed on ${afterLogoutUrl} without redirect to login`,
    evidence: 'Navigated directly to the protected LMS dashboard route immediately after a confirmed logout call in the same browser context (fresh session, not shared storage state).',
  });
} else {
  console.log('OK: protected page correctly redirected to login after logout.');
}

// Double-check: re-attempt to hit an auth-web API with the now-revoked cookie
// (if the browser somehow retained it) to confirm server-side revocation, not
// just cookie deletion on the client.
const meRes = await ctx.request.get(`${cfg.apps['auth-web']}/api/auth/me`);
const meAfter = { status: meRes.status() };
console.log('GET /api/auth/me after logout ->', JSON.stringify(meAfter));
if (meAfter.status && meAfter.status < 400) {
  record('core', {
    severity: 'critical',
    role: 'read_only',
    page: '/api/auth/me',
    scenario: 'Session still valid server-side after logout',
    expected: '401 from /auth/me once the jti has been revoked by logout',
    actual: `/auth/me returned status ${meAfter.status} after logout`,
    evidence: 'Called fetch(/api/auth/me) in the same page/context immediately after the logout call returned.',
  });
}

console.log('\nconsoleErrors:', log.consoleErrors.slice(0, 5));
console.log('badRequests:', log.badRequests.slice(0, 5));

await browser.close();
console.log('\nDone.');
