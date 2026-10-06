// LMS cross-cutting: Meta lead routing product decisions (2026-09-26, schema
// 1.51.0 - 1.70.0), lead-assignment weights, the lms-web pages and the
// lookup-admin Meta console — READ-ONLY.
//
// HARD RULE: this suite NEVER clicks a Meta console action (Sync / Pull / Apply /
// Remap / Retry / Re-run / Validate / Archive / Discard / Ignore). Those drive the
// real Meta Graph API or import real leads. Pages are only LOADED, as a
// super_admin, with a network guard that aborts (and reports) any non-GET request
// the page tries to make; buttons are inventoried by label and left alone.
// Server calls here are GETs of DB-backed list routes, plus a STABLE SQL function
// (marketing.fn_match_campaign_type_rules) called through psql.
//
// Product decisions asserted (memory: meta-routing-product-decisions):
//   D1  branch comes from the PAGE (a form-level row is only an override)
//   D2  ordered rules, first match wins, "contains word" on campaign/form/adset/ad name
//   D3  re-typing a campaign moves ALL its open leads (relabel unconditional)
//   D4  scheduled catch-up pull STAGES ONLY, never applies
//   D5  a campaign never spans tenants; no per-type dedup
//   W1  every branch with active reps has a weighted user (weight 0 = auto-assign dies silently)
//   W2  a (branch x type) pool sums to 100 or 0; a lead's type has a pool in its branch
//
//   node suites/lms/meta-routing-and-weights.mjs
import { APPS, GATEWAY, ROLES, roleMeta, cfg, authFile, openAs, visit, save, CROSS_TENANT, primaryTenant } from '../../lib.mjs';
import { actor, apiGet } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { tenantIdForOrg, resolvedCapabilities } from '../../capability.mjs';
import { finder, isOk, isDenied, leakOf } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'lms';
const fail = finder(TOOL, 'Meta routing, assignment weights & console inventory (read-only)');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const summary = { rules: {}, weights: {}, api: {}, pages: {}, inventory: {} };
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };

const A = primaryTenant();
const tenantA = tenantIdForOrg(A.org);
const orgA = scalar(`SELECT id FROM entity.organizations WHERE name=${lit(roleMeta('org_admin')?.org ?? A.org)} LIMIT 1`);

// ── W1/W2. Weights, straight from Postgres ───────────────────────────────────
console.log('— W1/W2: assignment weights —');
const unweighted = rows(`
  SELECT o.name, COUNT(DISTINCT m.user_id)::int
    FROM entity.organizations o
    JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module='lms' AND tm.is_active
    JOIN iam.user_org_mapping m ON m.org_id=o.id AND m.is_active
    JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted AND u.email NOT LIKE '%@e2e.local'
    JOIN iam.user_roles r ON r.id=m.role_id AND r.name IN ('sales_representative','senior_sales_executive')
   WHERE o.is_active AND NOT o.is_deleted
     AND NOT EXISTS (SELECT 1 FROM iam.user_org_mapping m2 JOIN lms.lead_assignment_weights w ON w.user_org_mapping_id=m2.id AND w.weight>0
                       JOIN iam.users u2 ON u2.id=m2.user_id AND u2.is_active AND NOT u2.is_deleted
                      WHERE m2.org_id=o.id AND m2.is_active)
   GROUP BY o.name ORDER BY o.name`, ['branch', 'reps']);
const licensedBranches = Number(scalar(`SELECT COUNT(*) FROM entity.organizations o JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module='lms' AND tm.is_active WHERE o.is_active AND NOT o.is_deleted`) ?? 0);
const branchesWithReps = Number(scalar(`SELECT COUNT(DISTINCT m.org_id) FROM iam.user_org_mapping m JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted JOIN iam.user_roles r ON r.id=m.role_id AND r.name IN ('sales_representative','senior_sales_executive') JOIN entity.organizations o ON o.id=m.org_id AND o.is_active JOIN entity.tenant_modules tm ON tm.tenant_id=o.tenant_id AND tm.module='lms' AND tm.is_active WHERE m.is_active`) ?? 0);
console.log(`  LMS-licensed active branches=${licensedBranches}, with active reps=${branchesWithReps}, reps but NO weighted user=${unweighted.length}`);
summary.weights = { licensedBranches, branchesWithReps, unweightedWithReps: unweighted };
if (unweighted.length) {
  fail('high', 'data', `W1: ${unweighted.length} of ${branchesWithReps} branches with active reps have no weighted user — auto-assign returns null`,
    'Every branch that has active reps has at least one with weight > 0 (resolveAutoAssignedUser requires it)',
    unweighted.slice(0, 15).map((r) => `${r.branch} (${r.reps} reps)`).join(' | '), `licensed=${licensedBranches} withReps=${branchesWithReps}`,
    'Team -> Lead weights. Leads still land in lms.marketing_leads but unassigned, with only a warn log (lead.autoassign_skipped); also make createUser/addOrgMapping refuse an all-zero pool for a branch that has reps.');
}
// A role holding the LMS "assign.reports" style rank-floor means managers see unassigned leads; count the damage.
const stranded = Number(safe(() => scalar(`SELECT COUNT(*) FROM lms.marketing_leads WHERE is_active AND NOT is_deleted AND superseded_by IS NULL AND assigned_user_id IS NULL AND created_at > NOW() - INTERVAL '30 days'`), 0));
console.log(`  unassigned active leads created in the last 30 days: ${stranded}`);
summary.weights.unassignedLast30d = stranded;
const badPools = rows(`SELECT o.name, ct.name, SUM(w.weight)::int FROM lms.lead_assignment_weights w
    JOIN iam.user_org_mapping m ON m.id=w.user_org_mapping_id AND m.is_active JOIN iam.users u ON u.id=m.user_id AND u.is_active AND NOT u.is_deleted
    JOIN entity.organizations o ON o.id=m.org_id AND o.is_active JOIN marketing.campaign_types ct ON ct.id=w.campaign_type_id
   GROUP BY o.name, ct.name HAVING SUM(w.weight) NOT IN (0,100)`, ['branch', 'type', 'sum']);
if (badPools.length) fail('medium', 'data', `W2: ${badPools.length} (branch x type) pools do not sum to 100 or 0`, 'Deficit formula assumes 100',
  badPools.slice(0, 12).map((r) => `${r.branch}/${r.type}=${r.sum}`).join(' | '), 'lms.lead_assignment_weights', 'Enforce the 100-or-0 rule in one place (DB constraint trigger or the repository), not only in PUT /users/assignment-weights.');
summary.weights.badPools = badPools.length;

// W-API: the weights API agrees with the DB, and is branch/tenant fenced.
console.log('\n— W-API: GET /users/assignment-weights —');
const bKey = CROSS_TENANT.find((c) => fs.existsSync(authFile(c.stateKey)))?.stateKey ?? null;
const aTypeId = safe(() => scalar(`SELECT id FROM marketing.campaign_types WHERE tenant_id=${lit(tenantA)}::uuid AND is_active AND NOT is_deleted ORDER BY is_default DESC LIMIT 1`));
const aOtherBranch = safe(() => scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tenantA)}::uuid AND id<>${lit(orgA)}::uuid AND is_active AND NOT is_deleted LIMIT 1`));
const W = `${GATEWAY}/users/assignment-weights`;
for (const role of ['org_admin', 'sales_representative']) {
  if (!fs.existsSync(authFile(role))) continue;
  const a = await actor(role);
  try {
    const own = await apiGet(a, `${W}?org_id=${orgA}`);
    const items = Array.isArray(own.body?.data) ? own.body.data : [];
    const dbN = Number(scalar(`SELECT COUNT(*) FROM lms.vw_lead_assignment_weights v WHERE v.org_id=${lit(orgA)}::uuid`) ?? 0);
    console.log(`  ${role.padEnd(22)} own branch http=${own.status} rows=${items.length} db=${dbN}`);
    if (role === 'org_admin') {
      if (!isOk(own.status)) fail('high', role, 'org_admin cannot read its own branch weights', '200 with the branch pool', `HTTP ${own.status}`, JSON.stringify(own.body).slice(0, 200), 'identity-service GET /users/assignment-weights (scopeContext requireOrg).');
      else if (items.length !== dbN) fail('medium', role, 'Weights API row count differs from lms.vw_lead_assignment_weights for the branch', `${dbN} rows`, `${items.length} rows`, JSON.stringify(items.slice(0, 2)), 'The API must read the same view the picker does (resolveAutoAssignedUser) — a UI showing different weights than the picker uses is how a branch ends up "weighted" on screen and dead in practice.');
    }
    if (aOtherBranch) {
      const other = await apiGet(a, `${W}?org_id=${aOtherBranch}`);
      console.log(`  ${role.padEnd(22)} other branch of same tenant http=${other.status}`);
      if (role === 'sales_representative' && isOk(other.status)) fail('high', role, 'A sales rep reads another branch\'s lead weights', '403 (canSeeOrgFilter)', `HTTP ${other.status}`, JSON.stringify(other.body).slice(0, 200), 'users.service getAssignmentWeights: keep the canSeeOrgFilter guard.');
    }
  } finally { await a.close(); }
}
if (bKey) {
  const b = await actor(bKey);
  try {
    for (const [label, qs] of [['tenant-A branch', `?org_id=${orgA}`], ['tenant-A campaign type', aTypeId ? `?campaign_type_id=${aTypeId}` : null], ['smuggled tenant_id', `?tenant_id=${tenantA}`]]) {
      if (!qs) continue;
      const r = await apiGet(b, `${W}${qs}`);
      const txt = JSON.stringify(r.body ?? '');
      const leaked = isOk(r.status) && /"weight"/.test(txt) && txt.includes(orgA);
      console.log(`  ${bKey.padEnd(22)} ${label.padEnd(24)} http=${r.status}${leaked ? ' LEAK' : ''}`);
      if (leaked) fail('critical', bKey, `Tenant B reads tenant A's lead weights (${label})`, '400/403 — branch / type not in the caller\'s tenant', `HTTP ${r.status}, body names tenant-A branch`, txt.slice(0, 200), 'getAssignmentWeights must validate org/type against the session tenant (getOrgsInTenant / getCampaignTypesInTenant) — never the query string.');
      else if (r.status >= 500) fail('medium', bKey, `Weights API 5xx for ${label}`, '400/403', `HTTP ${r.status}`, txt.slice(0, 200), 'Map to BadRequest/Forbidden.');
    }
  } finally { await b.close(); }
}

// ── D2. The ordered-rule matcher (STABLE SQL function, read-only) ────────────
console.log('\n— D2: ordered rules, first match wins (marketing.fn_match_campaign_type_rules) —');
const rules = rows(`SELECT r.id, r.tenant_id, r.rule_order, r.match_field, r.pattern, r.campaign_type_id, (ct.is_active AND NOT ct.is_deleted)::text AS type_live
    FROM marketing.campaign_type_rules r JOIN marketing.campaign_types ct ON ct.id=r.campaign_type_id
   WHERE r.is_active AND NOT r.is_deleted ORDER BY r.tenant_id, r.rule_order, r.id`, ['id', 'tenant', 'order', 'field', 'pattern', 'type', 'typeLive']);
const byTenant = new Map();
for (const r of rules) (byTenant.get(r.tenant) ?? byTenant.set(r.tenant, []).get(r.tenant)).push({ ...r, order: Number(r.order), typeLive: r.typeLive === 'true' || r.typeLive === 't' });
const esc = (p) => p.trim().replace(/([^a-zA-Z0-9])/g, '\\$1');
const jsMatch = (r, subject) => new RegExp(`(^|[^a-z0-9])${esc(r.pattern)}([^a-z0-9]|$)`, 'i').test(subject);
const ARG = { campaign_name: 0, form_name: 1, adset_name: 2, ad_name: 3 };
const callMatch = (tenant, subjects) => {
  const args = [subjects.campaign_name ?? null, subjects.form_name ?? null, subjects.adset_name ?? null, subjects.ad_name ?? null].map((v) => (v == null ? 'NULL' : lit(v)));
  const r = rows(`SELECT rule_id, campaign_type_id FROM marketing.fn_match_campaign_type_rules(${lit(tenant)}::uuid, ${args.join(',')})`, ['rule', 'type'])[0];
  return r ?? null;
};
const subjectsFor = (field, text) => ({ [field]: text });
let ruleCases = 0, ruleBad = 0;
for (const [tenant, list] of byTenant) {
  const live = list.filter((r) => r.typeLive);
  for (const r of live) {
    // (a) exact word match, upper-cased: must be matched by this rule OR an earlier-ordered rule on the same field — never a LATER one.
    const subj = `Promo ${r.pattern.toUpperCase()} Offer`;
    const expectedWinner = live.filter((x) => x.field === r.field && jsMatch(x, subj)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
    const got = callMatch(tenant, subjectsFor(r.field, subj));
    ruleCases++;
    if (!got || got.rule !== expectedWinner?.id) {
      ruleBad++;
      fail('high', 'data', `Rule engine disagrees with "first match wins" for tenant ${tenant.slice(0, 8)} rule #${r.order} "${r.pattern}" (${r.field})`, `rule ${expectedWinner?.id} (order ${expectedWinner?.order}) wins for "${subj}"`, `function returned ${got?.rule ?? 'no match'}`, `subject=${subj}`, 'marketing.fn_match_campaign_type_rules must ORDER BY rule_order ASC, id ASC LIMIT 1 and match case-insensitively on word boundaries (decision 2026-09-26).');
    }
    // (b) the pattern embedded inside a longer word must NOT fire THIS rule ("contains word", not substring).
    const embedded = `x${r.pattern.replace(/[^a-zA-Z0-9]/g, '')}y`;
    if (/[a-zA-Z0-9]/.test(r.pattern)) {
      const g2 = callMatch(tenant, subjectsFor(r.field, embedded));
      ruleCases++;
      if (g2?.rule === r.id && !jsMatch(r, embedded)) { ruleBad++; fail('high', 'data', `Rule "${r.pattern}" fires on a substring, not a word`, 'Match on word boundaries only', `matched inside "${embedded}"`, `rule ${r.id}`, 'The boundary class in fn_match_campaign_type_rules must be [^[:alnum:]] on both sides.'); }
    }
  }
  // (c) a rule whose type is inactive/deleted is skipped, never returned.
  for (const r of list.filter((x) => !x.typeLive).slice(0, 5)) {
    const got = callMatch(tenant, subjectsFor(r.field, `Promo ${r.pattern} Offer`));
    ruleCases++;
    if (got?.rule === r.id) { ruleBad++; fail('high', 'data', `A rule on an inactive campaign type still routes leads (tenant ${tenant.slice(0, 8)}, "${r.pattern}")`, 'Rule skipped while its type is inactive (re-activating restores it)', `rule ${r.id} returned`, '', 'The JOIN in fn_match_campaign_type_rules must require ct.is_active AND NOT ct.is_deleted.'); }
  }
}
// (d) tenant fence: tenant X's function never returns tenant Y's rule.
const tenants = [...byTenant.keys()];
for (const tX of tenants) for (const tY of tenants) {
  if (tX === tY) continue;
  const r = byTenant.get(tY)?.find((x) => x.typeLive);
  if (!r) continue;
  const got = callMatch(tX, subjectsFor(r.field, `Promo ${r.pattern} Offer`));
  ruleCases++;
  if (got && rules.find((x) => x.id === got.rule)?.tenant !== tX) { ruleBad++; fail('critical', 'data', 'Rule matcher returns another tenant\'s rule', 'Only the named tenant\'s rules are evaluated', `tenant ${tX.slice(0, 8)} matched rule of ${tY.slice(0, 8)}`, `rule ${got.rule}`, 'WHERE r.tenant_id = p_tenant_id is the whole fence — keep it.'); }
}
console.log(`  tenants with rules=${byTenant.size} live rules=${rules.length} cases=${ruleCases} violations=${ruleBad}`);
summary.rules = { tenants: byTenant.size, liveRules: rules.length, cases: ruleCases, violations: ruleBad };
if (!rules.length) fail('info', 'data', 'No live campaign-type rules exist, so rule precedence is untested here', 'At least one tenant with two rules', '0 rules', '', 'Create rules in /dashboard/campaign-types (campaign-types-rules.mjs covers ordering with throwaway rules).');

// ── D1/D3/D4/D5. DB-level product decisions (also in data-health, asserted here per area) ──
console.log('\n— D1/D3/D4/D5: routing data —');
const d4 = Number(safe(() => scalar(`SELECT COUNT(*) FROM scratch.meta_pull_runs WHERE trigger_kind='scheduled' AND (status IN ('apply_queued','applying','applied') OR applied_at IS NOT NULL)`), 0));
const d4h = Number(safe(() => scalar(`SELECT COUNT(*) FROM ext.meta_pull_run_history WHERE trigger_kind='scheduled' AND (status IN ('apply_queued','applying','applied') OR applied_at IS NOT NULL)`), 0));
console.log(`  D4 scheduled runs applied: runs=${d4} history=${d4h}`);
if (d4 || d4h) fail('critical', 'data', 'D4: a scheduled catch-up run was APPLIED', 'Scheduled runs stage and classify only; Apply needs a person', `runs=${d4} history=${d4h}`, '', 'The poller must never enqueue apply; Apply must reject trigger_kind=scheduled without an explicit user action.');
const d1 = Number(safe(() => scalar(`SELECT COUNT(*) FROM (SELECT page_id FROM ext.meta_page_form_org_map WHERE is_active GROUP BY page_id HAVING COUNT(DISTINCT tenant_id)>1) x`), 0));
if (d1) fail('critical', 'data', `D1/D5: ${d1} Meta page(s) are mapped under more than one tenant`, 'A page belongs to one tenant; branch comes from the page', `${d1} pages`, '', 'Fix /sa/dashboard/meta-mappings; flag + skip campaigns that span tenants.');
const d3 = Number(safe(() => scalar(`SELECT COUNT(*) FROM ext.meta_campaigns c JOIN ext.meta_leads ml ON ml.campaign_id=c.meta_campaign_id JOIN lms.marketing_leads l ON l.id=ml.marketing_lead_id JOIN entity.organizations o ON o.id=l.org_id AND o.tenant_id=c.tenant_id LEFT JOIN lms.lead_stage ls ON ls.id=l.stage_id WHERE c.mapping_status='confirmed' AND NOT l.is_deleted AND l.is_active AND l.superseded_by IS NULL AND ls.is_terminated IS DISTINCT FROM TRUE AND l.campaign_type_id IS DISTINCT FROM c.campaign_type_id`), 0));
console.log(`  D1 pages over several tenants=${d1}; D3 open leads still on a different type than their confirmed campaign=${d3}`);
if (d3) fail('high', 'data', `D3: ${d3} open lead(s) of confirmed campaigns carry a different type than the campaign`, 'Re-typing a campaign relabels and re-routes ALL its open leads', `${d3} leads`, 'ext.meta_campaigns -> ext.meta_leads -> lms.marketing_leads', 'leads-service reclassifyCampaign must run to completion after a confirm; see data-health META-5/META-6 for the per-campaign list.');
summary.routing = { d1PagesOverTenants: d1, d3OpenLeadsOffType: d3, d4ScheduledApplied: d4 + d4h };

// ── Meta console: DB-backed GET routes, as super_admin / everyone else ───────
console.log('\n— Meta console API (read-only GETs of DB-backed lists) —');
// Deliberately excluded: /meta/pages, /meta/pages/:id/forms, /meta/ad-accounts/token-permissions,
// /meta/lead-pull/campaigns — each calls the Meta Graph API when the caller is allowed.
const META_READS = ['/meta/page-org-map', '/meta/pages/health', '/meta/campaigns', '/meta/ad-accounts', '/meta/lead-inbox', '/meta/lead-pull/history', '/meta/lead-pull/runs/latest', '/meta/integration'];
const SECRET_RX = /EAA[A-Za-z0-9]{25,}|"(access_token|app_secret|page_access_token|client_secret|verify_token)"\s*:\s*"[^"]{6,}"/i;
const PII_KEYS = /"(first_name|last_name|full_name|phone|email|whatsapp_number)"\s*:/i;
const apiSummary = {};
if (fs.existsSync(authFile('super_admin'))) {
  const sa = await actor('super_admin');
  try {
    for (const p of META_READS) {
      const res = await apiGet(sa, `${GATEWAY}${p}`);
      const txt = JSON.stringify(res.body ?? '');
      apiSummary[p] = { status: res.status, bytes: txt.length };
      console.log(`  super_admin ${p.padEnd(32)} http=${res.status} ${txt.length}B`);
      if (res.status >= 500) fail('high', 'super_admin', `GET ${p} 5xx for super_admin`, '2xx', `HTTP ${res.status}`, txt.slice(0, 200), 'Check meta-conversion-api log; typical: missing grant for lms_svc/meta_svc on a 1.69/1.70 table (ext.meta_page_health, ext.meta_pull_run_history, meta_ad_accounts.last_error).');
      if (SECRET_RX.test(txt)) fail('critical', 'super_admin', `GET ${p} returns a credential`, 'No token / secret in any Meta console response (nothing here is a credential)', 'access token or app secret in the body', txt.match(SECRET_RX)?.[0].slice(0, 12) + '…', 'Strip token columns in the repository select list; return has_token booleans only.');
      if (p === '/meta/lead-pull/history' && PII_KEYS.test(txt)) fail('high', 'super_admin', 'Lead-pull history exposes lead PII', 'History rows hold summary counts only — no names, phones or emails (1.70.0 design)', 'PII keys in the body', txt.slice(0, 200), 'Select only the summary columns of ext.meta_pull_run_history.');
    }
    // Shape parity with the 1.69 / 1.70 columns the UI filters on.
    const ads = apiSummary['/meta/ad-accounts'];
    const adBody = await apiGet(sa, `${GATEWAY}/meta/ad-accounts`);
    const adRows = Array.isArray(adBody.body?.data) ? adBody.body.data : adBody.body?.data?.items ?? [];
    if (adRows.length && !('last_error' in adRows[0])) fail('medium', 'super_admin', 'Ad-accounts API omits last_error (1.69.0)', 'Rows carry last_error / last_error_at so the page can filter to accounts with errors', `keys: ${Object.keys(adRows[0]).join(',')}`, '', 'Add the columns to the ad-accounts select + response type.');
    const dbMap = Number(scalar(`SELECT COUNT(*) FROM ext.meta_page_form_org_map WHERE is_active`) ?? 0);
    const mapBody = await apiGet(sa, `${GATEWAY}/meta/page-org-map`);
    const mapRows = Array.isArray(mapBody.body?.data) ? mapBody.body.data : mapBody.body?.data?.items ?? [];
    console.log(`  page-org-map API rows=${mapRows.length} DB active=${dbMap}`);
    if (isOk(mapBody.status) && mapRows.length && mapRows.length < dbMap) fail('medium', 'super_admin', 'page-org-map API returns fewer mappings than the DB holds', `>= ${dbMap}`, `${mapRows.length}`, '', 'Check pagination / tenant scoping of the super-admin listing.');
  } finally { await sa.close(); }
} else console.log('  (no super_admin session — Meta API reads skipped)');
// Everyone else is denied — the same routes, every non-super-admin login + tenant B (GET only).
const denyActors = [...ROLES.filter((r) => r !== 'super_admin'), ...CROSS_TENANT.map((c) => c.stateKey)].filter((k) => fs.existsSync(authFile(k)));
let deniedOk = 0, deniedBad = 0;
for (const k of denyActors) {
  const a = await actor(k);
  try {
    for (const p of META_READS) {
      const res = await apiGet(a, `${GATEWAY}${p}`);
      if (isOk(res.status)) { deniedBad++; fail('critical', k, `Meta console route ${p} served to a non-super-admin`, '403 (withSuperAdmin edge guard)', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 160), 'The Meta console is platform-level: re-add withSuperAdmin on the gateway route AND the service-side rank check.'); }
      else if (isDenied(res.status) || res.status === 400) deniedOk++;
      else if (res.status >= 500) fail('medium', k, `Meta console route ${p} 5xx for a denied caller`, '403', `HTTP ${res.status}`, '', 'Deny at the edge before proxying.');
    }
  } finally { await a.close(); }
}
console.log(`  non-super-admin logins=${denyActors.length} denied=${deniedOk} served=${deniedBad}`);
summary.api = { reads: apiSummary, nonSaLogins: denyActors.length, denied: deniedOk, served: deniedBad };

// ── Pages: lookup-admin Meta console (inventory) + lms-web pages (capability gating) ──
const NON_GET = (m) => !['GET', 'HEAD', 'OPTIONS'].includes(m);
const DANGER = /\b(sync|pull|apply|remap|re-?map|retry|re-?run|rerun|validate|archive|discard|ignore|rotate|delete|confirm|save)\b/i;
async function guardedPage(stateKey) {
  const s = await openAs(stateKey);
  const blocked = [];
  await s.page.route('**/*', (route) => {
    const req = route.request();
    if (NON_GET(req.method()) && /\/api\//.test(req.url())) { blocked.push(`${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, '')}`); return route.abort(); }
    return route.continue();
  });
  return { ...s, blocked };
}
console.log('\n— lookup-admin Meta console pages (load only; controls inventoried, NEVER clicked) —');
const META_PAGES = ['/dashboard/meta-mappings', '/dashboard/meta-campaigns', '/dashboard/meta-ad-accounts', '/dashboard/meta-lead-inbox', '/dashboard/lead-pull', '/dashboard/lead-assignment-rerun', '/dashboard/campaign-types'];
if (fs.existsSync(authFile('super_admin'))) {
  const s = await guardedPage('super_admin');
  try {
    for (const p of META_PAGES) {
      const before = { c: s.log.consoleErrors.length, e: s.log.pageErrors.length, b: s.log.badRequests.length, k: s.blocked.length };
      const v = await visit(s.page, `${APPS['lookup-admin']}${p}`);
      const buttons = (await s.page.locator('button, [role="button"], a[role="button"]').allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const actions = [...new Set(buttons.filter((t) => DANGER.test(t)))].slice(0, 12);
      const newBad = s.log.badRequests.slice(before.b).filter((x) => /^5\d\d |FAILED/.test(x));
      summary.inventory[p] = { url: v.url, status: v.httpStatus, heading: v.heading, buttons: buttons.length, metaActions: actions, blockedWrites: s.blocked.slice(before.k), serverErrors: newBad };
      console.log(`  ${p.padEnd(36)} http=${v.httpStatus} "${v.heading}" buttons=${buttons.length} actions[not clicked]=${actions.join(' / ') || '-'}${s.blocked.length > before.k ? '  WRITE-ATTEMPT' : ''}`);
      if (v.looksLikeError || (v.httpStatus && v.httpStatus >= 400)) fail('high', 'super_admin', `${p} does not render for super_admin`, 'Page renders', `HTTP ${v.httpStatus}; "${v.heading}"`, v.bodySnippet, 'Check the page\'s server fetch (a 1.69/1.70 column or table the API selects may be missing in this database — SCH-1 in data-health).');
      if (newBad.length) fail('medium', 'super_admin', `${p} triggers server errors while loading`, 'No 5xx / failed request on load', newBad.slice(0, 3).join(' | '), '', 'Reproduce with super_admin and read the meta-conversion-api / leads-service log.');
      if (s.blocked.length > before.k) fail('medium', 'super_admin', `${p} sends a write request just by loading`, 'Loading a console page is read-only', s.blocked.slice(before.k).join(' | '), 'aborted by the harness network guard', 'A page must not POST/PUT/PATCH/DELETE on mount (auto-sync or auto-retry on load would run Meta actions every time someone opens the page).');
    }
  } finally { await s.browser.close(); }
}

console.log('\n— lms-web pages: access follows the role\'s EFFECTIVE capability —');
const LMS_PAGES = [
  { id: 'leads', path: '/dashboard/leads', cap: 'lms.leads' },
  { id: 'my-leads', path: '/dashboard/my-leads', cap: 'lms.leads' },
  { id: 'follow-ups', path: '/dashboard/follow-ups', cap: 'lms.followups' },
  { id: 'leads-history', path: '/dashboard/leads-history', cap: 'lms.history' },
  { id: 'assignments', path: '/dashboard/assignments', cap: 'lms.assignments' },
  { id: 'analytics', path: '/dashboard/analytics', cap: 'lms.analytics' },
  { id: 'bulk-assign', path: '/dashboard/bulk-assign', cap: 'lms.leads.assign.bulk' },
];
const pageResults = [];
for (const meta of cfg.roles) {
  const role = meta.role;
  if (role === 'super_admin' || !fs.existsSync(authFile(role))) continue;
  const tId = tenantIdForOrg(meta.org);
  const caps = tId ? resolvedCapabilities(tId, role) : new Map();
  if (!caps.size) { console.log(`  ${role}: no capability matrix resolved — skipped`); continue; }
  const s = await guardedPage(role);
  try {
    for (const pg of LMS_PAGES) {
      const want = caps.get(pg.cap) === true && caps.get('lms') !== false;
      const v = await visit(s.page, `${APPS['lms-web']}${pg.path}`);
      const landed = new URL(v.url).pathname.replace(/\/$/, '');
      const reached = landed.endsWith(pg.path) && !v.looksLikeError && !(v.httpStatus && v.httpStatus >= 400) && !/no.access|not authori[sz]ed|access denied|not allowed/i.test(v.bodySnippet);
      pageResults.push({ role, page: pg.id, capability: pg.cap, capabilityGranted: want, reached });
      if (want !== reached) {
        const bypass = reached && !want;
        // Server-rendered pages gate on the capability or on the nav config; a mismatch in either direction is a defect, but only "reached without the capability" is a security finding.
        fail(bypass ? 'high' : 'medium', role, `${pg.path}: ${bypass ? 'reachable' : 'blocked'} although the role ${bypass ? 'lacks' : 'holds'} ${pg.cap}`,
          `Page access == effective capability ${pg.cap} (${want ? 'granted' : 'not granted'})`, `reached=${reached} landed=${landed} http=${v.httpStatus}`, `body: ${v.bodySnippet.slice(0, 120)}`,
          bypass ? 'Gate the page (and its API) on the capability via the page guard, not on role rank/name — role names are not an authorization boundary here.' : 'The capability is granted but the page/nav still gates on rank or role name; move it to the capability (memory: hr-leave-approver-capability-gap).');
      }
    }
  } finally { await s.browser.close(); }
  console.log(`  ${role.padEnd(26)} ${pageResults.filter((r) => r.role === role).map((r) => `${r.page}:${r.reached ? 'Y' : 'n'}${r.reached === r.capabilityGranted ? '' : '!'}`).join(' ')}`);
}
summary.pages = pageResults;
save('lms', 'meta-routing-weights', { generatedAt: new Date().toISOString(), ...summary });
console.log('\nresults -> results/lms-meta-routing-weights.json');
