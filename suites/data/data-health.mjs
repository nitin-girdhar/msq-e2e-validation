// Data & configuration health — invariants read straight from Postgres.
//
// The UI/API suites can only see a bug once someone triggers it. Several of the
// worst ones in this platform's history were SILENT — no error, no log, just
// wrong behaviour for a subset of users — and each left a fingerprint in the
// data that a query can find before a user does:
//
//   RLS-1  RLS policy that names app_user but no *_svc login. Service logins are
//          NOINHERIT, so the policy does not apply to them: the table reads back
//          ZERO rows with no error (memory: rls-policies-need-service-logins-named).
//   RLS-2  org/tenant-scoped table with RLS disabled — the tenancy boundary is
//          missing outright (CLAUDE.md: every route must enforce RLS).
//   CAP-1  a role that active users hold, resolving WITHOUT platform.write — every
//          withRoleTx write for those users dies as a bare 500 (2026-09-28 prod).
//   CAP-2  grants that are ticked in iam.role_capabilities but resolve FALSE
//          because an ancestor is denied (parent-denial cascade).
//   LMS-1  active branch with no weighted assignee — auto-assign returns null,
//          leads land unassigned, nobody is told (10/30 branches on 2026-08-29).
//   LMS-2  pool weights that do not sum to 100 (deficit formula assumes 100).
//   LMS-3  active leads assigned to inactive users / users outside the lead's branch.
//   LMS-4  a lead whose campaign type belongs to another tenant.
//   IAM-*  non-canonical / case-duplicate emails, org mappings or managers that
//          cross tenants, self-managers, inactive managers of active users.
//   HR-1   active users with no HR profile, or a profile on the wrong branch /
//          active flag (Team -> HR sync, 044f345).
//   META-1 Meta lead-inbox items stuck 'open' (webhook payloads never ingested).
//   E2E-1  harness residue — throwaway rows a killed run left behind.
//
// Every check is independent and fail-soft: a query that no longer matches the
// schema is reported as `info` (harness drift) instead of aborting the suite.
//
//   node suites/data/data-health.mjs
import { dbReachable, rows, lit } from '../../db.mjs';
import { finder } from '../../fixtures.mjs';
import { save } from '../../lib.mjs';

const TOOL = 'data';
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const summary = [];
function check(id, title, { sql, cols, severity, expected, fix, describe = (r) => JSON.stringify(r), max = 20 }) {
  const fail = finder(TOOL, `Data health — ${id}`);
  let found;
  try { found = rows(sql, cols); } catch (e) {
    const msg = String(e.message).split('\n').find((l) => /ERROR/.test(l)) ?? String(e.message).slice(0, 200);
    console.log(`${id.padEnd(7)} ${title} — COULD NOT RUN (${msg})`);
    fail('info', 'harness', `${id}: ${title} — check could not run`, 'The query matches the current schema', msg, sql.replace(/\s+/g, ' ').slice(0, 400), 'Update this check in suites/data/data-health.mjs to the current schema.');
    summary.push({ id, title, status: 'error', error: msg });
    return [];
  }
  console.log(`${id.padEnd(7)} ${title} — ${found.length ? `${found.length} VIOLATION(S)` : 'ok'}`);
  summary.push({ id, title, status: found.length ? 'violations' : 'ok', count: found.length, sample: found.slice(0, 5) });
  if (found.length) {
    fail(severity, 'data', `${id}: ${title} (${found.length})`, expected,
      found.slice(0, max).map(describe).join(' | ').slice(0, 1500),
      JSON.stringify(found.slice(0, 10)).slice(0, 600), fix);
  }
  return found;
}

const APP_SCHEMAS = `('lms','hr','task','iam','entity','marketing','ext')`;

// ── RLS ──────────────────────────────────────────────────────────────────────
check('RLS-1', 'RLS policies that do not reach the service logins', {
  sql: `SELECT schemaname||'.'||tablename, policyname, array_to_string(roles, ',')
          FROM pg_policies
         WHERE schemaname IN ${APP_SCHEMAS}
           AND NOT EXISTS (SELECT 1 FROM unnest(roles) r WHERE r::text LIKE '%\\_svc' ESCAPE '\\' OR r::text IN ('public','root_service'))`,
  cols: ['table', 'policy', 'roles'], severity: 'high',
  expected: 'Every policy on a product table also names the NOINHERIT service logins (lms_svc, hr_svc, task_svc, ...) — 08_rls.sql widens them in its closing DO block',
  describe: (r) => `${r.table}.${r.policy} TO {${r.roles}}`,
  fix: 'Re-run db_scripts/apply_schema (the 08_rls.sql widening sweep), or add the ALTER POLICY ... TO <svc logins> block to the one-off script that recreated these policies. Symptom otherwise: the owning service reads ZERO rows with no error.',
});
check('RLS-2', 'Org/tenant-scoped tables with row-level security disabled', {
  sql: `SELECT n.nspname||'.'||c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind='r' AND n.nspname IN ${APP_SCHEMAS} AND NOT c.relrowsecurity
           AND EXISTS (SELECT 1 FROM information_schema.columns i
                        WHERE i.table_schema=n.nspname AND i.table_name=c.relname AND i.column_name IN ('org_id','tenant_id'))
           AND c.relname NOT IN ('tenants','organizations')
           -- service-only: revoked from app_user/tenant_admin, read via serviceDrizzle
           AND n.nspname||'.'||c.relname <> 'iam.token_blocklist'`,
  cols: ['table'], severity: 'high',
  expected: 'ENABLE ROW LEVEL SECURITY + app_user/tenant_admin policies (with WITH CHECK) on every table holding org/tenant-scoped rows (skills/postgresql §2)',
  describe: (r) => r.table,
  fix: 'Add the org_isolation/tenant_isolation policy pair from skills/postgresql/templates.md, or document why the table is global reference data.',
});

// ── Capabilities ─────────────────────────────────────────────────────────────
check('CAP-1', 'Roles held by active users that resolve without platform.write', {
  sql: `WITH held AS (
          SELECT DISTINCT o.tenant_id, r.name AS role_name, COUNT(*) OVER (PARTITION BY o.tenant_id, r.name) AS users
            FROM iam.users u JOIN iam.user_roles r ON r.id=u.role_id JOIN entity.organizations o ON o.id=u.org_id
           WHERE u.is_active AND NOT u.is_deleted)
        SELECT h.tenant_id, h.role_name, h.users
          FROM held h
         WHERE h.role_name <> 'read_only'  -- read-only by design: no platform.write is correct
           AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(h.tenant_id) m
                            WHERE m.role_name=h.role_name AND m.capability_key='platform.write' AND m.granted)`,
  cols: ['tenant', 'role', 'users'], severity: 'high',
  expected: 'Every role that real users hold can write (platform + platform.write granted)',
  describe: (r) => `${r.role} (${r.users} users, tenant ${r.tenant})`,
  fix: 'Grant platform + platform.write to these roles (Capability Matrix), map PG 25006 "read-only transaction" to a 403 instead of a bare 500, and warn in the matrix UI when a role lacks it.',
});
check('CAP-2', 'Granted capabilities that do not apply (ancestor denied)', {
  sql: `SELECT DISTINCT o.tenant_id, r.name, c.key
          FROM iam.role_capabilities rc
          JOIN iam.user_roles r ON r.id=rc.role_id
          JOIN iam.capabilities c ON c.id=rc.capability_id
          JOIN iam.users u ON u.role_id=r.id AND u.is_active AND NOT u.is_deleted
          JOIN entity.organizations o ON o.id=u.org_id
         WHERE rc.is_granted AND (rc.tenant_id IS NULL OR rc.tenant_id=o.tenant_id)
           AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(o.tenant_id) m
                            WHERE m.role_name=r.name AND m.capability_key=c.key AND m.granted)`,
  cols: ['tenant', 'role', 'capability'], severity: 'medium', max: 40,
  expected: 'A ticked grant is effective — no child granted under a denied parent (the matrix UI still shows these ticked)',
  describe: (r) => `${r.role}: ${r.capability}`,
  fix: 'Grant the denied ancestor page/tab (or remove the dead child grants). Audit with iam.fn_role_capability_matrix(tenant), never iam.role_capabilities alone.',
});

// ── LMS ──────────────────────────────────────────────────────────────────────
check('LMS-1', 'Active branches (LMS licensed) with no weighted assignee', {
  sql: `SELECT o.name, o.id
          FROM entity.organizations o
          JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module='lms' AND tm.is_active
         WHERE o.is_active AND NOT o.is_deleted
           AND NOT EXISTS (SELECT 1 FROM iam.user_org_mapping m
                             JOIN lms.lead_assignment_weights w ON w.user_org_mapping_id=m.id AND w.weight>0
                             JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted
                            WHERE m.org_id=o.id AND m.is_active)
         ORDER BY o.name`,
  cols: ['branch', 'id'], severity: 'high',
  expected: 'Every active LMS branch has at least one active user with weight > 0 (otherwise resolveAutoAssignedUser returns null silently)',
  describe: (r) => r.branch,
  fix: 'Set weights in Team → Lead weights for these branches; also make auto-assign log/notify when it returns null (lead.autoassign_skipped is only a warn log today).',
});
check('LMS-2', 'Branch pools whose weights do not sum to 100', {
  sql: `SELECT o.name, ct.name, SUM(w.weight)::int
          FROM lms.lead_assignment_weights w
          JOIN iam.user_org_mapping m ON m.id=w.user_org_mapping_id AND m.is_active
          JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted
          JOIN entity.organizations o ON o.id=m.org_id AND o.is_active
          JOIN marketing.campaign_types ct ON ct.id=w.campaign_type_id
         GROUP BY o.name, ct.name HAVING SUM(w.weight) NOT IN (0,100)`,
  cols: ['branch', 'type', 'sum'], severity: 'medium',
  expected: 'Each (branch, campaign type) pool sums to 100 or 0 — the deficit formula assumes 100',
  describe: (r) => `${r.branch}/${r.type}=${r.sum}`,
  fix: 'The 100-or-0 rule is enforced only in PUT /users/assignment-weights; createUser/addOrgMapping/reconcileOrgAssignments and one_time scripts bypass it. Enforce it in one place (DB constraint trigger or the repository).',
});
check('LMS-3', 'Active leads assigned to an inactive user or to someone outside the lead\'s branch', {
  sql: `SELECT o.name, COUNT(*)::int,
               SUM(CASE WHEN NOT u.is_active OR u.is_deleted THEN 1 ELSE 0 END)::int,
               SUM(CASE WHEN u.is_active AND NOT u.is_deleted THEN 1 ELSE 0 END)::int
          FROM lms.marketing_leads l
          JOIN iam.users u ON u.id=l.assigned_user_id
          JOIN entity.organizations o ON o.id=l.org_id
         WHERE l.is_active AND NOT l.is_deleted
           AND (NOT u.is_active OR u.is_deleted OR (u.org_id<>l.org_id AND NOT EXISTS (
                 SELECT 1 FROM iam.user_org_mapping m WHERE m.user_id=u.id AND m.org_id=l.org_id AND m.is_active)))
         GROUP BY o.name ORDER BY 2 DESC`,
  cols: ['branch', 'leads', 'inactiveOwner', 'outsideBranch'], severity: 'medium',
  expected: 'Active leads are owned by active members of their branch',
  describe: (r) => `${r.branch}: ${r.leads} (inactive owner ${r.inactiveOwner}, outside branch ${r.outsideBranch})`,
  fix: 'Deactivation / branch moves should require reassign_leads_to (updateUser already supports it) — make it mandatory when the user owns open leads, and re-run assignment for the orphans.',
});
check('LMS-4', 'Leads whose campaign type belongs to another tenant', {
  sql: `SELECT l.id, o.tenant_id, ct.tenant_id
          FROM lms.marketing_leads l
          JOIN entity.organizations o ON o.id=l.org_id
          JOIN marketing.campaign_types ct ON ct.id=l.campaign_type_id
         WHERE ct.tenant_id<>o.tenant_id AND NOT l.is_deleted LIMIT 50`,
  cols: ['lead', 'leadTenant', 'typeTenant'], severity: 'critical',
  expected: 'campaign_type_id always belongs to the lead\'s own tenant',
  describe: (r) => r.lead,
  fix: 'Assert the type\'s tenant at every write (intake, transfer, Meta routing) and add a trigger like fn_assert_weight_type_tenant for marketing_leads.',
});

// ── IAM ──────────────────────────────────────────────────────────────────────
check('IAM-1', 'Non-canonical or case-duplicate emails', {
  sql: `SELECT email, 'not lowercase/trimmed' FROM iam.users WHERE email <> lower(btrim(email))
        UNION ALL
        SELECT lower(email), COUNT(*)::text || ' accounts' FROM iam.users WHERE NOT is_deleted GROUP BY lower(email) HAVING COUNT(*)>1`,
  cols: ['email', 'problem'], severity: 'high',
  expected: 'Emails stored trimmed+lowercase (chk_users_email_lowercase), one account per address',
  describe: (r) => `${r.email}: ${r.problem}`,
  fix: 'Backfill lower(btrim(email)), merge duplicates, and keep emailInputSchema on every write path (c2fba5e).',
});
check('IAM-2', 'Branch mappings or managers that cross tenants', {
  sql: `SELECT u.email, 'mapped to org of another tenant' FROM iam.user_org_mapping m
          JOIN iam.users u ON u.id=m.user_id JOIN entity.organizations h ON h.id=u.org_id
          JOIN entity.organizations o ON o.id=m.org_id
         WHERE m.is_active AND o.tenant_id<>h.tenant_id
        UNION ALL
        SELECT u.email, 'manager in another tenant' FROM iam.users u
          JOIN iam.users mg ON mg.id=u.manager_id
          JOIN entity.organizations a ON a.id=u.org_id JOIN entity.organizations b ON b.id=mg.org_id
         WHERE a.tenant_id<>b.tenant_id AND mg.email NOT IN ('root@root.com')`,
  cols: ['email', 'problem'], severity: 'critical',
  expected: 'Every mapping and reporting line stays inside the user\'s tenant',
  describe: (r) => `${r.email}: ${r.problem}`,
  fix: 'Delete the stray rows, and assert o.tenant_id in getUserOrgs (my-orgs) and in addOrgMapping — the branch picker lists whatever this table says.',
});
check('IAM-3', 'Broken reporting lines (self-manager, inactive manager of an active user)', {
  sql: `SELECT u.email, CASE WHEN u.manager_id=u.id THEN 'reports to self' ELSE 'manager inactive/deleted' END
          FROM iam.users u JOIN iam.users mg ON mg.id=u.manager_id
         WHERE u.is_active AND NOT u.is_deleted AND (u.manager_id=u.id OR NOT mg.is_active OR mg.is_deleted)`,
  cols: ['email', 'problem'], severity: 'medium',
  expected: 'Active users report to an active manager (the leave-approval chain walks manager_id)',
  describe: (r) => `${r.email}: ${r.problem}`,
  fix: 'Reassign reports when deactivating a manager; leave requests from these users have no valid approver.',
});

// ── HR ───────────────────────────────────────────────────────────────────────
check('HR-1', 'Active users whose HR profile is missing or out of sync', {
  sql: `SELECT u.email, CASE WHEN p.user_id IS NULL THEN 'no hr.employee_profiles row'
                             WHEN p.org_id<>u.org_id THEN 'profile on a different branch'
                             ELSE 'profile inactive' END
          FROM iam.users u
          JOIN entity.organizations o ON o.id=u.org_id
          JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module IN ('attendance','leave') AND tm.is_active
          LEFT JOIN hr.employee_profiles p ON p.user_id=u.id AND NOT p.is_deleted
         WHERE u.is_active AND NOT u.is_deleted AND u.email NOT LIKE '%@e2e.local'
           AND (p.user_id IS NULL OR p.org_id<>u.org_id OR NOT p.is_active)
         GROUP BY u.email, p.user_id, p.org_id, u.org_id, p.is_active`,
  cols: ['email', 'problem'], severity: 'medium', max: 40,
  expected: 'Every active member of an HR-licensed tenant has an active hr.employee_profiles row on their home branch',
  describe: (r) => `${r.email}: ${r.problem}`,
  fix: 'Backfill via hr-service POST /internal/employees/sync; users created before 044f345 (or whose sync failed — hr_profile_synced=false) are the usual gap.',
});

// ── Meta ─────────────────────────────────────────────────────────────────────
check('META-1', 'Meta lead-inbox items stuck open for more than an hour', {
  sql: `SELECT COUNT(*)::int, MIN(created_at)::text, MAX(attempts)::int, LEFT(MAX(error_text), 160)
          FROM ext.meta_lead_inbox WHERE status='open' AND created_at < NOW() - INTERVAL '1 hour'
        HAVING COUNT(*) > 0`,
  cols: ['open', 'oldest', 'maxAttempts', 'lastError'], severity: 'medium',
  expected: 'Inbox items are ingested (resolved) or deliberately ignored — nothing sits open',
  describe: (r) => `${r.open} open since ${r.oldest}, attempts<=${r.maxAttempts}, error: ${r.lastError}`,
  fix: 'Review /sa/dashboard/meta-lead-inbox: each open row is a real enquiry that never became a lead. The error_text names the failing mapping (page/form -> branch) or campaign type.',
});

// ── Harness residue ──────────────────────────────────────────────────────────
check('E2E-1', 'Throwaway rows left behind by a killed harness run', {
  sql: `SELECT 'iam.users', COUNT(*)::int FROM iam.users WHERE email LIKE '%@e2e.local' HAVING COUNT(*)>0
        UNION ALL SELECT 'lms.marketing_leads', COUNT(*)::int FROM lms.marketing_leads WHERE first_name LIKE 'E2E-%' AND NOT is_deleted HAVING COUNT(*)>0
        UNION ALL SELECT 'marketing.campaign_types', COUNT(*)::int FROM marketing.campaign_types WHERE name LIKE 'e2e\\_%' ESCAPE '\\' AND NOT is_deleted HAVING COUNT(*)>0`,
  cols: ['table', 'rows'], severity: 'low',
  expected: 'No e2e residue (every suite purges what it creates)',
  describe: (r) => `${r.table}: ${r.rows}`,
  fix: 'Run `node restore.mjs --purge-residue` to remove harness rows by their markers.',
});

save('data', 'health', { generatedAt: new Date().toISOString(), checks: summary });
console.log('\nresults -> results/data-health.json');
