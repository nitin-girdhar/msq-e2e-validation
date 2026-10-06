// Responsive / look-and-feel audit across phone, tablet, laptop and desktop.
//
// Renders every product route at 5 viewports (phone 390, small phone 360,
// tablet 820, laptop 1366, desktop 1920) and reports measurable layout defects,
// saving a screenshot per viewport as evidence:
//   - sideways scroll, overflowing elements, sub-44px tap targets, tiny text,
//     overlapping controls;
//   - TAB-STRIP rendering (the "Follow-ups tab looks odd on mobile" class:
//     tabs clipped, overflowing with no scroll affordance, or wrapping to an
//     unaligned multi-row block);
//   - DISABLED-STATE INTEGRITY (a control that looks disabled must be genuinely
//     inert, not merely styled or backend-guarded — catches "html hide/show but
//     still clickable").
//
// New-page coverage (2026-10, Stitch redesign): on the DEFAULT run the audit also covers
//   - todo-web as msq_org_admin (Tasks is licensed for MSquare, not Fitclass, so the Fitclass roles
//     above are bounced) incl. /tasks/lists, /tasks/team, a real /tasks/<id> detail page and the
//     not-found state of an unknown task id;
//   - lookup-admin as super_admin incl. /dashboard/branding and /dashboard/tenants/<id>/branding|modules
//     (every lower role is bounced from /sa, so the default roles never saw these pages);
//   - auth-web authenticated screens (/select-branch, /change-password) as tenant_admin;
//   - auth-web public screens anonymously (/forgot-password, /reset-password, /offline).
// Pass --no-extras to skip them, or --extras to add them to an explicit role list.
//
//   node suites/visual/responsive-audit.mjs                 # default roles + new-page extras
//   node suites/visual/responsive-audit.mjs org_admin,read_only
//   node suites/visual/responsive-audit.mjs org_admin --extras
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { openState, APPS, authFile, resultsDir } from '../../lib.mjs';
import { TOOLS } from '../../tools.config.mjs';
import { auditRoute } from '../../visual.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';

// One representative role per privilege band is enough for layout: the DOM is
// the same shape, only the data/nav differs. org_admin sees the richest UI
// (most nav, most buttons) so it surfaces the most layout stress.
const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const roles = (posArgs[0] || 'org_admin,sales_representative,read_only').split(',').map((s) => s.trim()).filter(Boolean);
const withExtras = process.argv.includes('--extras') || (!posArgs[0] && !process.argv.includes('--no-extras'));

const out = [];
const flagsOf = (res) => {
  // Flag routes where the phone viewport shows a tab-strip or fake-disabled issue.
  const phone = res.viewports.find((v) => v.viewport === 'phone');
  return [
    phone?.tabStrip && (phone.tabStrip.clipped.length || (phone.tabStrip.overflowsContainer && !phone.tabStrip.scrollableX) || phone.tabStrip.rows > 1) ? 'TABS' : '',
    res.viewports.some((v) => v.fakeDisabled?.length) ? 'FAKE-DISABLED' : '',
  ].filter(Boolean).join(',');
};
async function audit(page, { url, toolKey, role, id, shown }) {
  const res = await auditRoute(page, { url, tool: toolKey, role, label: id }).catch(() => null);
  if (!res) return;
  out.push(res);
  const worst = res.viewports.map((v) => `${v.viewport}:${v.bodyOverflowPx}px`).join(' ');
  const flags = flagsOf(res);
  console.log(`  ${role.padEnd(20)} ${toolKey.padEnd(7)} ${shown.padEnd(28)} overflow[${worst}]${flags ? '  ⚠ ' + flags : ''}`);
}

for (const role of roles) {
  if (!fs.existsSync(authFile(role))) { console.log(`skip ${role} (no auth state)`); continue; }
  const { browser, page } = await openState(role);
  try {
    for (const [toolKey, tool] of Object.entries(TOOLS)) {
      if (toolKey === 'core') continue;
      const appUrl = APPS[tool.app];
      for (const route of tool.routes.filter((r) => !r.dynamicChildOf && !r.public && r.id !== 'select-branch')) {
        await audit(page, { url: appUrl + route.path, toolKey, role, id: route.id, shown: route.path });
      }
    }
  } finally {
    await browser.close();
  }
}

// ── new-page extras ──────────────────────────────────────────────────────────
// A first-class row for each page the Stitch redesign added that the default roles cannot reach.
// Dynamic ids are resolved from Postgres (skipped, with a note, when the DB is down or has none).
const safe = (fn) => { try { return fn(); } catch { return null; } };
const dbUp = withExtras && !!safe(() => dbReachable());
const rolesJson = safe(() => JSON.parse(fs.readFileSync(new URL('../../roles.json', import.meta.url), 'utf8'))) ?? {};
const emailForKey = (k) => (rolesJson.roles ?? []).find((r) => r.role === k)?.email ?? (rolesJson.crossTenantActors ?? []).find((c) => c.stateKey === k)?.email ?? null;
const short = (p) => (p.length > 28 ? `${p.slice(0, 13)}…${p.slice(-12)}` : p);

const EXTRA = [
  {
    role: 'msq_org_admin', toolKey: 'todo',
    routes: () => {
      const r = TOOLS.todo.routes.map((x) => ({ id: x.id, path: x.path }));
      const e = emailForKey('msq_org_admin');
      const tid = dbUp && e ? safe(() => scalar(`SELECT t.id FROM task.tasks t JOIN iam.users u ON u.org_id = t.org_id AND u.email = ${lit(e.toLowerCase())}
        WHERE NOT t.is_deleted AND (t.created_by = u.id OR t.assignee_id = u.id) ORDER BY t.created_at DESC LIMIT 1`)) : null;
      if (tid) r.push({ id: 'tasks-detail', path: `/tasks/${tid}` });
      else console.log('  (todo: no task visible to msq_org_admin or DB down - /tasks/<id> not audited)');
      r.push({ id: 'tasks-not-found', path: '/tasks/00000000-0000-4000-8000-000000000000' });
      return r;
    },
  },
  {
    role: 'super_admin', toolKey: 'lookup',
    routes: () => {
      const r = TOOLS.lookup.routes.filter((x) => !x.dynamicChildOf).map((x) => ({ id: x.id, path: x.path }));
      const tid = dbUp ? safe(() => scalar(`SELECT id FROM entity.tenants WHERE NOT is_deleted ORDER BY (name = 'MSquare Professionals') DESC, name LIMIT 1`)) : null;
      if (tid) r.push({ id: 'tenant-branding', path: `/dashboard/tenants/${tid}/branding` }, { id: 'tenant-modules', path: `/dashboard/tenants/${tid}/modules` });
      else console.log('  (lookup: no tenant id or DB down - tenant branding/modules not audited)');
      return r;
    },
  },
  {
    role: 'tenant_admin', toolKey: 'core',
    routes: () => [{ id: 'select-branch', path: '/select-branch' }, { id: 'change-password', path: '/change-password' }],
  },
];
if (withExtras) {
  console.log('\n-- new-page extras --');
  for (const x of EXTRA) {
    if (!fs.existsSync(authFile(x.role))) { console.log(`skip ${x.role} (no auth state)`); continue; }
    const { browser, page } = await openState(x.role);
    try {
      const appUrl = APPS[TOOLS[x.toolKey].app];
      // When the role was already part of `roles` its standard routes were audited above; only the
      // routes that are new (dynamic ids, not-found state, pages the role could not reach) are added.
      const already = roles.includes(x.role);
      for (const r of x.routes()) {
        const std = TOOLS[x.toolKey].routes.some((t) => t.path === r.path && !t.public);
        if (already && std && x.toolKey !== 'core') continue;
        await audit(page, { url: appUrl + r.path, toolKey: x.toolKey, role: x.role, id: r.id, shown: short(r.path) });
      }
    } finally { await browser.close(); }
  }
  // public auth-web screens, anonymous (no session, no .auth state)
  const br = await chromium.launch();
  try {
    const ctx = await br.newContext();
    const page = await ctx.newPage();
    for (const r of TOOLS.core.routes.filter((x) => x.public)) {
      await audit(page, { url: APPS['auth-web'] + r.path, toolKey: 'core', role: 'anonymous', id: r.id, shown: short(r.path) });
    }
  } finally { await br.close(); }
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'visual-audit.json'), JSON.stringify(out, null, 2));
console.log(`\nAudited ${out.length} route×role combinations across 5 viewports -> results/visual-audit.json`);
console.log('Screenshots: results/screenshots/');
