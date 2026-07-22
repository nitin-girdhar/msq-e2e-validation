// Shared helpers for role-based UI exploration.
// Usage: node your-script.mjs   (from the e2e/ folder)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8'));
export const APPS = cfg.apps;
export const ROLES = cfg.roles.map((r) => r.role);

// Opens a browser page already authenticated as `role`.
// Collects console errors, page errors, and failed/5xx network calls.
export async function openAs(role, { headless = true } = {}) {
  const statePath = path.join(dir, '.auth', `${role}.json`);
  if (!fs.existsSync(statePath)) throw new Error(`No storage state for ${role}; run auth-setup.mjs first`);
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

// Navigate and report what actually rendered.
export async function visit(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => ({ err: e.message }));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
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

// Append a finding to results/findings-<area>.json
export function record(area, finding) {
  const f = path.join(dir, 'results', `findings-${area}.json`);
  const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  all.push({ ...finding, at: new Date().toISOString() });
  fs.writeFileSync(f, JSON.stringify(all, null, 2));
}

export function save(area, name, data) {
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'results', `${area}-${name}.json`), JSON.stringify(data, null, 2));
}
