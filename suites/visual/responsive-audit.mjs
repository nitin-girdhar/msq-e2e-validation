// Responsive / look-and-feel audit across phone, tablet, laptop and desktop.
//
// Renders every product route at 5 viewports and reports measurable layout
// defects (sideways scroll, overflowing elements, sub-44px tap targets, tiny
// text, overlapping controls), saving a screenshot per viewport as evidence.
//
//   node suites/visual/responsive-audit.mjs                 # default roles
//   node suites/visual/responsive-audit.mjs org_admin,read_only
import fs from 'node:fs';
import path from 'node:path';
import { openState, APPS, authFile, resultsDir } from '../../lib.mjs';
import { TOOLS } from '../../tools.config.mjs';
import { auditRoute } from '../../visual.mjs';

// One representative role per privilege band is enough for layout: the DOM is
// the same shape, only the data/nav differs. org_admin sees the richest UI
// (most nav, most buttons) so it surfaces the most layout stress.
const roles = (process.argv[2] || 'org_admin,sales_representative,read_only').split(',').map((s) => s.trim()).filter(Boolean);

const out = [];
for (const role of roles) {
  if (!fs.existsSync(authFile(role))) { console.log(`skip ${role} (no auth state)`); continue; }
  const { browser, page } = await openState(role);
  try {
    for (const [toolKey, tool] of Object.entries(TOOLS)) {
      if (toolKey === 'core') continue;
      const appUrl = APPS[tool.app];
      for (const route of tool.routes.filter((r) => !r.dynamicChildOf && !r.public && r.id !== 'select-branch')) {
        const res = await auditRoute(page, { url: appUrl + route.path, tool: toolKey, role, label: route.id }).catch((e) => null);
        if (!res) continue;
        out.push(res);
        const worst = res.viewports.map((v) => `${v.viewport}:${v.bodyOverflowPx}px`).join(' ');
        console.log(`  ${role.padEnd(20)} ${toolKey.padEnd(7)} ${route.path.padEnd(28)} overflow[${worst}]`);
      }
    }
  } finally {
    await browser.close();
  }
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'visual-audit.json'), JSON.stringify(out, null, 2));
console.log(`\nAudited ${out.length} route×role combinations across 5 viewports -> results/visual-audit.json`);
console.log('Screenshots: results/screenshots/');
