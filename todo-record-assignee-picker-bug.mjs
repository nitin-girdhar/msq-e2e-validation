import { record } from './lib.mjs';

record('todo', {
  severity: 'high',
  role: 'sales_representative / read_only',
  page: '/tasks (Task detail drawer, Assignee field)',
  scenario: 'Assignee picker options for lower-rank roles',
  expected:
    'A general-purpose Tasks assignee picker should let a user assign a task to at least a peer or their manager (typical task-management collaboration), not only to people strictly below them in the org hierarchy.',
  actual:
    'The Assignee picker is completely empty (only "Unassigned") for sales_representative and read_only — the two lowest-ranked seeded roles. Higher ranks see progressively more options. Confirmed with todo-assignee-picker-check.mjs across all 6 roles: read_only -> 0 real options, sales_representative -> 0 real options, senior_sales_executive -> 4 options (all strictly lower rank), org_manager -> 5, org_sr_manager -> 6, org_admin -> 7 (every rank strictly below the actor).',
  evidence:
    'useAssignableUsers (msq-todo/packages/task-web/src/hooks/useAssignableUsers.ts) calls the shared CRM users.assignable() endpoint. Root cause traced to msq-core/services/identity-service/src/api/v1/users/users.repository.ts getAssignableUsers(): `WHERE ... AND ur.rank < ${actorRank}` — strictly less-than the caller\'s own CRM/org rank. This is correct for CRM lead-assignment (delegating leads downward) but is reused verbatim for Tasks (see task-web hook comment: "same mapping LeadDashboardShell uses for lead assignment"), so the lowest-ranked roles can never assign a task to anyone, including their own manager or a same-rank peer, making collaborative task assignment impossible for those roles. Reproduced twice (initial todo-permissions.mjs run on sales_representative, then the full 6-role sweep in todo-assignee-picker-check.mjs).',
});
console.log('recorded');
