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
import { authFile } from './lib.mjs';
import fs from 'node:fs';

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
