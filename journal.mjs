// Action journal.
//
// `record()` only captures DEFECTS. That makes the final report a bug list and
// leaves the obvious question unanswered: what was actually exercised? This
// journals EVERY action a suite performs — successes included — so the report
// can say "as org_manager, on HR > Leave Admin > Policies tab, create policy ->
// allowed (201), verified in hr.leave_policies".
//
// Parallel-safe: suites run as several concurrent worker processes, so a shared
// append-rewrite file would lose entries to interleaved writes. Each process
// writes its own shard under results/actions/ and the reporter merges them.
import fs from 'node:fs';
import path from 'node:path';
import { resultsDir } from './lib.mjs';

const dir = path.join(resultsDir, 'actions');
const shard = path.join(dir, `actions-${process.pid}-${Date.now()}.json`);
const buffer = [];

/**
 * Log one action.
 *
 *  tool       – lms | hr | todo | lookup | capability | tenant | concurrency
 *  role       – the acting login (role name or actor/state key)
 *  area       – page or route the action belongs to ("Leave Admin", "/dashboard/leads")
 *  tab        – tab within that page, when applicable ("Policies")
 *  action     – human sentence: "create a leave policy"
 *  method     – GET | POST | PATCH | PUT | DELETE | UI
 *  endpoint   – API path or UI control that was driven
 *  status     – HTTP status (or null for pure-UI actions)
 *  outcome    – allowed | denied | error | no-op | hidden | visible
 *  verified   – true/false/null: did a backend read confirm the effect?
 *  expected   – what the harness expected (optional, for grading context)
 *  note       – anything else worth showing in the report
 */
export function logAction(entry) {
  buffer.push({ at: new Date().toISOString(), ...entry });
  flush();
}

let flushing = false;
function flush() {
  if (flushing) return;
  flushing = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(shard, JSON.stringify(buffer, null, 2));
  } catch {} finally { flushing = false; }
}

// Convenience: derive the outcome word from an HTTP status + verification.
export function outcomeOf(status, verified = null) {
  if (status === 0 || status === -1) return 'error';
  if (status >= 500) return 'error';
  if (status === 401 || status === 403 || status === 404) return 'denied';
  if (status >= 400) return 'error';
  if (status >= 200 && status < 300) {
    if (verified === false) return 'no-op';   // 2xx that changed nothing
    return 'allowed';
  }
  return 'unknown';
}

// Merge every shard — used by the reporter.
export function readAllActions() {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try { out.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Wipe the journal (call at the start of a full run so the report reflects
// THIS run, not an accumulation of every run since the folder was created).
export function resetActions() {
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) fs.unlinkSync(path.join(dir, f));
    return files.length;
  } catch { return 0; }
}
