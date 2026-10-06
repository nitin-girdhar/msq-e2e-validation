// Shared kit for the 2026-10 HR attendance/roster suites (schema 1.59 - 1.67):
//   hr-swap-desk.mjs, hr-roster-planner.mjs, hr-punch-hub-admin.mjs,
//   hr-attendance-role-matrix.mjs, hr-attendance-ui-flows.mjs
//
// What lives here (so every suite fixtures the SAME way and restores the SAME way):
//   * req()/me()        thin API helpers (gateway, real session cookies)
//   * fixtures          three E2E-* shifts, two peers on ONE manager with one open-ended
//                       assignment each, all journalled BEFORE they are written so a
//                       killed run is undone by restorePending('e2e-att')
//   * snapshot/restore  roster rows (assignments, requirements, publications) are
//                       snapshotted as JSON and put back EXACTLY, not just purged
//   * weekdays()        future working days that are not holidays / weekly offs
//   * the shared reporting wrappers (bug(), act())
//
// Actors (roles.json; no new users are created):
//   requester  fitness_trainer (Kishan)      swap.request, no swap.approve
//   peer       org_manager (Anup)            swap.request + swap.approve  (re-parented under the
//                                            requester's manager for the run, restored in finally)
//   approver   fitness_manager (Vishal)      assigned approver, roster.manage, admin.override
//
// All data is E2E-marked; roster rows are restored from the snapshot.
import { GATEWAY, record, roleMeta } from '../../lib.mjs';
import { actor, readResp } from '../../conc.mjs';
import { q, rows, scalar, lit } from '../../db.mjs';
import { journalRestore, runRestore, restorePending, leakOf } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';

export const TOOL = 'hr';
export const API = GATEWAY;
export const stamp = Date.now();
export const DEV_ROLES = { requester: 'fitness_trainer', peer: 'org_manager', approver: 'fitness_manager' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API ─────────────────────────────────────────────────────────────────────
export async function req(a, method, path, body, query) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const url = `${API}${path}${qs}`;
  const opt = { failOnStatusCode: false, ...(body !== undefined ? { data: body } : {}) };
  const m = method.toLowerCase();
  const res = m === 'get' ? await a.request.get(url, opt) : await a.request[m](url, opt);
  const r = await readResp(res);
  return { ...r, url: `${method} ${path}` };
}

// /auth/me, the authoritative "who is this session and what may it do".
export async function me(a) {
  const r = await req(a, 'GET', '/auth/me');
  const u = r.body?.data?.user ?? {};
  return { status: r.status, id: u.id, org_id: u.org_id, org_name: u.org_name, tenant_id: u.tenant_id, role: u.role, name: u.name ?? u.full_name, caps: new Set(u.capabilities ?? []), email: u.email };
}

// Open several actors; any that cannot be opened/authenticated come back as null.
export async function openActors(keys) {
  const out = {};
  for (const [name, key] of Object.entries(keys)) {
    try {
      const a = await actor(key);
      const m = await me(a);
      if (m.status !== 200) { console.log(`  ! ${name} (${key}) /auth/me -> ${m.status} — run auth-refresh.mjs`); await a.close(); out[name] = null; continue; }
      out[name] = Object.assign(a, { key, name, me: m });
    } catch (e) { console.log(`  ! ${name} (${key}) unavailable: ${String(e.message).slice(0, 80)}`); out[name] = null; }
  }
  return out;
}
export async function closeActors(map) { for (const a of Object.values(map)) { try { await a?.close(); } catch {} } }

// ── Reporting ───────────────────────────────────────────────────────────────
let findings = 0;
export const findingCount = () => findings;
export function bug(severity, role, page, scenario, expected, actual, evidence, proposedSolution) {
  findings++;
  record(TOOL, { severity, role, tool: TOOL, page, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 600), proposedSolution });
  console.log(`  FINDING [${severity}] ${role} · ${page} · ${scenario} -> ${String(actual).slice(0, 140)}`);
}
// Journal one action; `r` is a {status, body} API result (or null for UI-only).
export function act(role, area, action, method, endpoint, r, { verified = null, expected = null, note = '', tab = null, outcome = null } = {}) {
  logAction({
    tool: TOOL, role, area, tab, action, method, endpoint,
    status: r?.status ?? null, outcome: outcome ?? (r ? outcomeOf(r.status, verified) : 'unknown'),
    verified, expected, note,
  });
}
// A 5xx or a leaked internal on ANY response is a defect regardless of caller.
export function guard(role, scenario, r, page) {
  if (!r) return;
  if (r.status >= 500) bug('high', role, page ?? r.url, scenario, 'A clean 2xx / 4xx — never a 5xx', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 300), 'Map the thrown error to an AppError (400/403/404/409) in the service; check the service log for the stack.');
  const leak = leakOf(r.body);
  if (leak) bug('medium', role, page ?? r.url, scenario, 'Error bodies carry a message only', `Leaked backend internals: ${leak}`, JSON.stringify(r.body).slice(0, 300), 'Return the AppError message; never serialise driver/SQL/stack text.');
}
// Soft assertion: log PASS/FAIL, record a finding on FAIL. Returns the boolean.
export function check(ok, label, onFail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok && onFail) bug(...onFail);
  return ok;
}

// ── Dates ───────────────────────────────────────────────────────────────────
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const mondayOf = (iso) => addDays(iso, dowOf(iso) === 0 ? -6 : 1 - dowOf(iso));

// `n` future working days (Mon-Fri, not a holiday of the org), at least `ahead` days away and
// `gap` days apart so a swap on one never trips the 11 h rest rule of the next.
export function weekdays(orgId, n, { ahead = 3, gap = 3 } = {}) {
  const hol = new Set(rows(`SELECT holiday_date::text FROM hr.holidays WHERE org_id=${lit(orgId)} AND NOT is_deleted AND is_active`, ['d']).map((r) => r.d));
  const out = [];
  let d = addDays(todayIso(), ahead);
  while (out.length < n) {
    if (![0, 6].includes(dowOf(d)) && !hol.has(d)) { out.push(d); d = addDays(d, gap); } else d = addDays(d, 1);
  }
  return out;
}

// ── Snapshot / restore ──────────────────────────────────────────────────────
// The snapshot lives IN THE DATABASE (a scratch table public.e2e_snap_*), not in the journal:
// psql output is line-split by db.q(), so a JSON blob read back through it is truncated at the
// first row separator, and a Windows command line cannot carry a big literal anyway. The
// journalled undo is three short statements: delete the window, re-insert from the scratch
// table with an explicit column list, drop the scratch table. Bounds must be LITERALS (never
// now()/current_date) so the delete at restore time covers exactly the snapshotted window.
export function dbSnapshot(key, n, table, where) {
  const snapTbl = `public.e2e_snap_${String(key).replace(/[^a-z0-9]/gi, '_')}_${n}`;
  q(`DROP TABLE IF EXISTS ${snapTbl}`);
  q(`CREATE TABLE ${snapTbl} AS SELECT * FROM ${table} WHERE ${where}`);
  const cols = rows(`SELECT column_name FROM information_schema.columns WHERE table_schema || '.' || table_name = ${lit(table)} ORDER BY ordinal_position`, ['c']).map((r) => `"${r.c}"`).join(', ');
  const cnt = Number(scalar(`SELECT COUNT(*) FROM ${snapTbl}`));
  return {
    table, where, cnt, snapTbl,
    stmts: [`DELETE FROM ${table} WHERE ${where}`, `INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${snapTbl}`, `DROP TABLE IF EXISTS ${snapTbl}`],
  };
}
// ISO literal "n days ago" for snapshot windows.
export const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

// ── Fixtures ────────────────────────────────────────────────────────────────
// Builds the shared world. Everything it changes is registered in the restore journal first.
//   shifts A 08:00-12:00, B 12:00-16:00, C 16:00-20:00 (>= 11 h rest holds for any single-day swap)
//   requester <- A, peer <- B (open ended from today), peer re-parented under the approver
export async function buildFixtures(A, key = 'e2e-att-main') {
  restorePending('e2e-att'); // a previous killed run
  const req_ = A.requester.me, peer = A.peer.me, appr = A.approver.me;
  const orgId = req_.org_id;
  const users = [req_.id, peer.id];
  const fx = { key, orgId, tenantId: req_.tenant_id, requester: req_, peer, approver: appr, shifts: {}, snaps: [], origManager: null };

  // 1. Journal the undo FIRST.
  fx.origManager = scalar(`SELECT manager_id FROM iam.users WHERE id=${lit(peer.id)}`) || null;
  const assignSnap = dbSnapshot(key, 1, 'hr.shift_assignments', `user_id IN (${users.map(lit).join(',')})`);
  const reqSnap = dbSnapshot(key, 2, 'hr.shift_requirements', `org_id=${lit(orgId)}`);
  const pubSnap = dbSnapshot(key, 3, 'hr.roster_publications', `org_id=${lit(orgId)}`);
  fx.snaps = [assignSnap, reqSnap, pubSnap];
  console.log(`  snapshot: ${assignSnap.cnt} assignment(s), ${reqSnap.cnt} requirement(s), ${pubSnap.cnt} publication(s) held in scratch tables`);
  const undo = [
    `UPDATE iam.users SET manager_id=${fx.origManager ? lit(fx.origManager) : 'NULL'} WHERE id=${lit(peer.id)}`,
    `DELETE FROM hr.shift_swap_requests WHERE reason LIKE 'E2E-%' AND org_id=${lit(orgId)}`,
    ...assignSnap.stmts,
    `DELETE FROM hr.shift_requirements WHERE shift_id IN (SELECT id FROM hr.shifts WHERE org_id=${lit(orgId)} AND name LIKE 'E2E-ATT-%')`,
    ...reqSnap.stmts,
    ...pubSnap.stmts,
    `DELETE FROM hr.shifts WHERE org_id=${lit(orgId)} AND name LIKE 'E2E-ATT-%'`,
  ];
  journalRestore(key, 'HR attendance suites: shifts, assignments, requirements, publications, peer manager', undo);

  // 2. Build.
  for (const [k, s, e] of [['A', '08:00', '12:00'], ['B', '12:00', '16:00'], ['C', '16:00', '20:00']]) {
    const name = `E2E-ATT-${k}-${stamp}`;
    const id = scalar(`INSERT INTO hr.shifts (org_id, name, start_time, end_time) VALUES (${lit(orgId)}, ${lit(name)}, ${lit(s)}, ${lit(e)}) RETURNING id`);
    fx.shifts[k] = { id, name, start: s, end: e };
  }
  q(`DELETE FROM hr.shift_assignments WHERE user_id IN (${users.map(lit).join(',')})`);
  const today = todayIso();
  q(`INSERT INTO hr.shift_assignments (user_id, org_id, shift_id, effective_from) VALUES (${lit(req_.id)}, ${lit(orgId)}, ${lit(fx.shifts.A.id)}, ${lit(today)})`);
  q(`INSERT INTO hr.shift_assignments (user_id, org_id, shift_id, effective_from) VALUES (${lit(peer.id)}, ${lit(orgId)}, ${lit(fx.shifts.B.id)}, ${lit(today)})`);
  q(`UPDATE iam.users SET manager_id=${lit(appr.id)} WHERE id=${lit(peer.id)}`);
  // The requester must already report to the approver for the "shared manager" rule.
  fx.requesterManager = scalar(`SELECT manager_id FROM iam.users WHERE id=${lit(req_.id)}`);
  return fx;
}

export function teardownFixtures(fx) {
  try { return runRestore(fx.key); } catch (e) { console.log(`  !! restore failed: ${String(e.message).split('\n')[0]} — run restore.mjs`); return false; }
}

// ── DB reads ────────────────────────────────────────────────────────────────
// The shift NAME a person works on `date` according to hr.shift_assignments.
export const shiftOn = (userId, date) => scalar(`SELECT s.name FROM hr.shift_assignments a JOIN hr.shifts s ON s.id=a.shift_id
  WHERE a.user_id=${lit(userId)} AND NOT a.is_deleted AND a.is_active AND a.effective_from <= ${lit(date)}::date
    AND (a.effective_to IS NULL OR a.effective_to >= ${lit(date)}::date)`);
export const coverCount = (userId, date) => Number(scalar(`SELECT COUNT(*) FROM hr.shift_assignments a
  WHERE a.user_id=${lit(userId)} AND NOT a.is_deleted AND a.is_active AND a.effective_from <= ${lit(date)}::date
    AND (a.effective_to IS NULL OR a.effective_to >= ${lit(date)}::date)`));
export const swapRow = (id) => rows(`SELECT status, manager_id::text, acted_by::text, approver_comment FROM hr.shift_swap_requests WHERE id=${lit(id)}`, ['status', 'manager_id', 'acted_by', 'approver_comment'])[0] ?? null;
export const shortName = (fx, name) => Object.entries(fx.shifts).find(([, s]) => s.name === name)?.[0] ?? name;
export const roleMetaOf = roleMeta;
