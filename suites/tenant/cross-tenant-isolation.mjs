// Cross-tenant isolation — can tenant B see or touch tenant A's data?
//
// Everything else in this harness runs inside ONE tenant, so it can only prove
// role boundaries. This logs in as a second tenant (MSquare Professionals) and
// attacks the first (FitClass) four ways:
//
//   1. LIST SCOPING   — every row returned by a list endpoint must belong to the
//      caller's own tenant. Each returned id is checked against the database, so
//      a leak is proven by data, not inferred from counts.
//   2. IDOR READ      — fetch tenant A's lead / task / leave request by its real
//      id. Must 403/404, and the body must not contain the record.
//   3. IDOR WRITE     — PATCH tenant A's record. Must fail AND leave the row
//      byte-identical (checked before/after in the DB) — a "failed" write that
//      still mutated is the worst outcome.
//   4. CAPABILITY SCOPE — a capability override applied to tenant A must not
//      change what the same role holds in tenant B.
//
// A control is included on purpose: super_admin is SUPPOSED to see across
// tenants. If the suite reported everything as denied it would pass even with a
// broken check, so we assert the platform superuser still has reach.
//
//   node suites/tenant/cross-tenant-isolation.mjs
import { APPS, cfg, record, authFile, CROSS_TENANT, primaryTenant, otherTenant } from '../../lib.mjs';
import { actor, apiGet, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import {
  tenantIdForOrg, resolvedCapabilities, setOverride, restoreAll, loadJournal,
} from '../../capability.mjs';
import fs from 'node:fs';

const TOOL = 'tenant';
const LMS = APPS['lms-web'];
const TODO = APPS['todo-web'];
const HR = APPS['hr-web'];
const GATEWAY = cfg.gateway;

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const A = primaryTenant();
const B = otherTenant();
if (!A || !B) { console.log('Need two tenants configured in roles.json — aborting'); process.exit(0); }

const tenantAId = tenantIdForOrg(A.org);
const tenantBId = tenantIdForOrg(B.org);
console.log(`tenant A = ${A.name} (${tenantAId})`);
console.log(`tenant B = ${B.name} (${tenantBId})\n`);

// ── tenant A records to attack ─────────────────────────────────────────────
const aLead = rows(
  `SELECT l.id, COALESCE(l.last_name,'') FROM lms.marketing_leads l
   JOIN entity.organizations o ON o.id=l.org_id
   WHERE o.tenant_id=${lit(tenantAId)}::uuid AND l.is_active AND NOT l.is_deleted
   ORDER BY l.created_at DESC LIMIT 1`, ['id', 'last_name'])[0];

const aTask = rows(
  `SELECT t.id, t.title FROM task.tasks t
   JOIN entity.organizations o ON o.id=t.org_id
   WHERE o.tenant_id=${lit(tenantAId)}::uuid AND NOT t.is_deleted
   ORDER BY t.created_at DESC LIMIT 1`, ['id', 'title'])[0];

const aLeave = rows(
  `SELECT lr.id FROM hr.leave_requests lr
   JOIN entity.organizations o ON o.id=lr.org_id
   WHERE o.tenant_id=${lit(tenantAId)}::uuid AND NOT lr.is_deleted
   ORDER BY lr.created_at DESC LIMIT 1`, ['id'])[0];

console.log(`tenant A targets: lead=${aLead?.id ?? '-'} task=${aTask?.id ?? '-'} leave=${aLeave?.id ?? '-'}\n`);

// Which tenant does a given entity id belong to? Used to prove list leakage.
const tenantOfLead = (id) => scalar(
  `SELECT o.tenant_id FROM lms.marketing_leads l JOIN entity.organizations o ON o.id=l.org_id WHERE l.id=${lit(id)}`);
const tenantOfTask = (id) => scalar(
  `SELECT o.tenant_id FROM task.tasks t JOIN entity.organizations o ON o.id=t.org_id WHERE t.id=${lit(id)}`);

// Pull ids out of whatever envelope the API used.
function idsFrom(body) {
  const arr = body?.data?.items ?? body?.data?.rows ?? body?.data ?? body?.items ?? body;
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => x?.id).filter(Boolean);
}

const leaks = [];

// ── 1 + 2 + 3: run the attack set as each tenant-B actor ───────────────────
for (const cta of CROSS_TENANT) {
  if (!fs.existsSync(authFile(cta.stateKey))) { console.log(`skip ${cta.stateKey} (no auth state)`); continue; }
  console.log(`=== ${cta.stateKey} (${cta.role}, ${cta.tenant}) ===`);
  const b = await actor(cta.stateKey);
  try {
    // ---- 1. list scoping ----
    for (const [label, url, tenantOf] of [
      ['leads', `${LMS}/api/leads?page=1&page_size=50`, tenantOfLead],
      ['tasks', `${TODO}/api/tasks?page=1&page_size=50`, tenantOfTask],
    ]) {
      const res = await apiGet(b, url);
      const ids = idsFrom(res.body);
      const foreign = ids.filter((id) => { const t = tenantOf(id); return t && t !== tenantBId; });
      console.log(`  list ${label}: http=${res.status} rows=${ids.length} foreign=${foreign.length}`);
      if (foreign.length) {
        leaks.push({ actor: cta.stateKey, kind: 'list', label, count: foreign.length });
        record(TOOL, {
          severity: 'critical', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
          page: `Cross-tenant list scoping — ${url}`,
          scenario: `${cta.stateKey} lists ${label} and receives rows owned by another tenant`,
          expected: `Every row returned belongs to the caller's tenant (${B.name}); another tenant's records must never appear`,
          actual: `${foreign.length} of ${ids.length} returned ${label} belong to a different tenant. Example ids: ${foreign.slice(0, 5).join(', ')}`,
          evidence: `actor=${cta.email} tenant=${tenantBId}; foreign ids=${JSON.stringify(foreign.slice(0, 10))}`,
          proposedSolution: 'Scope this query by the caller\'s tenant_id (via org join) in the repository layer, and back it with an RLS policy so a missed WHERE cannot leak across tenants.',
        });
      }
    }

    // ---- 2. IDOR read ----
    const reads = [
      ['lead', aLead && `${LMS}/api/leads/${aLead.id}`, aLead?.last_name],
      ['task', aTask && `${TODO}/api/tasks/${aTask.id}`, aTask?.title],
      ['leave request', aLeave && `${HR}/api/hr/leave/requests/${aLeave.id}`, null],
    ];
    for (const [label, url, marker] of reads) {
      if (!url) continue;
      const res = await apiGet(b, url);
      const bodyStr = JSON.stringify(res.body ?? '');
      const exposed = res.status >= 200 && res.status < 300 &&
        (marker ? bodyStr.includes(marker) : bodyStr.length > 40);
      console.log(`  read ${label} of tenant A: http=${res.status} exposed=${exposed}`);
      if (exposed) {
        leaks.push({ actor: cta.stateKey, kind: 'idor-read', label });
        record(TOOL, {
          severity: 'critical', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
          page: `Cross-tenant direct read — ${url}`,
          scenario: `${cta.stateKey} fetches a ${label} belonging to ${A.name} by its id`,
          expected: 'A record from another tenant is not readable: 403 or 404, with no record data in the body',
          actual: `HTTP ${res.status} returned the record${marker ? ` (contains "${marker}")` : ''} — a user of ${B.name} can read ${A.name}'s data given an id.`,
          evidence: `actor=${cta.email} url=${url} status=${res.status} body=${bodyStr.slice(0, 250)}`,
          proposedSolution: 'Enforce tenant scoping on the by-id lookup (WHERE id = :id AND org.tenant_id = :callerTenant) rather than fetching by primary key alone; return 404 so ids are not enumerable.',
        });
      }
    }

    // ---- 3. IDOR write (must fail AND not mutate) ----
    if (aLead) {
      const before = scalar(`SELECT COALESCE(last_name,'') FROM lms.marketing_leads WHERE id=${lit(aLead.id)}`);
      const res = await apiPatch(b, `${LMS}/api/leads/${aLead.id}`, { last_name: `XT-${cta.stateKey}` });
      await new Promise((r) => setTimeout(r, 300));
      const after = scalar(`SELECT COALESCE(last_name,'') FROM lms.marketing_leads WHERE id=${lit(aLead.id)}`);
      const mutated = before !== after;
      console.log(`  write lead of tenant A: http=${res.status} mutated=${mutated}`);
      if (mutated) {
        // Put it back immediately — we just corrupted another tenant's row.
        q(`UPDATE lms.marketing_leads SET last_name=${lit(before)} WHERE id=${lit(aLead.id)}`);
        leaks.push({ actor: cta.stateKey, kind: 'idor-write', label: 'lead' });
        record(TOOL, {
          severity: 'critical', role: `${cta.role} @ ${cta.tenant}`, tool: TOOL,
          page: `Cross-tenant write — PATCH /api/leads/:id`,
          scenario: `${cta.stateKey} PATCHes a lead owned by ${A.name}`,
          expected: 'The write is rejected and the other tenant\'s row is untouched',
          actual: `HTTP ${res.status} and the row CHANGED ("${before}" -> "${after}"). A user of ${B.name} can modify ${A.name}'s records. (The suite restored the original value.)`,
          evidence: `actor=${cta.email} leadId=${aLead.id} before="${before}" after="${after}"`,
          proposedSolution: 'Apply the tenant predicate to the UPDATE itself (UPDATE ... WHERE id=:id AND org.tenant_id=:callerTenant) and add an RLS policy on lms.marketing_leads so a cross-tenant write cannot commit even if the service check is missed.',
        });
      }
    }
  } finally {
    await b.close();
  }
  console.log('');
}

// ── control: super_admin SHOULD reach across tenants ───────────────────────
// Without this, a totally broken (deny-everything) API would look like perfect
// isolation.
if (fs.existsSync(authFile('super_admin')) && aLead) {
  const sa = await actor('super_admin');
  try {
    const res = await apiGet(sa, `${LMS}/api/leads/${aLead.id}`);
    const reach = res.status >= 200 && res.status < 300;
    console.log(`control: super_admin read tenant A lead -> http=${res.status} (expected reachable)`);
    if (!reach) {
      record(TOOL, {
        severity: 'low', role: 'super_admin', tool: TOOL,
        page: 'Cross-tenant control probe',
        scenario: 'super_admin (platform superuser) reads a lead in the primary tenant',
        expected: 'The platform superuser can read across tenants — this probe exists to prove the isolation checks are discriminating, not blanket-denying',
        actual: `super_admin got HTTP ${res.status}. Either the superuser lost cross-tenant reach, or the API denies everything — in which case the isolation results above are not meaningful.`,
        evidence: `leadId=${aLead.id} status=${res.status}`,
        proposedSolution: 'Confirm super_admin retains platform scope; if this is intentional, re-baseline the cross-tenant suite so its negative results stay meaningful.',
      });
    }
  } finally { await sa.close(); }
}

// ── 4. capability overrides must not cross tenants ─────────────────────────
// The capability engine writes TENANT-scoped rows; this proves that scoping is
// real — revoking for a role in tenant A must leave tenant B untouched.
console.log('\n=== capability override scoping ===');
loadJournal();
const CAP = 'lms.followups';
const ROLE = 'org_admin';
try {
  const aBefore = resolvedCapabilities(tenantAId, ROLE).get(CAP);
  const bBefore = resolvedCapabilities(tenantBId, ROLE).get(CAP);
  console.log(`  before: A=${aBefore} B=${bBefore}`);
  if (aBefore && bBefore) {
    setOverride(tenantAId, ROLE, CAP, false);
    const aAfter = resolvedCapabilities(tenantAId, ROLE).get(CAP);
    const bAfter = resolvedCapabilities(tenantBId, ROLE).get(CAP);
    console.log(`  after revoke in A: A=${aAfter} B=${bAfter}`);
    if (bAfter !== true) {
      record(TOOL, {
        severity: 'high', role: ROLE, tool: TOOL, page: `capability ${CAP} tenant scoping`,
        scenario: `Revoke '${CAP}' for ${ROLE} in ${A.name} and re-resolve the same role in ${B.name}`,
        expected: `A tenant-scoped override changes only that tenant; ${B.name} keeps the capability`,
        actual: `Revoking in ${A.name} also removed the capability in ${B.name} (B granted=${bAfter}) — capability overrides bleed across tenants.`,
        evidence: `cap=${CAP} role=${ROLE} tenantA=${tenantAId} tenantB=${tenantBId}`,
        proposedSolution: 'Check the tenant predicate in iam.fn_role_capability_matrix and the uniqueness/override rows — a tenant override must be filtered by tenant_id, never applied globally.',
      });
    } else {
      console.log('  OK: override stayed inside tenant A');
    }
  } else {
    console.log('  skipped (role does not hold the capability in both tenants at baseline)');
  }
} finally {
  const n = restoreAll();
  if (n) console.log(`  [cleanup] restored ${n} override(s)`);
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${leaks.length} cross-tenant leak(s) detected.`);
for (const l of leaks) console.log(`  ${l.actor}: ${l.kind} ${l.label}${l.count ? ` (${l.count} rows)` : ''}`);
if (!leaks.length) console.log('  No cross-tenant data exposure found in the probed surfaces.');
