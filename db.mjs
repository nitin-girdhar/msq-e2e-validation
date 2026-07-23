// Backend verification layer.
//
// The E2E premise is "change it in the UI, then prove the backend agrees".
// These helpers read the source-of-truth Postgres directly, through the same
// container the app uses (msq-db-server / db `platforms`), so a suite can
// assert on real rows after a UI action instead of trusting the screen.
//
// Read-mostly by design: use q()/one()/scalar() to observe. Nothing here
// mutates on your behalf — suites drive writes through the UI/API so the
// product's own authorization and business rules are exercised.
import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.MSQ_DB_CONTAINER || 'msq-db-server';
const DB = process.env.MSQ_DB_NAME || 'platforms';
const USER = process.env.MSQ_DB_USER || 'postgres';
const SEP = '<@col@>'; // unlikely to appear in real data; used to split columns.

// Run SQL and return an array of rows, each row an array of column strings.
// Uses `psql` inside the DB container so no local psql client is required.
export function q(sql) {
  const out = execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', USER, '-d', DB, '-A', '-F', SEP, '-t', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  // psql -t ends output with a trailing newline; drop only that final empty
  // element, not legitimate rows whose single column is an empty string.
  const parts = out.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => line.split(SEP));
}

// Same as q(), but maps each row to an object given a column-name list.
export function rows(sql, columns) {
  return q(sql).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

// First row (as array) or null.
export function one(sql) {
  const r = q(sql);
  return r.length ? r[0] : null;
}

// Single scalar value (first column of first row) or null.
export function scalar(sql) {
  const r = one(sql);
  return r ? r[0] : null;
}

// Convenience: COUNT(*) for a where-claused table.
export function count(table, where = 'TRUE') {
  return Number(scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`) ?? 0);
}

// True if the DB container is reachable — call at suite start so a suite can
// fail loudly ("DB not reachable") instead of silently skipping verification.
export function dbReachable() {
  try {
    return scalar('SELECT 1') === '1';
  } catch {
    return false;
  }
}

// SQL string-literal escaping for safely interpolating a value.
export const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
