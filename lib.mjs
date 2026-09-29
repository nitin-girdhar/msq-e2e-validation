// Shared helpers for role-based UI exploration.
//
// PATH CONTRACT: this file lives at the e2e ROOT. All state (.auth/), config
// (roles.json), and output (results/) are resolved relative to THIS file, not
// to the caller. That is what makes it safe to keep suite scripts in
// suites/<tool>/ subfolders — they only ever import from here, so no suite
// needs to know how deep it is nested.
import { chromium } from '@playwright/test';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8'));

// ── Local topology (read from the platform's own .env) ────────────────────────
// Every web app is compiled with a Next `basePath` (auth-web at the root, then
// /lms /hrms /todo /admin /sa), and the session cookie is scoped to
// COOKIE_DOMAIN. The harness MUST browse the same URLs the apps and the
// identity service were configured with, or the cookie is never sent and every
// call reads as 401. So the URLs come from the platform root .env
// (localenv.mjs) — the same file the stack itself runs from:
//
//   full docker + Caddy  AUTH_URL=http://app.localhost   LMS_URL=http://app.localhost/lms ...
//   native pnpm dev      AUTH_URL=http://localhost:3000  LMS_URL=http://localhost:3001/lms ...
//
// The gateway is reached through auth-web's `/api/*` rewrite (`<AUTH_URL>/api`)
// so the session cookie is attached; `gatewayDirect` (no cookie) is only for
// the unauthenticated public/webhook surface.
//
// Overrides: E2E_ORIGIN=<url> (force one origin for all apps),
//            E2E_MODE=ports    (force localhost:3000..3005, the pnpm-dev layout),
//            E2E_GATEWAY_DIRECT=<url>.
import { LOCAL_ENV } from './localenv.mjs';
const trim = (u) => String(u || '').replace(/\/$/, '');
const DEFAULT_PREFIXES = cfg.prefixes ?? {
  'auth-web': '', 'lms-web': '/lms', 'hr-web': '/hrms', 'todo-web': '/todo', 'admin-web': '/admin', 'lookup-admin': '/sa',
};
const PORTS = { 'auth-web': 3000, 'lms-web': 3001, 'hr-web': 3002, 'todo-web': 3003, 'admin-web': 3004, 'lookup-admin': 3005 };
const ENV_KEY = { 'auth-web': 'AUTH_URL', 'lms-web': 'LMS_URL', 'hr-web': 'HR_URL', 'todo-web': 'TASK_URL', 'admin-web': 'ADMIN_WEB_URL', 'lookup-admin': 'ADMIN_URL' };
export const TOPOLOGY = process.env.E2E_ORIGIN ? 'E2E_ORIGIN'
  : process.env.E2E_MODE === 'ports' ? 'ports (E2E_MODE)'
  : LOCAL_ENV.AUTH_URL ? 'platform .env' : 'default single origin';
cfg.apps = Object.fromEntries(Object.keys(DEFAULT_PREFIXES).map((app) => {
  const prefix = DEFAULT_PREFIXES[app];
  if (process.env.E2E_ORIGIN) return [app, trim(process.env.E2E_ORIGIN) + prefix];
  if (process.env.E2E_MODE === 'ports') return [app, `http://localhost:${PORTS[app]}${prefix}`];
  const fromEnv = LOCAL_ENV[ENV_KEY[app]] || LOCAL_ENV[`NEXT_PUBLIC_${ENV_KEY[app]}`];
  return [app, trim(fromEnv) || `${trim(cfg.origin || 'http://app.localhost')}${prefix}`];
}));
// The basePath each app is actually served under (pathname of its URL).
export const PREFIXES = Object.fromEntries(Object.entries(cfg.apps).map(([app, u]) => {
  try { return [app, trim(new URL(u).pathname)]; } catch { return [app, DEFAULT_PREFIXES[app]]; }
}));
export const ORIGIN = new URL(cfg.apps['auth-web']).origin;
cfg.gateway = `${trim(cfg.apps['auth-web'])}/api`;
cfg.gatewayDirect = trim(process.env.E2E_GATEWAY_DIRECT || LOCAL_ENV.NEXT_PUBLIC_API_URL || LOCAL_ENV.API_GATEWAY_INTERNAL_URL || cfg.gatewayDirect || 'http://localhost:4000');
export const COOKIE_DOMAIN = LOCAL_ENV.COOKIE_DOMAIN ?? null;
export const APPS = cfg.apps;
export const GATEWAY = cfg.gateway;
export const GATEWAY_DIRECT = cfg.gatewayDirect;

// Node on Windows does not resolve `*.localhost` (Chromium does, natively).
// Playwright's APIRequestContext and Node's fetch both go through dns.lookup in
// THIS process, so answering `*.localhost` with loopback here is enough — no
// hosts-file edit, no admin rights. Anything else resolves normally.
const isLoopbackName = (h) => typeof h === 'string' && (h === 'localhost' || h.endsWith('.localhost'));
if (!dns.lookup.__e2eShim) {
  const origLookup = dns.lookup;
  dns.lookup = function lookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!isLoopbackName(host)) return origLookup.call(dns, host, opts, cb);
    const o = typeof opts === 'number' ? { family: opts } : (opts || {});
    process.nextTick(() => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
  };
  dns.lookup.__e2eShim = true;
  const origPromise = dns.promises.lookup;
  dns.promises.lookup = async (host, opts) => {
    if (!isLoopbackName(host)) return origPromise(host, opts);
    return opts && opts.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 };
  };
}

// The basePath of an app ('' for auth-web).
export const basePathOf = (app) => PREFIXES[app] ?? '';

// Turn an href scraped off a page into an absolute URL. Next renders <Link>s
// WITH the basePath (`/sa/dashboard/lookups/x`), so the old `appUrl + href`
// doubled the prefix (`/sa/sa/...`) and every drill-down 404'd.
export function absUrl(appUrl, href) {
  if (!href) return appUrl;
  if (/^https?:\/\//i.test(href)) return href;
  const base = new URL(appUrl);
  const prefix = base.pathname.replace(/\/$/, '');
  if (href.startsWith('/') && prefix && (href === prefix || href.startsWith(prefix + '/'))) return base.origin + href;
  if (href.startsWith('/')) return appUrl.replace(/\/$/, '') + href;
  return `${appUrl.replace(/\/$/, '')}/${href}`;
}

// App-relative path of a URL (basePath stripped), for comparing against the
// route paths in tools.config.mjs. `http://app.localhost/lms/dashboard/leads`
// -> `/dashboard/leads`.
export function appPath(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return ''; }
  for (const pre of Object.values(PREFIXES).filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (p === pre) return '/';
    if (p.startsWith(pre + '/')) return p.slice(pre.length);
  }
  return p;
}
export const ROLES = cfg.roles.map((r) => r.role);
export const SECONDARY = cfg.secondaryActors ?? [];
// Tenant B logins, used to prove cross-tenant isolation.
export const CROSS_TENANT = cfg.crossTenantActors ?? [];
export const TENANTS = cfg.tenants ?? [];
export const primaryTenant = () => TENANTS.find((t) => t.primary) ?? TENANTS[0] ?? null;
export const otherTenant = () => TENANTS.find((t) => !t.primary) ?? null;
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
