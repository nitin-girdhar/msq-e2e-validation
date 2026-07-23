// Deep-crawl every route of the todo tool (Tasks/To-Do) for every seeded role,
// exercising all tabs, dropdowns, and buttons (opening — not submitting —
// create/edit forms). Findings land in results/findings-todo.json; the coverage
// matrix in results/todo-coverage.json.
//   node suites/todo/deep-crawl-todo.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('todo');
