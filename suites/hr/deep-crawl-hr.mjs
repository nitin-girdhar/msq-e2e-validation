// Deep-crawl every route of the hr tool (HR attendance & leave) for every seeded role,
// exercising all tabs, dropdowns, and buttons (opening — not submitting —
// create/edit forms). Findings land in results/findings-hr.json; the coverage
// matrix in results/hr-coverage.json.
//   node suites/hr/deep-crawl-hr.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('hr');
