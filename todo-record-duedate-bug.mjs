import { record } from './lib.mjs';

record('todo', {
  severity: 'high',
  role: 'org_admin (any role — client-side bug, not permission-related)',
  page: '/tasks (Task detail drawer, Due date field)',
  scenario: 'Due-date round-trip through save + reload',
  expected: 'Setting the due-date picker to 2026-08-15, saving, and reloading should show 2026-08-15 again.',
  actual: 'The due date reads back as 2026-08-14 — one day earlier than what was entered. Reproduced 3/3 times with todo-duedate-check.mjs (fresh task each run).',
  evidence:
    'Root cause in msq-todo/packages/task-web/src/components/tasks/TaskDetailDrawer.tsx. On save (line ~69): `due_at: dueAt ? new Date(`${dueAt}T00:00:00`).toISOString() : null` builds a Date at LOCAL midnight for the picker\'s date string, then serializes with toISOString() which converts to UTC — for any timezone ahead of UTC (e.g. IST, UTC+5:30) local midnight is still the previous UTC day (e.g. 2026-08-15T00:00 IST -> 2026-08-14T18:30:00.000Z). On load (line ~41): `setDueAt(task.due_at ? task.due_at.slice(0, 10) : "")` takes the raw ISO string\'s first 10 characters (the UTC date) with no timezone conversion back to local, so it displays the UTC date directly. The write shifts the date back a day in UTC and the read never compensates, so any due date entered from a UTC+ timezone is silently stored/displayed one day earlier than selected. This will affect every timezone east of UTC (most of Asia including the seeded FitClass-Gurgaon/IST org) and is a correctness bug, not a display-only cosmetic issue, since the wrong date round-trips through the API and would also be visible in due-date sorting/overdue highlighting (isOverdue in msq-todo/packages/task-web/src/lib/tasks/format.ts) and in Team tasks table due-date column.',
});
console.log('recorded');
