// Deep-crawl every route of the core tool (auth-web login/branch/change-password surface) for every seeded role,
// exercising all tabs, dropdowns, and buttons (opening — not submitting —
// create/edit forms). Findings land in results/findings-core.json; the coverage
// matrix in results/core-coverage.json.
//   node suites/core/deep-crawl-core.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('core');
