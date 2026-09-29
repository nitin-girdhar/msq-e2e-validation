// Provision the read_only fixture users (one per tenant).
//
// The production-refresh data has NO active read_only user, so the bottom of
// the role ladder (rank 0) had zero real-user coverage in every earlier run.
// This creates one per tenant THROUGH THE PRODUCT (tenant_admin -> POST /users
// with an org_assignments row carrying the tenant's read_only role_id), so the
// user gets exactly what a real one gets: iam.user_org_mapping, the HR profile
// sync, capability resolution through iam.fn_role_capability_matrix.
//
// Then — local DB only, same as every other harness login (roles.json _note) —
// it copies the dev password hash from the tenant_admin and clears
// force_password_change so auth-setup can log in.
//
// Persistent by design (idempotent: existing users are only re-activated), and
// deliberately NOT @e2e.local, which restore --purge-residue and data-health
// treat as throwaway residue.
//
//   node provision-readonly.mjs
import { cfg } from './lib.mjs';
import { freshLogin, apiPost } from './conc.mjs';
import { dbReachable, scalar, q, lit } from './db.mjs';

if (!dbReachable()) { console.log('provision-readonly: DB not reachable — skipped'); process.exit(0); }

const targets = [];
const tA = cfg.roles.find((r) => r.role === 'tenant_admin');
if (tA) targets.push({ admin: tA.email, org: cfg.tenants.find((t) => t.primary)?.org ?? tA.org, email: 'readonly.fitclass@e2e-fixture.test' });
const tB = (cfg.crossTenantActors ?? []).find((r) => r.role === 'tenant_admin');
if (tB && process.env.E2E_READONLY_TENANT_B === '1') targets.push({ admin: tB.email, org: tB.org, email: 'readonly.msq@e2e-fixture.test' });

let failed = 0;
for (const t of targets) {
  const orgId = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(t.org)} AND NOT is_deleted LIMIT 1`);
  const tenantId = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgId)}`);
  const roleId = scalar(`SELECT id FROM iam.user_roles WHERE name='read_only' AND is_active AND (tenant_id=${lit(tenantId)}::uuid OR tenant_id IS NULL)
    ORDER BY tenant_id NULLS LAST LIMIT 1`);
  if (!orgId || !roleId) { console.log(`provision-readonly: ${t.email}: org/role not found (org=${orgId} role=${roleId})`); failed++; continue; }

  let userId = scalar(`SELECT id FROM iam.users WHERE email=${lit(t.email)} AND NOT is_deleted LIMIT 1`);
  if (!userId) {
    const s = await freshLogin(t.admin);
    try {
      const r = await apiPost(s, `${cfg.apps['auth-web']}/api/users`, {
        first_name: 'E2E', last_name: 'ReadOnly', email: t.email,
        org_assignments: [{ org_id: orgId, role_id: roleId }], home_org_id: orgId,
        force_password_change: false, send_email_notification: false,
      });
      userId = r.body?.data?.id ?? scalar(`SELECT id FROM iam.users WHERE email=${lit(t.email)} LIMIT 1`);
      console.log(`provision-readonly: create ${t.email} via Team API as ${t.admin} -> HTTP ${r.status}${userId ? '' : ` ${JSON.stringify(r.body).slice(0, 200)}`}`);
    } finally { await s.close(); }
  }
  if (!userId) { failed++; continue; }
  q(`UPDATE iam.users SET password_hash=(SELECT password_hash FROM iam.users WHERE email=${lit(t.admin)}),
       force_password_change=false, is_active=true, password_changed_at=clock_timestamp() - interval '1 minute'
     WHERE id=${lit(userId)}`);
  const mapped = scalar(`SELECT COUNT(*) FROM iam.user_org_mapping WHERE user_id=${lit(userId)} AND role_id=${lit(roleId)} AND is_active`);
  console.log(`provision-readonly: ${t.email} ready (id=${userId}, read_only mappings=${mapped})`);
  if (Number(mapped) === 0) failed++;
}
// Every harness login -> the dev password (LOCAL DB ONLY, same practice as the
// roles.json _note). A production refresh of the local DB brings back real
// hashes and every login but the tenant_admins turns into "stuck-on-login".
// The reference hash is the primary tenant_admin's, which auth-setup proves.
const logins = [...cfg.roles.map((r) => r.email), ...(cfg.secondaryActors ?? []).map((a) => a.email), ...(cfg.crossTenantActors ?? []).map((a) => a.email)];
if (tA) {
  const n = q(`UPDATE iam.users SET password_hash=(SELECT password_hash FROM iam.users WHERE email=${lit(tA.email)}),
       failed_login_attempts=0, locked_until=NULL, force_password_change=false
     WHERE email IN (${logins.map(lit).join(',')}) AND email<>${lit(tA.email)}
       AND password_hash IS DISTINCT FROM (SELECT password_hash FROM iam.users WHERE email=${lit(tA.email)})
     RETURNING email`).filter((r) => r[0]).length;
  console.log(`provision-readonly: harness logins aligned to the dev password: ${n} user(s) reset`);
}
process.exit(failed ? 1 : 0);
