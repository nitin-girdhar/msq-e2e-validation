// Deep-crawl every route of the new consolidated admin-web console (Team,
// API Tokens, Leave Admin, Attendance Admin) for every seeded role, exercising
// all tabs, dropdowns, and buttons (opening — not submitting — create/edit
// forms). This app (port 3004) did not exist in the harness before this pass —
// see tools.config.mjs TOOLS.admin for the "why" (msq-core 543a91e "feat:
// Admin panel for Tanent/Org/HR Admin"). Findings land in
// results/findings-admin.json (shared with the other suites/admin/*.mjs); the
// coverage matrix in results/admin-coverage.json.
//   node suites/admin/deep-crawl-admin.mjs
import { runToolCrawl } from '../../driver.mjs';
await runToolCrawl('admin');
