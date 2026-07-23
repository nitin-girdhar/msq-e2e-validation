// Orchestrator: run the full validation pass in order and produce SUMMARY.md.
//
//   node run-all.mjs                 # everything
//   node run-all.mjs --only=lms,hr   # a subset of stages
//   node run-all.mjs --skip-auth     # reuse existing .auth/ storage states
//
// Stages, in order:
//   auth         -> auth-setup.mjs (login every role, save storage states)
//   deep-crawl   -> per-tool deep crawlers (all roles × all routes × controls)
//   concurrency  -> multi-user conflict scenarios
//   report       -> aggregate findings into results/SUMMARY.md
//
// Each stage is a child `node` process so one crash never takes down the run;
// a non-zero exit is logged and the pass continues to the reporter.
import { spawnSync } from 'node:child_process';
import { dir } from './lib.mjs';
import path from 'node:path';

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
const skipAuth = args.includes('--skip-auth');
const skipPreflight = args.includes('--skip-preflight');
const want = (tag) => only.length === 0 || only.includes(tag);

const STAGES = [
  // Preflight first: if the product drifted from what the suites assume,
  // everything after this reports harness drift as if it were product defects.
  { tag: 'preflight', skip: skipPreflight, script: 'preflight.mjs', gate: true },
  { tag: 'auth', skip: skipAuth, script: 'auth-setup.mjs' },

  // Breadth — every role over every route, all controls.
  { tag: 'core', script: 'suites/core/deep-crawl-core.mjs' },
  { tag: 'lookup', script: 'suites/core/deep-crawl-lookup.mjs' },
  { tag: 'lms', script: 'suites/lms/deep-crawl-lms.mjs' },
  { tag: 'hr', script: 'suites/hr/deep-crawl-hr.mjs' },
  { tag: 'todo', script: 'suites/todo/deep-crawl-todo.mjs' },

  // Depth — real writes, graded across the whole 19-role ladder.
  { tag: 'lms', script: 'suites/lms/lms-crud-matrix.mjs' },
  { tag: 'hr', script: 'suites/hr/hr-admin-matrix.mjs' },
  { tag: 'hr', script: 'suites/hr/attendance-geofence-guard.mjs' },
  { tag: 'hr', script: 'suites/hr/leave-lifecycle.mjs' },
  { tag: 'hr', script: 'suites/hr/regularization-lifecycle.mjs' },
  { tag: 'todo', script: 'suites/todo/task-visibility-matrix.mjs' },
  { tag: 'admin', script: 'suites/admin/lookup-crud.mjs' },
  { tag: 'admin', script: 'suites/admin/user-management.mjs' },

  // Cross-tenant isolation: log in as tenant B and try to see/touch tenant A.
  { tag: 'tenant', script: 'suites/tenant/cross-tenant-isolation.mjs' },
  { tag: 'tenant', script: 'suites/tenant/cross-tenant-hr-config.mjs' },

  // Capability grants: toggle off/on and check resolver, session, UI and API
  // all agree. Runs late — it mutates authorization config (reversibly), so
  // everything that assumes baseline grants has already run.
  { tag: 'capability', script: 'suites/capability/capability-toggle.mjs' },

  // Multi-user conflicts.
  { tag: 'concurrency', script: 'suites/concurrency/lms-lead-lost-update.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/hr-leave-approval-race.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/todo-task-double-edit.mjs' },

  // Look and feel across phone/tablet/laptop/desktop.
  { tag: 'visual', script: 'suites/visual/responsive-audit.mjs' },

  // Offline analysis over the crawl output.
  { tag: 'analysis', script: 'suites/core/tab-authz-consistency.mjs' },
];

function run(script) {
  const full = path.join(dir, script);
  console.log(`\n========== ${script} ==========`);
  const res = spawnSync('node', [full], { stdio: 'inherit', cwd: dir });
  if (res.status !== 0) console.log(`!! ${script} exited with ${res.status ?? res.signal}`);
  return res.status === 0;
}

for (const stage of STAGES) {
  if (stage.skip) { console.log(`\n== skip ${stage.script}`); continue; }
  // preflight/auth always run; everything else honours --only=
  if (!['auth', 'preflight'].includes(stage.tag) && !want(stage.tag)) continue;
  const passed = run(stage.script);
  if (stage.gate && !passed) {
    console.log('\nPreflight reported drift between the product and the harness assumptions.');
    console.log('Aborting: a run against a drifted stack reports harness breakage as product defects.');
    console.log('Re-run with --skip-preflight once the harness is realigned, or `node preflight.mjs --warn` to see details.');
    process.exit(1);
  }
}

console.log('\n========== report.mjs ==========');
run('report.mjs');
console.log('\nDone. See results/SUMMARY.md');
