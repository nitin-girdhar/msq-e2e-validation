// Orchestrator: run the full validation pass in order and produce SUMMARY.md.
// Built to be left running unattended (overnight) against the local stack.
//
//   node run-all.mjs                 # everything
//   node run-all.mjs --only=lms,hr   # a subset of stages (by tag)
//   node run-all.mjs --skip-auth     # reuse existing .auth/ storage states
//   node run-all.mjs --keep-results  # do not archive the previous results/
//
// Stages, in order:
//   preflight -> restore -> auth -> data health -> breadth crawls ->
//   security sweeps -> depth (real writes, per product) -> cross-tenant ->
//   capability / entitlement toggles -> concurrency -> visual -> analysis ->
//   restore -> report
//
// Each stage is a child `node` process with a wall-clock timeout, so one hung
// or crashed suite never takes the night down; its exit code, duration and
// timeout are written to results/run-ledger.json and shown at the top of
// SUMMARY.md, so "no findings" is never confused with "never ran".
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dir, resultsDir } from './lib.mjs';

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
const skipAuth = args.includes('--skip-auth');
const skipPreflight = args.includes('--skip-preflight');
const keepResults = args.includes('--keep-results');
const want = (tag) => only.length === 0 || only.includes(tag);

const MIN = 60 * 1000;
const STAGES = [
  // Preflight first: if the product drifted from what the suites assume,
  // everything after this reports harness drift as if it were product defects.
  // read_only fixture users must exist before preflight checks every roles.json login.
  { tag: 'provision', script: 'provision-readonly.mjs', always: true },
  { tag: 'preflight', skip: skipPreflight, script: 'preflight.mjs', gate: true, always: true },
  // Undo anything a previous killed run left mutated (config journals).
  { tag: 'restore', script: 'restore.mjs', always: true },
  { tag: 'auth', skip: skipAuth, script: 'auth-setup.mjs', always: true, timeout: 20 * MIN },

  // Read-only invariants — cheap, and the most likely to explain later failures.
  { tag: 'data', script: 'suites/data/data-health.mjs' },

  // Breadth — every role over every route, all controls.
  { tag: 'core', script: 'suites/core/deep-crawl-core.mjs', timeout: 60 * MIN },
  { tag: 'lookup', script: 'suites/core/deep-crawl-lookup.mjs', timeout: 90 * MIN },
  { tag: 'lms', script: 'suites/lms/deep-crawl-lms.mjs', timeout: 90 * MIN },
  { tag: 'hr', script: 'suites/hr/deep-crawl-hr.mjs', timeout: 90 * MIN },
  { tag: 'todo', script: 'suites/todo/deep-crawl-todo.mjs', timeout: 60 * MIN },
  { tag: 'admin', script: 'suites/admin/deep-crawl-admin.mjs', timeout: 60 * MIN },
  { tag: 'core', script: 'suites/core/core-07-lookup-admin-authz.mjs' },
  { tag: 'auth', script: 'auth-refresh.mjs', always: true },

  // Security — every gateway route as every login + anonymous; public edge.
  { tag: 'security', script: 'suites/security/api-surface-sweep.mjs', timeout: 60 * MIN },
  { tag: 'security', script: 'suites/security/public-edge.mjs' },
  { tag: 'security', script: 'suites/security/public-api-v2.mjs' },
  { tag: 'core', script: 'suites/core/switch-org.mjs' },
  { tag: 'core', script: 'suites/core/account-session-lifecycle.mjs' },
  { tag: 'core', script: 'suites/core/branding.mjs' },
  { tag: 'core', script: 'suites/core/branding-ownership.mjs' },
  { tag: 'core', script: 'suites/core/auth-recovery.mjs' },
  { tag: 'core', script: 'suites/core/auth-screens.mjs' },
  { tag: 'platform', script: 'suites/platform/push-and-stream.mjs' },
  { tag: 'platform', script: 'suites/platform/push-flag-and-stream.mjs' },

  // Depth — real writes, graded across the role ladder, verified in Postgres.
  { tag: 'lms', script: 'suites/lms/lms-crud-matrix.mjs' },
  { tag: 'lms', script: 'suites/lms/lead-transfer.mjs' },
  { tag: 'lms', script: 'suites/lms/campaign-types-rules.mjs' },
  { tag: 'lms', script: 'suites/lms/analytics-scope.mjs' },
  { tag: 'lms', script: 'suites/lms/lms-whatsapp-send.mjs' },
  { tag: 'lms', script: 'suites/lms/bulk-assign.mjs' },
  { tag: 'lms', script: 'suites/lms/public-report-api.mjs' },
  { tag: 'lms', script: 'suites/lms/public-read-api.mjs' },
  { tag: 'lms', script: 'suites/lms/meta-routing-and-weights.mjs' },
  { tag: 'lms', script: 'suites/lms/meta-console-1-70-authz.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-admin-matrix.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-employees-reports.mjs' },
  { tag: 'hr', script: 'suites/hr/attendance-geofence-guard.mjs' },
  { tag: 'hr', script: 'suites/hr/attendance-face-enroll.mjs' },
  { tag: 'hr', script: 'suites/hr/attendance-split-shift.mjs' },
  { tag: 'hr', script: 'suites/hr/leave-lifecycle.mjs' },
  { tag: 'hr', script: 'suites/hr/regularization-lifecycle.mjs' },
  { tag: 'hr', script: 'suites/hr/regularization-window.mjs' },
  { tag: 'hr', script: 'suites/hr/geo-exceptions.mjs' },
  { tag: 'hr', script: 'suites/hr/request-detail-approval-chain.mjs' },
  { tag: 'hr', script: 'suites/hr/request-detail-idor.mjs' },
  { tag: 'hr', script: 'suites/hr/monthly-summary-wfh.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-announcements-assets.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-attendance-role-matrix.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-attendance-ui-flows.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-documents-vault.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-payroll.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-people-role-matrix.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-people-ui.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-profile-360.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-punch-hub-admin.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-roster-planner.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-swap-desk.mjs' },
  { tag: 'hr', script: 'suites/hr/leave-apply-v2.mjs' },
  { tag: 'hr', script: 'suites/hr/leave-comp-off.mjs' },
  { tag: 'hr', script: 'suites/hr/leave-encashment.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-taxonomy-holidays.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-self-routes-dossier.mjs' },
  { tag: 'todo', script: 'suites/todo/task-visibility-matrix.mjs' },
  { tag: 'todo', script: 'suites/todo/task-comments-lists.mjs' },
  { tag: 'todo', script: 'suites/todo/tasks-v2.mjs' },
  { tag: 'todo', script: 'suites/todo/task-soft-delete.mjs' },
  { tag: 'admin', script: 'suites/admin/lookup-crud.mjs' },
  { tag: 'admin', script: 'suites/admin/user-management.mjs' },
  { tag: 'admin', script: 'suites/admin/team-user-contracts.mjs' },
  { tag: 'admin', script: 'suites/admin/lookup-module-nav.mjs' },
  { tag: 'admin', script: 'suites/admin/admin-web-console.mjs' },

  // UI round trip — real writes through the browser, verified in Postgres, per role.
  { tag: 'ui', script: 'suites/ui/ui-write-roundtrip.mjs', timeout: 60 * MIN },

  // Cross-tenant isolation: log in as tenant B and try to see/touch tenant A.
  { tag: 'tenant', script: 'suites/tenant/cross-tenant-isolation.mjs' },
  { tag: 'tenant', script: 'suites/tenant/cross-tenant-hr-config.mjs' },
  { tag: 'tenant', script: 'suites/tenant/cross-tenant-new-modules.mjs' },

  // Authorization / entitlement config toggles — reversible, journalled, late:
  // everything that assumes baseline grants has already run.
  { tag: 'auth', script: 'auth-refresh.mjs', always: true },
  // 1.76.0 capability walls: read-only, so it runs before the toggles that reshape grants.
  { tag: 'capability', script: 'suites/capability/capability-walls.mjs' },
  { tag: 'capability', script: 'suites/capability/capability-toggle.mjs' },
  { tag: 'capability', script: 'suites/admin/capability-matrix-ui.mjs' },
  { tag: 'capability', script: 'suites/admin/sa-console.mjs' },

  // Multi-user conflicts.
  { tag: 'concurrency', script: 'suites/concurrency/lms-lead-lost-update.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/lms-lead-transfer-race.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/hr-leave-approval-race.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/todo-task-double-edit.mjs' },

  // Look and feel across phone/tablet/laptop/desktop.
  { tag: 'visual', script: 'suites/visual/responsive-audit.mjs', timeout: 90 * MIN },
  { tag: 'visual', script: 'suites/visual/text-size-scaling.mjs', timeout: 60 * MIN },

  // Offline analysis over the crawl output.
  { tag: 'analysis', script: 'suites/core/tab-authz-consistency.mjs' },

  { tag: 'restore', script: 'restore.mjs', always: true },
];

// ── Fresh results per run ───────────────────────────────────────────────────
// report.mjs folds EVERY results/findings-*.json, so without this a night's
// SUMMARY.md mixes tonight's findings with every earlier run's.
const KEEP = new Set(['restore-journal.json', 'capability-overrides.json']);
if (!keepResults && !only.length && fs.existsSync(resultsDir)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = path.join(resultsDir, '_archive', stamp);
  const entries = fs.readdirSync(resultsDir).filter((f) => !f.startsWith('_archive') && !KEEP.has(f));
  if (entries.length) {
    fs.mkdirSync(archive, { recursive: true });
    for (const f of entries) fs.renameSync(path.join(resultsDir, f), path.join(archive, f));
    console.log(`archived previous results (${entries.length} entries) -> results/_archive/${stamp}`);
  }
}
fs.mkdirSync(resultsDir, { recursive: true });

const ledger = [];
const ledgerFile = path.join(resultsDir, 'run-ledger.json');
const writeLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify({ startedAt: ledger[0]?.startedAt, stages: ledger }, null, 2));

// ── Laptop: stay awake for the whole run ─────────────────────────────────────
// An overnight run on a laptop dies the moment Windows sleeps (browsers,
// docker and the dev servers all freeze; every in-flight stage then times out).
// Hold ES_SYSTEM_REQUIRED from a helper PowerShell that watches this process
// and exits with it, so the request never outlives the run. The display may
// still turn off. Opt out with E2E_ALLOW_SLEEP=1.
let keepAwake = null;
if (process.platform === 'win32' && process.env.E2E_ALLOW_SLEEP !== '1') {
  const ps = [
    '$sig = \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\';',
    '$k = Add-Type -MemberDefinition $sig -Name E2eAwake -Namespace Win32 -PassThru;',
    '[void]$k::SetThreadExecutionState([uint32]"0x80000001");',
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
  ].join(' ');
  try {
    keepAwake = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    keepAwake.on('error', () => { keepAwake = null; });
    console.log('keep-awake: holding the system awake for this run (E2E_ALLOW_SLEEP=1 to disable)');
  } catch { keepAwake = null; }
}
const releaseAwake = () => { try { keepAwake?.kill(); } catch {} };
process.on('exit', releaseAwake);

// Kill a stage AND everything it started. A timed-out suite leaves Chromium
// processes behind; on Windows killing only the node child orphans them, and a
// night of orphans exhausts the laptop's RAM for every later stage.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}

function run(stage) {
  const full = path.join(dir, stage.script);
  const startedAt = new Date().toISOString();
  console.log(`\n========== ${stage.script} ==========`);
  if (!fs.existsSync(full)) {
    ledger.push({ tag: stage.tag, script: stage.script, startedAt, status: 'missing', seconds: 0 });
    writeLedger();
    console.log(`!! ${stage.script} does not exist`);
    return Promise.resolve(false);
  }
  const limit = stage.timeout ?? 30 * MIN;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [full], { stdio: 'inherit', cwd: dir, windowsHide: true, detached: process.platform !== 'win32' });
    let timedOut = false;
    let done = false;
    let grace = null;
    // After the kill, do NOT wait for 'exit' indefinitely: a grandchild wedged
    // on a hung `docker exec` (Rancher's Hyper-V socket hang) keeps the
    // inherited stdio open, 'exit' never fires, and the stage ran 537 min past
    // a 60 min limit on 2026-09-29. Give it 60 s, then move on regardless.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      grace = setTimeout(() => finish(null, 'SIGKILL-unconfirmed'), 60 * 1000);
    }, limit);
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const seconds = Math.round((Date.now() - t0) / 1000);
      const status = timedOut ? 'timeout' : code === 0 ? 'passed' : 'crashed';
      ledger.push({ tag: stage.tag, script: stage.script, startedAt, status, exitCode: code, signal, seconds });
      writeLedger();
      if (status !== 'passed') console.log(`!! ${stage.script} ${status} (exit ${code ?? signal}) after ${seconds}s`);
      resolve(status === 'passed');
    };
    child.on('exit', finish);
    child.on('error', (e) => { console.log(`!! could not start ${stage.script}: ${e.message}`); finish(-1, null); });
  });
}

for (const stage of STAGES) {
  if (stage.skip) { console.log(`\n== skip ${stage.script}`); continue; }
  if (!stage.always && !want(stage.tag)) continue;
  const passed = await run(stage);
  if (stage.gate && !passed) {
    console.log('\nPreflight reported drift between the product and the harness assumptions.');
    console.log('Aborting: a run against a drifted stack reports harness breakage as product defects.');
    console.log('Re-run with --skip-preflight once the harness is realigned, or `node preflight.mjs --warn` to see details.');
    releaseAwake();
    process.exit(1);
  }
}

console.log('\n========== report.mjs ==========');
await run({ tag: 'report', script: 'report.mjs' });
const bad = ledger.filter((s) => !['passed'].includes(s.status));
console.log(`\nDone. ${ledger.length} stage(s), ${bad.length} not clean${bad.length ? `: ${bad.map((s) => `${s.script}=${s.status}`).join(', ')}` : ''}.`);
console.log('See results/SUMMARY.md');
releaseAwake();
