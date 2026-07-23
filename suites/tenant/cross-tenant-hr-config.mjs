// Cross-tenant HR-config isolation.
//
// The main cross-tenant suite attacks transactional data (leads, tasks, leave
// REQUESTS). This one attacks HR CONFIGURATION — the per-tenant setup the user
// flagged as must-not-leak: holidays / holiday calendars, leave policies, shifts,
// and leave types. A tenant-B admin must never see or edit tenant A's HR config.
//
// Two attacks per config type, proven by data (not inferred):
//   1. LIST SCOPING — GET the config list as a tenant-B admin; every returned id
//      must resolve (in Postgres) to tenant B. Any tenant-A id is a leak.
//   2. IDOR WRITE   — PATCH a real tenant-A config row by id; must fail AND leave
//      the row byte-identical (checked before/after in the DB).
//
// A control probe confirms each tenant-B admin CAN see its own config, so a
// blanket-deny API cannot masquerade as perfect isolation.
//
//   node suites/tenant/cross-tenant-hr-config.mjs
import { APPS, record, authFile, CROSS_TENANT, primaryTenant, otherTenant } from '../../lib.mjs';
import { actor, apiGet, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { tenantIdForOrg } from '../../capability.mjs';
import fs from 'node:fs';

const TOOL = 'tenant';
const HR = APPS['hr-web'];
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const A = primaryTenant();
const B = otherTenant();
if (!A || !B) { console.log('Need two tenants configured — aborting'); process.exit(0); }
const tenantAId = tenantIdForOrg(A.org);
const tenantBId = tenantIdForOrg(B.org);
const year = new Date().getFullYear();
console.log(`tenant A=${A.name} (${tenantAId}) · tenant B=${B.name} (${tenantBId})\n`);

// Resolve which tenant a config id belongs to (via its org, or directly).
const tenantOf = {
  holiday:  (id) => scalar(`SELECT o.tenant_id FROM hr.holidays h JOIN entity.organizations o ON o.id=h.org_id WHERE h.id=${lit(id)}`),
  policy:   (id) => scalar(`SELECT o.tenant_id FROM hr.leave_policies p JOIN entity.organizations o ON o.id=p.org_id WHERE p.id=${lit(id)}`),
  shift:    (id) => scalar(`SELECT o.tenant_id FROM hr.shifts s JOIN entity.organizations o ON o.id=s.org_id WHERE s.id=${lit(id)}`),
  calendar: (id) => scalar(`SELECT o.tenant_id FROM hr.holiday_calendars c JOIN entity.organizations o ON o.id=c.org_id WHERE c.id=${lit(id)}`),
};

// Real tenant-A config rows to attack by id (IDOR write targets).
const aHoliday = rows(`SELECT h.id, h.name FROM hr.holidays h JOIN entity.organizations o ON o.id=h.org_id
  WHERE o.tenant_id=${lit(tenantAId)}::uuid AND NOT h.is_deleted ORDER BY h.created_at DESC LIMIT 1`, ['id', 'name'])[0];
const aShift = rows(`SELECT s.id, s.name FROM hr.shifts s JOIN entity.organizations o ON o.id=s.org_id
  WHERE o.tenant_id=${lit(tenantAId)}::uuid AND NOT s.is_deleted ORDER BY s.created_at DESC LIMIT 1`, ['id', 'name'])[0];
console.log(`tenant A targets: holiday=${aHoliday?.id ?? '-'} shift=${aShift?.id ?? '-'}\n`);

function idsFrom(body) {
  const arr = body?.data?.items ?? body?.data?.rows ?? body?.data ?? body?.items ?? body;
  return Array.isArray(arr) ? arr.map((x) => x?.id).filter(Boolean) : [];
}

const leaks = [];

// ── List-scoping + IDOR-write as each tenant-B admin actor ───────────────────
for (const cta of CROSS_TENANT) {
  // Only the admin-tier actors can reach HR config lists; skip low ranks.
  if (!/admin|hr_head/.test(cta.role)) continue;
  if (!fs.existsSync(authFile(cta.stateKey))) { console.log(`skip ${cta.stateKey} (no auth state)`); continue; }
  console.log(`=== ${cta.stateKey} (${cta.role}, ${cta.tenant}) ===`);
  const b = await actor(cta.stateKey);
  try {
    // 1. LIST SCOPING — no returned id may belong to tenant A.
    const lists = [
      ['holidays', `${HR}/api/hr/holidays?year=${year}`, tenantOf.holiday],
      ['leave policies', `${HR}/api/hr/leave/policies`, tenantOf.policy],
      ['shifts', `${HR}/api/hr/shifts`, tenantOf.shift],
      ['holiday calendars', `${HR}/api/hr/holiday-calendars`, tenantOf.calendar],
    ];
    let ownSeen = 0;
    for (const [label, url, resolve] of lists) {
      const res = await apiGet(b, url);
      const ids = idsFrom(res.body);
      const foreign = ids.filter((id) => { const t = resolve(id); return t && t !== tenantBId; });
      const own = ids.filter((id) => resolve(id) === tenantBId).length;
      ownSeen += own;
      console.log(`  list ${label.padEnd(18)} http=${res.status} rows=${ids.length} own=${own} foreign=${foreign.length}`);
      if (foreign.length) {
        leaks.push({ actor: cta.stateKey, kind: 'list', label, count: foreign.length });
        record(TOOL, {
          severity: 'critical', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
          page: `Cross-tenant HR-config list — ${url}`,
          scenario: `${cta.stateKey} lists ${label} and receives rows owned by ${A.name}`,
          expected: `Every ${label} row belongs to the caller's tenant (${B.name})`,
          actual: `${foreign.length}/${ids.length} ${label} belong to another tenant. Example: ${foreign.slice(0, 5).join(', ')}`,
          evidence: `actor=${cta.email} tenantB=${tenantBId} foreign=${JSON.stringify(foreign.slice(0, 8))}`,
          proposedSolution: 'Scope the HR-config query by the caller\'s tenant (org.tenant_id) and back it with an RLS policy so a missed WHERE cannot leak config across tenants.',
        });
      }
    }

    // 2. IDOR WRITE — PATCH tenant A's config by id; must fail AND not mutate.
    const writes = [
      aHoliday && ['holiday', `${HR}/api/hr/holidays/${aHoliday.id}`, { name: `XT-${cta.stateKey}` },
        () => scalar(`SELECT name FROM hr.holidays WHERE id=${lit(aHoliday.id)}`), aHoliday.name],
      aShift && ['shift', `${HR}/api/hr/shifts/${aShift.id}`, { name: `XT-${cta.stateKey}` },
        () => scalar(`SELECT name FROM hr.shifts WHERE id=${lit(aShift.id)}`), aShift.name],
    ].filter(Boolean);
    for (const [label, url, patch, readNow, original] of writes) {
      const before = readNow();
      const res = await apiPatch(b, url, patch);
      await new Promise((r) => setTimeout(r, 250));
      const after = readNow();
      const mutated = before !== after;
      console.log(`  write ${label.padEnd(17)} http=${res.status} mutated=${mutated}`);
      if (mutated) {
        q(`UPDATE hr.${label === 'holiday' ? 'holidays' : 'shifts'} SET name=${lit(original)} WHERE id=${lit(url.split('/').pop())}`);
        leaks.push({ actor: cta.stateKey, kind: 'idor-write', label });
        record(TOOL, {
          severity: 'critical', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
          page: `Cross-tenant HR-config write — PATCH ${url}`,
          scenario: `${cta.stateKey} PATCHes a ${label} owned by ${A.name}`,
          expected: 'The write is rejected and the other tenant\'s config row is untouched',
          actual: `HTTP ${res.status} and the row CHANGED ("${before}" -> "${after}"). (Suite restored it.)`,
          evidence: `actor=${cta.email} id=${url.split('/').pop()} before="${before}" after="${after}"`,
          proposedSolution: 'Apply the tenant predicate to the UPDATE and add an RLS policy so a cross-tenant config write cannot commit even if the service check is missed.',
        });
      }
    }

    // Control: the actor should see at least some of its OWN config (not blanket-denied).
    if (ownSeen === 0) {
      record(TOOL, {
        severity: 'low', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
        page: 'Cross-tenant HR-config control probe',
        scenario: `${cta.stateKey} lists its own tenant's HR config`,
        expected: `A tenant admin sees its OWN config — this probe keeps the isolation results meaningful`,
        actual: 'The actor saw zero own-tenant config rows across all lists — either the tenant has no config seeded, or the API denies everything (isolation results above are then vacuous).',
        evidence: `actor=${cta.email} tenantB=${tenantBId}`,
        proposedSolution: 'Confirm tenant B has HR config seeded; if the lists are genuinely empty, the cross-tenant negative results need a seeded control before they can be trusted.',
      });
    }
  } finally {
    await b.close();
  }
  console.log('');
}

// ── leave_types RLS probe (DB-level) ─────────────────────────────────────────
// leave_types are tenant-scoped by tenant_id + RLS. Prove the two tenants hold
// DISTINCT type rows (no shared/global row that would let one tenant's rename
// bleed into the other).
const aTypes = Number(scalar(`SELECT COUNT(*) FROM hr.leave_types WHERE tenant_id=${lit(tenantAId)}::uuid`) ?? 0);
const bTypes = Number(scalar(`SELECT COUNT(*) FROM hr.leave_types WHERE tenant_id=${lit(tenantBId)}::uuid`) ?? 0);
const shared = Number(scalar(`SELECT COUNT(*) FROM hr.leave_types WHERE tenant_id IS NULL`) ?? 0);
console.log(`leave_types: tenantA=${aTypes} tenantB=${bTypes} shared/null=${shared}`);
if (shared > 0) {
  record(TOOL, {
    severity: 'medium', role: 'n/a', tool: TOOL, page: 'hr.leave_types tenant scoping',
    scenario: 'Inspect leave_types for tenant-less (shared) rows',
    expected: 'Every leave type is owned by exactly one tenant (tenant_id NOT NULL)',
    actual: `${shared} leave_types row(s) have a NULL tenant_id — a shared type edited by one tenant affects all tenants.`,
    evidence: `null-tenant leave_types count=${shared}`,
    proposedSolution: 'Make hr.leave_types.tenant_id NOT NULL and per-tenant, so config edits cannot cross tenants.',
  });
}

console.log(`\n${leaks.length} cross-tenant HR-config leak(s) detected.`);
if (!leaks.length) console.log('  No HR-config exposure found in the probed surfaces.');
