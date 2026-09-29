// Crawl driver: run the deep crawler across a tool's routes for every role.
//
// This is what the per-tool deep-crawl suites call. For each role it opens an
// authenticated context, walks every route in tools.config for that tool
// (clicking tabs/dropdowns/buttons, opening forms), records findings via the
// crawler, and writes a per-tool coverage matrix to results/<tool>-coverage.json
// so you can see, at a glance, which role reached which route with what result.
import fs from 'node:fs';
import { openState, ROLES, APPS, resultsDir, authFile, absUrl, appPath } from './lib.mjs';
import { TOOLS } from './tools.config.mjs';
import { crawlRoute } from './crawl.mjs';
import path from 'node:path';

// Expand dynamic child routes (e.g. lookup-admin's per-table pages) by reading
// the links actually present on the parent route. Keeps coverage honest to
// what the UI exposes rather than a hardcoded table list.
async function expandRoutes(page, appUrl, tool) {
  // Authenticated crawl: skip pre-auth routes (login/select-branch) — they just
  // redirect an already-logged-in user back to the product and waste a heavy
  // re-crawl of the landing page.
  const routes = [...tool.routes.filter((r) => !r.dynamicChildOf && !r.public && r.id !== 'select-branch')];
  for (const r of tool.routes.filter((x) => x.dynamicChildOf)) {
    const parent = tool.routes.find((p) => p.id === r.dynamicChildOf);
    if (!parent) continue;
    await page.goto(appUrl + parent.path, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const hrefs = await page.locator(`a[href*="${r.path}/"]`).evaluateAll(
      (els) => Array.from(new Set(els.map((e) => e.getAttribute('href')))).filter(Boolean)
    ).catch(() => []);
    for (const href of hrefs.slice(0, 25)) {
      const id = href.split('/').filter(Boolean).pop();
      routes.push({ id: `${r.id}:${id}`, label: `${r.label}/${id}`, path: appPath(absUrl(appUrl, href)) });
    }
  }
  return routes;
}

// Crawl every tool for a SINGLE role using one already-open context. Used by
// the role-partitioned runner so a role's session is never loaded into two
// contexts at once (concurrent use rotates the token and logs the role out).
export async function crawlAllToolsForRole(page, log, role) {
  const out = [];
  for (const toolKey of Object.keys(TOOLS)) {
    const tool = TOOLS[toolKey];
    if (toolKey === 'core') continue; // change-password only; low value per-role
    const appUrl = APPS[tool.app];
    const routes = await expandRoutes(page, appUrl, tool);
    for (const route of routes) {
      const summary = await crawlRoute(page, log, { appUrl, route, tool: toolKey, role }).catch((e) => ({
        role, tool: toolKey, route: route.id, path: route.path, error: String(e.message).slice(0, 200),
      }));
      out.push(summary);
      const btn = summary.buttons ? Object.values(summary.buttons).reduce((a, b) => a + b, 0) : 0;
      console.log(`  ${role.padEnd(22)} ${toolKey.padEnd(7)} ${route.path.padEnd(28)} tabs=${(summary.tabs || []).length} btns=${btn} ${/\/login/.test(summary.url || '') ? 'LOGIN-BOUNCE!' : ''}`);
    }
  }
  return out;
}

export async function runToolCrawl(toolKey, { roles = ROLES } = {}) {
  const tool = TOOLS[toolKey];
  if (!tool) throw new Error(`Unknown tool '${toolKey}'`);
  const appUrl = APPS[tool.app];
  const matrix = [];

  for (const role of roles) {
    if (!fs.existsSync(authFile(role))) {
      console.log(`  skip ${role} (no auth state)`);
      continue;
    }
    const { browser, page, log } = await openState(role);
    try {
      const routes = await expandRoutes(page, appUrl, tool);
      for (const route of routes) {
        const summary = await crawlRoute(page, log, { appUrl, route, tool: toolKey, role }).catch((e) => ({
          role, tool: toolKey, route: route.id, path: route.path, error: String(e.message).slice(0, 200),
        }));
        matrix.push(summary);
        const btn = summary.buttons ? Object.values(summary.buttons).reduce((a, b) => a + b, 0) : 0;
        console.log(`  ${role.padEnd(24)} ${route.path.padEnd(30)} tabs=${(summary.tabs || []).length} dropdowns=${summary.dropdownCount ?? '-'} buttons=${btn} ${summary.redirected ? 'REDIRECTED' : ''}`);
      }
    } finally {
      await browser.close();
    }
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${toolKey}-coverage.json`), JSON.stringify(matrix, null, 2));
  console.log(`\n[${toolKey}] crawled ${matrix.length} role×route combinations -> results/${toolKey}-coverage.json`);
  return matrix;
}
