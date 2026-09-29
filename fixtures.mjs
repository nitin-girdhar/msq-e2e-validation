// Shared fixtures for the suites added in the 2026-09 coverage pass.
//
//   * purgeById()      — remove a THROWAWAY row the suite created, and whatever
//                        rows the product wrote that point at it, without
//                        knowing the schema up front (FKs are discovered live).
//   * restore journal  — crash-safe undo log for reversible config changes
//                        (tenant modules, weights, ...). Same doctrine as
//                        capability.mjs: journal BEFORE mutating, restore in a
//                        finally, and replay anything a killed run left behind.
//   * leakOf()         — does an error body leak backend internals?
//   * idsOf()          — pull ids out of whichever envelope a list endpoint used.
//
// Every suite that creates data marks it with e2eMarker() so a human (or
// purgeMarked()) can always tell harness rows from real ones.
import fs from 'node:fs';
import path from 'node:path';
import { q, scalar, rows, lit } from './db.mjs';
import { resultsDir, record } from './lib.mjs';

export const e2eMarker = (suite) => `e2e-${suite}-${Date.now()}`;

// ── FK-aware purge ───────────────────────────────────────────────────────────
const fkCache = new Map();
function referencingColumns(table) {
  if (fkCache.has(table)) return fkCache.get(table);
  const refs = rows(
    `SELECT n.nspname || '.' || c.relname, a.attname, a.attnotnull::text
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND con.confrelid = ${lit(table)}::regclass
        AND array_length(con.conkey, 1) = 1`,
    ['table', 'column', 'notnull'],
  );
  fkCache.set(table, refs);
  return refs;
}

const idColCache = new Map();
function hasIdColumn(table) {
  if (!idColCache.has(table)) {
    idColCache.set(table, Number(scalar(`SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema || '.' || table_name = ${lit(table)} AND column_name = 'id'`)) > 0);
  }
  return idColCache.get(table);
}

// Delete one row the harness created. For each FK pointing at it: a NULLABLE
// column is set to NULL (never delete someone else's row just because it
// references ours — e.g. another user's manager_id), a NOT NULL column's rows
// are deleted (they cannot exist without the parent: mappings, weights, HR
// profile, audit lines written about the throwaway). Falls back to a soft
// delete when a trigger or deeper FK refuses. Returns 'deleted' | 'soft' | 'kept'.
export function purgeById(table, id, depth = 0) {
  if (!id) return 'kept';
  for (const ref of referencingColumns(table)) {
    if (ref.table === table && ref.column === 'id') continue;
    try {
      if (ref.notnull === 'true') {
        // Children of the child (e.g. weights under a user_org_mapping row) —
        // only when the child HAS an id column. Selecting id from one that does
        // not (hr.employee_profiles, lms.lead_assignment_weights) used to throw
        // into the catch below and skip this child's DELETE too, so the parent
        // delete failed and throwaway users leaked as soft-deleted rows.
        if (depth < 2 && hasIdColumn(ref.table)) {
          const childIds = rows(`SELECT id FROM ${ref.table} WHERE ${ref.column} = ${lit(id)}`, ['id']).map((r) => r.id).filter(Boolean);
          for (const cid of childIds) purgeById(ref.table, cid, depth + 1);
        }
        q(`DELETE FROM ${ref.table} WHERE ${ref.column} = ${lit(id)}`);
      } else {
        q(`UPDATE ${ref.table} SET ${ref.column} = NULL WHERE ${ref.column} = ${lit(id)}`);
      }
    } catch { /* table without an id column, trigger refusal — fall through */ }
  }
  try {
    q(`DELETE FROM ${table} WHERE id = ${lit(id)}`);
    // db.q runs DELETEs as root_service, the soft_delete_row() trigger's
    // hard-delete path; still verify rather than trust the command tag.
    return Number(scalar(`SELECT COUNT(*) FROM ${table} WHERE id = ${lit(id)}`)) === 0 ? 'deleted' : 'soft';
  } catch {
    try {
      const cols = rows(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema || '.' || table_name = ${lit(table)} AND column_name IN ('is_deleted','is_active')`,
        ['c'],
      ).map((r) => r.c);
      if (!cols.length) return 'kept';
      q(`UPDATE ${table} SET ${cols.map((c) => (c === 'is_deleted' ? 'is_deleted = TRUE' : 'is_active = FALSE')).join(', ')} WHERE id = ${lit(id)}`);
      return 'soft';
    } catch { return 'kept'; }
  }
}

export const userIdByEmail = (email) => scalar(`SELECT id FROM iam.users WHERE email = ${lit(String(email).toLowerCase())} LIMIT 1`);

// Remove every harness-created user whose email carries the marker domain.
// Real users never use @e2e.local, so this cannot touch production-refresh rows.
export function purgeE2eUsers(like = '%@e2e.local') {
  const ids = rows(`SELECT id FROM iam.users WHERE email LIKE ${lit(like)}`, ['id']).map((r) => r.id);
  const out = { deleted: 0, soft: 0, kept: 0 };
  for (const id of ids) out[purgeById('iam.users', id)]++;
  return out;
}

// ── Restore journal ──────────────────────────────────────────────────────────
// Each entry is { key, label, sql[] } — the SQL that puts things back. Written
// BEFORE the mutation so a killed process can be undone from cold.
const JOURNAL = path.join(resultsDir, 'restore-journal.json');
const readJournal = () => { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch { return []; } };
const writeJournal = (j) => { fs.mkdirSync(resultsDir, { recursive: true }); fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 2)); };

export function journalRestore(key, label, sqlStatements) {
  const j = readJournal().filter((e) => e.key !== key);
  j.push({ key, label, sql: sqlStatements, at: new Date().toISOString() });
  writeJournal(j);
}

export function runRestore(key) {
  const j = readJournal();
  const entry = j.find((e) => e.key === key);
  if (!entry) return false;
  for (const s of entry.sql) q(s);
  writeJournal(j.filter((e) => e.key !== key));
  return true;
}

// Replay everything still pending — call at suite start (a previous run died
// mid-mutation) and from restore.mjs at the start and end of run-all.
export function restorePending(prefix = '') {
  const j = readJournal();
  const done = [];
  for (const e of j.filter((x) => x.key.startsWith(prefix))) {
    try { for (const s of e.sql) q(s); done.push(e.key); } catch (err) {
      console.log(`  !! restore '${e.key}' failed: ${String(err.message).split('\n')[0]}`);
    }
  }
  writeJournal(j.filter((e) => !done.includes(e.key)));
  return done;
}

// ── Response inspection ──────────────────────────────────────────────────────
// A leaked internal is a defect on its own: stack frames, file paths, SQL, PG
// error text or constraint names tell an attacker the schema and the stack.
const LEAK_RX = /(\bat [\w$.<>]+ \(|node_modules|\/src\/[\w/.-]+\.ts|\.ts:\d+:\d+|\bSELECT\b[\s\S]{0,80}\bFROM\b|\bINSERT INTO\b|syntax error at or near|relation "[^"]+" does not exist|violates [a-z ]*constraint|duplicate key value|column "[^"]+" (does not exist|of relation)|invalid input syntax for type|current transaction is aborted|ECONNREFUSED|drizzle|ZodError)/i;
export function leakOf(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const m = s.match(LEAK_RX);
  return m ? s.slice(Math.max(0, m.index - 60), m.index + 140) : null;
}

export function idsOf(body) {
  const arr = body?.data?.items ?? body?.data?.rows ?? body?.data?.data ?? body?.data ?? body?.items ?? body;
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => x?.id ?? x?.user_id ?? x?.lead_id).filter(Boolean);
}

export const isOk = (s) => s >= 200 && s < 300;
export const isDenied = (s) => s === 401 || s === 403 || s === 404;

// Findings helper bound to one tool/page so suites stay terse.
export function finder(tool, page) {
  return (severity, role, scenario, expected, actual, evidence, proposedSolution) => record(tool, {
    severity, role, tool, page, scenario, expected, actual,
    evidence: String(evidence ?? '').slice(0, 600), proposedSolution,
  });
}

// A leave type the user can actually apply for: one with an ACTIVE policy for
// the user's branch (or tenant-wide). The suites used to hardcode 'casual', and
// a production refresh where only 'sick' has a live policy turned every leave
// suite into a false "apply failed". Prefers casual when it is available.
export function leaveTypeFor(email) {
  return scalar(`SELECT lt.name FROM hr.leave_policies p
      JOIN hr.leave_types lt ON lt.id = p.leave_type_id
      JOIN iam.users u ON u.email = ${lit(String(email).toLowerCase())}
      JOIN entity.organizations o ON o.id = u.org_id
     WHERE p.is_active AND NOT p.is_deleted AND p.tenant_id = o.tenant_id
       AND (p.org_id = u.org_id OR p.org_id IS NULL) AND p.applicable_from <= current_date
     ORDER BY (lt.name = 'casual') DESC, p.min_notice_days, lt.name LIMIT 1`) ?? 'casual';
}

// Seed a leave balance directly (an 'adjustment' ledger row). A precondition,
// not the thing under test: the product's own adjustment endpoint is gated on
// a capability that org_admin does not hold in every tenant, and a suite about
// apply/approve must not turn that into "apply failed". Callers delete by note.
export function seedLeaveBalance(email, leaveTypeName, amount, note) {
  return q(`INSERT INTO hr.leave_ledger (user_id, org_id, leave_type_id, entry_type, amount, effective_date, note)
    SELECT u.id, u.org_id, lt.id, 'adjustment', ${Number(amount)}, current_date, ${lit(note)}
      FROM iam.users u JOIN entity.organizations o ON o.id = u.org_id
      JOIN hr.leave_types lt ON lt.name = ${lit(leaveTypeName)} AND lt.tenant_id = o.tenant_id
     WHERE u.email = ${lit(String(email).toLowerCase())} RETURNING id`).filter((r) => r[0]).length;
}
