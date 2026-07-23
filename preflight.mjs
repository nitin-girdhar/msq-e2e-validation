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
import { cfg, APPS } from './lib.mjs';
import { dbReachable, q, scalar, lit } from './db.mjs';

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

// ── 1. Database reachable ──────────────────────────────────────────────────
if (!dbReachable()) {
  console.log('PREFLIGHT FAIL: database not reachable (container msq-db-server / db platforms).');
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
const ROUTES = [
  ['lms-web', '/dashboard/leads'],
  ['hr-web', '/attendance'],
  ['todo-web', '/tasks'],
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
