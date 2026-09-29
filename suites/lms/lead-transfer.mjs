// Lead branch-transfer — POST /leads/:id/transfer (454719b "bulk lead and
// branch transfer"), plus the per-lead read endpoints the transfer feeds
// (timeline, assignment-history, form-data) and follow-up ownership.
//
// A transfer runs in a BYPASSRLS service tx (it spans two orgs), so the
// repository's explicit org/tenant checks ARE the security boundary. Reading
// leads.repository.ts transferLead turned up three things this suite pins:
//
//   * "Lead not found or already inactive" and "Target org not found or not in
//     the same tenant" are thrown as plain `new Error(...)` — the error handler
//     only maps AppError/Zod/PG errors, so both surface as 500 instead of
//     404/400. Probed: re-transfer, cross-tenant target, other-branch lead.
//   * The source row is read without FOR UPDATE and the final UPDATE does not
//     re-check is_active, so two concurrent transfers can both mint a lead
//     (suites/concurrency/lms-lead-transfer-race.mjs).
//   * The source lookup is pinned to ctx.org_id — the session's CURRENT branch.
//     A tenant_admin transferring a lead from another branch is probed.
//
// Everything here is a throwaway lead (first_name E2E-xfer-<stamp>), purged
// FK-aware at the end together with the leads the transfers minted.
//
//   node suites/lms/lead-transfer.mjs
import { roleMeta, ROLES, APPS, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch, apiDelete } from '../../conc.mjs';
import { runRoleMatrix } from '../../matrix.mjs';
import { dbReachable, scalar, one, rows, lit } from '../../db.mjs';
import { finder, isOk, purgeById, e2eMarker } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'lms';
const fail = finder(TOOL, 'Lead branch transfer');
const LMS = `${APPS['lms-web']}/api`;
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
if (!fs.existsSync(authFile('tenant_admin'))) { console.log('tenant_admin login needed to seed leads across branches — aborting'); process.exit(0); }

const MARK = `E2E-xfer-${Date.now()}`;
const orgOf = (email) => scalar(`SELECT org_id FROM iam.users WHERE email=${lit(email)}`);
const orgA = orgOf(roleMeta('org_admin').email);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgA)}`);
const otherOrg = (not) => scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tenantA)} AND id<>${lit(not)} AND is_active AND NOT is_deleted ORDER BY name LIMIT 1`);
const orgT = otherOrg(orgA);
const orgB = CROSS_TENANT[0] ? orgOf(CROSS_TENANT[0].email) : null;
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)}`);
if (!orgT) { console.log('Tenant A needs a second active branch to transfer into — aborting'); process.exit(0); }

// Null-safe: a seed that failed must read as 'nothing moved', not as a psql
// uuid-cast error inside matrix verify() (which would be graded as a denial).
const leadRow = (id) => !id ? null : one(`SELECT org_id, is_active::text, superseded_by FROM lms.marketing_leads WHERE id=${lit(id)}`);
let seq = 0;
const phone = () => `+9198${String(Date.now()).slice(-6)}${String(seq++ % 100).padStart(2, '0')}`;

const seeder = await actor('tenant_admin');
async function seedLead(orgId, extra = {}) {
  const tag = `${MARK}-${seq}`;
  const r = await apiPost(seeder, `${LMS}/leads`, { first_name: tag, last_name: 'Transfer', phone: phone(), org_id: orgId, ...extra });
  const id = r.body?.data?.id ?? scalar(`SELECT id FROM lms.marketing_leads WHERE first_name=${lit(tag)} ORDER BY created_at DESC LIMIT 1`);
  return { id, status: r.status, body: r.body };
}
const minted = (srcId) => !srcId ? null : scalar(`SELECT dest_lead_id FROM lms.lead_links WHERE source_lead_id=${lit(srcId)} AND link_type='transfer' ORDER BY created_at DESC LIMIT 1`);

const probe = await seedLead(orgA);
if (!probe.id) {
  fail('high', 'tenant_admin', 'Create a lead in a chosen branch (tenant_admin, org_id in body)', '201', `HTTP ${probe.status}`, JSON.stringify(probe.body).slice(0, 300), 'tenant_admin may target any org in its tenant (createLeadSchema org_id; RLS tenant policy WITH CHECK). A 500 here is usually the lms_svc RLS policy gap — see rls-policies-need-service-logins-named.');
  await seeder.close();
  process.exit(0);
}

const others = {};
try {
  // ── 1. Capability matrix: lms.leads.transfer, each role on a lead in ITS branch ──
  console.log('— transfer a lead to another branch (lms.leads.transfer) —');
  const perRole = {};
  await runRoleMatrix({
    tool: TOOL, action: 'transfer a lead to another branch', endpoint: 'POST /leads/:id/transfer', area: 'Leads', tab: 'Transfer',
    capability: 'lms.leads.transfer',
    act: async (a, role) => {
      const home = orgOf(roleMeta(role).email);
      const lead = await seedLead(home);
      perRole[role] = lead.id;
      return apiPost(a, `${LMS}/leads/${lead.id}/transfer`, { target_org_id: otherOrg(home), notes: 'e2e matrix' });
    },
    verify: (role) => leadRow(perRole[role])?.[1] === 'false' && !!minted(perRole[role]),
  });

  // ── 2. Happy path in detail (org_admin) ────────────────────────────────────
  const admin = await actor('org_admin');
  others.admin = admin;
  const L = await seedLead(orgA);
  const t = await apiPost(admin, `${LMS}/leads/${L.id}/transfer`, { target_org_id: orgT, notes: 'e2e happy path' });
  const src = leadRow(L.id); const dest = minted(L.id); const destRow = dest ? leadRow(dest) : null;
  const srcStage = scalar(`SELECT s.name FROM lms.marketing_leads l JOIN lms.lead_stage s ON s.id=l.stage_id WHERE l.id=${lit(L.id)}`);
  console.log(`2. org_admin transfer http=${t.status} src.active=${src?.[1]} src.stage=${srcStage} dest=${!!dest} dest.org=${destRow?.[0] === orgT}`);
  if (isOk(t.status)) {
    if (!dest || destRow?.[0] !== orgT) fail('high', 'org_admin', 'Transfer returns 2xx but no lead exists in the target branch', `A new lms.marketing_leads row in org ${orgT} + a lms.lead_links transfer row`, `dest=${dest} destOrg=${destRow?.[0]}`, L.id, 'The insert + link + source update must commit together.');
    if (src?.[1] !== 'false' || srcStage !== 'transferred_out' || src?.[2] !== dest) fail('high', 'org_admin', 'The source lead is not closed out after a transfer', 'is_active=false, stage=transferred_out, superseded_by=<new lead>', `is_active=${src?.[1]} stage=${srcStage} superseded_by=${src?.[2]}`, L.id, 'Check the final UPDATE in leads.repository transferLead.');
    if (dest) {
      for (const [p, lbl] of [['timeline', 'timeline'], ['assignment-history', 'assignment history'], ['form-data', 'form data']]) {
        const r = await apiGet(admin, `${LMS}/leads/${L.id}/${p}`);
        if (r.status >= 500) fail('high', 'org_admin', `GET /leads/:id/${p} 5xxs on a transferred-out lead`, '2xx or a clean 404', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), `The ${lbl} read must tolerate an inactive/superseded lead.`);
      }
    }
  } else {
    fail('high', 'org_admin', 'org_admin cannot transfer an in-branch lead to a sibling branch', '2xx', `HTTP ${t.status}`, JSON.stringify(t.body).slice(0, 250), 'Check the lms.leads.transfer grant for org_admin and the lms_svc RLS policies on lms.lead_links / lms.marketing_leads.');
  }

  // ── 3. Error mapping — every refusal must be a clean 4xx ──────────────────
  const refusal = async (label, a, leadId, target, who, sevIfOk) => {
    const r = await apiPost(a, `${LMS}/leads/${leadId}/transfer`, { target_org_id: target });
    const moved = leadId && leadRow(leadId)?.[1] === 'false' && minted(leadId);
    console.log(`3. ${label.padEnd(46)} http=${r.status}`);
    if (isOk(r.status)) fail(sevIfOk, who, `Transfer allowed: ${label}`, 'Refused with 4xx and no lead minted', `HTTP ${r.status}${moved ? ', lead moved' : ''}`, JSON.stringify(r.body).slice(0, 200), 'Keep the org and tenant boundary checks in transferLead; this path runs under withServiceTx so RLS will not catch it.');
    else if (r.status >= 500) fail('high', who, `Transfer ${label} returns 500 instead of a 4xx`, '400/404 with a readable message', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'leads.repository.ts transferLead throws plain `new Error(...)` for "Lead not found or already inactive" / "Target org not found or not in the same tenant"; throw NotFoundError / BadRequestError instead so the error handler maps them.');
  };
  const same = await seedLead(orgA);
  await refusal('to the SAME branch', admin, same.id, orgA, 'org_admin', 'medium');
  if (isOk(t.status)) await refusal('of an already-transferred lead', admin, L.id, orgT, 'org_admin', 'high');
  await refusal('of a non-existent lead id', admin, '00000000-0000-4000-8000-000000000000', orgT, 'org_admin', 'medium');
  if (orgB) { const x = await seedLead(orgA); await refusal('to ANOTHER TENANT\'s branch', admin, x.id, orgB, 'org_admin', 'critical'); }
  const foreignBranch = await seedLead(orgT);
  await refusal('of a lead in ANOTHER branch (org-scoped admin)', admin, foreignBranch.id, otherOrg(orgT) === orgA ? orgA : otherOrg(orgT), 'org_admin', 'high');
  const bKey = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)))?.stateKey;
  if (bKey) {
    const b = await actor(bKey); others.b = b;
    const x = await seedLead(orgA);
    await refusal('of a tenant-A lead BY a tenant-B user', b, x.id, orgB, bKey, 'critical');
  }

  // ── 3b. tenant_admin moving a lead that sits outside its current branch ────
  const ta = seeder;
  const remote = await seedLead(orgT);
  const rt = await apiPost(ta, `${LMS}/leads/${remote.id}/transfer`, { target_org_id: orgA });
  console.log(`3b. tenant_admin transfers a lead from a non-current branch http=${rt.status}`);
  if (!isOk(rt.status)) fail(rt.status >= 500 ? 'high' : 'medium', 'tenant_admin', 'tenant_admin cannot transfer a lead that lives outside its current branch', '2xx — tenant-wide roles cover every branch (All branches mode)', `HTTP ${rt.status}`, JSON.stringify(rt.body).slice(0, 200), 'transferLead reads the source with `org_id = ctx.org_id`; for a tenant-wide actor resolve the lead\'s real org (as resolveLeadWriteScope does for interactions) and assert it is in ctx.tenant_id instead.');

  // ── 4. Follow-up ownership: write must not exceed read ─────────────────────
  if (repId && fs.existsSync(authFile('rep2'))) {
    const rep = await actor('sales_representative'); others.rep = rep;
    const rep2 = await actor('rep2'); others.rep2 = rep2;
    const own = await seedLead(orgA, { assigned_user_id: repId });
    const fu = await apiPost(rep, `${LMS}/leads/${own.id}/follow-ups`, { scheduled_at: new Date(Date.now() + 86400000).toISOString(), notes: 'e2e' });
    const fuId = fu.body?.data?.id ?? scalar(`SELECT id FROM lms.lead_follow_ups WHERE lead_id=${lit(own.id)} ORDER BY created_at DESC LIMIT 1`);
    if (fuId) {
      const canRead = isOk((await apiGet(rep2, `${LMS}/leads/${own.id}`)).status);
      const p = await apiPatch(rep2, `${LMS}/leads/${own.id}/follow-ups/${fuId}`, { notes: 'edited by another rep' });
      const d = await apiDelete(rep2, `${LMS}/leads/${own.id}/follow-ups/${fuId}`);
      console.log(`4. rep2 on rep1's follow-up: read lead=${canRead} patch=${p.status} delete=${d.status}`);
      if (!canRead && (isOk(p.status) || isOk(d.status))) fail('high', 'sales_representative (rep2)', 'A rep edits/deletes a follow-up on a lead they cannot even read', 'Same visibility for writes as for reads (403/404)', `patch=${p.status} delete=${d.status}`, `lead=${own.id} followUp=${fuId}`, 'Resolve the follow-up\'s lead through the same visibility scope as GET /leads/:id before updating (resolveLeadWriteScope).');
    } else console.log(`4. could not create a follow-up (http=${fu.status}) — ownership probe skipped`);
  }
} finally {
  for (const a of Object.values(others)) await a.close().catch(() => {});
  await seeder.close();
  const ids = rows(`SELECT id FROM lms.marketing_leads WHERE first_name LIKE ${lit(`${MARK}-%`)}`, ['id']).map((r) => r.id);
  let n = 0;
  for (const id of ids) { if (purgeById('lms.marketing_leads', id) !== 'kept') n++; }
  console.log(`\npurged ${n}/${ids.length} throwaway lead(s) (sources + transfer copies).`);
}
