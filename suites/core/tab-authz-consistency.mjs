// Tab visibility vs. route reachability consistency check.
//
// Tabs in these products are capability-gated at render time (AttendanceTabs,
// LeaveTabs, TasksTabs only push a tab when the actor holds the capability).
// So for any role, the set of tabs it can SEE should match the set of routes it
// can actually LOAD. Two ways that can drift, both real bugs:
//
//   * tab shown -> route denied   = the user is invited into a dead end. This is
//     the exact class of defect found earlier (page guard passes on one rank,
//     the service rejects on a different one).
//   * route reachable -> tab hidden = a working page with no way to navigate to
//     it; usually a missed capability in the tab list.
//
// Pure analysis over results/coverage-all.json — runs offline, touches nothing.
//
//   node suites/core/tab-authz-consistency.mjs
import fs from 'node:fs';
import path from 'node:path';
import { record, resultsDir, appPath } from '../../lib.mjs';

const file = path.join(resultsDir, 'coverage-all.json');
if (!fs.existsSync(file)) {
  console.log('No results/coverage-all.json — run the crawl first (run-by-role.mjs + aggregation).');
  process.exit(0);
}
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));

// Landed URLs and tab hrefs carry the app's basePath (/lms/dashboard/leads);
// tools.config route paths do not (/dashboard/leads). Compare app-relative.
const pathOf = (u) => appPath(u).replace(/\/$/, '');
const norm = (p) => {
  const s = String(p || '');
  return (s.startsWith('/') ? appPath(`http://x${s}`) : s).replace(/\/$/, '');
};

// Did this role actually land on the route it asked for?
const reachedIndex = new Map(); // `${role}|${path}` -> boolean
for (const r of rows) {
  if (!r.path) continue;
  reachedIndex.set(`${r.role}|${norm(r.path)}`, pathOf(r.url) === norm(r.path));
}

// Every tab this role saw anywhere in a tool (tabs repeat across a tool's routes).
const tabsByRoleTool = new Map(); // `${role}|${tool}` -> Map(href -> label)
for (const r of rows) {
  if (!Array.isArray(r.tabs)) continue;
  const k = `${r.role}|${r.tool}`;
  if (!tabsByRoleTool.has(k)) tabsByRoleTool.set(k, new Map());
  const m = tabsByRoleTool.get(k);
  for (const t of r.tabs) if (t && t.href) m.set(norm(t.href), t.label);
}

const mismatches = [];
for (const [key, tabs] of tabsByRoleTool) {
  const [role, tool] = key.split('|');
  for (const [href, label] of tabs) {
    const reached = reachedIndex.get(`${role}|${href}`);
    if (reached === undefined) continue; // route not part of the crawl set
    if (!reached) {
      mismatches.push({ kind: 'tab-shown-route-denied', role, tool, href, label });
      record(tool, {
        severity: 'high',
        role, tool, page: `${tool} — tab "${label}" -> ${href}`,
        scenario: `${role} sees the "${label}" tab but opening it does not land on ${href}`,
        expected: 'A tab is only rendered when the actor holds the capability behind it, so every visible tab leads to a page that actually loads',
        actual: `The tab is visible to ${role}, but navigating to ${href} redirected away (the role cannot actually reach it) — the tab is a dead end.`,
        evidence: `role=${role} tool=${tool} tab="${label}" href=${href}; crawl landed elsewhere`,
        proposedSolution: 'Gate the tab on the SAME capability/rank the route and its service check, so the tab disappears for roles the backend will reject. If the role should have access, fix the route/service guard instead.',
      });
    }
  }
}

// Inverse: a route this role can load, in a tool that has tabs, with no tab for it.
const inverse = [];
for (const [key, tabs] of tabsByRoleTool) {
  const [role, tool] = key.split('|');
  const toolRoutes = rows.filter((r) => r.role === role && r.tool === tool && r.path);
  for (const r of toolRoutes) {
    const p = norm(r.path);
    if (tabs.has(p)) continue;
    if (reachedIndex.get(`${role}|${p}`) !== true) continue;
    inverse.push({ role, tool, path: p });
  }
}

fs.writeFileSync(path.join(resultsDir, 'tab-authz-consistency.json'),
  JSON.stringify({ mismatches, routesWithoutTab: inverse }, null, 2));

console.log(`Tab/route consistency over ${rows.length} crawl rows:`);
console.log(`  tab-shown-but-route-denied : ${mismatches.length}`);
for (const m of mismatches) console.log(`     ${m.role} [${m.tool}] "${m.label}" -> ${m.href}`);
console.log(`  reachable-routes-without-a-tab : ${inverse.length} (informational; many routes are nav-linked, not tabbed)`);
console.log('-> results/tab-authz-consistency.json');
