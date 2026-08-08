// Fast, high-value pass: skip the slow breadth crawls (already have core/lookup/
// lms coverage) and run the suites that actually catch defects — real writes
// graded across all 19 roles, cross-tenant IDOR, capability toggling, multi-user
// concurrency, responsive — then aggregate. Each suite is its own child process
// so one crash never aborts the pass.
import { spawnSync } from 'node:child_process';
import { dir } from './lib.mjs';
import path from 'node:path';

const STAGES = [
  // Depth — real writes across the whole ladder (API-driven, no web app needed).
  'suites/lms/lms-crud-matrix.mjs',
  'suites/hr/hr-admin-matrix.mjs',
  'suites/hr/attendance-geofence-guard.mjs',
  'suites/hr/leave-lifecycle.mjs',
  'suites/hr/regularization-lifecycle.mjs',
  'suites/hr/regularization-window.mjs',
  'suites/hr/geo-exceptions.mjs',
  'suites/hr/request-detail-approval-chain.mjs',
  'suites/lms/bulk-assign.mjs',
  'suites/lms/public-report-api.mjs',
  'suites/lms/public-read-api.mjs',
  'suites/todo/task-visibility-matrix.mjs',
  'suites/admin/lookup-crud.mjs',
  'suites/admin/user-management.mjs',
  // Cross-tenant isolation (API-driven).
  'suites/tenant/cross-tenant-isolation.mjs',
  'suites/tenant/cross-tenant-hr-config.mjs',
  // Multi-user conflicts (API-driven).
  'suites/concurrency/lms-lead-lost-update.mjs',
  'suites/concurrency/hr-leave-approval-race.mjs',
  'suites/concurrency/todo-task-double-edit.mjs',
  // Capability grants — needs web apps for the frontend view (started separately).
  'suites/capability/capability-toggle.mjs',
  // Responsive — needs web apps.
  'suites/visual/responsive-audit.mjs',
  // Offline analysis over crawl output.
  'suites/core/tab-authz-consistency.mjs',
];

for (const s of STAGES) {
  const full = path.join(dir, s);
  console.log(`\n========== ${s} ==========`);
  const res = spawnSync('node', [full], { stdio: 'inherit', cwd: dir });
  if (res.status !== 0) console.log(`!! ${s} exited with ${res.status ?? res.signal}`);
}

console.log('\n========== report.mjs ==========');
spawnSync('node', [path.join(dir, 'report.mjs')], { stdio: 'inherit', cwd: dir });
console.log('\nDecisive pass done. See results/SUMMARY.md');
