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

// ── Schema 1.53 – 1.70 coverage ──────────────────────────────────────────────
// Everything the Stitch redesign / HR parity / Meta console work added. Each
// table is declared with what its RLS shape SHOULD be (read from 08_rls.sql /
// 07_grants.sql), so a table that silently lost FORCE, lost a service login,
// or gained an app grant it must never have, is caught here — not by a user.
//   force    — FORCE ROW LEVEL SECURITY expected (false = deliberately ENABLE only)
//   denyAll  — RLS on with NO app-role policy and NO grant to app roles (service-only)
//   svc      — NOINHERIT service logins that must hold SELECT on it
const NEW_TABLES = {
  'hr.comp_off_claims':          { force: true, svc: ['hr_svc'] },
  'hr.employee_personal':        { force: true, svc: ['hr_svc'] },
  'hr.emergency_contacts':       { force: true, svc: ['hr_svc'] },
  'hr.employee_notes':           { force: true, svc: ['hr_svc'] },
  'hr.shift_swap_requests':      { force: true, svc: ['hr_svc'] },
  'hr.pay_periods':              { force: true, svc: ['hr_svc'] },
  'hr.payslips':                 { force: true, svc: ['hr_svc'] },
  'hr.payslip_lines':            { force: true, svc: ['hr_svc'] },
  'hr.announcements':            { force: true, svc: ['hr_svc'] },
  'hr.announcement_reads':       { force: true, svc: ['hr_svc'] },
  'hr.assets':                   { force: true, svc: ['hr_svc'] },
  'hr.asset_assignments':        { force: true, svc: ['hr_svc'] },
  'hr.leave_encashment_requests': { force: true, svc: ['hr_svc'] },
  'hr.employee_statutory':       { force: true, svc: ['hr_svc'] },
  'hr.profile_change_requests':  { force: true, svc: ['hr_svc'] },
  'hr.employee_documents':       { force: true, svc: ['hr_svc'] },
  'hr.document_settings':        { force: true, svc: ['hr_svc'] },
  'hr.shift_requirements':       { force: true, svc: ['hr_svc'] },
  'hr.roster_publications':      { force: true, svc: ['hr_svc'] },
  'task.task_counters':          { force: false, denyAll: true },
  'entity.tenant_branding':      { force: true, svc: [] },
  'iam.user_preferences':        { force: true, svc: [] },
  'iam.password_reset_tokens':   { force: true, denyAll: true },
  'ext.meta_ad_accounts':        { force: true, denyAll: true },
  'ext.meta_page_health':        { force: true, svc: ['lms_svc', 'meta_svc'] },
  'ext.meta_pull_run_history':   { force: false, svc: ['lms_svc', 'meta_svc'] },
  'marketing.campaign_type_rules': { force: true, svc: ['lms_svc'] },
  'lms.lead_assignment_weights': { force: true, svc: ['lms_svc'] },
  'scratch.meta_pull_runs':      { force: true, svc: ['lms_svc', 'meta_svc'] },
  'scratch.meta_pull_leads':     { force: true, svc: ['lms_svc', 'meta_svc'] },
  'ext.meta_lead_inbox':         { force: true, svc: ['lms_svc'] },
  'ext.lead_stage_capi_event_map': { force: false, svc: ['lms_svc'] },
  'notify.push_subscriptions':   { force: true, svc: [] },
};
const NT = Object.keys(NEW_TABLES);
const DENY = NT.filter((x) => NEW_TABLES[x].denyAll);
const inList = (xs) => xs.map(lit).join(',');
const asValues = (xs) => xs.map((x) => `(${lit(x)})`).join(',');

check('SCH-1', 'Tables added in schema 1.53-1.70 that do not exist in this database', {
  sql: `SELECT t.q FROM (VALUES ${asValues(NT)}) t(q) WHERE to_regclass(t.q) IS NULL`,
  cols: ['table'], severity: 'high',
  expected: 'Every table declared by 02/03_tables_*.sql up to the current schema version exists (a missing one means the one_time/apply_* script was never run here)',
  describe: (r) => r.table,
  fix: 'Apply the matching db_scripts/one_time/apply_*.sql (apply_schema.ps1 never re-runs 02/03). Diff catalog objects against local — schema_versions can lie.',
});
check('RLS-3', 'New tables whose RLS is not ENABLED (and FORCED where required)', {
  sql: `SELECT t.q, c.relrowsecurity::text, c.relforcerowsecurity::text
          FROM (VALUES ${NT.map((x) => `(${lit(x)}, ${NEW_TABLES[x].force})`).join(',')}) t(q, need_force)
          JOIN pg_class c ON c.oid = to_regclass(t.q)
         WHERE NOT c.relrowsecurity OR (t.need_force AND NOT c.relforcerowsecurity)`,
  cols: ['table', 'enabled', 'forced'], severity: 'critical',
  expected: 'relrowsecurity on every new table; relforcerowsecurity on all but the documented ENABLE-only tables (task.task_counters, ext.meta_pull_run_history, ext.lead_stage_capi_event_map)',
  describe: (r) => `${r.table} enabled=${r.enabled} forced=${r.forced}`,
  fix: 'ALTER TABLE ... ENABLE / FORCE ROW LEVEL SECURITY per 08_rls.sql. Without FORCE the table owner bypasses the tenant policy.',
});
check('RLS-4', 'Policies naming app_user that do not name EVERY NOINHERIT login in app_user (zero rows, no error)', {
  // Direct query of the memory rule: a policy `TO app_user` does not reach a NOINHERIT lms_svc / hr_svc / task_svc / meta_svc.
  // The login set is membership of app_user UNION the product logins by name, so a login whose
  // GRANT app_user TO ... went missing is still held to the rule.
  sql: `WITH logins AS (
          SELECT r.rolname AS login FROM pg_auth_members m
            JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
           WHERE g.rolname='app_user' AND r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolbypassrls
          UNION SELECT rolname FROM pg_roles WHERE rolname IN ('lms_svc','hr_svc','task_svc','meta_svc'))
        SELECT p.schemaname||'.'||p.tablename, p.policyname, string_agg(l.login, ',' ORDER BY l.login)
          FROM pg_policies p CROSS JOIN logins l
         WHERE p.schemaname IN ('lms','hr','task','iam','entity','marketing','ext','scratch','notify')
           AND 'app_user' = ANY(p.roles::text[]) AND NOT (l.login = ANY(p.roles::text[]))
         GROUP BY 1,2 ORDER BY 1,2`,
  cols: ['table', 'policy', 'missing'], severity: 'high', max: 40,
  expected: 'Every policy TO app_user also names every NOINHERIT service login (08_rls.sql closing widening block rewrites role lists from current membership)',
  describe: (r) => `${r.table}.${r.policy} missing {${r.missing}}${NEW_TABLES[r.table] ? ' [NEW TABLE]' : ''}`,
  fix: 'Re-run the widening DO block at the end of 08_rls.sql after ANY one_time script that CREATE/ALTER POLICYs. Symptom otherwise: the owning service reads zero rows and logs nothing.',
});
check('RLS-5', 'Service-only tables (deny-all) that an application role can reach', {
  sql: `SELECT t.q, 'policy '||p.policyname FROM (VALUES ${asValues(DENY)}) t(q)
          JOIN pg_policies p ON p.schemaname||'.'||p.tablename = t.q
         WHERE p.roles::text[] && ARRAY['app_user','tenant_admin','public','lms_svc','hr_svc','task_svc','meta_svc']
        UNION ALL
        SELECT t.q, r.rolname||' holds SELECT' FROM (VALUES ${asValues(DENY)}) t(q)
          CROSS JOIN pg_roles r
         WHERE to_regclass(t.q) IS NOT NULL AND r.rolname IN ('app_user','tenant_admin','lms_svc','hr_svc','task_svc','meta_svc') AND has_table_privilege(r.rolname, t.q, 'SELECT')`,
  cols: ['table', 'reach'], severity: 'critical',
  expected: 'task.task_counters, iam.password_reset_tokens and ext.meta_ad_accounts are reachable only through the SECURITY DEFINER trigger / root_service',
  describe: (r) => `${r.table}: ${r.reach}`,
  fix: 'REVOKE ALL ... FROM app_user, tenant_admin, <svc logins> and DROP the policy (07_grants.sql 1.68.0 / 1.57.0 blocks).',
});
check('GRANT-1', 'New tables missing the grants their callers need', {
  sql: `SELECT t.q, r.rolname FROM (VALUES ${asValues(NT.filter((x) => !NEW_TABLES[x].denyAll))}) t(q)
          CROSS JOIN (VALUES ('app_user'),('tenant_admin'),('root_service')) r(rolname)
         WHERE to_regclass(t.q) IS NOT NULL AND NOT has_table_privilege(r.rolname, t.q, 'SELECT')
           -- assets are HR-only data: no app_user policy by design; Meta health/history is a super_admin surface (no tenant_admin grant)
           AND NOT (t.q IN ('hr.assets','hr.asset_assignments') AND r.rolname='app_user')
           AND NOT (t.q IN ('ext.meta_page_health','ext.meta_pull_run_history','scratch.meta_pull_runs','scratch.meta_pull_leads') AND r.rolname='tenant_admin')
        UNION ALL
        ${NT.filter((x) => !NEW_TABLES[x].denyAll && NEW_TABLES[x].svc.length).map((x) => `SELECT ${lit(x)}, l.login FROM (VALUES ${NEW_TABLES[x].svc.map((s) => `(${lit(s)})`).join(',')}) l(login)
         WHERE to_regclass(${lit(x)}) IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=l.login) AND NOT has_table_privilege(l.login, ${lit(x)}, 'SELECT')`).join('\n        UNION ALL\n        ')}`,
  cols: ['table', 'login'], severity: 'high', max: 40,
  expected: 'SELECT for app_user + tenant_admin + root_service, and for the owning service login (a NOINHERIT login does not inherit app_user\'s privileges — GRANT has no widening sweep)',
  describe: (r) => `${r.table} -> ${r.login}`,
  fix: '07_grants.sql: add the explicit GRANT ... TO hr_svc / lms_svc / meta_svc. Symptom otherwise: "permission denied for table" 500 from that service only.',
});

// Cross-tenant rows: every org/user/tenant FK of a new table must agree on ONE tenant.
try {
  const fks = rows(`SELECT n.nspname||'.'||c.relname, a.attname, ref.relname
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1] JOIN pg_class ref ON ref.oid=con.confrelid
     WHERE con.contype='f' AND array_length(con.conkey,1)=1
       AND n.nspname||'.'||c.relname IN (${inList(NT.concat(['hr.leave_requests', 'task.tasks']))})
       AND con.confrelid IN ('iam.users'::regclass, 'entity.organizations'::regclass)`, ['table', 'col', 'ref']);
  const by = {};
  for (const f of fks) (by[f.table] ??= { org: [], user: [] })[f.ref === 'organizations' ? 'org' : 'user'].push(f.col);
  const parts = [];
  for (const [t, c] of Object.entries(by)) {
    const org = c.org[0];
    if (!org) continue;
    for (const u of c.user) {
      parts.push(`SELECT '${t}.${u}' AS k, t.ctid::text AS row_id FROM ${t} t
        JOIN entity.organizations o ON o.id=t.${org} JOIN iam.users u ON u.id=t.${u} JOIN entity.organizations uo ON uo.id=u.org_id
       WHERE o.tenant_id<>uo.tenant_id AND COALESCE(u.platform_role,'')<>'super_admin'`);
    }
    for (const o2 of c.org.slice(1)) {
      parts.push(`SELECT '${t}.${o2}' AS k, t.ctid::text FROM ${t} t JOIN entity.organizations a ON a.id=t.${org} JOIN entity.organizations b ON b.id=t.${o2} WHERE a.tenant_id<>b.tenant_id`);
    }
  }
  // push_subscriptions.tenant_id has no FK: it must equal the org's tenant.
  parts.push(`SELECT 'notify.push_subscriptions.tenant_id', s.ctid::text FROM notify.push_subscriptions s JOIN entity.organizations o ON o.id=s.org_id WHERE o.tenant_id<>s.tenant_id`);
  check('XT-1', 'New-table rows whose org / user / tenant columns disagree on the tenant', {
    sql: `SELECT k, COUNT(*)::int, MIN(row_id) FROM (${parts.join('\nUNION ALL\n')}) x GROUP BY k ORDER BY k`,
    cols: ['column', 'rows', 'sample'], severity: 'critical',
    expected: 'A row\'s branch, its employee/approver/peer/handover user and its tenant all resolve to ONE tenant (no cross-tenant approver, swap peer, handover colleague or push device)',
    describe: (r) => `${r.column}: ${r.rows} row(s), e.g. ctid ${r.sample}`,
    fix: 'Assert the other party\'s tenant at the write (service layer) — RLS only checks the caller\'s own org. Back it with a trigger like fn_assert_weight_type_tenant. Delete/repair the listed rows.',
  });
} catch (e) {
  console.log(`XT-1    could not discover FKs (${String(e.message).slice(0, 120)})`);
  summary.push({ id: 'XT-1', title: 'cross-tenant FK discovery', status: 'error', error: String(e.message).slice(0, 200) });
}
check('XT-2', 'Meta / routing rows crossing tenants', {
  sql: `SELECT 'rule type', r.id::text FROM marketing.campaign_type_rules r JOIN marketing.campaign_types ct ON ct.id=r.campaign_type_id WHERE ct.tenant_id<>r.tenant_id
        UNION ALL SELECT 'page map org', m.id::text FROM ext.meta_page_form_org_map m JOIN entity.organizations o ON o.id=m.org_id WHERE o.tenant_id<>m.tenant_id
        UNION ALL SELECT 'page map default type', m.id::text FROM ext.meta_page_form_org_map m JOIN marketing.campaign_types ct ON ct.id=m.default_campaign_type_id WHERE ct.tenant_id<>m.tenant_id
        UNION ALL SELECT 'campaign type', c.id::text FROM ext.meta_campaigns c JOIN marketing.campaign_types ct ON ct.id=c.campaign_type_id WHERE ct.tenant_id<>c.tenant_id
        UNION ALL SELECT 'inbox org', i.id::text FROM ext.meta_lead_inbox i JOIN entity.organizations o ON o.id=i.org_id WHERE i.tenant_id IS NOT NULL AND o.tenant_id<>i.tenant_id
        UNION ALL SELECT 'pull staged lead org', l.id::text FROM scratch.meta_pull_leads l JOIN entity.organizations o ON o.id=l.org_id WHERE o.tenant_id<>l.tenant_id
        UNION ALL SELECT 'weight type', w.user_org_mapping_id::text FROM lms.lead_assignment_weights w JOIN marketing.campaign_types ct ON ct.id=w.campaign_type_id JOIN iam.user_org_mapping m ON m.id=w.user_org_mapping_id JOIN entity.organizations o ON o.id=m.org_id WHERE ct.tenant_id<>o.tenant_id`,
  cols: ['kind', 'id'], severity: 'critical',
  expected: 'Routing rules, page mappings, campaigns, inbox items, staged pull rows and assignment weights only ever reference their own tenant\'s types / branches',
  describe: (r) => `${r.kind} ${r.id}`,
  fix: 'The tenant fence must be asserted at every writer (Apply, remap, confirm, rule create) — the admin_tenant_config_policy WITH CHECK only pins tenant_id, not the referenced row.',
});

// ── Capabilities added 1.53-1.70 ─────────────────────────────────────────────
const NEW_CAPS = ['platform.appearance', 'admin.branding', 'admin.branding.view', 'admin.branding.manage',
  'lms.leads.bulk.update', 'lms.followups.bulk.reschedule', 'tasks.bulk', 'tasks.export',
  'hr.reports', 'hr.reports.attendance', 'hr.reports.attendance.view', 'hr.reports.attendance.view.org', 'hr.reports.attendance.view.tenant', 'hr.reports.payroll.manage',
  'hr.leave.comp_off.request', 'hr.leave.comp_off.approve', 'hr.leave.encashment.request', 'hr.leave.encashment.approve',
  'hr.employees.profile.edit', 'hr.employees.profile360.view', 'hr.employees.notes.manage', 'hr.employees.payslip.view',
  'hr.employees.announcements.view', 'hr.employees.announcements.manage', 'hr.employees.assets.view', 'hr.employees.assets.manage',
  'hr.employees.statutory.manage', 'hr.employees.documents.view', 'hr.employees.documents.manage',
  'hr.attendance.roster.view', 'hr.attendance.roster.manage', 'hr.attendance.swap.request', 'hr.attendance.swap.approve', 'hr.attendance.admin.override'];
check('CAP-3', 'New capabilities missing, inactive, or hanging off an inactive parent', {
  sql: `SELECT k.key, CASE WHEN c.id IS NULL THEN 'missing from iam.capabilities' WHEN NOT c.is_active THEN 'inactive'
                          WHEN p.id IS NULL THEN 'no parent' ELSE 'parent '||p.key||' inactive' END
          FROM (VALUES ${asValues(NEW_CAPS)}) k(key)
          LEFT JOIN iam.capabilities c ON c.key=k.key LEFT JOIN iam.capabilities p ON p.key=c.parent_key
         WHERE c.id IS NULL OR NOT c.is_active OR (c.kind<>'tool' AND (p.id IS NULL OR NOT p.is_active))`,
  cols: ['key', 'problem'], severity: 'high',
  expected: 'Every capability the 1.56-1.68 code gates on exists, is active, and sits under an active parent (fn_role_capability_matrix walks active nodes only)',
  describe: (r) => `${r.key}: ${r.problem}`,
  fix: 'Apply reference_data/02_capabilities.sql (idempotent upsert) and the matching one_time/apply_*_capabilit*.sql.',
});
check('CAP-4', 'Retired hr.attendance.admin.reports keys still active (1.56.0)', {
  sql: `SELECT key FROM iam.capabilities WHERE key IN ('hr.attendance.admin.reports','hr.attendance.admin.reports.view') AND is_active`,
  cols: ['key'], severity: 'medium',
  expected: 'The attendance-reports tab keys are DEACTIVATED (reports moved to the hr.reports tool) — an active retired node shows a dead tab in the Capability Matrix',
  describe: (r) => r.key,
  fix: 'Run one_time/apply_hr_reports_capability.sql.',
});
// Back-fill pins (reference_data/03_roles_and_grants.sql): every EFFECTIVE holder of the source
// key got the target key, DO NOTHING on conflict — so the only legitimate gap is an explicit
// is_granted=FALSE override row. Anything else is a role that lost a feature, or a target granted
// to a role that never held its source (privilege widening).
const PINS = [
  ['lms.leads.assign.bulk', 'lms.leads.bulk.update'], ['lms.leads.assign.bulk', 'lms.followups.bulk.reschedule'],
  ['tasks.assign', 'tasks.bulk'], ['tasks.view.team', 'tasks.export'],
  ['hr.leave.request.create', 'hr.leave.comp_off.request'], ['hr.leave.approve', 'hr.leave.comp_off.approve'],
  ['hr.leave.request.create', 'hr.leave.encashment.request'], ['hr.leave.approve', 'hr.leave.encashment.approve'],
  ['hr.employees.view', 'hr.employees.profile.edit'], ['hr.employees.manage', 'hr.employees.profile360.view'],
  ['hr.employees.manage', 'hr.employees.notes.manage'], ['hr.employees.view', 'hr.employees.payslip.view'],
  ['hr.employees.manage', 'hr.reports.payroll.manage'], ['hr.employees.view', 'hr.employees.announcements.view'],
  ['hr.employees.manage', 'hr.employees.announcements.manage'], ['hr.employees.view', 'hr.employees.assets.view'],
  ['hr.employees.manage', 'hr.employees.assets.manage'], ['hr.employees.manage', 'hr.employees.statutory.manage'],
  ['hr.employees.view', 'hr.employees.documents.view'], ['hr.employees.manage', 'hr.employees.documents.manage'],
  ['hr.attendance.view', 'hr.attendance.roster.view'], ['hr.attendance.punch', 'hr.attendance.swap.request'],
  ['hr.attendance.regularization.approve', 'hr.attendance.swap.approve'],
  ['hr.attendance.admin.assignments.manage', 'hr.attendance.admin.override'], ['hr.attendance.admin.assignments.manage', 'hr.attendance.roster.manage'],
];
const pinSql = `(VALUES ${PINS.map(([s, t]) => `(${lit(s)},${lit(t)})`).join(',')}) pin(src,tgt)`;
const tenantRoles = `SELECT t.id AS tenant_id, r.name AS role_name, r.id AS role_id FROM entity.tenants t
     JOIN iam.user_roles r ON (r.tenant_id=t.id OR r.tenant_id IS NULL) AND r.is_active WHERE t.is_active AND NOT t.is_deleted`;
const roleHeldIn = (tr) => `EXISTS (SELECT 1 FROM iam.users u JOIN iam.user_roles ur ON ur.id=u.role_id JOIN entity.organizations o ON o.id=u.org_id
                        WHERE ur.name=${tr}.role_name AND o.tenant_id=${tr}.tenant_id AND u.is_active AND NOT u.is_deleted)`;
check('CAP-5', 'Roles that hold a back-fill source capability but not its 1.56-1.68 target (and have not opted out)', {
  sql: `SELECT DISTINCT tr.tenant_id, tr.role_name, pin.src, pin.tgt
          FROM (${tenantRoles}) tr CROSS JOIN ${pinSql}
          JOIN LATERAL iam.fn_role_capability_matrix(tr.tenant_id) s ON s.role_name=tr.role_name AND s.capability_key=pin.src AND s.granted
         WHERE tr.role_name NOT IN ('super_admin','read_only')
           AND ${roleHeldIn('tr')}
           AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) g WHERE g.role_name=tr.role_name AND g.capability_key=pin.tgt AND g.granted)
           AND NOT EXISTS (SELECT 1 FROM iam.role_capabilities rc JOIN iam.capabilities c ON c.id=rc.capability_id
                            WHERE rc.role_id=tr.role_id AND c.key=pin.tgt AND NOT rc.is_granted AND (rc.tenant_id=tr.tenant_id OR rc.tenant_id IS NULL))`,
  cols: ['tenant', 'role', 'source', 'target'], severity: 'high', max: 60,
  expected: 'Every role that effectively holds the source key also holds the new key (reference_data/03 back-fills; an explicit is_granted=FALSE is the only legitimate gap)',
  describe: (r) => `${r.role} @${String(r.tenant).slice(0, 8)}: has ${r.source}, lacks ${r.target}`,
  fix: 'Re-run the matching one_time/apply_*capabilit*.sql — a grant added to the GLOBAL role template never reaches a tenant that holds its own copy of the role; the back-fill must pin to effective holders per tenant.',
});
check('CAP-6', 'Roles that hold a manage-type target capability without holding its source (privilege widening)', {
  sql: `SELECT DISTINCT tr.tenant_id, tr.role_name, pin.src, pin.tgt
          FROM (${tenantRoles}) tr CROSS JOIN ${pinSql}
          JOIN LATERAL iam.fn_role_capability_matrix(tr.tenant_id) g ON g.role_name=tr.role_name AND g.capability_key=pin.tgt AND g.granted
         WHERE tr.role_name NOT IN ('super_admin','tenant_admin')
           AND pin.tgt ~ '(manage|approve|bulk|export|override)$'
           AND ${roleHeldIn('tr')}
           AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) s WHERE s.role_name=tr.role_name AND s.capability_key=pin.src AND s.granted)`,
  cols: ['tenant', 'role', 'source', 'target'], severity: 'medium', max: 40,
  expected: 'A role holds .manage/.approve/.bulk/.export only if it also holds the capability they were back-filled from — otherwise someone widened it by hand (confirm intent)',
  describe: (r) => `${r.role} @${String(r.tenant).slice(0, 8)}: has ${r.target} without ${r.source}`,
  fix: 'Confirm with the tenant admin; remove the grant in the Capability Matrix if unintended.',
});
check('CAP-7', 'platform.appearance / admin.branding grants wrong (1.57.0)', {
  sql: `SELECT tr.tenant_id, tr.role_name,
               CASE WHEN pin.k='platform.appearance' THEN 'lacks platform.appearance (personal, every role incl. read_only)'
                    WHEN pin.k='admin.branding.manage' AND tr.role_name='tenant_admin' THEN 'tenant_admin lacks admin.branding.manage'
                    ELSE 'non-admin role holds '||pin.k END
          FROM (${tenantRoles}) tr CROSS JOIN (VALUES ('platform.appearance'),('admin.branding.manage'),('admin.branding.view')) pin(k)
         WHERE tr.role_name <> 'super_admin' AND ${roleHeldIn('tr')}
           AND (
             (pin.k='platform.appearance' AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) m WHERE m.role_name=tr.role_name AND m.capability_key=pin.k AND m.granted)
                AND EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) p WHERE p.role_name=tr.role_name AND p.capability_key='platform' AND p.granted))
             OR (pin.k='admin.branding.manage' AND tr.role_name='tenant_admin' AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) m WHERE m.role_name=tr.role_name AND m.capability_key=pin.k AND m.granted))
             OR (pin.k LIKE 'admin.branding%' AND tr.role_name <> 'tenant_admin' AND EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(tr.tenant_id) m WHERE m.role_name=tr.role_name AND m.capability_key=pin.k AND m.granted))
           )`,
  cols: ['tenant', 'role', 'problem'], severity: 'high',
  expected: 'platform.appearance wherever the platform tool is granted (incl. read_only); admin.branding.* held by tenant_admin only (+ super_admin via *)',
  describe: (r) => `${r.role} @${String(r.tenant).slice(0, 8)}: ${r.problem}`,
  fix: 'one_time/apply_branding_appearance_reset.sql back-fills both; a role that a tenant deliberately opted out must carry an explicit is_granted=FALSE row.',
});
check('CAP-8', 'Tenant-created roles that cannot write: no platform + platform.write (held yet or not)', {
  sql: `SELECT t.id, r.name, (SELECT COUNT(*) FROM iam.users u WHERE u.role_id=r.id AND u.is_active AND NOT u.is_deleted)::int
          FROM entity.tenants t JOIN iam.user_roles r ON r.tenant_id=t.id AND r.is_active
         WHERE t.is_active AND NOT t.is_deleted AND r.name <> 'read_only'
           AND NOT EXISTS (SELECT 1 FROM iam.fn_role_capability_matrix(t.id) m WHERE m.role_name=r.name AND m.capability_key='platform.write' AND m.granted)`,
  cols: ['tenant', 'role', 'users'], severity: 'medium',
  expected: 'Every active tenant-owned role can write — a custom role created without platform.write is a bare-500 trap the first time someone is assigned to it (CAP-1 covers roles users already hold)',
  describe: (r) => `${r.role} @${String(r.tenant).slice(0, 8)} (${r.users} users)`,
  fix: 'Make the Create Role flow default-grant platform + platform.write (memory: custom-roles-missing-platform-write) and surface PG 25006 as a 403.',
});

// ── Domain integrity of the new HR / Tasks tables ────────────────────────────
check('HRX-1', 'Payslip totals disagree with their lines (service computes, never trusts the client)', {
  sql: `SELECT p.id::text, p.gross::text, COALESCE(SUM(l.amount) FILTER (WHERE l.kind='earning'),0)::text, p.deductions::text, COALESCE(SUM(l.amount) FILTER (WHERE l.kind='deduction'),0)::text, p.net::text
          FROM hr.payslips p LEFT JOIN hr.payslip_lines l ON l.payslip_id=p.id
         WHERE NOT p.is_deleted GROUP BY p.id
        HAVING p.gross <> COALESCE(SUM(l.amount) FILTER (WHERE l.kind='earning'),0)
            OR p.deductions <> COALESCE(SUM(l.amount) FILTER (WHERE l.kind='deduction'),0)
            OR p.net <> p.gross - p.deductions`,
  cols: ['payslip', 'gross', 'earnings', 'deductions', 'deductionLines', 'net'], severity: 'high',
  expected: 'gross = sum(earning lines), deductions = sum(deduction lines), net = gross - deductions',
  describe: (r) => `${r.payslip}: gross ${r.gross}/${r.earnings} ded ${r.deductions}/${r.deductionLines} net ${r.net}`,
  fix: 'Recompute in the payroll service transaction whenever lines change (PUT /hr/payroll/admin/payslips).',
});
check('HRX-2', 'Locked pay periods that still hold unpublished payslips', {
  sql: `SELECT p.org_id::text, p.period::text, COUNT(*)::int FROM hr.payslips p
          JOIN hr.pay_periods pp ON pp.org_id=p.org_id AND pp.period=p.period AND pp.status='locked'
         WHERE NOT p.is_deleted AND p.published_at IS NULL GROUP BY 1,2`,
  cols: ['org', 'period', 'unpublished'], severity: 'low',
  expected: 'A locked pay period holds only published payslips (lock freezes what employees can already read)',
  describe: (r) => `${r.org} ${r.period}: ${r.unpublished} draft payslip(s) in a locked month`,
  fix: 'Publish before lock, or unlock + publish; lock should refuse while drafts exist.',
});
check('HRX-3', 'Leave request numbers (LV-n) missing, duplicated, or below the sequence start', {
  sql: `SELECT 'null', COUNT(*)::int FROM hr.leave_requests WHERE request_no IS NULL HAVING COUNT(*)>0
        UNION ALL SELECT 'duplicate '||request_no, COUNT(*)::int FROM hr.leave_requests GROUP BY request_no HAVING COUNT(*)>1
        UNION ALL SELECT 'below 1001', COUNT(*)::int FROM hr.leave_requests WHERE request_no < 1001 HAVING COUNT(*)>0`,
  cols: ['problem', 'rows'], severity: 'medium',
  expected: 'request_no unique, >= 1001 (hr.leave_request_no_seq START 1001), shown as LV-<n>',
  describe: (r) => `${r.problem}: ${r.rows}`,
  fix: 'Re-number in created_at order and setval the sequence past MAX(request_no).',
});
check('HRX-4', 'Leave attachment columns half-filled, key outside the request\'s folder, or handover colleague in another tenant', {
  sql: `SELECT id::text, 'attachment fields partial' FROM hr.leave_requests
         WHERE (attachment_key IS NULL) <> (attachment_name IS NULL) OR (attachment_key IS NULL) <> (attachment_mime IS NULL)
        UNION ALL
        SELECT lr.id::text, 'handover user in another tenant' FROM hr.leave_requests lr
          JOIN entity.organizations o ON o.id=lr.org_id JOIN iam.users h ON h.id=lr.handover_user_id JOIN entity.organizations ho ON ho.id=h.org_id
         WHERE o.tenant_id<>ho.tenant_id
        UNION ALL
        SELECT id::text, 'attachment key outside leave/<org>/<user>/' FROM hr.leave_requests
         WHERE attachment_key IS NOT NULL AND attachment_key NOT LIKE 'leave/'||org_id::text||'/'||user_id::text||'/%'`,
  cols: ['request', 'problem'], severity: 'high',
  expected: 'attachment_* all set or all null; the blob key lives under leave/<org>/<user>/ of the request itself; handover colleague is in the same tenant',
  describe: (r) => `${r.request}: ${r.problem}`,
  fix: 'Derive the blob key server-side from the verified session (never accept a client key), and validate handover_user_id against the requester\'s tenant.',
});
check('HRX-5', 'Employee documents: key outside the owner\'s folder, over the org limit, or org/owner tenant mismatch', {
  sql: `SELECT d.id::text, 'file_key not under documents/<org>/<user>/' FROM hr.employee_documents d
         WHERE NOT d.is_deleted AND d.file_key NOT LIKE 'documents/'||d.org_id::text||'/'||d.user_id::text||'/%'
        UNION ALL SELECT d.id::text, 'bigger than the org limit '||s.max_bytes FROM hr.employee_documents d
          JOIN hr.document_settings s ON s.org_id=d.org_id WHERE NOT d.is_deleted AND d.size_bytes > s.max_bytes
        UNION ALL SELECT d.id::text, 'document org differs from owner home tenant' FROM hr.employee_documents d
          JOIN entity.organizations o ON o.id=d.org_id JOIN iam.users u ON u.id=d.user_id JOIN entity.organizations uo ON uo.id=u.org_id WHERE o.tenant_id<>uo.tenant_id`,
  cols: ['document', 'problem'], severity: 'high',
  expected: 'Vault blobs live under the owner\'s own prefix (a guessable/foreign key is a download IDOR), within the HR-configured size limit',
  describe: (r) => `${r.document}: ${r.problem}`,
  fix: 'Build file_key from the session in the service; lowering document_settings.max_bytes must not strand bigger existing files unflagged.',
});
check('HRX-6', 'Swap / comp-off rows in impossible states', {
  sql: `SELECT id::text, 'swap peer = requester' FROM hr.shift_swap_requests WHERE peer_id = requester_id
        UNION ALL SELECT id::text, 'swap approved without acted_by/at' FROM hr.shift_swap_requests WHERE status='approved' AND (acted_by IS NULL OR acted_at IS NULL)
        UNION ALL SELECT id::text, 'comp-off approved without ledger credit' FROM hr.comp_off_claims WHERE status='approved' AND ledger_entry_id IS NULL AND NOT is_deleted
        UNION ALL SELECT id::text, 'comp-off self-approved' FROM hr.comp_off_claims WHERE status='approved' AND acted_by = user_id`,
  cols: ['row', 'problem'], severity: 'medium',
  expected: 'Swap requires two people; approval records its actor; approved comp-off credits the ledger; nobody approves their own claim',
  describe: (r) => `${r.row}: ${r.problem}`,
  fix: 'Check the approval transactions in hr-service (comp-off / swap services) and repair the rows.',
});
check('TASK-1', 'Task codes: counter behind MAX(task_no), duplicates, or tasks without a number', {
  sql: `SELECT t.org_id::text, MAX(t.task_no)::text, COALESCE(c.last_no,-1)::text FROM task.tasks t LEFT JOIN task.task_counters c ON c.org_id=t.org_id
         GROUP BY t.org_id, c.last_no HAVING COALESCE(c.last_no,-1) < MAX(t.task_no)
        UNION ALL SELECT org_id::text, 'dup '||task_no, COUNT(*)::text FROM task.tasks GROUP BY org_id, task_no HAVING COUNT(*)>1
        UNION ALL SELECT org_id::text, 'null task_no', COUNT(*)::text FROM task.tasks WHERE task_no IS NULL GROUP BY org_id`,
  cols: ['org', 'maxOrProblem', 'counter'], severity: 'high',
  expected: 'task.task_counters.last_no >= MAX(task_no) per branch; TASK-<n> unique per branch (uq_tasks_org_task_no)',
  describe: (r) => `${r.org}: ${r.maxOrProblem} vs counter ${r.counter}`,
  fix: 'A counter behind the max re-issues an existing TASK-n: UPDATE task.task_counters SET last_no = MAX(task_no) under root_service.',
});
check('BRAND-1', 'Tenant branding / preference invariants (1.57.0)', {
  sql: `SELECT b.tenant_id::text, 'branding row for a missing/deleted tenant' FROM entity.tenant_branding b LEFT JOIN entity.tenants t ON t.id=b.tenant_id WHERE t.id IS NULL OR t.is_deleted
        UNION ALL SELECT p.user_id::text, 'preference row for a missing user' FROM iam.user_preferences p LEFT JOIN iam.users u ON u.id=p.user_id WHERE u.id IS NULL
        UNION ALL SELECT t.id::text, 'reset token lives longer than 15 minutes' FROM iam.password_reset_tokens t WHERE t.expires_at > t.created_at + INTERVAL '16 minutes'`,
  cols: ['subject', 'problem'], severity: 'medium',
  expected: 'One branding row per live tenant; password-reset tokens live 15 minutes at most',
  describe: (r) => `${r.subject}: ${r.problem}`,
  fix: 'Check the branding upsert and the identity-service reset-token TTL.',
});

// ── LMS: assignment weights (memory: lead-assignment-weight-zero) ────────────
check('LMS-5', 'Branches WITH active sales reps but no rep in any weighted rotation', {
  sql: `SELECT o.name, COUNT(DISTINCT m.user_id)::int
          FROM entity.organizations o
          JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module='lms' AND tm.is_active
          JOIN iam.user_org_mapping m ON m.org_id=o.id AND m.is_active
          JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted AND u.email NOT LIKE '%@e2e.local'
          JOIN iam.user_roles r ON r.id=m.role_id AND r.name IN ('sales_representative','senior_sales_executive')
         WHERE o.is_active AND NOT o.is_deleted
           AND NOT EXISTS (SELECT 1 FROM iam.user_org_mapping m2 JOIN lms.lead_assignment_weights w ON w.user_org_mapping_id=m2.id AND w.weight>0
                             JOIN iam.users u2 ON u2.id=m2.user_id AND u2.is_active AND NOT u2.is_deleted
                            WHERE m2.org_id=o.id AND m2.is_active)
         GROUP BY o.name ORDER BY o.name`,
  cols: ['branch', 'reps'], severity: 'high',
  expected: 'A branch that has working reps has at least one with weight > 0 — otherwise every new lead there lands unassigned and nothing says so',
  describe: (r) => `${r.branch} (${r.reps} reps, 0 weighted)`,
  fix: 'Team -> Lead weights; consider making createUser/addOrgMapping refuse an all-zero pool for a branch that has reps.',
});
check('LMS-6', 'Weighted pools with no ACTIVE weighted member (declared >0, effectively 0)', {
  sql: `SELECT o.name, ct.name, SUM(w.weight)::int
          FROM lms.lead_assignment_weights w
          JOIN iam.user_org_mapping m ON m.id=w.user_org_mapping_id
          JOIN iam.users u ON u.id=m.user_id
          JOIN entity.organizations o ON o.id=m.org_id AND o.is_active
          JOIN marketing.campaign_types ct ON ct.id=w.campaign_type_id AND ct.is_active AND NOT ct.is_deleted
         GROUP BY o.name, ct.name
        HAVING SUM(w.weight) > 0 AND SUM(w.weight) FILTER (WHERE m.is_active AND u.is_active AND NOT u.is_deleted) IS NULL`,
  cols: ['branch', 'type', 'declared'], severity: 'high',
  expected: 'If a pool declares weight, at least one of its weighted members is an active user on an active mapping',
  describe: (r) => `${r.branch}/${r.type} declares ${r.declared}% but every weighted member is inactive`,
  fix: 'On deactivate/unmap reconcile the pool (reconcileOrgAssignments) and redistribute to 100.',
});
check('LMS-7', 'Unassigned leads (last 30 days) whose type has NO weighted member in the lead\'s branch', {
  sql: `SELECT o.name, ct.name, COUNT(*)::int
          FROM lms.marketing_leads l JOIN entity.organizations o ON o.id=l.org_id AND o.is_active
          JOIN marketing.campaign_types ct ON ct.id=l.campaign_type_id
         WHERE l.created_at > NOW() - INTERVAL '30 days' AND NOT l.is_deleted AND l.is_active AND l.superseded_by IS NULL
           AND l.assigned_user_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM lms.lead_assignment_weights w JOIN iam.user_org_mapping m ON m.id=w.user_org_mapping_id AND m.is_active
                            WHERE m.org_id=l.org_id AND w.campaign_type_id=l.campaign_type_id AND w.weight>0)
         GROUP BY o.name, ct.name ORDER BY 3 DESC`,
  cols: ['branch', 'type', 'unassigned'], severity: 'medium', max: 30,
  expected: 'Per-type membership: a lead of a type must have somebody in that type\'s pool in its branch (a hiring lead is never offered to the sales pool)',
  describe: (r) => `${r.branch}/${r.type}: ${r.unassigned} unassigned lead(s), no weighted member`,
  fix: 'Add the type\'s pool in Team -> Lead weights for this branch (or route the type elsewhere).',
});

// ── Meta routing (product decisions 2026-09-26) ─────────────────────────────
check('META-2', 'Campaign-type rules: duplicate order, or live rule on an inactive type', {
  sql: `SELECT tenant_id::text, 'duplicate rule_order '||rule_order, COUNT(*)::int FROM marketing.campaign_type_rules WHERE NOT is_deleted AND is_active GROUP BY tenant_id, rule_order HAVING COUNT(*)>1
        UNION ALL SELECT r.tenant_id::text, 'live rule "'||r.pattern||'" targets inactive type '||ct.name, 1 FROM marketing.campaign_type_rules r
          JOIN marketing.campaign_types ct ON ct.id=r.campaign_type_id WHERE r.is_active AND NOT r.is_deleted AND (NOT ct.is_active OR ct.is_deleted)`,
  cols: ['tenant', 'problem', 'n'], severity: 'medium',
  expected: 'Ordered rules, first match wins: rule_order unique per tenant among live rules (uix_campaign_type_rules_order); a rule on an inactive type is skipped by the matcher (harmless but confusing)',
  describe: (r) => `${String(r.tenant).slice(0, 8)}: ${r.problem}`,
  fix: 'The reorder endpoint rewrites the list in one statement; check the unique index exists (06_indexes.sql).',
});
check('META-3', 'Page=branch: page mapped under several tenants / several live page-level rows / redundant form override', {
  sql: `SELECT page_id::text, 'page mapped under '||COUNT(DISTINCT tenant_id)||' tenants' FROM ext.meta_page_form_org_map WHERE is_active GROUP BY page_id HAVING COUNT(DISTINCT tenant_id)>1
        UNION ALL SELECT page_id::text, COUNT(*)||' live page-level rows' FROM ext.meta_page_form_org_map WHERE is_active AND form_id IS NULL GROUP BY page_id HAVING COUNT(*)>1
        UNION ALL SELECT DISTINCT m.page_id::text, 'form override row duplicates its page-level branch (redundant)' FROM ext.meta_page_form_org_map m
          JOIN ext.meta_page_form_org_map p ON p.page_id=m.page_id AND p.form_id IS NULL AND p.is_active AND p.org_id=m.org_id
         WHERE m.is_active AND m.form_id IS NOT NULL`,
  cols: ['page', 'problem'], severity: 'high',
  expected: 'Branch comes from the Page only; a form-level row exists solely as an override for a page shared by several branches; a page never maps across tenants',
  describe: (r) => `page ${r.page}: ${r.problem}`,
  fix: 'Fix mappings in /sa/dashboard/meta-mappings (read-only here; the harness never clicks Meta actions).',
});
check('META-4', 'Campaigns: span tenants unflagged, or confirmed without a type/confirmer, or a guess hardened into the type', {
  sql: `SELECT c.meta_campaign_id::text, 'pages map to '||COUNT(DISTINCT m.tenant_id)||' tenants but conflict_reason is NULL'
          FROM ext.meta_campaigns c JOIN ext.meta_page_form_org_map m ON m.page_id = ANY(c.page_ids) AND m.is_active
         WHERE c.conflict_reason IS NULL GROUP BY c.id, c.meta_campaign_id HAVING COUNT(DISTINCT m.tenant_id)>1
        UNION ALL SELECT meta_campaign_id::text, 'confirmed without campaign_type_id' FROM ext.meta_campaigns WHERE mapping_status='confirmed' AND campaign_type_id IS NULL
        UNION ALL SELECT meta_campaign_id::text, 'confirmed without confirmer' FROM ext.meta_campaigns WHERE mapping_status='confirmed' AND (confirmed_by IS NULL OR confirmed_at IS NULL)
        UNION ALL SELECT meta_campaign_id::text, 'type set but not confirmed (a guess hardened into the type)' FROM ext.meta_campaigns WHERE mapping_status<>'confirmed' AND campaign_type_id IS NOT NULL`,
  cols: ['campaign', 'problem'], severity: 'high',
  expected: 'A campaign never spans tenants (flag + skip); campaign_type_id is set ONLY by an admin confirm — a guess lives in suggested_campaign_type_id',
  describe: (r) => `campaign ${r.campaign}: ${r.problem}`,
  fix: 'Resolve in /sa/dashboard/meta-campaigns (inventory only from the harness).',
});
check('META-5', 'Re-type moves ALL open leads: open leads of a confirmed campaign still on a different type', {
  sql: `SELECT c.meta_campaign_id::text, ct.name, COUNT(*)::int
          FROM ext.meta_campaigns c
          JOIN marketing.campaign_types ct ON ct.id=c.campaign_type_id
          JOIN ext.meta_leads ml ON ml.campaign_id=c.meta_campaign_id
          JOIN lms.marketing_leads l ON l.id=ml.marketing_lead_id
          JOIN entity.organizations o ON o.id=l.org_id AND o.tenant_id=c.tenant_id
          LEFT JOIN lms.lead_stage ls ON ls.id=l.stage_id
         WHERE c.mapping_status='confirmed' AND NOT l.is_deleted AND l.is_active AND l.superseded_by IS NULL
           AND ls.is_terminated IS DISTINCT FROM TRUE
           AND l.campaign_type_id IS DISTINCT FROM c.campaign_type_id
         GROUP BY c.meta_campaign_id, ct.name ORDER BY 3 DESC`,
  cols: ['campaign', 'confirmedType', 'openLeadsOnOtherType'], severity: 'high', max: 30,
  expected: 'After an admin confirms/re-types a campaign every open lead of it carries the new type (RELABEL is unconditional, 2026-09-26)',
  describe: (r) => `campaign ${r.campaign} -> ${r.confirmedType}: ${r.openLeadsOnOtherType} open lead(s) still on another type`,
  fix: 'leads-service reclassifyCampaign did not run/finish after the confirm (meta-conversion-api -> leads-service call). Size it with the dry run; the harness never triggers it.',
});
check('META-6', 'Open leads of a re-typed campaign left with an owner outside the new type\'s pool (a pool exists)', {
  sql: `SELECT c.meta_campaign_id::text, ct.name, o.name, COUNT(*)::int
          FROM ext.meta_campaigns c JOIN marketing.campaign_types ct ON ct.id=c.campaign_type_id
          JOIN ext.meta_leads ml ON ml.campaign_id=c.meta_campaign_id JOIN lms.marketing_leads l ON l.id=ml.marketing_lead_id
          JOIN entity.organizations o ON o.id=l.org_id AND o.tenant_id=c.tenant_id
          LEFT JOIN lms.lead_stage ls ON ls.id=l.stage_id
         WHERE c.mapping_status='confirmed' AND NOT l.is_deleted AND l.is_active AND l.superseded_by IS NULL
           AND ls.is_terminated IS DISTINCT FROM TRUE AND l.campaign_type_id = c.campaign_type_id
           AND (l.assigned_user_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM lms.lead_assignment_weights w JOIN iam.user_org_mapping uom ON uom.id=w.user_org_mapping_id
                   JOIN iam.user_roles ur ON ur.id=uom.role_id JOIN marketing.campaign_types nct ON nct.id=w.campaign_type_id
                  WHERE uom.user_id=l.assigned_user_id AND uom.org_id=l.org_id AND uom.is_active AND w.campaign_type_id=c.campaign_type_id AND w.weight>0
                    AND ur.department_id IS NOT NULL AND nct.department_id IS NOT DISTINCT FROM ur.department_id))
           AND EXISTS (SELECT 1 FROM lms.lead_assignment_weights w2 JOIN iam.user_org_mapping m2 ON m2.id=w2.user_org_mapping_id AND m2.is_active
                        JOIN iam.users u2 ON u2.id=m2.user_id AND u2.is_active AND NOT u2.is_deleted
                       WHERE m2.org_id=l.org_id AND w2.campaign_type_id=c.campaign_type_id AND w2.weight>0)
         GROUP BY c.meta_campaign_id, ct.name, o.name ORDER BY 4 DESC`,
  cols: ['campaign', 'type', 'branch', 'leads'], severity: 'medium', max: 30,
  expected: 'Product decision 2026-09-26: re-route moves EVERY open lead to the new type\'s pool unless its owner already works that pool (same predicate as selectReroutableLeads)',
  describe: (r) => `${r.campaign} (${r.type}) @ ${r.branch}: ${r.leads} open lead(s) not re-routed`,
  fix: 'Run the reclassify dry run for the campaign from the Meta console (human action) and compare with this list.',
});
check('META-7', 'Catch-up pulls must STAGE ONLY: a scheduled run that was applied', {
  sql: `SELECT 'scratch.meta_pull_runs', id::text, status FROM scratch.meta_pull_runs
         WHERE trigger_kind='scheduled' AND (status IN ('apply_queued','applying','applied') OR applied_at IS NOT NULL OR applied_by IS NOT NULL)
        UNION ALL SELECT 'ext.meta_pull_run_history', run_id::text, status FROM ext.meta_pull_run_history
         WHERE trigger_kind='scheduled' AND (status IN ('apply_queued','applying','applied') OR applied_at IS NOT NULL)`,
  cols: ['table', 'run', 'status'], severity: 'critical',
  expected: 'trigger_kind=scheduled runs are never applied without a person pressing Apply (product decision 2026-09-26) — an applied scheduled run means leads were imported unattended',
  describe: (r) => `${r.table} run ${r.run} status=${r.status}`,
  fix: 'The poller must call the stage path only; Apply must require a verified user session and refuse trigger_kind=scheduled without an explicit review.',
});
check('META-8', 'Mapped Meta pages whose last token check failed (pull/webhook for the page is dead)', {
  sql: `SELECT h.page_id::text, h.token_status, COALESCE(h.is_subscribed::text,'?'), LEFT(COALESCE(h.error_text,''),120), h.checked_at::text
          FROM ext.meta_page_health h
         WHERE h.token_status<>'ok' AND EXISTS (SELECT 1 FROM ext.meta_page_form_org_map m WHERE m.page_id=h.page_id AND m.tenant_id=h.tenant_id AND m.is_active)`,
  cols: ['page', 'token', 'subscribed', 'error', 'checkedAt'], severity: 'medium',
  expected: 'Every actively mapped page has a valid token and webhook subscription',
  describe: (r) => `page ${r.page}: token ${r.token}, subscribed ${r.subscribed} (${r.error}) @ ${r.checkedAt}`,
  fix: 'Re-issue the page token in the Meta console (human action).',
});
check('META-9', 'Ad accounts with a recorded fetch error (1.69.0)', {
  sql: `SELECT ad_account_id, LEFT(last_error,140), last_error_at::text FROM ext.meta_ad_accounts WHERE last_error IS NOT NULL ORDER BY last_error_at DESC`,
  cols: ['account', 'error', 'at'], severity: 'low',
  expected: 'last_error NULL (cleared by the next clean walk)',
  describe: (r) => `${r.account}: ${r.error} @ ${r.at}`,
  fix: 'Campaign fetch cannot read these accounts; review token permissions on /sa/dashboard/meta-ad-accounts.',
});
check('META-10', 'Lead-pull runs stuck in a working state > 30 min (heartbeat stale)', {
  sql: `SELECT id::text, status, COALESCE(heartbeat_at, started_at, created_at)::text FROM scratch.meta_pull_runs
         WHERE status IN ('queued','running','apply_queued','applying') AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - INTERVAL '30 minutes'`,
  cols: ['run', 'status', 'lastBeat'], severity: 'medium',
  expected: 'Working runs heartbeat; a dead worker leaves the run forever "running" and blocks the next pull',
  describe: (r) => `${r.run} ${r.status}, last beat ${r.lastBeat}`,
  fix: 'Check the meta-conversion-api worker; mark the run failed (service action).',
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
