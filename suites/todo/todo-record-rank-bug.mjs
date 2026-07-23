import { record } from '../../lib.mjs';

const affected = ['org_sr_manager', 'org_manager', 'senior_sales_executive'];
for (const role of affected) {
  record('todo', {
    severity: 'high',
    role,
    page: '/tasks/team',
    scenario: 'Rank-gate mismatch between Next.js page guard and tasks-service API guard',
    expected:
      'If a role is allowed to navigate to /tasks/team (page-level canViewTeamTasks(session.rank) passes and the "Team" tab renders), the underlying API calls should also succeed so the page shows real data.',
    actual:
      'Page renders "Team tasks" with the Team tab visible and no redirect, but both GET /api/task-lists?scope=team and GET /api/tasks?scope=team return 403 "Insufficient rank for the team task scope". The UI shows an error banner and permanently "No team tasks found." Root cause: app/tasks/team/page.tsx gates on the platform/session rank (SessionUser.rank, likely CRM/org rank) via @task/authz canViewTeamTasks, while tasks-service authenticate() (middleware/auth.middleware.ts) resolves a separate, product-specific rank from task.member_roles via resolveMemberRole("task", ...) and tasks.service.ts listTasks() re-checks canViewTeamTasks against THAT rank. These two ranks are on different scales / provisioned independently, so a user can pass the page gate on session.rank yet fail the API gate on their (lower or unprovisioned) task.member_roles rank.',
    evidence:
      'Reproduced twice: (1) todo-coverage.mjs run across all 6 roles showed 403 on scope=team task-lists/tasks calls for org_sr_manager, org_manager and senior_sales_executive (not org_admin) while the /tasks/team page itself returned 200 and the Team tab was visible for all three; (2) todo-team-403-check.mjs re-ran org_sr_manager alone and confirmed the same 403s plus the literal on-page text "Insufficient rank for the team task scope" surfaced in the Alert banner, with the assignee/status/priority filters still rendered above an empty "No team tasks found." state. sales_representative and read_only, by contrast, are correctly redirected server-side from /tasks/team back to /tasks (no broken page).',
  });
}
console.log('recorded', affected.length, 'findings');
