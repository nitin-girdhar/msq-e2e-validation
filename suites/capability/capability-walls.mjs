// Capability walls (schema 1.76.0) — the routes that used to answer to ANY logged-in user, or to a
// rank/role name, now answer to a capability. This suite pins that, from the outside.
//
// Two halves:
//
//  1. CLOSED ROUTES — routes the 2026-10-08 audit found open and with no caller were REMOVED from the
//     gateway. They must stay gone for every login: a 404 (no route), never a 2xx and never a 5xx.
//       POST /meta/crm-event                  looked a lead up by id on a service connection with no
//                                             tenant check -> cross-tenant PII to the caller's pixel
//       POST /communications/{email,send,whatsapp/*}   rank > 0 was the only gate; free-form recipients
//       GET  /users/team                      whole-branch roster, RLS only
//
//  2. CAPABILITY-GATED READS — the same request is made as EVERY role and graded against that role's own
//     /auth/me capability list (matrix.mjs runRoleMatrix): a role without the capability must be refused
//     (OVER-PERMITTED is a privilege escalation), a role with it must be served.
//       GET /users/:id (a colleague)          admin.team.view   (self is always allowed)
//       GET /users/org-chart                  admin.team.view
//       GET /users/assignment-weights         admin.team.manage
//       GET /hr/attendance/rules              hr.attendance.view
//       GET /hr/attendance/rules/admin        hr.attendance.admin.rules.view
//       GET /api-clients                      admin.api_tokens.view (the rank-980 floor is gone)
//       GET /meta/integration                 super_admin only (no tenant UI calls it)
//
// Read-only: nothing is created, changed or deleted, so there is nothing to restore.
//
//   node suites/capability/capability-walls.mjs
import { record, roleMeta, cfg, GATEWAY, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import fs from 'node:fs';

const TOOL = 'capability';
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

let failures = 0;
const fail = (finding) => { failures++; record(TOOL, finding); };

// ── 1. Closed routes ─────────────────────────────────────────────────────────
console.log('\n— Closed routes: removed from the gateway, must stay gone —');
const CLOSED = [
  ['POST', '/meta/crm-event', { marketingLeadId: '00000000-0000-0000-0000-000000000000', eventName: 'Lead' }],
  ['POST', '/communications/email', { to: 'x@example.com', subject: 's', body: 'b' }],
  ['POST', '/communications/send', { channels: ['email'], email_addresses: ['x@example.com'] }],
  ['POST', '/communications/whatsapp/text', { phone: '9999999999', text: 'hi' }],
  ['POST', '/communications/whatsapp/template', { phone: '9999999999', template_name: 't' }],
  ['GET', '/users/team', null],
];
// Every login that has a stored session — a closed route is closed for super_admin too.
const sessions = cfg.roles.map((r) => r.role).filter((r) => fs.existsSync(authFile(r)));
for (const role of sessions) {
  const a = await actor(role);
  try {
    for (const [method, path, body] of CLOSED) {
      const res = method === 'GET' ? await apiGet(a, `${GATEWAY}${path}`) : await apiPost(a, `${GATEWAY}${path}`, body);
      const ok = res.status === 404;
      console.log(`  ${role.padEnd(24)} ${method.padEnd(4)} ${path.padEnd(32)} -> ${res.status} ${ok ? 'ok' : '<< SHOULD BE 404'}`);
      if (!ok) {
        fail({
          severity: res.status >= 200 && res.status < 300 ? 'critical' : 'high', role, tool: TOOL, page: `${method} ${path}`,
          scenario: `${role} calls ${method} ${path}, a route removed from the gateway in 1.76.0`,
          expected: 'HTTP 404 — the route no longer exists, for every login including super_admin',
          actual: `HTTP ${res.status}`,
          evidence: JSON.stringify({ role, method, path, status: res.status, body: typeof res.body === 'string' ? res.body.slice(0, 160) : res.body }).slice(0, 400),
          proposedSolution: 'Remove the route from api-gateway/src/server.ts again (git log -S"' + path + '" shows who re-added it). If a UI needs it, build it behind a capability instead of re-opening the bare route.',
        });
      }
    }
  } finally { await a.close(); }
}

// ── 2. Capability-gated reads ────────────────────────────────────────────────
console.log('\n— Capability-gated reads, every role, graded by its own /auth/me —');
const knownEmails = cfg.roles.map((r) => r.email).concat((cfg.secondaryActors ?? []).map((x) => x.email).filter(Boolean));
// A colleague in EACH role's own session branch who is nobody under test: RLS hides other branches from
// app_user, so one shared colleague would read as a false denial for roles homed elsewhere.
const colleagueFor = (role) => {
  const email = roleMeta(role)?.email;
  if (!email) return null;
  return scalar(`
    SELECT c.id FROM iam.users me JOIN iam.users c ON c.org_id = me.org_id
     WHERE me.email = ${lit(email)} AND c.is_active AND NOT c.is_deleted AND c.id <> me.id
       AND c.email NOT IN (${knownEmails.map(lit).join(',') || "''"})
     ORDER BY c.created_at LIMIT 1`);
};

const get = (path) => (a) => apiGet(a, `${GATEWAY}${path}`);
const PROBES = [
  { action: `read a colleague's record (GET /users/:id)`, endpoint: 'GET /users/:id', capability: 'admin.team.view',
    act: async (a, role) => { const id = colleagueFor(role); return id ? apiGet(a, `${GATEWAY}/users/${id}`) : { status: 404, body: 'no colleague in this role branch' }; } },
  { action: 'read the branch org chart', endpoint: 'GET /users/org-chart', act: get('/users/org-chart'), capability: 'admin.team.view' },
  { action: 'read lead-assignment weights', endpoint: 'GET /users/assignment-weights', act: get('/users/assignment-weights'), capability: 'admin.team.manage' },
  { action: 'read the effective attendance rules', endpoint: 'GET /hr/attendance/rules', act: get('/hr/attendance/rules'), capability: 'hr.attendance.view' },
  { action: 'read the attendance rules (admin)', endpoint: 'GET /hr/attendance/rules/admin', act: get('/hr/attendance/rules/admin'), capability: 'hr.attendance.admin.rules.view' },
  { action: 'list API clients', endpoint: 'GET /api-clients', act: get('/api-clients?page=1&page_size=1'), capability: 'admin.api_tokens.view' },
  // Team lists/catalogs keep their seniority floor (rank >= 40) AND now need the capability, so only the
  // OVER direction is graded for these (a low-rank holder is legitimately refused by the floor).
  { action: 'list users (GET /users)', endpoint: 'GET /users', act: get('/users?page=1&page_size=1'), capability: 'admin.team.view', overOnly: true },
  { action: 'read the role catalog', endpoint: 'GET /users/role-catalog', act: get('/users/role-catalog'), capability: 'admin.team.manage', overOnly: true },
  { action: 'read the campaign-type catalog', endpoint: 'GET /users/campaign-type-catalog', act: get('/users/campaign-type-catalog'), capability: 'admin.team.manage', overOnly: true },
  { action: 'read manager candidates', endpoint: 'GET /users/manager-candidates', act: get('/users/manager-candidates'), capability: 'admin.team.manage', overOnly: true },
  // No tenant screen calls the Meta integration any more: super_admin only.
  { action: 'read the Meta integration', endpoint: 'GET /meta/integration', act: get('/meta/integration'), allow: ['super_admin'] },
];
const summary = [];
for (const p of PROBES) {
  console.log(`\n${p.action}  [${p.capability ?? 'super_admin only'}]`);
  const res = await runRoleMatrix({
    tool: TOOL, action: p.action, endpoint: p.endpoint, act: p.act,
    ...(p.capability ? { capability: p.capability } : { allow: p.allow }),
    severityOver: 'critical', severityUnder: p.overOnly ? 'info' : 'medium', area: 'Capability walls', tab: '1.76.0',
  });
  const over = res.filter((r) => r.expected === false && r.succeeded).map((r) => r.role);
  const under = res.filter((r) => r.expected === true && !r.succeeded).map((r) => r.role);
  failures += over.length + (p.overOnly ? 0 : under.length);
  summary.push({ endpoint: p.endpoint, over, under });
}

console.log('\n' + JSON.stringify(summary));
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(0);
