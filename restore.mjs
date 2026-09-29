// Put the database back the way the suites found it.
//
// Suites that change configuration journal the undo BEFORE the change
// (fixtures.mjs journalRestore -> results/restore-journal.json; capability.mjs
// -> results/capability-overrides.json). A normal run restores in its own
// `finally`; this replays whatever a killed / timed-out run left behind.
// run-all.mjs calls it before the first stage and after the last one.
//
//   node restore.mjs                   # replay pending journals
//   node restore.mjs --purge-residue   # also delete harness rows by marker
import { dbReachable } from './db.mjs';
import { restorePending, purgeE2eUsers, purgeById } from './fixtures.mjs';
import { loadJournal, restoreAll } from './capability.mjs';
import { rows } from './db.mjs';

if (!dbReachable()) { console.log('restore: DB not reachable — nothing done'); process.exit(0); }

const done = restorePending();
console.log(`restore: config journal entries replayed: ${done.length ? done.join(', ') : 'none'}`);

const pendingCaps = loadJournal();
const restoredCaps = pendingCaps ? restoreAll() : 0;
console.log(`restore: capability overrides restored: ${restoredCaps}`);

if (process.argv.includes('--purge-residue')) {
  console.log(`restore: e2e users purged: ${JSON.stringify(purgeE2eUsers())}`);
  const sets = [
    ['lms.marketing_leads', `SELECT id FROM lms.marketing_leads WHERE first_name LIKE 'E2E-%'`],
    ['marketing.campaign_type_rules', `SELECT r.id FROM marketing.campaign_type_rules r JOIN marketing.campaign_types t ON t.id=r.campaign_type_id WHERE t.name LIKE 'e2e\\_%' ESCAPE '\\' OR r.pattern LIKE 'e2e\\_%' ESCAPE '\\'`],
    ['marketing.campaign_types', `SELECT id FROM marketing.campaign_types WHERE name LIKE 'e2e\\_%' ESCAPE '\\'`],
    ['task.tasks', `SELECT id FROM task.tasks WHERE title LIKE 'E2E-%'`],
    ['task.task_lists', `SELECT id FROM task.task_lists WHERE name LIKE 'E2E-%'`],
  ];
  for (const [table, sql] of sets) {
    let ids = [];
    try { ids = rows(sql, ['id']).map((r) => r.id); } catch { continue; }
    for (const id of ids) purgeById(table, id);
    console.log(`restore: ${table} residue purged: ${ids.length}`);
  }
}
