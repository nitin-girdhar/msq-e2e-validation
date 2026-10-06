// One-off: capture current non-Stitch screens (desktop + phone) for Stitch redesign. Read-only navigation.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, authDir } from './lib.mjs';

const OUT = 'C:/Girdhar/MSquare/stitch-current-screens';
const A = cfg.apps;
const S = [
  // [id, app, state, path]
  ['auth-select-branch', 'auth-web', 'tenant_admin', '/select-branch'],
  ['auth-change-password', 'auth-web', 'tenant_admin', '/change-password'],
  ['auth-offline', 'auth-web', 'tenant_admin', '/offline'],
  ['admin-dashboard', 'admin-web', 'tenant_admin', '/dashboard'],
  ['admin-team', 'admin-web', 'tenant_admin', '/dashboard/team'],
  ['admin-api-tokens', 'admin-web', 'tenant_admin', '/dashboard/api-tokens'],
  ['admin-branding', 'admin-web', 'tenant_admin', '/dashboard/branding'],
  ['admin-leave-admin', 'admin-web', 'tenant_admin', '/dashboard/leave/admin'],
  ['admin-attendance-admin', 'admin-web', 'tenant_admin', '/dashboard/attendance/admin'],
  ['lms-assignments', 'lms-web', 'super_admin', '/dashboard/assignments'],
  ['lms-leads-history', 'lms-web', 'tenant_admin', '/dashboard/leads-history'],
  ['lms-team', 'lms-web', 'tenant_admin', '/dashboard/team'],
  ['lms-no-access', 'lms-web', 'tenant_admin', '/dashboard/no-access'],
  ['hr-org-chart', 'hr-web', 'hr_admin', '/org-chart'],
  ['hr-planner', 'hr-web', 'hr_admin', '/planner'],
  ['hr-leave-admin', 'hr-web', 'hr_admin', '/leave/admin'],
  ['hr-attendance-admin', 'hr-web', 'hr_admin', '/attendance/admin'],
  ['sa-home', 'lookup-admin', 'super_admin', '/dashboard'],
  ['sa-lookups-lead-stage', 'lookup-admin', 'super_admin', '/dashboard/lookups/lead-stage'],
  ['sa-capi-events', 'lookup-admin', 'super_admin', '/dashboard/lookups/lead-stage/capi-events'],
  ['sa-catalogs', 'lookup-admin', 'super_admin', '/dashboard/catalogs'],
  ['sa-campaign-types', 'lookup-admin', 'super_admin', '/dashboard/campaign-types'],
  ['sa-users', 'lookup-admin', 'super_admin', '/dashboard/users'],
  ['sa-lead-assignment-rerun', 'lookup-admin', 'super_admin', '/dashboard/lead-assignment-rerun'],
  ['sa-meta-lead-inbox', 'lookup-admin', 'super_admin', '/dashboard/meta-lead-inbox'],
  ['sa-module-lms', 'lookup-admin', 'super_admin', '/dashboard/m/lms'],
  ['sa-branding-tenant-list', 'lookup-admin', 'super_admin', '/dashboard/branding'],
];
const VP = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

// Redact emails and phone numbers in the DOM before shooting (local DB is a prod copy).
const mask = () => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const n = []; while (w.nextNode()) n.push(w.currentNode);
  for (const t of n) {
    t.nodeValue = t.nodeValue
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.com')
      .replace(/(\+?\d[\d\s-]{8,}\d)/g, '+91 90000 00000');
  }
  document.querySelectorAll('input').forEach((i) => { if (/@|\d{8,}/.test(i.value) && i.type !== 'password') i.value = 'redacted'; });
};

const browser = await chromium.launch();
const log = [];
let tenantExtra = [];
for (const [state, shots] of Object.entries(S.reduce((m, s) => ((m[s[2]] ||= []).push(s), m), {}))) {
  const sf = path.join(authDir, state + '.json');
  for (const [dev, vp] of Object.entries(VP)) {
    const ctx = await browser.newContext({ storageState: sf, viewport: vp, deviceScaleFactor: 1, isMobile: dev === 'mobile' });
    const page = await ctx.newPage();
    const list = [...shots];
    if (state === 'super_admin') {
      // tenant-specific pages: discover the first tenant id from the branding list
      await page.goto(A['lookup-admin'] + '/dashboard/branding', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const href = await page.locator('a[href*="/tenants/"][href$="/branding"]').first().getAttribute('href').catch(() => null);
      if (href) {
        const base = href.replace(/\/branding$/, '');
        list.push(['sa-tenant-branding', 'lookup-admin', state, base.replace(/^.*?\/dashboard/, '/dashboard') + '/branding']);
        list.push(['sa-tenant-modules', 'lookup-admin', state, base.replace(/^.*?\/dashboard/, '/dashboard') + '/modules']);
      }
    }
    for (const [id, app, , p] of list) {
      const url = A[app] + p;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await page.evaluate(mask);
        const final = page.url();
        const file = path.join(OUT, `${id}__${dev}.png`);
        await page.screenshot({ path: file, fullPage: true });
        log.push({ id, dev, url, final, ok: true });
      } catch (e) { log.push({ id, dev, url, ok: false, err: e.message.slice(0, 100) }); }
    }
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, '_capture-log.json'), JSON.stringify(log, null, 1));
for (const l of log) console.log(l.ok ? 'ok ' : 'ERR', l.id, l.dev, l.ok ? l.final.replace(/^https?:\/\/[^/]+/, '') : l.err);
