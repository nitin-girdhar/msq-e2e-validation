// Capability toggling engine.
//
// Capabilities live in a tree (tool -> page -> tab -> operation -> scope) in
// iam.capabilities, granted per role in iam.role_capabilities. Resolution is
// iam.fn_role_capability_matrix(tenant): a TENANT-scoped row overrides the
// platform default (tenant_id IS NULL), and page/tab nodes inherit their
// parent's grant unless they carry their own row.
//
// SAFETY — this module mutates authorization config, so it is built to be
// reversible by construction:
//   * it NEVER edits the platform-default rows. It inserts a tenant-scoped
//     OVERRIDE row and removes that row to restore, so the shipped defaults are
//     untouched no matter how a run ends.
//   * every override is tracked in `applied`; call restoreAll() in a finally.
//
// The session is NOT a static token: identity-service re-resolves capabilities
// on login, on /auth/me and on refresh (auth.service.ts), served through an
// in-process cache that a NOTIFY trigger invalidates. So a toggle reaches a
// live user on their next /auth/me — no re-login required — which is exactly
// what makes "did the UI update?" testable.
import { q, scalar, rows, lit } from './db.mjs';
import { cfg, resultsDir } from './lib.mjs';
import { apiGet } from './conc.mjs';
import fs from 'node:fs';
import path from 'node:path';

const GATEWAY = cfg.gateway;

// Track every override we apply so we can always put things back. The list is
// ALSO journalled to disk: if a run is killed mid-toggle, the in-memory array
// dies with it and the tenant would be left with a revoked capability. The
// journal lets a later `--restore-only` put things back from a cold process.
const JOURNAL = path.join(resultsDir, 'capability-overrides.json');
const applied = [];

function persist() {
  try {
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(JOURNAL, JSON.stringify(applied, null, 2));
  } catch {}
}

// Load anything a previous (crashed) run left behind.
export function loadJournal() {
  try {
    if (!fs.existsSync(JOURNAL)) return 0;
    const prior = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (Array.isArray(prior)) { for (const e of prior) applied.push(e); return prior.length; }
  } catch {}
  return 0;
}

export function capabilityId(key) {
  return scalar(`SELECT id FROM iam.capabilities WHERE key=${lit(key)} LIMIT 1`);
}

// Role id for a role name. Global roles carry tenant_id IS NULL; department
// roles are tenant-scoped, so prefer the tenant's row when one exists.
export function roleId(roleName, tenantId) {
  return scalar(
    `SELECT id FROM iam.user_roles WHERE name=${lit(roleName)}
       AND (tenant_id IS NULL OR tenant_id=${lit(tenantId)}::uuid)
     ORDER BY (tenant_id IS NOT NULL) DESC LIMIT 1`
  );
}

export function tenantIdForOrg(orgName) {
  return scalar(
    `SELECT t.id FROM entity.tenants t
     JOIN entity.organizations o ON o.tenant_id=t.id
     WHERE o.name=${lit(orgName)} LIMIT 1`
  );
}

// What the resolver says this role effectively holds, as a Map(key -> granted).
export function resolvedCapabilities(tenantId, roleName) {
  const r = rows(
    `SELECT capability_key, granted FROM iam.fn_role_capability_matrix(${lit(tenantId)}::uuid)
     WHERE role_name=${lit(roleName)}`,
    ['key', 'granted']
  );
  return new Map(r.map((x) => [x.key, x.granted === 't' || x.granted === 'true']));
}

// Insert (or update) a TENANT-scoped override row. Restores are a DELETE of
// exactly this row, so platform defaults are never touched.
export function setOverride(tenantId, roleName, capKey, granted) {
  const rid = roleId(roleName, tenantId);
  const cid = capabilityId(capKey);
  if (!rid || !cid) throw new Error(`cannot resolve role='${roleName}' or capability='${capKey}'`);

  // Remember whether a tenant override already existed, so restore is exact.
  const pre = scalar(
    `SELECT is_granted FROM iam.role_capabilities
     WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`
  );
  applied.push({ tenantId, rid, cid, capKey, roleName, preExisting: pre });
  persist(); // journal BEFORE mutating, so a crash mid-write is still recoverable

  q(`INSERT INTO iam.role_capabilities (tenant_id, role_id, capability_id, is_granted)
     VALUES (${lit(tenantId)}::uuid, ${lit(rid)}::uuid, ${lit(cid)}::uuid, ${granted ? 'TRUE' : 'FALSE'})
     ON CONFLICT (tenant_id, role_id, capability_id) WHERE tenant_id IS NOT NULL
     DO UPDATE SET is_granted=EXCLUDED.is_granted, updated_at=NOW()`);
}

// Put one override back exactly as it was.
export function restoreOne(entry) {
  const { tenantId, rid, cid, preExisting } = entry;
  if (preExisting === null || preExisting === undefined) {
    q(`DELETE FROM iam.role_capabilities
       WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`);
  } else {
    q(`UPDATE iam.role_capabilities SET is_granted=${preExisting === 't' ? 'TRUE' : 'FALSE'}, updated_at=NOW()
       WHERE tenant_id=${lit(tenantId)}::uuid AND role_id=${lit(rid)}::uuid AND capability_id=${lit(cid)}::uuid`);
  }
}

export function restoreAll() {
  let n = 0;
  while (applied.length) { try { restoreOne(applied.pop()); n++; } catch {} persist(); }
  try { if (fs.existsSync(JOURNAL) && applied.length === 0) fs.unlinkSync(JOURNAL); } catch {}
  return n;
}

export const pendingOverrides = () => applied.length;

// ── session view ───────────────────────────────────────────────────────────
// GET {gateway}/auth/me re-resolves capabilities server-side, so this is the
// authoritative "what does the backend think this user can do right now".
export async function sessionCapabilities(a) {
  const res = await apiGet(a, `${GATEWAY}/auth/me`);
  const caps = res.body?.data?.user?.capabilities;
  return { status: res.status, capabilities: Array.isArray(caps) ? caps : null };
}

// Poll /auth/me until the capability reaches `want`, so we can measure (and
// report) how long a grant change takes to become effective rather than
// racing the cache invalidation.
export async function waitForSessionCapability(a, key, want, { timeoutMs = 15000, stepMs = 750 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const s = await sessionCapabilities(a);
    last = s;
    if (s.capabilities && s.capabilities.includes(key) === want) {
      return { ok: true, ms: Date.now() - t0, session: s };
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return { ok: false, ms: Date.now() - t0, session: last };
}
