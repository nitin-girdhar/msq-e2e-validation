// Preflight: verify the world still looks the way the suites assume.
//
// The suites hardcode schema and route facts discovered by inspection (table
// and column names, API paths, seeded roles). When someone changes the product
// underneath, those assumptions silently rot and suites fail with confusing
// errors — a missing column looks like a crash, a moved route looks like a 404
// "finding" that is really harness drift. This checks all of it up front and
// says plainly what moved.
//
//   node preflight.mjs            # exits 1 if anything critical drifted
//   node preflight.mjs --warn     # always exit 0, just report
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cfg, APPS, ORIGIN, GATEWAY, GATEWAY_DIRECT, COOKIE_DOMAIN, TOPOLOGY, dir } from './lib.mjs';
import { dbReachable, q, scalar, lit, CONTAINER, DB } from './db.mjs';
import { PLATFORM_ENV_FILE, hasLocalEnv } from './localenv.mjs';

const warnOnly = process.argv.includes('--warn');
const problems = [];
const ok = [];

const check = (label, fn) => {
  try {
    const r = fn();
    if (r === true) ok.push(label);
    else problems.push(`${label} — ${r}`);
  } catch (e) {
    problems.push(`${label} — threw: ${String(e.message).split('\n')[0].slice(0, 140)}`);
  }
};

// ── 0. This laptop: topology, Docker, DB container, cookie scope ──────────
const authHost = new URL(APPS['auth-web']).hostname;
const proxied = authHost !== 'localhost' && authHost !== '127.0.0.1';
console.log(`topology: ${TOPOLOGY}${hasLocalEnv ? ` (${PLATFORM_ENV_FILE})` : ' — platform .env NOT found, using defaults'}`);
for (const [app, u] of Object.entries(APPS)) console.log(`  ${app.padEnd(13)} ${u}`);
console.log(`  gateway       ${GATEWAY}  (direct: ${GATEWAY_DIRECT})`);
console.log(`  cookie domain ${COOKIE_DOMAIN ?? '(unset)'}   db: ${CONTAINER}/${DB}\n`);

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  docker(['version', '--format', '{{.Server.Version}}']);
  ok.push('docker daemon responding');
} catch {
  console.log('PREFLIGHT FAIL: Docker is not responding.');
  console.log('  Rancher Desktop "timed out dialing Hyper-V socket": run "wsl --shutdown", relaunch Rancher Desktop, wait for green, retry.');
  process.exit(warnOnly ? 0 : 1);
}
let dbState;
try { dbState = docker(['inspect', '-f', '{{.State.Status}}', CONTAINER]); } catch { dbState = 'missing'; }
if (dbState !== 'running') {
  console.log(`PREFLIGHT FAIL: DB container '${CONTAINER}' is ${dbState}.`);
  console.log('  From the platform root: "make dev-infra" (Postgres only, for native pnpm dev)');
  console.log('  or "docker compose --profile sso-proxy up -d" (the whole stack incl. the app.localhost proxy).');
  process.exit(warnOnly ? 0 : 1);
}
// identity-service sets the session cookie for COOKIE_DOMAIN. If that does not
// cover the host the apps are browsed on, the browser DROPS the cookie: every
// login "succeeds" and bounces back to /login, and every suite reads 401.
const cd = COOKIE_DOMAIN ? COOKIE_DOMAIN.replace(/^\./, '') : null;
if (cd && authHost !== cd && !authHost.endsWith(`.${cd}`)) {
  problems.push(`COOKIE_DOMAIN=${COOKIE_DOMAIN} does not cover the app host '${authHost}' — every login will silently fail. In ${PLATFORM_ENV_FILE}: native pnpm dev needs COOKIE_DOMAIN=localhost with the localhost:300x *_URL values; docker needs COOKIE_DOMAIN=app.localhost with the app.localhost URLs. Restart identity-service after changing it.`);
} else ok.push(`cookie domain covers ${authHost}`);

// ── 1. Database reachable ──────────────────────────────────────────────────
if (!dbReachable()) {
  console.log(`PREFLIGHT FAIL: container '${CONTAINER}' is running but psql cannot open database '${DB}'.`);
  process.exit(warnOnly ? 0 : 1);
}
ok.push('database reachable');

// ── 2. Tables + columns the suites read/assert on ──────────────────────────
const REQUIRED = {
  'lms.marketing_leads': ['id', 'org_id', 'last_name', 'outcome_comment', 'stage_id', 'assigned_user_id', 'is_active', 'is_deleted', 'updated_at'],
  'task.tasks': ['id', 'title', 'assignee_id', 'parent_task_id', 'list_id', 'status_id', 'priority_id', 'is_deleted'],
  'task.task_lists': ['id', 'name', 'is_deleted'],
  'hr.leave_requests': ['id', 'user_id', 'status_id', 'leave_type_id', 'start_date', 'reason', 'is_deleted'],
  'hr.leave_request_approvals': ['leave_request_id', 'level', 'approver_id', 'action'],
  'hr.leave_policies': ['id', 'org_id', 'leave_type_id', 'is_active'],
  'hr.leave_types': ['id', 'name'],
  'hr.shifts': ['id', 'org_id'],
  'hr.attendance_days': ['id', 'user_id', 'work_date'],
  'lms.lead_sources': ['id', 'name', 'is_active'],
  'iam.users': ['id', 'email', 'role_id', 'org_id', 'is_active'],
  'iam.user_roles': ['id', 'name', 'rank'],
  'entity.organizations': ['id', 'name'],
  // Added with the 2026-09 coverage pass (campaign types, transfer, weights,
  // HR sync, entitlement, push, Meta inbox).
  'marketing.campaign_types': ['id', 'tenant_id', 'name', 'is_default', 'is_deleted'],
  'marketing.campaign_type_rules': ['id', 'tenant_id', 'rule_order', 'pattern', 'campaign_type_id', 'is_deleted'],
  'lms.lead_links': ['source_lead_id', 'dest_lead_id', 'link_type'],
  'lms.lead_assignment_weights': ['user_org_mapping_id', 'campaign_type_id', 'weight'],
  'lms.lead_follow_ups': ['id', 'lead_id'],
  'lms.lead_stage': ['id', 'name', 'tenant_id'],
  'iam.user_org_mapping': ['id', 'user_id', 'org_id', 'is_active'],
  'iam.departments': ['id', 'name'],
  'hr.employee_profiles': ['user_id', 'org_id', 'is_active', 'is_deleted'],
  'hr.designations': ['id', 'name'],
  'entity.tenant_modules': ['tenant_id', 'module', 'is_active'],
  'notify.push_subscriptions': ['endpoint', 'user_id'],
  'ext.meta_lead_inbox': ['status', 'created_at', 'attempts', 'error_text'],
};

for (const [table, cols] of Object.entries(REQUIRED)) {
  const [schema, name] = table.split('.');
  check(`table ${table}`, () => {
    const present = q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=${lit(schema)} AND table_name=${lit(name)}`
    ).map((r) => r[0]);
    if (!present.length) return 'table does not exist';
    const missing = cols.filter((c) => !present.includes(c));
    return missing.length ? `missing column(s): ${missing.join(', ')}` : true;
  });
}

// ── 3. Every role in roles.json still resolves to a real, active login ─────
for (const r of cfg.roles) {
  check(`role ${r.role} (${r.email})`, () => {
    const row = q(
      `SELECT ro.name, ro.rank FROM iam.users u
       JOIN iam.user_roles ro ON ro.id = u.role_id
       WHERE u.email=${lit(r.email)} AND u.is_active`
    )[0];
    if (!row) return 'no active user with this email';
    if (row[0] !== r.role) return `email now maps to role '${row[0]}', not '${r.role}'`;
    if (String(row[1]) !== String(r.rank)) return `rank changed: roles.json says ${r.rank}, db says ${row[1]}`;
    return true;
  });
}

// ── 3b. Tenant B logins + genuinely separate tenants ───────────────────────
// If these are missing the cross-tenant suite would silently find "no leaks"
// simply because it never logged in — a false all-clear on a security check.
for (const a of (cfg.crossTenantActors ?? [])) {
  check(`cross-tenant login ${a.stateKey} (${a.email})`, () => {
    const row = q(
      `SELECT ro.name, t.name FROM iam.users u
       JOIN iam.user_roles ro ON ro.id = u.role_id
       JOIN entity.organizations o ON o.id = u.org_id
       JOIN entity.tenants t ON t.id = o.tenant_id
       WHERE u.email=${lit(a.email)} AND u.is_active`
    )[0];
    if (!row) return 'no active user with this email — cross-tenant suite would report a false all-clear';
    if (row[0] !== a.role) return `email maps to role '${row[0]}', not '${a.role}'`;
    if (row[1] !== a.tenant) return `user is in tenant '${row[1]}', not '${a.tenant}'`;
    return true;
  });
}

check('the two configured tenants are distinct', () => {
  const names = (cfg.tenants ?? []).map((t) => t.name);
  if (names.length < 2) return 'fewer than two tenants configured in roles.json';
  const ids = names.map((n) => scalar(`SELECT id FROM entity.tenants WHERE name=${lit(n)} LIMIT 1`));
  if (ids.some((x) => !x)) return `tenant not found in db: ${names.join(' / ')}`;
  if (new Set(ids).size < ids.length) return 'configured tenants resolve to the same tenant id — isolation tests would be meaningless';
  return true;
});

// ── 4. Web apps + the API routes the suites drive ──────────────────────────
// APPS already carries each app's basePath on the single origin
// (http://app.localhost/lms ...), so these probe the real prefixed routes.
const ROUTES = [
  ['lms-web', '/dashboard/leads'],
  ['hr-web', '/attendance'],
  ['todo-web', '/tasks'],
  ['admin-web', '/dashboard'],
  ['lookup-admin', '/dashboard'],
  ['auth-web', '/login'],
];

const reachable = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return res.status;
  } catch { return 0; }
};

const appResults = [];
for (const [app, p] of ROUTES) {
  const status = await reachable(APPS[app] + p);
  appResults.push([app, p, status]);
  if (status === 0) problems.push(`app ${app} (${APPS[app]}${p}) — not responding; is the dev stack running?`);
  else ok.push(`app ${app} ${p} -> ${status}`);
}

// ── 5. Single origin, /api rewrite, gateway, harness inputs ──────────────────
// Every authenticated call goes to ${ORIGIN}/api/* (auth-web rewrite -> gateway)
// so the host-only session cookie is sent. If that hop is broken, every suite
// reads 401/404 and would report it as product defects.
const me = await reachable(`${GATEWAY}/auth/me`);
if (me === 0) {
  problems.push(proxied
    ? `${ORIGIN} not reachable — the single-origin proxy is opt-in: start the stack with "docker compose --profile sso-proxy up -d" from the platform root. Running native "make dev" instead? Point the platform .env at the localhost:300x URLs with COOKIE_DOMAIN=localhost (or run with E2E_MODE=ports after doing so).`
    : `${ORIGIN} not reachable — is auth-web running ("make dev" / "pnpm turbo dev")?`);
}
else if (me !== 401) problems.push(`${GATEWAY}/auth/me answered ${me} without a session (expected 401) — the auth-web /api rewrite to the gateway is not in place`);
else ok.push(`${GATEWAY}/auth/me -> 401 (rewrite to gateway works)`);
const health = await reachable(`${GATEWAY_DIRECT}/health`);
if (health !== 200) problems.push(`gateway ${GATEWAY_DIRECT}/health -> ${health} (public-edge and the anonymous sweep call the gateway directly; set E2E_GATEWAY_DIRECT)`);
else ok.push('gateway direct /health -> 200');
const gwSrc = process.env.E2E_GATEWAY_SRC || path.resolve(dir, '../msq-core/services/api-gateway/src/server.ts');
if (!fs.existsSync(gwSrc)) problems.push(`gateway source not found at ${gwSrc} — api-surface-sweep parses it for the route list (set E2E_GATEWAY_SRC)`);
else ok.push('gateway source present for the route sweep');

// ── report ─────────────────────────────────────────────────────────────────
console.log(`PREFLIGHT — ${ok.length} ok, ${problems.length} problem(s)\n`);
if (problems.length) {
  console.log('DRIFT / PROBLEMS:');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('\nThe suites hardcode the facts above. Fix the harness (roles.json,');
  console.log('tools.config.mjs, the suite queries) to match the product before trusting a run —');
  console.log('otherwise drift will be reported as product defects.');
} else {
  console.log('No drift detected — schema, roles, and app routes match the harness assumptions.');
}

process.exit(problems.length && !warnOnly ? 1 : 0);
