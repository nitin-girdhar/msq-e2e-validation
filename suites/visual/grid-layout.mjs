// Grid / table layout at real device widths — the "content overlaps and buttons
// run off the screen" suite.
//
// responsive-audit.mjs only measures page-level overflow and a few control
// heuristics; it never looked INSIDE a data grid, so squeezed columns, clipped
// badges and off-screen row actions went unreported (Cycle 10). For every grid
// page this measures, at 1366 / 1024 / 820 / 390 px:
//
//   PAGE SCROLL   the document scrolls sideways (header or content overflows)
//   CLIPPED       an interactive control sits outside the viewport, or inside an
//                 overflow:hidden ancestor, so it cannot be reached
//   SPILL         text wider than its own box with overflow:visible, so it paints
//                 over the neighbouring cell / control
//   OVERLAP       two text/controls occupy the same pixels
//
// Deliberately ignored (verified false positives in Cycle 10):
//   - controls entirely left of the viewport: the closed off-canvas drawer
//   - anything inside .ag-paging-panel: AG Grid's own pager overlay
//   - overlaps where BOTH sides live in .ag-root and are absolutely positioned:
//     AG Grid lays cells out absolutely; real text collisions show up as SPILL
//
//   node suites/visual/grid-layout.mjs            # all roles
//   node suites/visual/grid-layout.mjs hr         # one group (lms|hr|todo|admin)
import { APPS, record, openState } from '../../lib.mjs';

const TOOL = 'visual';
const O = APPS['auth-web'] || 'http://app.localhost';
const WIDTHS = [[1366, 768], [1024, 768], [820, 1180], [390, 844]];

// Each page is opened by a login that actually holds its capabilities — several
// fixture roles are redirected to LMS instead (Fitclass org_admin has no HR/Tasks).
const GROUPS = {
  lms: { role: 'org_admin', pages: ['/lms/dashboard/leads', '/lms/dashboard/follow-ups', '/lms/dashboard/leads-history', '/lms/dashboard/bulk-assign', '/lms/dashboard/team'] },
  admin: { role: 'org_admin', pages: ['/admin/dashboard/team'] },
  hr: { role: 'hr_admin', pages: ['/hrms/employees', '/hrms/attendance/team', '/hrms/leave/approvals', '/hrms/payroll', '/hrms/documents', '/hrms/reports', '/hrms/team'] },
  todo: { role: 'msq_org_admin', pages: ['/todo/tasks', '/todo/tasks/team'] },
};

const measure = () => {
  const vw = window.innerWidth;
  const vis = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.title || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  const out = { pageScroll: document.documentElement.scrollWidth - vw, clipped: [], spill: [], overlap: [] };

  const seen = new Set();
  const ctl = [...document.querySelectorAll('button, a[href], [role=button], input, select, [role=tab]')].filter(vis);
  for (const el of ctl) {
    if (el.closest('.ag-paging-panel')) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= 0) continue; // off-canvas drawer
    let hidden = null, scroller = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p); const pr = p.getBoundingClientRect();
      if (!(r.right > pr.right + 1 || r.left < pr.left - 1)) continue;
      if (/(auto|scroll)/.test(s.overflowX)) scroller = true;
      else if (/(hidden|clip)/.test(s.overflowX)) { hidden = p; break; }
    }
    const offViewport = r.right > vw + 1 || r.left < -1;
    const key = label(el) + '|' + Math.round(r.left);
    if (seen.has(key)) continue; seen.add(key);
    if (hidden) out.clipped.push({ label: label(el), right: Math.round(r.right), by: String(hidden.className).slice(0, 40) });
    else if (offViewport && !scroller) out.clipped.push({ label: label(el), right: Math.round(r.right), by: 'viewport' });
  }

  for (const el of document.querySelectorAll('td, th, [role=gridcell], [role=columnheader], span, div, a, button, label, h1, h2, h3, p')) {
    if (el.children.length > 2 || !el.firstChild || !vis(el)) continue;
    const s = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 2 && s.overflowX === 'visible' && el.clientWidth > 0 && el.innerText?.trim()) {
      if (out.spill.length < 8) out.spill.push({ text: label(el), over: el.scrollWidth - el.clientWidth });
    }
  }

  const leaves = [...document.querySelectorAll('button, a[href], [role=button], th, td, [role=gridcell], h1, h2, h3, label')].filter(vis).slice(0, 500);
  const rects = leaves.map((e) => [e, e.getBoundingClientRect()]);
  for (let i = 0; i < rects.length && out.overlap.length < 6; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, ra] = rects[i], [b, rb] = rects[j];
    if (a.contains(b) || b.contains(a)) continue;
    if (a.closest('.ag-paging-panel') || b.closest('.ag-paging-panel')) continue;
    if (a.closest('.ag-root') && b.closest('.ag-root')) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 6 && h > 6) { out.overlap.push({ a: label(a), b: label(b), w: Math.round(w), h: Math.round(h) }); break; }
  }
  return out;
};

const only = process.argv[2];
let issues = 0, checked = 0;
for (const [group, { role, pages }] of Object.entries(GROUPS)) {
  if (only && only !== group) continue;
  let session;
  try { session = await openState(role); } catch (e) { console.log(`skip ${group}: ${e.message.slice(0, 80)}`); continue; }
  const { browser, page } = session;
  for (const path of pages) {
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      try {
        await page.goto(`${O}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const landed = new URL(page.url()).pathname;
        if (!landed.startsWith(path.split('/').slice(0, 2).join('/'))) { console.log(`  ${path} @${w}: redirected to ${landed} — not measured`); continue; }
        const m = await page.evaluate(measure);
        checked++;
        const spillBad = m.spill.filter((x) => x.over > 8);
        const sev = (m.pageScroll > 1 || m.clipped.length) ? 'medium' : 'low';
        const bad = m.pageScroll > 1 || m.clipped.length || spillBad.length || m.overlap.length;
        console.log(`  ${path.padEnd(32)} ${String(w).padStart(4)}  ${bad ? 'ISSUES' : 'ok    '} scroll+${Math.max(0, m.pageScroll)} clipped=${m.clipped.length} spill=${spillBad.length} overlap=${m.overlap.length}`);
        if (!bad) continue;
        issues++;
        record(TOOL, {
          severity: sev, role, tool: TOOL, page: `${path} @ ${w}px`,
          scenario: `Grid layout at ${w}px`,
          expected: 'No sideways page scroll, no unreachable controls, no text painted over a neighbour, no overlapping controls',
          actual: [
            m.pageScroll > 1 && `page scrolls sideways by ${m.pageScroll}px`,
            m.clipped.length && `${m.clipped.length} unreachable control(s), e.g. ${m.clipped.slice(0, 3).map((c) => `"${c.label}" (right edge ${c.right}px, ${c.by})`).join(', ')}`,
            spillBad.length && `${spillBad.length} text run(s) spill out of their box, e.g. ${spillBad.slice(0, 3).map((c) => `"${c.text}" +${c.over}px`).join(', ')}`,
            m.overlap.length && `${m.overlap.length} overlap(s), e.g. "${m.overlap[0].a}" over "${m.overlap[0].b}" (${m.overlap[0].w}x${m.overlap[0].h}px)`,
          ].filter(Boolean).join('; '),
          evidence: JSON.stringify(m).slice(0, 600),
          proposedSolution: 'Give every grid column a real minWidth (sizeColumnsToFit respects it, then the grid scrolls with key columns pinned), truncate text cells with ellipsis + title, and switch to cards below the width the table needs.',
        });
      } catch (e) { console.log(`  ${path} @${w}: ERR ${String(e.message).slice(0, 80)}`); }
    }
  }
  await browser.close();
}
console.log(`\nGrid layout: ${checked} page x width measurements, ${issues} with issues.`);
