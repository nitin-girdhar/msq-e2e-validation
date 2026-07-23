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
const want = (tag) => only.length === 0 || only.includes(tag);

const STAGES = [
  { tag: 'auth', skip: skipAuth, script: 'auth-setup.mjs' },
  { tag: 'core', script: 'suites/core/deep-crawl-core.mjs' },
  { tag: 'lookup', script: 'suites/core/deep-crawl-lookup.mjs' },
  { tag: 'lms', script: 'suites/lms/deep-crawl-lms.mjs' },
  { tag: 'hr', script: 'suites/hr/deep-crawl-hr.mjs' },
  { tag: 'todo', script: 'suites/todo/deep-crawl-todo.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/lms-lead-lost-update.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/hr-leave-approval-race.mjs' },
  { tag: 'concurrency', script: 'suites/concurrency/todo-task-double-edit.mjs' },
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
  if (stage.tag !== 'auth' && !want(stage.tag)) continue;
  run(stage.script);
}

console.log('\n========== report.mjs ==========');
run('report.mjs');
console.log('\nDone. See results/SUMMARY.md');
