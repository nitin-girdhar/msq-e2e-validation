// Deep-crawl every route of the lookup tool (lookup-admin console (categorized under core/identity)) for every seeded role,
// exercising all tabs, dropdowns, and buttons (opening — not submitting —
// create/edit forms). Findings land in results/findings-lookup.json; the coverage
// matrix in results/lookup-coverage.json.
//   node suites/core/deep-crawl-lookup.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('lookup');
