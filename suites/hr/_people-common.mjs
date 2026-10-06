// Shared plumbing for the HR people / payroll suites (hr-profile-360, hr-documents-vault,
// hr-announcements-assets, hr-payroll, hr-people-role-matrix, hr-people-ui).
//
// Not a suite itself (no top-level side effects beyond imports) — the suites import it.
//
//   suite(tool, page)  -> { api, check, find, close, summary }
//     api()   one HTTP call as an actor, auto-journalled (logAction) and auto-graded
//             against an `expect` list; a 5xx or a leaked backend internal in ANY response
//             is recorded as a finding no matter what the caller expected.
//     check() boolean assertion that records a finding when false.
//   who(actor)         live /auth/me facts (id, org, tenant, capability set) — the honest
//                      source for "what may this login do right now".
//   snapshotRow()      crash-safe (journalled) before-image of one DB row, restored in finally.
//   waitAudit()        polls audit.activities (the product writes it fire-and-forget).
import crypto from 'node:crypto';
import { APPS, GATEWAY, authFile, record } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { q, scalar, rows, lit } from '../../db.mjs';
import { leakOf, journalRestore, runRestore, purgeById } from '../../fixtures.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';
import fs from 'node:fs';

export const HR = `${APPS['hr-web']}/api/hr`;
export const HR_BASE = APPS['hr-web'];
export { GATEWAY, lit, q, scalar, rows, purgeById };
export const STAMP = Date.now();
export const MARK = `E2E-people-${STAMP}`;
export const uuid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── file fixtures ────────────────────────────────────────────────────────────
export const pdfBytes = (n = 600, tail = '') => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n', 'latin1');
  const t = Buffer.from(tail, 'latin1');
  return Buffer.concat([head, t, Buffer.alloc(Math.max(0, n - head.length - t.length), 0x20)]);
};
export const pngBytes = (n = 400) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, n - 8), 1)]);
export const jpgBytes = (n = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, n - 4), 2)]);
export const webpBytes = (n = 400) => Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'latin1'), Buffer.alloc(Math.max(0, n - 12), 3)]);
export const b64 = (buf) => Buffer.from(buf).toString('base64');

// ── actors ───────────────────────────────────────────────────────────────────
const handles = new Map();
const whoCache = new Map();
export const hasAuth = (key) => fs.existsSync(authFile(key));
export async function open(key) {
  if (!hasAuth(key)) return null;
  if (!handles.has(key)) handles.set(key, actor(key).catch(() => null));
  return handles.get(key);
}
export async function closeAll() {
  for (const p of handles.values()) { try { const a = await p; if (a) await a.close(); } catch { /* ignore */ } }
  handles.clear();
}

/** Live facts about a login from /auth/me (identity-service resolves caps right now). */
export async function who(a, { fresh = false } = {}) {
  if (!fresh && whoCache.has(a.stateKey)) return whoCache.get(a.stateKey);
  const r = await a.request.get(`${GATEWAY}/auth/me`, { failOnStatusCode: false });
  let u = null;
  try { u = (await r.json())?.data?.user ?? null; } catch { /* unauthenticated */ }
  const w = u ? { key: a.stateKey, id: u.id, email: u.email, org_id: u.org_id, tenant_id: u.tenant_id, role: u.role, name: u.name, caps: new Set(u.capabilities ?? []) } : null;
  if (w) whoCache.set(a.stateKey, w);
  return w;
}
export const holds = (w, ...keys) => !!w && keys.some((k) => w.caps.has(k));

/** An employee profile (not the actor) in the given org — for "act on someone else in my branch". */
export const otherEmployeeIn = (orgId, notUserId) => scalar(
  `SELECT ep.user_id FROM hr.employee_profiles ep JOIN iam.users u ON u.id = ep.user_id
    WHERE ep.org_id = ${lit(orgId)} AND NOT ep.is_deleted AND ep.is_active AND u.is_active AND ep.user_id <> ${lit(notUserId)}
    ORDER BY ep.created_at LIMIT 1`);
export const hasProfile = (userId, orgId) => Number(scalar(`SELECT count(*) FROM hr.employee_profiles WHERE user_id=${lit(userId)} AND org_id=${lit(orgId)} AND NOT is_deleted`)) > 0;

// ── DB helpers ───────────────────────────────────────────────────────────────
/** Poll until fn() is truthy (the product's audit/side effects are fire-and-forget). */
export async function waitFor(fn, { timeoutMs = 6000, stepMs = 400 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await sleep(stepMs);
  }
}
/** Rows of audit.activities for (action, subject) written since `sinceIso`. */
export const auditRows = (action, targetId, sinceIso) => rows(
  `SELECT id::text, performed_by::text, org_id::text, COALESCE(meta::text,'') FROM audit.activities
    WHERE action_type=${lit(action)} AND target_id=${lit(targetId)} AND created_at >= ${lit(sinceIso)}::timestamptz ORDER BY created_at`,
  ['id', 'by', 'org', 'meta']);
export const waitAudit = (action, targetId, sinceIso, n = 1) => waitFor(() => { const r = auditRows(action, targetId, sinceIso); return r.length >= n ? r : null; });

/**
 * Journalled before-image of ONE row. Returns restore() — run it in finally. The restore
 * SQL is written to the restore journal BEFORE the test mutates anything, so a killed run
 * is replayed by restore.mjs / restorePending.
 */
export function snapshotRow(key, table, keyCol, keyVal) {
  const json = scalar(`SELECT row_to_json(t)::text FROM ${table} t WHERE ${keyCol} = ${lit(keyVal)} LIMIT 1`);
  let sql;
  if (!json) sql = [`DELETE FROM ${table} WHERE ${keyCol} = ${lit(keyVal)}`];
  else {
    const o = JSON.parse(json);
    const sets = Object.entries(o).filter(([k]) => k !== keyCol && k !== 'updated_at')
      .map(([k, v]) => `${k} = ${v === null ? 'NULL' : lit(typeof v === 'object' ? JSON.stringify(v) : v)}`);
    sql = [`UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyCol} = ${lit(keyVal)}`];
  }
  journalRestore(key, `restore ${table} ${keyCol}=${keyVal}`, sql);
  return () => { try { runRestore(key); } catch (e) { console.log(`  !! restore ${key} failed: ${String(e.message).split('\n')[0]}`); } };
}
/** Journalled cleanup of E2E-created rows (hard delete under root_service), run in finally. */
export function journalPurge(key, label, statements) {
  journalRestore(key, label, statements);
  return () => { try { runRestore(key); } catch (e) { console.log(`  !! purge ${key} failed: ${String(e.message).split('\n')[0]}`); } };
}

// ── per-suite recorder ───────────────────────────────────────────────────────
const SETS = {
  ok: [200, 201, 204],
  created: [201],
  denied: [401, 403, 404],
  forbidden: [403],
  invalid: [400, 422],
  conflict: [409],
  missing: [404],
  notok: [400, 401, 403, 404, 409, 422],
};
const dflt = (s) => (typeof s === 'string' ? SETS[s] : s);

export function suite(tool, page, { area = page } = {}) {
  const t0 = new Date(Date.now() - 2000).toISOString();
  let findings = 0, checks = 0, failed = 0;
  const find = (severity, role, scenario, expected, actual, evidence, proposedSolution) => {
    findings++;
    record(tool, { severity, role, tool, page, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 600), proposedSolution });
  };

  /**
   * One HTTP call as `a`. opts: { body, label, expect: 'ok'|'denied'|[200,..], sev, raw, headers, tab, note, verified }
   * Returns { status, body, headers, resp }.
   */
  async function api(a, method, path, opts = {}) {
    const { body, label = `${method} ${path}`, expect = null, sev = null, raw = false, headers, tab = null, note = '', verified = null, multipart = null, allow5xx = false } = opts;
    const url = /^https?:/.test(path) ? path : `${HR}${path}`;
    let resp, status = 0, data = null, buf = null;
    try {
      const init = { failOnStatusCode: false, ...(headers ? { headers } : {}) };
      if (body !== undefined) init.data = body;
      if (multipart) init.multipart = multipart;
      resp = await a.request.fetch(url, { method, ...init });
      status = resp.status();
      if (raw) buf = await resp.body().catch(() => Buffer.alloc(0));
      else { const txt = await resp.text().catch(() => ''); try { data = JSON.parse(txt); } catch { data = txt.slice(0, 400); } }
    } catch (e) { status = -1; data = String(e.message).slice(0, 200); }
    const res = { status, body: data, buf, headers: resp ? resp.headers() : {}, resp };
    const exp = expect ? dflt(expect) : null;
    const [mth, ep] = [method, path.split('?')[0]];
    logAction({
      tool, role: a.stateKey, area, tab, action: label, method: mth, endpoint: ep, status,
      outcome: outcomeOf(status, verified), verified,
      expected: exp ? (exp.some((s) => s < 300) ? 'allowed' : 'denied/invalid') : 'observed only', note,
    });
    if (!allow5xx && status >= 500) {
      find('high', a.stateKey, `${label} — server error`, 'A clean 2xx, or a 4xx with a readable message — never a 5xx',
        `HTTP ${status}`, JSON.stringify({ path, body: typeof body === 'object' ? Object.keys(body ?? {}) : body, response: data }).slice(0, 500),
        'Validate/cast the input before it reaches SQL (uuid / calendar date) and map the failure to an AppError (400/404) instead of a plain Error.');
    }
    const leak = leakOf(data);
    if (leak) find('medium', a.stateKey, `${label} — response leaks backend internals`, 'A generic message', leak, path, 'Return only the AppError message; keep SQL/constraint text in the server log.');
    if (exp && !exp.includes(status) && !(status >= 500 && !allow5xx)) {
      const gotOk = status >= 200 && status < 300;
      const wantDenied = exp.every((s) => s >= 400);
      find(sev ?? (gotOk && wantDenied ? 'high' : 'medium'), a.stateKey, label,
        `HTTP ${exp.join('/')}`, `HTTP ${status}`, JSON.stringify(data).slice(0, 400),
        gotOk && wantDenied ? 'Enforce the capability / ownership / org fence server-side for this route.' : 'Check the route guard and validation for this case.');
    }
    const tag = exp ? (exp.includes(status) ? 'ok  ' : 'FAIL') : 'info';
    console.log(`  ${tag} ${a.stateKey.padEnd(20)} ${String(status).padStart(3)} ${label}`);
    return res;
  }

  function check(cond, severity, role, scenario, expected, actual, evidence = '', fix = '') {
    checks++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${String(role).padEnd(20)} ${scenario}`);
    if (!cond) { failed++; find(severity, role, scenario, expected, actual, evidence, fix); }
    logAction({ tool, role, area, action: scenario, method: 'DB', endpoint: 'verify', status: null, outcome: cond ? 'allowed' : 'error', verified: !!cond, expected: expected, note: cond ? '' : String(actual).slice(0, 200) });
    return !!cond;
  }

  const summary = () => {
    console.log(`\n${tool}/${page}: ${checks} check(s), ${failed} failed, ${findings} finding(s) recorded.`);
    return { checks, failed, findings };
  };
  return { api, check, find, summary, since: t0 };
}

/** Run `fn` and always run `cleanups` after, newest first, even when fn throws. */
export async function guarded(fn, cleanups) {
  try { await fn(); } finally {
    for (const c of [...cleanups].reverse()) { try { await c(); } catch (e) { console.log(`  !! cleanup failed: ${String(e.message).split('\n')[0]}`); } }
    await closeAll();
  }
}
