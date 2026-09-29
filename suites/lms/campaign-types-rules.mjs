// Campaign types + ordered routing rules (13e0237 "campaign types", schema 1.51.0).
//
// A campaign type decides which POOL an inbound lead routes to (sales, hiring,
// ...), and the ordered rules decide which type a Meta lead gets from its
// campaign / form / ad-set / ad name — first match wins. Getting this wrong
// silently mis-routes real leads, so this suite proves, in Postgres:
//
//   1. GATES      — list: lms.campaign_types.view OR lms.leads.view.all_types;
//                   every write: lms.campaign_types.manage. Graded per role
//                   from that role's own /auth/me capabilities (matrix.mjs).
//   2. CRUD       — create/patch a type lands in marketing.campaign_types for
//                   the caller's tenant; deleting a type a rule still uses is a
//                   clean 409, deleting the default type is a clean 400.
//   3. RULES      — create two overlapping rules, /rules/test returns the FIRST
//                   by rule_order; PUT /rules/order flips the winner; the
//                   original order is restored (journalled — rule order routes
//                   real leads, so a crash must not leave it flipped).
//   4. TENANTS    — tenant B cannot list, read, patch, test-match or point a
//                   rule at tenant A's types (critical).
//   5. ?tenant_id — only a super_admin may administer another tenant.
//
//   node suites/lms/campaign-types-rules.mjs
import { roleMeta, GATEWAY, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../../conc.mjs';
import { runRoleMatrix, sessionCaps } from '../../matrix.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, idsOf, purgeById, journalRestore, runRestore, restorePending, e2eMarker } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'lms';
const fail = finder(TOOL, 'Campaign types & routing rules');
const CT = `${GATEWAY}/campaign-types`;
const VIEW = 'lms.campaign_types.view', MANAGE = 'lms.campaign_types.manage', ALL_TYPES = 'lms.leads.view.all_types';
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const pending = restorePending('rules-order');
if (pending.length) console.log(`restored rule order left by a previous run: ${pending.join(', ')}`);

const MARK = e2eMarker('ctype').replace(/-/g, '_');
const tenantA = scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(roleMeta('org_admin').email)}`);
const bKey = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)))?.stateKey ?? null;
const typeRow = (id) => rows(`SELECT tenant_id, label, is_active::text FROM marketing.campaign_types WHERE id=${lit(id)}`, ['tenant', 'label', 'active'])[0];
const liveRuleIds = () => rows(`SELECT id FROM marketing.campaign_type_rules WHERE tenant_id=${lit(tenantA)} AND NOT is_deleted ORDER BY rule_order, created_at`, ['id']).map((r) => r.id);
const created = { types: [], rules: [] };

// ── 1. Gates, graded by each role's live capabilities ──────────────────────
console.log('— list campaign types (view | view.all_types) —');
await runRoleMatrix({
  tool: TOOL, action: 'list campaign types', endpoint: 'GET /campaign-types', area: 'Campaign types',
  capability: [VIEW, ALL_TYPES], act: (a) => apiGet(a, CT),
});
console.log('\n— create a campaign type (manage) —');
await runRoleMatrix({
  tool: TOOL, action: 'create a campaign type', endpoint: 'POST /campaign-types', area: 'Campaign types',
  capability: MANAGE, severityOver: 'high',
  act: (a, role) => apiPost(a, CT, { name: `${MARK}_${role}`.slice(0, 80), label: `E2E ${role}` }),
  verify: (role) => !!scalar(`SELECT id FROM marketing.campaign_types WHERE name=${lit(`${MARK}_${role}`.slice(0, 80))}`),
  cleanup: (role) => { const id = scalar(`SELECT id FROM marketing.campaign_types WHERE name=${lit(`${MARK}_${role}`.slice(0, 80))}`); if (id) purgeById('marketing.campaign_types', id); },
});

// ── 2–5 as a manager that genuinely holds MANAGE ────────────────────────────
let mgrRole = null, mgr = null;
for (const role of ['tenant_admin', 'org_admin']) {
  if (!fs.existsSync(authFile(role))) continue;
  const a = await actor(role);
  if ((await sessionCaps(a))?.has(MANAGE)) { mgrRole = role; mgr = a; break; }
  await a.close();
}
if (!mgr) { console.log('\nNo tenant-A login holds lms.campaign_types.manage — CRUD/rules skipped'); process.exit(0); }
console.log(`\nCRUD + rules as ${mgrRole}`);

const bActor = bKey ? await actor(bKey) : null;
const sa = fs.existsSync(authFile('super_admin')) ? await actor('super_admin') : null;
const originalRows = rows(`SELECT id, rule_order FROM marketing.campaign_type_rules WHERE tenant_id=${lit(tenantA)} AND NOT is_deleted ORDER BY rule_order`, ['id', 'ord']);
const originalOrder = originalRows.map((r) => r.id);
try {
  // ── 2. CRUD ─────────────────────────────────────────────────────────────
  const mk = async (suffix) => {
    const r = await apiPost(mgr, CT, { name: `${MARK}_${suffix}`, label: `E2E ${suffix}`, match_keywords: [`${MARK}-${suffix}`] });
    const id = r.body?.data?.id ?? scalar(`SELECT id FROM marketing.campaign_types WHERE name=${lit(`${MARK}_${suffix}`)}`);
    if (id) created.types.push(id);
    return { r, id };
  };
  const t1 = await mk('alpha'), t2 = await mk('beta');
  console.log(`2. create types http=${t1.r.status}/${t2.r.status}`);
  if (!t1.id || !t2.id) {
    fail('high', mgrRole, 'Create a campaign type', '201 and a marketing.campaign_types row', `HTTP ${t1.r.status}`, JSON.stringify(t1.r.body).slice(0, 200), 'Check campaign-types.repository create under the tenant tx.');
    throw new Error('stop');
  }
  if (typeRow(t1.id)?.tenant !== tenantA) fail('critical', mgrRole, 'A created campaign type is stored under the wrong tenant', `tenant_id=${tenantA}`, `tenant_id=${typeRow(t1.id)?.tenant}`, t1.id, 'Insert with ctx.tenant_id from request.auth, never from the body.');
  const p = await apiPatch(mgr, `${CT}/${t1.id}`, { label: 'E2E alpha renamed' });
  if (!isOk(p.status) || typeRow(t1.id)?.label !== 'E2E alpha renamed') fail('medium', mgrRole, 'PATCH a campaign type label', 'label updated in marketing.campaign_types', `HTTP ${p.status}, label=${typeRow(t1.id)?.label}`, JSON.stringify(p.body).slice(0, 200), 'Check update() and its RLS WITH CHECK.');

  const def = scalar(`SELECT id FROM marketing.campaign_types WHERE tenant_id=${lit(tenantA)} AND is_default LIMIT 1`);
  if (def) {
    const d = await apiDelete(mgr, `${CT}/${def}`);
    console.log(`   delete DEFAULT type http=${d.status} (expect 400)`);
    if (isOk(d.status)) fail('high', mgrRole, 'The tenant\'s DEFAULT campaign type can be deleted', '400 The default campaign type cannot be deleted', `HTTP ${d.status}`, def, 'Keep the default guard in campaign-types.service remove(); unrouted leads fall back to it.');
    else if (d.status >= 500) fail('medium', mgrRole, 'Deleting the default type 5xxs', '400', `HTTP ${d.status}`, JSON.stringify(d.body).slice(0, 200), 'Throw BadRequestError before touching the row.');
  }

  // ── 3. Rules: first match wins, order flips the winner ──────────────────
  const rule = async (pattern, typeId) => {
    const r = await apiPost(mgr, `${CT}/rules`, { match_field: 'campaign_name', pattern, campaign_type_id: typeId });
    const id = r.body?.data?.id ?? scalar(`SELECT id FROM marketing.campaign_type_rules WHERE pattern=${lit(pattern)} AND tenant_id=${lit(tenantA)} ORDER BY created_at DESC LIMIT 1`);
    if (id) created.rules.push(id);
    return { r, id };
  };
  const specific = `${MARK}-camp-specific`, generic = `${MARK}-camp`;
  const r1 = await rule(specific, t1.id);
  const r2 = await rule(generic, t2.id);
  console.log(`3. create rules http=${r1.r.status}/${r2.r.status}`);
  if (r1.id && r2.id) {
    const probe = { campaign_name: `Diwali ${specific} Oct` };
    const test1 = await apiPost(mgr, `${CT}/rules/test`, probe);
    const win1 = test1.body?.data?.campaign_type_id;
    const ids = liveRuleIds();
    const firstIsR1 = ids.indexOf(r1.id) < ids.indexOf(r2.id);
    console.log(`   test (order r1<r2=${firstIsR1}) -> ${win1 === t1.id ? 'alpha' : win1 === t2.id ? 'beta' : win1}`);
    const expected1 = firstIsR1 ? t1.id : t2.id;
    if (win1 !== expected1) fail('high', mgrRole, 'Rule test does not return the FIRST matching rule by rule_order', `campaign_type_id=${expected1}`, `got ${win1}`, JSON.stringify(test1.body).slice(0, 250), 'marketing.fn_match_campaign_type_rules must ORDER BY rule_order and LIMIT 1 over active rules of the tenant.');

    // Flip r1/r2, journalled so a crash restores the tenant's real routing order.
    // rule_order is UNIQUE per tenant among live rules (uix_campaign_type_rules_order),
    // so restore the way reorderRules does: park everything out of range, then
    // write the exact original values in ONE statement.
    if (originalRows.length) {
      journalRestore('rules-order', 'campaign_type_rules order (tenant A)', [
        `UPDATE marketing.campaign_type_rules SET rule_order = rule_order + 1000000 WHERE tenant_id=${lit(tenantA)} AND NOT is_deleted AND rule_order < 1000000`,
        `UPDATE marketing.campaign_type_rules SET rule_order = CASE id ${originalRows.map((r) => `WHEN ${lit(r.id)}::uuid THEN ${Number(r.ord)}`).join(' ')} END
           WHERE id IN (${originalRows.map((r) => `${lit(r.id)}::uuid`).join(',')})`,
      ]);
    }
    const flipped = liveRuleIds().filter((id) => id !== r1.id && id !== r2.id);
    const order = firstIsR1 ? [r2.id, r1.id, ...flipped] : [r1.id, r2.id, ...flipped];
    const re = await apiPut(mgr, `${CT}/rules/order`, { rule_ids: order });
    const test2 = await apiPost(mgr, `${CT}/rules/test`, probe);
    const win2 = test2.body?.data?.campaign_type_id;
    const expected2 = order[0] === r1.id ? t1.id : t2.id;
    console.log(`   reorder http=${re.status}; test -> ${win2 === t1.id ? 'alpha' : win2 === t2.id ? 'beta' : win2}`);
    if (!isOk(re.status)) fail('medium', mgrRole, 'Reorder routing rules', '2xx and rule_order rewritten', `HTTP ${re.status}`, JSON.stringify(re.body).slice(0, 200), 'reorderRules requires every live rule id exactly once — confirm the list the UI sends matches liveRules.');
    else if (win2 !== expected2) fail('high', mgrRole, 'Reordering rules does not change which rule wins', `campaign_type_id=${expected2} after reorder`, `got ${win2}`, JSON.stringify(test2.body).slice(0, 250), 'Rewrite rule_order in one transaction and make the matcher read it (no cached order).');

    const partial = await apiPut(mgr, `${CT}/rules/order`, { rule_ids: [r1.id] });
    if (isOk(partial.status) && liveRuleIds().length > 1) fail('medium', mgrRole, 'A partial rule list is accepted by PUT /rules/order', '400 rule_ids must list every live rule exactly once', `HTTP ${partial.status}`, '', 'Keep the exact-set check in reorderRules; a partial list leaves duplicate/ambiguous rule_order values.');

    // Deleting a type a live rule still points at.
    const inUse = await apiDelete(mgr, `${CT}/${t1.id}`);
    console.log(`   delete type used by a rule http=${inUse.status} (expect 409)`);
    if (isOk(inUse.status)) fail('medium', mgrRole, 'A campaign type still referenced by a routing rule can be deleted', '409 Conflict naming the rules that use it', `HTTP ${inUse.status}`, t1.id, 'Check rule usage in campaign-types.service remove() before deleting.');
    else if (inUse.status >= 500) fail('high', mgrRole, 'Deleting an in-use campaign type 5xxs (FK violation leaks)', '409', `HTTP ${inUse.status}`, JSON.stringify(inUse.body).slice(0, 200), 'Detect usage up front and throw ConflictError.');

    // ── 4. Tenant B ───────────────────────────────────────────────────────
    if (bActor) {
      const bl = await apiGet(bActor, CT);
      const leaked = idsOf(bl.body).filter((id) => id === t1.id || id === t2.id || typeRow(id)?.tenant === tenantA);
      const br = await apiGet(bActor, `${CT}/${t1.id}`);
      const bp = await apiPatch(bActor, `${CT}/${t2.id}`, { label: 'pwned-by-tenant-b' });
      const brules = await apiGet(bActor, `${CT}/rules`);
      const ruleLeak = idsOf(brules.body).filter((id) => id === r1.id || id === r2.id);
      const bt = await apiPost(bActor, `${CT}/rules/test`, probe);
      const bRule = await apiPost(bActor, `${CT}/rules`, { match_field: 'campaign_name', pattern: `${MARK}-b`, campaign_type_id: t1.id });
      const bRuleId = scalar(`SELECT id FROM marketing.campaign_type_rules WHERE pattern=${lit(`${MARK}-b`)} LIMIT 1`);
      if (bRuleId) created.rules.push(bRuleId);
      console.log(`4. tenant B: list leak=${leaked.length} read=${br.status} patch=${bp.status} label=${typeRow(t2.id)?.label} rules leak=${ruleLeak.length} test=${bt.body?.data?.campaign_type_id ? 'MATCH' : 'none'} ruleOnAType=${bRule.status}`);
      const crit = (scenario, actual, fix) => fail('critical', bKey, scenario, 'Invisible / 404 / 400 — tenant A\'s routing config is not tenant B\'s to see or change', actual, `typeA=${t1.id}`, fix);
      if (leaked.length) crit('Tenant B lists tenant A\'s campaign types', `${leaked.length} tenant-A type(s)`, 'List under the caller\'s tenant tx (RLS on marketing.campaign_types).');
      if (isOk(br.status)) crit('Tenant B reads a tenant A campaign type by id', `HTTP ${br.status}`, 'getById must run in the caller\'s tenant tx.');
      if (typeRow(t2.id)?.label === 'pwned-by-tenant-b') crit('Tenant B RENAMED a tenant A campaign type', `HTTP ${bp.status}, row changed`, 'Updates must be fenced by RLS WITH CHECK on tenant_id.');
      if (ruleLeak.length) crit('Tenant B lists tenant A\'s routing rules', `${ruleLeak.length} rule(s)`, 'listRules must filter by ctx.tenant_id / RLS.');
      if ([t1.id, t2.id].includes(bt.body?.data?.campaign_type_id)) crit('Tenant B\'s rule test matched tenant A\'s rules', JSON.stringify(bt.body?.data), 'fn_match_campaign_type_rules is called with ctx.tenant_id — confirm the function filters on its tenant argument.');
      if (bRuleId || isOk(bRule.status)) crit('Tenant B created a routing rule pointing at tenant A\'s campaign type', `HTTP ${bRule.status}`, 'createRule must reject a campaign_type_id outside the tenant ("bad_type").');
    }

    // ── 5. ?tenant_id= administration ─────────────────────────────────────
    const tenantB = bKey ? scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(CROSS_TENANT.find((c) => c.stateKey === bKey).email)}`) : null;
    if (tenantB) {
      const x = await apiGet(mgr, `${CT}?tenant_id=${tenantB}`);
      const bTypes = idsOf(x.body).filter((id) => typeRow(id)?.tenant === tenantB);
      console.log(`5. ${mgrRole} GET ?tenant_id=B http=${x.status} tenantB types=${bTypes.length} (expect 403)`);
      if (bTypes.length) fail('critical', mgrRole, 'Tenant staff administer another tenant via ?tenant_id=', '403 Super admin only', `${bTypes.length} tenant-B types returned`, `HTTP ${x.status}`, 'campaignTypesGate must send any ?tenant_id= caller through authenticateSuperAdmin.');
      if (sa) {
        const s = await apiGet(sa, `${CT}?tenant_id=${tenantB}`);
        const wrong = idsOf(s.body).filter((id) => typeRow(id)?.tenant !== tenantB);
        console.log(`   super_admin GET ?tenant_id=B http=${s.status} foreign=${wrong.length}`);
        if (!isOk(s.status)) fail('medium', 'super_admin', 'super_admin cannot administer a tenant\'s campaign types', '2xx with that tenant\'s types', `HTTP ${s.status}`, JSON.stringify(s.body).slice(0, 200), 'The lookup-admin Campaign Types screen depends on this path.');
        if (wrong.length) fail('high', 'super_admin', '?tenant_id=B returns types of another tenant', 'Only tenant B', `${wrong.length} foreign types`, JSON.stringify(wrong.slice(0, 3)), 'Pin the tx to the administered tenant (scopeCtx).');
      }
    }
  }
} catch (e) {
  if (e.message !== 'stop') throw e;
} finally {
  runRestore('rules-order');
  for (const id of created.rules) { await apiDelete(mgr, `${CT}/rules/${id}`).catch(() => {}); purgeById('marketing.campaign_type_rules', id); }
  for (const id of created.types) { await apiDelete(mgr, `${CT}/${id}`).catch(() => {}); purgeById('marketing.campaign_types', id); }
  for (const a of [mgr, bActor, sa]) if (a) await a.close();
  const after = liveRuleIds();
  const drift = originalOrder.some((id, i) => after[i] !== id) || after.length !== originalOrder.length;
  console.log(`\ncleanup: ${created.rules.length} rule(s), ${created.types.length} type(s) removed; tenant rule order restored=${!drift}`);
  if (drift) fail('high', 'harness', 'Tenant A rule order differs after the suite restored it', `order ${originalOrder.join(',')}`, `order ${after.join(',')}`, '', 'Inspect results/restore-journal.json and run node restore.mjs.');
}
