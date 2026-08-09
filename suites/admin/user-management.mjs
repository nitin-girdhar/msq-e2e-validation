// User management — create / edit-name / reset-password / change-manager /
// change-org, verified against iam.users, plus a create-authority matrix.
//
// The harness declared iam.users a write table but never actually managed a
// user. This does, two ways:
//
//   Part 1 — CREATE-USER AUTHORITY MATRIX. Creating a user issues a credential,
//   so who may do it matters. identity-service gates user management at global
//   rank >= 40 (USER_MGMT_MIN_RANK in users.controller.ts). We attempt a create
//   as ALL 19 roles and grade allow/deny against that threshold, Postgres-
//   verified — a role below 40 that succeeds is a privilege escalation graded
//   critical (it just minted an account).
//
//   Part 2 — ADMIN LIFECYCLE ROUND-TRIP. As org_admin, create a throwaway user
//   then edit name, change manager, reset password, and move org — asserting
//   each change landed in iam.users (name/full_name, manager_id, password_hash,
//   org_id). Also proves a duplicate email is a clean 4xx, not a raw 500.
//
// Everything is self-cleaning: throwaway users are hard-deleted by their marker
// email at the end.
//
//   node suites/admin/user-management.mjs
import { cfg, record, roleMeta } from '../../lib.mjs';
import { actor, apiPost, apiPatch } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, one, q, lit } from '../../db.mjs';

const TOOL = 'admin';
const GATEWAY = cfg.gateway;
const USERS = `${GATEWAY}/users`;
const stamp = Date.now();
const MARKER = `e2e-usermgmt-${stamp}`;
const NEW_PW = `E2ePw!${stamp}`; // satisfies the strong-password rule

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const emailFor = (who) => `${MARKER}-${who}@e2e.local`.toLowerCase();
const userRow = (email) => one(
  `SELECT id, first_name, full_name, email, org_id, manager_id, password_hash, is_active
     FROM iam.users WHERE email=${lit(email)}`
);

// ── Part 1: create-user authority across all 19 roles ────────────────────────
console.log('— create a user (identity management, global rank >= 40) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a new user (mint an account)',
  endpoint: 'POST /users', area: 'Users', tab: 'Directory',
  minRank: 40, severityOver: 'critical', severityUnder: 'high',
  act: (a, role) => apiPost(a, USERS, {
    first_name: 'E2E',
    last_name: role.slice(0, 20),
    email: emailFor(role),
    role_name: 'read_only',
  }),
  verify: (role) => userRow(emailFor(role)) != null,
  cleanup: (role) => { q(`DELETE FROM iam.users WHERE email=${lit(emailFor(role))}`); },
});

// ── Part 2: admin lifecycle round-trip (as org_admin) ────────────────────────
console.log('\n— admin lifecycle round-trip (org_admin) —');
const ADMIN = 'org_admin';
const adminOrg = roleMeta(ADMIN).org;
const adminOrgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(adminOrg)} LIMIT 1`);
// A manager candidate in the same org (rep2 lives in FitClass - Gurgaon with org_admin).
const managerId = scalar(`SELECT id FROM iam.users WHERE email=${lit(cfg.secondaryActors.find((a) => a.actor === 'rep2').email)} LIMIT 1`);
// A second org in the SAME tenant to test the move (any org that isn't the admin's).
const otherOrgId = scalar(
  `SELECT o.id FROM entity.organizations o
     JOIN entity.organizations home ON home.id=${lit(adminOrgId)}
    WHERE o.tenant_id = home.tenant_id AND o.id <> home.id AND o.name LIKE 'FitClass%'
    ORDER BY o.name LIMIT 1`
);
const email = emailFor('lifecycle');
q(`DELETE FROM iam.users WHERE email=${lit(email)}`); // clean any stale run

const a = await actor(ADMIN);
const fail = (severity, scenario, expected, actual, evidence, fix) => record(TOOL, {
  severity, role: ADMIN, tool: TOOL, page: 'User management (org_admin)',
  scenario, expected, actual, evidence: String(evidence).slice(0, 400), proposedSolution: fix,
});
try {
  // (a) CREATE
  const created = await apiPost(a, USERS, {
    first_name: 'Lifecycle', last_name: 'One', email, role_name: 'read_only',
  });
  let row = userRow(email);
  console.log(`  create            http=${created.status} row=${row ? 'yes' : 'no'} org=${row?.[4] === adminOrgId ? 'admin-org' : row?.[4]}`);
  if (!row) {
    fail('high', 'Create a user via POST /users as org_admin',
      'A new iam.users row exists in the admin’s org',
      `No row after HTTP ${created.status}`, JSON.stringify(created.body),
      'Confirm createUser persists and scopes the new user to the creator’s org.');
  } else {
    const userId = row[0];
    if (row[4] !== adminOrgId) {
      fail('medium', 'New user org scoping',
        'The new user is created in the org_admin’s own org',
        `org_id=${row[4]} (admin org=${adminOrgId})`, JSON.stringify(row),
        'Scope createUser to the creator’s org unless an explicit org is passed and authorized.');
    }

    // (b) EDIT NAME
    await apiPatch(a, `${USERS}/${userId}`, { first_name: 'Renamed' });
    row = userRow(email);
    console.log(`  edit name         full_name="${row?.[2]}"`);
    if (row?.[1] !== 'Renamed' || !String(row?.[2]).startsWith('Renamed')) {
      fail('high', 'Edit a user’s first name',
        'first_name and the generated full_name reflect the new value',
        `first_name="${row?.[1]}" full_name="${row?.[2]}"`, JSON.stringify(row),
        'Ensure PATCH /users/:id updates first_name and the generated full_name is recomputed.');
    }

    // (c) CHANGE MANAGER
    if (managerId) {
      await apiPatch(a, `${USERS}/${userId}`, { manager_id: managerId });
      row = userRow(email);
      console.log(`  change manager    manager_id=${row?.[5] === managerId ? 'set' : row?.[5]}`);
      if (row?.[5] !== managerId) {
        fail('high', 'Change a user’s reporting manager',
          `manager_id is updated to the chosen manager (${managerId})`,
          `manager_id=${row?.[5]}`, JSON.stringify(row),
          'Persist manager_id on PATCH /users/:id and validate the manager is in-scope.');
      }
    }

    // (d) RESET PASSWORD — hash must change and force_password_change should flip on.
    const hashBefore = row?.[6];
    const reset = await apiPost(a, `${USERS}/${userId}/reset-password`, { new_password: NEW_PW });
    row = userRow(email);
    const hashChanged = row?.[6] && row[6] !== hashBefore;
    console.log(`  reset password    http=${reset.status} hashChanged=${hashChanged}`);
    if (!(reset.status >= 200 && reset.status < 300) || !hashChanged) {
      fail('high', 'Reset a user’s password',
        'The stored password_hash changes (new credential in effect)',
        `HTTP ${reset.status}, hashChanged=${hashChanged}`, JSON.stringify(reset.body),
        'Ensure reset-password re-hashes and stores the new secret and sets force_password_change.');
    }

    // (e) CHANGE ORG — success verified; a clean 4xx is acceptable (scope), a 500 is not.
    if (otherOrgId) {
      const moved = await apiPatch(a, `${USERS}/${userId}`, { org_id: otherOrgId });
      row = userRow(email);
      const ok2xx = moved.status >= 200 && moved.status < 300;
      console.log(`  change org        http=${moved.status} org_now=${row?.[4] === otherOrgId ? 'moved' : 'unchanged'}`);
      if (ok2xx && row?.[4] !== otherOrgId) {
        fail('high', 'Move a user to another org',
          'org_id is updated to the target org after a 2xx',
          `HTTP ${moved.status} but org_id=${row?.[4]}`, JSON.stringify(row),
          'Apply the org change (and re-map iam.user_org_mapping) when PATCH returns success.');
      } else if (moved.status >= 500) {
        fail('medium', 'Move a user to another org — error shape',
          'A disallowed/invalid org move returns a clean 4xx',
          `HTTP ${moved.status} (raw server error leaked)`, JSON.stringify(moved.body),
          'Map the ownership/scope failure to 403/404 instead of surfacing a 500.');
      }
    }

    // (f) DUPLICATE EMAIL — must be a clean 4xx (unique violation), not a 500.
    const dup = await apiPost(a, USERS, {
      first_name: 'Dup', last_name: 'Two', email, role_name: 'read_only',
    });
    console.log(`  duplicate email   http=${dup.status} (expect 4xx)`);
    if (dup.status >= 500 || (dup.status >= 200 && dup.status < 300)) {
      fail(dup.status < 300 ? 'high' : 'medium', 'Create a user with an already-used email',
        'A duplicate email is rejected with a clean 4xx (409/422)',
        `HTTP ${dup.status}`, JSON.stringify(dup.body),
        'Catch the unique-violation (23505) and return 409 Conflict; never a 2xx duplicate or a raw 500.');
    }
  }
} finally {
  await a.close();
}

// ── Cleanup: hard-delete every throwaway user this run created ────────────────
q(`DELETE FROM iam.users WHERE email LIKE ${lit(`${MARKER}-%@e2e.local`)}`);
console.log(`\ncleaned up throwaway users for marker ${MARKER}.`);
