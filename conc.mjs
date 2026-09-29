// Concurrency helpers.
//
// Multi-user conflict tests need two things this module provides: (1) an
// authenticated APIRequestContext per actor that carries that user's real
// session cookies (so the server applies the actor's own authorization), and
// (2) a way to fire two requests as close to simultaneously as possible and
// compare the outcomes. The web apps expose their product API on their own
// origin (e.g. lms-web serves /api/leads), so we drive requests there rather
// than at the gateway to exercise the exact path the browser uses.
import { chromium } from '@playwright/test';
import { authFile, cfg } from './lib.mjs';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST /auth/login and /auth/switch-org share ONE fixed-window limiter in the
// gateway: 10 requests / 60 s per client IP (api-gateway/src/lib/rate-limit.ts).
// The whole harness is one IP, so an overnight run logging in ~20 accounts
// would otherwise read 429s as "login broken". Honour Retry-After and try again.
export async function with429Retry(fn, { attempts = 6, label = 'request' } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    const status = typeof last?.status === 'function' ? last.status() : last?.status;
    if (status !== 429) return last;
    const hdr = typeof last?.headers === 'function' ? last.headers()['retry-after'] : null;
    const waitS = Math.min(Math.max(Number(hdr) || 15, 2), 65);
    console.log(`  (${label}: 429 rate-limited, waiting ${waitS}s — gateway login bucket is 10/min per IP)`);
    await sleep(waitS * 1000 + 250);
  }
  return last;
}

// A brand-new session for `email`, logged in through the gateway API rather
// than loaded from .auth/. Use this — never a stored storageState — for anything
// that re-mints or kills the session (switch-org REVOKES the caller's jti,
// change-password bumps pwd_iat, logout revokes): doing that to a shared
// .auth/<role>.json would 401 every later suite that runs as that role.
export async function freshLogin(email, password = cfg.password) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const resp = await with429Retry(
    () => ctx.request.post(`${cfg.apps['auth-web']}/api/auth/login`, { data: { email, password }, failOnStatusCode: false }),
    { label: `login ${email}` },
  );
  const { status, body } = await readResp(resp);
  return {
    stateKey: `fresh:${email}`,
    email,
    loginStatus: status,
    loginBody: body,
    request: ctx.request,
    context: ctx,
    async cookies() { return ctx.cookies(); },
    async close() { await browser.close(); },
  };
}

// Open an APIRequestContext bound to a stored login's cookies.
export async function actor(stateKey) {
  const file = authFile(stateKey);
  if (!fs.existsSync(file)) throw new Error(`No auth state for '${stateKey}'; run auth-setup.mjs`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: file });
  return {
    stateKey,
    request: ctx.request,
    async close() { await browser.close(); },
  };
}

// Parse a Playwright APIResponse into { status, body }.
export async function readResp(resp) {
  const status = resp.status();
  let body;
  try { body = await resp.json(); } catch { body = (await resp.text().catch(() => '')).slice(0, 300); }
  return { status, body };
}

// Fire an array of async thunks as close to simultaneously as possible and
// return their settled results in order.
export async function simultaneously(thunks) {
  return Promise.all(thunks.map((t) => t().catch((e) => ({ error: String(e.message || e) }))));
}

// Convenience wrappers that return { status, body }.
export async function apiGet(a, url, opts = {}) { return readResp(await a.request.get(url, opts)); }
export async function apiPost(a, url, data, opts = {}) { return readResp(await a.request.post(url, { data, ...opts })); }
export async function apiPatch(a, url, data, opts = {}) { return readResp(await a.request.patch(url, { data, ...opts })); }
export async function apiPut(a, url, data, opts = {}) { return readResp(await a.request.put(url, { data, ...opts })); }
export async function apiDelete(a, url, opts = {}) { return readResp(await a.request.delete(url, opts)); }
