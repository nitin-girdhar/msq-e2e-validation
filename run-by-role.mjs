// Role-partitioned crawl runner.
//
// Crawls ALL tools for a given set of roles, opening exactly one browser
// context per role at a time. This avoids the concurrent-session trap: if the
// same stored login is loaded into two contexts simultaneously the app rotates
// the token and logs the role out mid-crawl. Run several of these in parallel
// over DISJOINT role sets and no role is ever shared across contexts.
//
//   node run-by-role.mjs org_admin,hr_head,read_only   [partitionLabel]
import fs from 'node:fs';
import path from 'node:path';
import { openState, resultsDir, authFile } from './lib.mjs';
import { crawlAllToolsForRole } from './driver.mjs';

const roles = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const label = process.argv[3] || roles[0] || 'part';
if (!roles.length) { console.error('usage: node run-by-role.mjs role1,role2[,...] [label]'); process.exit(1); }

const rows = [];
const bounced = [];
for (const role of roles) {
  if (!fs.existsSync(authFile(role))) { console.log(`skip ${role} (no auth state)`); continue; }
  const { browser, page, log } = await openState(role);
  try {
    const roleRows = await crawlAllToolsForRole(page, log, role);
    rows.push(...roleRows);
    const loginBounces = roleRows.filter((r) => /\/login/.test(r.url || '')).length;
    if (loginBounces > roleRows.length / 2) bounced.push(`${role} (${loginBounces}/${roleRows.length} routes bounced to login)`);
  } catch (e) {
    console.log(`  ${role}: ERROR ${String(e.message).slice(0, 160)}`);
  } finally {
    await browser.close();
  }
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, `coverage-part-${label}.json`), JSON.stringify(rows, null, 2));
console.log(`\n[${label}] ${rows.length} role×route rows`);
if (bounced.length) console.log(`!! SESSION BOUNCED: ${bounced.join('; ')}`);
