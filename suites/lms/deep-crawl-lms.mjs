// Deep-crawl every route of the lms tool (Leads/CRM) for every seeded role,
// exercising all tabs, dropdowns, and buttons (opening — not submitting —
// create/edit forms). Findings land in results/findings-lms.json; the coverage
// matrix in results/lms-coverage.json.
//   node suites/lms/deep-crawl-lms.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('lms');
