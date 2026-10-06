import { rows, lit, q } from './db.mjs';
import { purgeById } from './fixtures.mjs';
for (const r of rows(`SELECT id FROM task.tasks WHERE title LIKE '%E2E-tasks-%'`, ['id'])) purgeById('task.tasks', r.id);
for (const r of rows(`SELECT id FROM task.task_lists WHERE name LIKE 'E2E-tasks-%'`, ['id'])) purgeById('task.task_lists', r.id);
console.log('tasks left', rows(`SELECT id FROM task.tasks WHERE title LIKE '%E2E-tasks-%'`, ['id']).length);
