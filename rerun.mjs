// Re-run individual stages of the last full pass IN PLACE.
//
// A full `run-all` takes hours. When a suite is fixed after the pass (a
// grading bug, stale expectation, wrong actor), re-running only that suite
// with `node suites/x.mjs` would APPEND its new findings next to the stale
// ones. This tool uses results/run-ledger.json to find the stage's original
// time window, drops every finding and action-journal shard recorded inside
// that window, re-runs the stage, and updates its ledger entry — so the report
// reflects one pass, not a mix of two gradings.
//
//   node rerun.mjs suites/data/data-health.mjs suites/security/public-edge.mjs
//   (then: node report.mjs && node gen-openissues.mjs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dir, resultsDir } from './lib.mjs';

const scripts = process.argv.slice(2);
if (!scripts.length) { console.log('usage: node rerun.mjs <suite.mjs> [...]'); process.exit(2); }

const ledgerFile = path.join(resultsDir, 'run-ledger.json');
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
const actionsDir = path.join(resultsDir, 'actions');

for (const script of scripts) {
  const idx = ledger.stages.map((s) => s.script).lastIndexOf(script);
  const entry = idx >= 0 ? ledger.stages[idx] : null;
  if (entry) {
    const from = Date.parse(entry.startedAt);
    const to = from + (entry.seconds + 5) * 1000;
    const inWindow = (at) => { const t = Date.parse(at); return t >= from && t <= to; };
    let dropped = 0;
    for (const f of fs.readdirSync(resultsDir).filter((f) => /^findings-.*\.json$/.test(f))) {
      const p = path.join(resultsDir, f);
      const all = JSON.parse(fs.readFileSync(p, 'utf8'));
      const keep = all.filter((x) => !(x.at && inWindow(x.at)));
      dropped += all.length - keep.length;
      fs.writeFileSync(p, JSON.stringify(keep, null, 2));
    }
    let shards = 0;
    if (fs.existsSync(actionsDir)) {
      for (const f of fs.readdirSync(actionsDir)) {
        const p = path.join(actionsDir, f);
        try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); if (a.length && inWindow(a[0].at)) { fs.unlinkSync(p); shards++; } } catch {}
      }
    }
    console.log(`\n== ${script}: dropped ${dropped} finding(s), ${shards} action shard(s) from its ${entry.startedAt} run`);
  } else {
    console.log(`\n== ${script}: not in the ledger — running fresh`);
  }
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, script)], { stdio: 'inherit', cwd: dir, windowsHide: true, timeout: 90 * 60 * 1000 });
  const rec = { tag: entry?.tag ?? 'rerun', script, startedAt, status: r.status === 0 ? 'passed' : r.error ? 'timeout' : 'crashed', exitCode: r.status, seconds: Math.round((Date.now() - t0) / 1000), rerun: true };
  if (idx >= 0) ledger.stages[idx] = rec; else ledger.stages.push(rec);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  console.log(`== ${script}: ${rec.status} in ${rec.seconds}s`);
}
