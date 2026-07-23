// Shared helpers for role-based UI exploration.
//
// PATH CONTRACT: this file lives at the e2e ROOT. All state (.auth/), config
// (roles.json), and output (results/) are resolved relative to THIS file, not
// to the caller. That is what makes it safe to keep suite scripts in
// suites/<tool>/ subfolders — they only ever import from here, so no suite
// needs to know how deep it is nested.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8'));
export const APPS = cfg.apps;
export const ROLES = cfg.roles.map((r) => r.role);
export const SECONDARY = cfg.secondaryActors ?? [];
export const authDir = path.join(dir, '.auth');
export const resultsDir = path.join(dir, 'results');

// Absolute path to a stored storageState. `key` is a role name (org_admin) or
// a secondary-actor label (rep2). Keeps every caller off path math.
export const authFile = (key) => path.join(authDir, `${key}.json`);

// Full role descriptor from roles.json (rank, dept, scope, org, email).
export function roleMeta(role) {
  return cfg.roles.find((r) => r.role === role) ?? null;
}

// Opens a browser page already authenticated as `stateKey` (role or actor).
// Collects console errors, page errors, and failed/5xx network calls.
export async function openState(stateKey, { headless = true } = {}) {
  const statePath = authFile(stateKey);
  if (!fs.existsSync(statePath)) throw new Error(`No storage state for '${stateKey}'; run auth-setup.mjs first`);
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  const log = { consoleErrors: [], pageErrors: [], badRequests: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message).slice(0, 400)));
  page.on('requestfailed', (r) => log.badRequests.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`.slice(0, 400)));
  page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 400)); });

  return { browser, ctx, page, log };
}

// Back-compat alias — the original API. `openAs('org_admin')` still works.
export const openAs = openState;

// Navigate and report what actually rendered.
export async function visit(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => ({ err: e.message }));
  // Many pages hold a long-lived SSE stream (/api/notifications/stream) open, so
  // networkidle never fires — cap the wait low and fall back to a settle delay.
  await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
  const body = await page.locator('body').innerText().catch(() => '');
  return {
    url: page.url(),
    httpStatus: res && res.status ? res.status() : null,
    redirected: !page.url().startsWith(url),
    // Deliberately phrase-based: bare numbers like "500" appear in legitimate
    // stat tiles, so matching on status codes alone produces false positives.
    looksLikeError: /something went wrong|unexpected error|application error|internal server error|failed to (load|fetch)|access denied|not authorized|unauthorized|forbidden|this page could not be found/i.test(body),
    heading: (await page.locator('h1, h2').first().innerText().catch(() => '')).slice(0, 120),
    bodySnippet: body.slice(0, 400),
  };
}

// Append a finding to results/findings-<area>.json.
//
// Finding shape (fields beyond `severity` are free-form and all preserved):
//   { severity, role, tool, page, scenario, expected, actual, evidence,
//     proposedSolution }
// `severity` should be one of: critical | high | medium | low | info.
export function record(area, finding) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const f = path.join(resultsDir, `findings-${area}.json`);
  const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  all.push({ tool: area, at: new Date().toISOString(), ...finding });
  fs.writeFileSync(f, JSON.stringify(all, null, 2));
}

export function save(area, name, data) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${area}-${name}.json`), JSON.stringify(data, null, 2));
}
