// Issue #1 regression — POST /users must not 500 for RLS app-pool roles.
//
// createUser used `INSERT INTO iam.users … RETURNING id`. Postgres evaluates a
// RETURNING clause through the table's SELECT (USING) policy; on the app pool the
// `users_org_select` policy only admits ids already present in
// iam.fn_org_active_users(app.current_org_id) — which derives from a
// iam.user_org_mapping row inserted only AFTER this statement. So the read-back
// failed the policy (SQLSTATE 42501) and the whole request 500'd for `org_admin`
// and every rank-40–980 app-pool role. The fix mints the id up front
// (gen_uuidv7()) and drops RETURNING.
//
// This asserts the exact regression signature: for each affected role a create
// returns a clean 2xx AND lands a real iam.users row — never a 5xx. super_admin /
// tenant_admin (non-RLS pools) are included as the always-worked control.
//
// Self-cleaning: every throwaway user is hard-deleted by its marker email.
//
//   node suites/admin/create-user-rls-regression.mjs
import { cfg, record, roleMeta, authFile } from '../../lib.mjs';
import { actor, apiPost } from '../../conc.mjs';
import { dbReachable, one, q, lit } from '../../db.mjs';
import { purgeE2eUsers } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'admin';
const USERS = `${cfg.gateway}/users`;
const stamp = Date.now();
const MARKER = `e2e-issue1-${stamp}`;

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

// The roles Issue #1 broke: org_admin and app-pool roles at rank 40–980, plus the
// two non-RLS admins as the "always worked" control. All create a read_only user
// (rank 0), which sits below every one of these roles' grant ceiling.
const ROLES = ['super_admin', 'tenant_admin', 'org_admin', 'org_sr_manager', 'org_manager', 'sales_head'];
const emailFor = (r) => `${MARKER}-${r}@e2e.local`.toLowerCase();
const userRow = (email) => one(`SELECT id, org_id FROM iam.users WHERE email=${lit(email)}`);

console.log('— Issue #1: create-user must not 500 for RLS app-pool roles —');
let failures = 0;

for (const role of ROLES) {
  if (!fs.existsSync(authFile(role))) { console.log(`  skip ${role} (no auth state)`); continue; }
  const a = await actor(role);
  try {
    const res = await apiPost(a, USERS, {
      first_name: 'E2E', last_name: role.slice(0, 20), email: emailFor(role), role_name: 'read_only',
    });
    const row = userRow(emailFor(role));
    const ok2xx = res.status >= 200 && res.status < 300;
    console.log(`  ${role.padEnd(18)} http=${res.status} row=${row ? 'yes' : 'no'}`);

    if (res.status >= 500) {
      failures++;
      record(TOOL, {
        severity: 'high', role, tool: TOOL, page: 'User management',
        scenario: `Create a user via POST /users as ${role}`,
        expected: 'A clean 2xx and a new iam.users row — the RLS SELECT-policy read-back that broke this (Issue #1) is gone',
        actual: `HTTP ${res.status} (server error). The INSERT … RETURNING RLS collision has regressed.`,
        evidence: JSON.stringify(res.body).slice(0, 400),
        proposedSolution: 'Keep createUser minting the id app-side (gen_uuidv7()) without RETURNING, so no post-insert SELECT policy is evaluated before the user_org_mapping row exists.',
      });
    } else if (!ok2xx || !row) {
      failures++;
      record(TOOL, {
        severity: 'high', role, tool: TOOL, page: 'User management',
        scenario: `Create a user via POST /users as ${role}`,
        expected: 'HTTP 2xx and a persisted iam.users row',
        actual: `HTTP ${res.status}, row=${row ? 'present' : 'absent'}`,
        evidence: JSON.stringify(res.body).slice(0, 400),
        proposedSolution: 'Confirm createUser persists and scopes the new user to the creator’s org for every user-management-capable role.',
      });
    }
  } finally {
    await a.close();
  }
}

purgeE2eUsers(`${MARKER}-%@e2e.local`);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — cleaned up throwaway users for ${MARKER}.`);
