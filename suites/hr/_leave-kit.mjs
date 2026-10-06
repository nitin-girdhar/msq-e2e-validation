// Shared plumbing for the 2026-10 leave suites (apply v2, comp-off, encashment).
//
// Not a suite: importing it has no side effects. It holds
//   * the "world"   - who the employee / approver / second approver / bystanders are, resolved from the
//                     live DB (never hard-coded ids), plus the tenant and org ids
//   * fixtures      - an E2E-marked leave POLICY (so the suites do not depend on what the tenant happens to
//                     have configured), E2E leave balances, DB-inserted comp-off / encashment rows
//   * a cleanup stack - everything a suite creates is registered and unwound in a finally (and on SIGINT)
//   * an authority oracle - hr.can_approve_leave() called straight in Postgres, so a role matrix is graded
//                     on what the platform says is allowed, not on a role name
//   * UI helpers    - withResponse(), a console / 4xx / 5xx collector that turns noise into findings
//
// Everything created carries the marker E2E-* so a human can always tell harness rows apart.
import { APPS, GATEWAY, HR_EMPLOYEE, HR_APPROVER, ROLES, CROSS_TENANT, roleMeta, record, cfg } from '../../lib.mjs';
import { actor, apiGet, apiPost, apiPatch, apiDelete, simultaneously, readResp } from '../../conc.mjs';
import { scalar, rows, q, lit } from '../../db.mjs';
import { purgeById } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';

export const TOOL = 'hr';
export const HR = APPS['hr-web'];
export const stamp = Date.now();
export { GATEWAY, ROLES, CROSS_TENANT, roleMeta, record, HR_EMPLOYEE, HR_APPROVER };

// Every role the harness has a login for: tenant A ladder + tenant B actors.
export const ALL_ROLES = [...ROLES, ...CROSS_TENANT.map((a) => a.stateKey)];
export const emailOfKey = (key) => roleMeta(key)?.email ?? CROSS_TENANT.find((a) => a.stateKey === key)?.email ?? null;

export const CAP = {
  VIEW: 'hr.leave.view', CREATE: 'hr.leave.request.create', CANCEL: 'hr.leave.request.cancel',
  APPROVE: 'hr.leave.approve', REJECT: 'hr.leave.reject', ADMIN: 'hr.leave.admin',
  CO_REQ: 'hr.leave.comp_off.request', CO_APP: 'hr.leave.comp_off.approve',
  EN_REQ: 'hr.leave.encashment.request', EN_APP: 'hr.leave.encashment.approve',
};

// ── dates ───────────────────────────────────────────────────────────────────────
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (n, from = new Date()) => { const x = new Date(from); x.setUTCDate(x.getUTCDate() + n); return x; };
// First Monday..Friday on/after today+offset (the roster default weekly off is Sat/Sun).
export function weekday(offset) {
  let d = addDays(offset);
  while ([0, 6].includes(d.getUTCDay())) d = addDays(1, d);
  return iso(d);
}
// The most recent date (<= today) whose weekday is in `pattern`, not in `taken`, within the 60-day window.
export function recentOffDay(pattern, taken = new Set(), { skip = 0 } = {}) {
  let skipped = 0;
  for (let i = 0; i <= 55; i++) {
    const d = addDays(-i);
    if (pattern.includes(d.getUTCDay()) && !taken.has(iso(d))) { if (skipped < skip) { skipped++; continue; } return iso(d); }
  }
  return null;
}

// ── world ────────────────────────────────────────────────────────────────────
const uid = (email) => scalar(`SELECT id FROM iam.users WHERE email=${lit(String(email).toLowerCase())} AND NOT is_deleted LIMIT 1`);
const homeOrg = (userId) => scalar(`SELECT org_id FROM iam.users WHERE id=${lit(userId)}`);
const tenantOf = (orgId) => scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgId)}`);

export function resolveWorld() {
  const empEmail = roleMeta(HR_EMPLOYEE).email;
  const apprEmail = roleMeta(HR_APPROVER).email;
  const empId = uid(empEmail), apprId = uid(apprEmail);
  const orgId = homeOrg(empId);
  const tenantId = tenantOf(orgId);
  const other = CROSS_TENANT.find((a) => a.role === 'org_admin') ?? CROSS_TENANT[0];
  const otherEmp = CROSS_TENANT.find((a) => a.role === 'sales_representative') ?? CROSS_TENANT[0];
  // a same-org colleague with no HR capabilities (for IDOR + handover)
  const rep2 = cfg.secondaryActors?.find((a) => a.actor === 'rep2');
  const rep2Id = rep2 ? uid(rep2.email) : null;
  // a same-tenant, DIFFERENT-org login (Noida branch) for cross-org IDOR
  const noidaKey = ROLES.find((r) => { const m = roleMeta(r); return m && /Noida/.test(m.org); }) ?? null;
  return {
    empKey: HR_EMPLOYEE, empEmail, empId, apprKey: HR_APPROVER, apprEmail, apprId,
    orgId, tenantId,
    otherTenantId: otherEmp ? tenantOf(homeOrg(uid(otherEmp.email))) : null,
    xKey: other?.stateKey ?? null, xEmpKey: otherEmp?.stateKey ?? null,
    xAdminKey: CROSS_TENANT.find((a) => a.role === 'tenant_admin')?.stateKey ?? null,
    rep2Key: rep2?.actor ?? null, rep2Id, noidaKey,
    noidaOrgId: noidaKey ? homeOrg(uid(roleMeta(noidaKey).email)) : null,
  };
}
export const leaveTypeId = (tenantId, name) =>
  scalar(`SELECT id FROM hr.leave_types WHERE tenant_id=${lit(tenantId)} AND name=${lit(name)} LIMIT 1`);
export const weeklyOffOf = (userId) => {
  const r = scalar(`SELECT weekly_off_pattern FROM hr.employee_profiles WHERE user_id=${lit(userId)} AND NOT is_deleted LIMIT 1`);
  if (!r) return [0, 6];
  return r.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
};

// ── cleanup stack ─────────────────────────────────────────────────────────────
const stack = [];
let cleaned = false;
export const onCleanup = (label, fn) => stack.push({ label, fn });
export function runCleanup() {
  if (cleaned) return;
  cleaned = true;
  let n = 0;
  while (stack.length) {
    const { label, fn } = stack.pop();
    try { fn(); n++; } catch (e) { console.log(`  cleanup '${label}' failed: ${String(e.message).slice(0, 120)}`); }
  }
  console.log(`\ncleaned up ${n} fixture group(s).`);
}
process.on('SIGINT', () => { runCleanup(); process.exit(130); });

// ── fixtures ───────────────────────────────────────────────────────────────────
// An E2E leave policy for one org so the suite owns the rules it asserts on. Registered for purge.
export function seedPolicy(world, typeName, o = {}) {
  const tid = leaveTypeId(world.tenantId, typeName);
  if (!tid) throw new Error(`no leave type ${typeName} in tenant`);
  const v = { maxConsecutive: 5, minNotice: 0, allowHalf: true, docAfter: 2, levels: 1, sla: 37, encashable: false, maxEncash: null, ...o };
  const id = scalar(`INSERT INTO hr.leave_policies
      (tenant_id, org_id, leave_type_id, accrual_frequency, accrual_amount, max_consecutive_days, min_notice_days,
       allow_half_day, requires_document_after_days, approval_levels, applicable_from, sla_hours, encashable, max_encash_days)
    VALUES (${lit(world.tenantId)}, ${lit(o.orgId ?? world.orgId)}, ${lit(tid)}, 'none', 0, ${v.maxConsecutive ?? 'NULL'}, ${v.minNotice},
       ${v.allowHalf}, ${v.docAfter ?? 'NULL'}, ${v.levels}, current_date - 1, ${v.sla}, ${v.encashable}, ${v.maxEncash ?? 'NULL'})
    RETURNING id`);
  onCleanup(`policy ${typeName}`, () => { q(`DELETE FROM hr.leave_policies WHERE id=${lit(id)}`); });
  return id;
}
// Balance rows with a marker note; removed by note.
export function seedBalance(userId, orgId, typeId, amount, note) {
  q(`INSERT INTO hr.leave_ledger (user_id, org_id, leave_type_id, entry_type, amount, effective_date, note)
     VALUES (${lit(userId)}, ${lit(orgId)}, ${lit(typeId)}, 'adjustment', ${Number(amount)}, current_date, ${lit(note)})`);
  onCleanup(`balance ${note}`, () => q(`DELETE FROM hr.leave_ledger WHERE note=${lit(note)}`));
}
export const balanceOf = (userId, typeId) =>
  Number(scalar(`SELECT COALESCE(SUM(amount),0) FROM hr.leave_ledger WHERE user_id=${lit(userId)} AND leave_type_id=${lit(typeId)}`) ?? 0);

// Leave request teardown (ledger + approvals + status log first; attendance rows an approval wrote too).
export function purgeLeaveRequest(id) {
  if (!id) return;
  q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`);
  q(`DELETE FROM hr.attendance_days WHERE leave_request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(id)}`);
  q(`DELETE FROM hr.leave_requests WHERE id=${lit(id)}`);
}
// Registers a leave request id for purge; returns the id.
export const trackLeave = (id) => { if (id) onCleanup(`leave ${id}`, () => purgeLeaveRequest(id)); return id; };

export const statusOfLeave = (id) => scalar(
  `SELECT s.name FROM hr.leave_requests r JOIN hr.leave_request_statuses s ON s.id=r.status_id WHERE r.id=${lit(id)}`);

// Comp-off / encashment rows inserted straight into Postgres (the precondition, not the thing under test).
export function insertClaim({ userId, orgId, date, days = 1, approverId = null, reason }) {
  const id = scalar(`INSERT INTO hr.comp_off_claims (user_id, org_id, worked_date, days, reason, approver_id, created_by)
    VALUES (${lit(userId)}, ${lit(orgId)}, ${lit(date)}, ${days}, ${lit(reason)}, ${approverId ? lit(approverId) : 'NULL'}, ${lit(userId)}) RETURNING id`);
  trackClaim(id);
  return id;
}
export function purgeClaim(id) {
  if (!id) return;
  const led = scalar(`SELECT ledger_entry_id FROM hr.comp_off_claims WHERE id=${lit(id)}`);
  q(`UPDATE hr.comp_off_claims SET ledger_entry_id=NULL WHERE id=${lit(id)}`);
  if (led) q(`DELETE FROM hr.leave_ledger WHERE id=${lit(led)}`);
  q(`DELETE FROM hr.comp_off_claims WHERE id=${lit(id)}`);
}
export const trackClaim = (id) => { if (id) onCleanup(`claim ${id}`, () => purgeClaim(id)); return id; };

export function insertEncashment({ userId, orgId, typeId, days = 1, approverId = null, reason }) {
  const id = scalar(`INSERT INTO hr.leave_encashment_requests (user_id, org_id, leave_type_id, days, reason, approver_id, created_by)
    VALUES (${lit(userId)}, ${lit(orgId)}, ${lit(typeId)}, ${days}, ${lit(reason)}, ${approverId ? lit(approverId) : 'NULL'}, ${lit(userId)}) RETURNING id`);
  trackEncashment(id);
  return id;
}
export function purgeEncashment(id) {
  if (!id) return;
  const led = scalar(`SELECT ledger_entry_id FROM hr.leave_encashment_requests WHERE id=${lit(id)}`);
  q(`UPDATE hr.leave_encashment_requests SET ledger_entry_id=NULL WHERE id=${lit(id)}`);
  if (led) q(`DELETE FROM hr.leave_ledger WHERE id=${lit(led)}`);
  q(`DELETE FROM hr.leave_encashment_requests WHERE id=${lit(id)}`);
}
export const trackEncashment = (id) => { if (id) onCleanup(`encash ${id}`, () => purgeEncashment(id)); return id; };

// ── authority oracle ──────────────────────────────────────────────────────────
// Whether the platform's own rule lets `approverId` decide something `requesterId` raised in `orgId`.
export const canApproveSql = (orgId, approverId, requesterId) =>
  scalar(`SELECT hr.can_approve_leave(${lit(orgId)}, ${lit(approverId)}, ${lit(requesterId)})`) === 't';

// Live session facts for a login: capabilities, the ACTIVE org, user id, tenant.
export async function sessionInfo(key) {
  const a = await actor(key).catch(() => null);
  if (!a) return null;
  try {
    const me = await apiGet(a, `${GATEWAY}/auth/me`);
    const u = me.body?.data?.user;
    if (!u) return null;
    return { key, caps: new Set(u.capabilities ?? []), orgId: u.org_id ?? null, userId: u.id ?? null, tenantId: u.tenant_id ?? null, orgName: u.org_name ?? null };
  } finally { await a.close(); }
}
export async function allSessions(keys = ALL_ROLES) {
  const out = {};
  for (const k of keys) { const s = await sessionInfo(k); if (s) out[k] = s; }
  return out;
}

// Who may DECIDE a request raised by `world.empId` that is assigned to `assignedApproverId`, as the
// platform defines it: holds the capability, acts in the request's org, is the assigned approver or holds
// hr.leave.admin (override), and passes hr.can_approve_leave (never the requester, in the chain / rank / admin).
export function decisionAllowList(world, sessions, capKey, assignedApproverId) {
  return Object.values(sessions).filter((s) =>
    s.caps.has(capKey) && s.orgId === world.orgId && s.userId !== world.empId &&
    (s.userId === assignedApproverId || s.caps.has(CAP.ADMIN)) &&
    canApproveSql(world.orgId, s.userId, world.empId)).map((s) => s.key);
}


// Tolerant capability matrix: for endpoints whose SUCCESS depends on per-role business context (policy, balance,
// branch) that the harness cannot give every login. Grades only authorisation:
//   lacks the capability -> must be refused (401/403/404) and must not persist anything
//   holds the capability -> must NOT be refused with 403 (a 2xx or a business 400/409/422 both prove the gate passed)
//   any 5xx is a defect either way.
// act(a, role) -> {status, body}; persisted(role) -> bool; cleanup(role).
export async function capabilityGrade({ sessions, roles = ALL_ROLES, capKey, tool = TOOL, area, tab, action, method = 'POST', endpoint, act, persisted = null, cleanup = null, fail, observe = ['super_admin'] }) {
  const out = [];
  for (const role of roles) {
    const s = sessions[role]; if (!s) continue;
    const a = await actor(role).catch(() => null); if (!a) continue;
    let res = { status: 0, body: null };
    try { res = await act(a, role); } catch (e) { res = { status: -1, body: String(e.message).slice(0, 120) }; }
    const stuck = persisted ? await Promise.resolve().then(() => persisted(role)).catch(() => false) : null;
    try { if (cleanup) await cleanup(role); } catch { /* best effort */ }
    await a.close();
    const holds = s.caps.has(capKey);
    const refused = [401, 403, 404].includes(res.status);
    const ok2xx = res.status >= 200 && res.status < 300;
    const verdict = observe.includes(role) ? 'observed' : holds ? (refused ? 'under-permitted' : res.status >= 500 ? 'error' : 'ok') : (ok2xx || stuck ? 'OVER-PERMITTED' : refused ? 'ok' : res.status >= 500 ? 'error' : 'gate-skipped');
    console.log(`  ${role.padEnd(26)} cap=${holds ? 'Y' : 'n'} http=${String(res.status).padStart(4)} ${persisted ? `persisted=${stuck} ` : ''}${verdict}`);
    logAction({ tool, role, area, tab, action, method, endpoint, status: res.status, outcome: outcomeOf(res.status, persisted ? stuck : null), verified: persisted ? stuck : null, expected: holds ? 'authorised (2xx or business 4xx)' : 'denied', note: verdict === 'ok' ? '' : verdict });
    out.push({ role, status: res.status, verdict });
    const j2 = JSON.stringify(res.body ?? null).slice(0, 300);
    if (verdict === 'OVER-PERMITTED') fail(role.startsWith('msq_') ? 'critical' : 'high', role, `${action} without ${capKey}`, 'Refused (403)', `HTTP ${res.status}; persisted=${stuck}`, j2, `Gate ${endpoint} on ${capKey} (requireCapability) before the handler.`);
    else if (verdict === 'under-permitted') fail('medium', role, `${action} with ${capKey} granted`, 'Not refused by the capability gate', `HTTP ${res.status}`, j2, `Check the session capability and requireCapability on ${endpoint}.`);
    else if (verdict === 'gate-skipped') fail('medium', role, `${action} without ${capKey}: answered ${res.status} instead of 403`, '403 from requireCapability before validation/business rules', `HTTP ${res.status}`, j2, 'requireCapability must run before validate() and the handler.');
    else if (verdict === 'error') fail('high', role, `${action}: server error`, 'No 5xx', `HTTP ${res.status}`, j2, 'Map the thrown error to an AppError.');
  }
  return out;
}

// ── journal + findings ───────────────────────────────────────────────────────────
export function journal(role, area, action, method, endpoint, status, verified, expected, note = '', tab) {
  logAction({
    tool: TOOL, role, area, tab, action, method, endpoint, status,
    outcome: method === 'UI' && status == null ? (verified === false ? 'hidden' : 'visible') : outcomeOf(status ?? 0, verified),
    verified, expected, note,
  });
}
export function makeFail(pageName) {
  let count = 0;
  const fail = (severity, role, scenario, expected, actual, evidence, fix) => {
    count++;
    console.log(`  FINDING [${severity}] ${role}: ${scenario} -> ${String(actual).slice(0, 160)}`);
    record(TOOL, { severity, role, tool: TOOL, page: pageName, scenario, expected, actual,
      evidence: typeof evidence === 'string' ? evidence.slice(0, 500) : JSON.stringify(evidence ?? '').slice(0, 500), proposedSolution: fix });
  };
  fail.count = () => count;
  return fail;
}
export const j = (b) => JSON.stringify(b ?? null).slice(0, 300);

// ── UI helpers ──────────────────────────────────────────────────────────────────
// Run `fn` and resolve with the first response matching `match(method, url)`.
export async function withResponse(page, match, fn, timeout = 20000) {
  const wait = page.waitForResponse((r) => match(r.request().method(), r.url()), { timeout }).catch(() => null);
  await fn();
  const r = await wait;
  if (!r) return { status: null, url: null, body: null };
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status(), url: r.url(), body };
}
export const settle = async (page, ms = 1200) => {
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(ms);
};
// Turn what the browser logged during a UI action into findings. `allow` = [/regex/] for requests the
// scenario provoked on purpose (e.g. the 403 of a negative probe).
export function reportUiLog(fail, role, pageName, log, allow = []) {
  const okBad = (s) => allow.some((r) => r.test(s));
  const noise = /favicon|\/_next\/|hot-update|notifications\/stream|ERR_ABORTED|net::ERR_INTERNET|Failed to load resource: the server responded with a status of 40[134]/i;
  for (const e of [...log.pageErrors, ...log.consoleErrors].filter((x) => !noise.test(x) && !okBad(x)).slice(0, 5)) {
    fail('medium', role, `${pageName}: browser error during the flow`, 'No uncaught page error / console error', e, e, 'Fix the failing component or the request behind it.');
  }
  for (const b of log.badRequests.filter((x) => !noise.test(x) && !okBad(x)).slice(0, 8)) {
    const status = Number((b.match(/^(\d{3})/) || [])[1] || 0);
    fail(status >= 500 ? 'high' : 'low', role, `${pageName}: ${status >= 500 ? '5xx' : '4xx'} from the UI`, 'Every request the page itself issues succeeds for a legitimate user', b, b,
      status >= 500 ? 'Map the thrown error to an AppError and return a 4xx/2xx.' : 'Gate the call on the capability the user holds, or fix the failing endpoint.');
  }
}

// A tiny valid PNG (1x1) and PDF, for uploads.
export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const PDF_MIN = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

export { actor, apiGet, apiPost, apiPatch, apiDelete, simultaneously, readResp, scalar, rows, q, lit, purgeById };
