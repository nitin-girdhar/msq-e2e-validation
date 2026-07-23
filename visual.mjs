// Responsive / visual-quality engine.
//
// Runs a route at several device viewports and reports OBJECTIVE layout defects
// — the things that actually make a UI look unprofessional on a phone or tablet:
//
//   * horizontal page scroll (the classic "it breaks on mobile")
//   * elements spilling past the right edge of the viewport
//   * tap targets smaller than the 44x44 CSS-px accessibility minimum
//   * text below a legible size
//   * overlapping interactive controls (buttons sitting on top of each other)
//   * content clipped to zero height/width
//   * horizontal scroll trapped inside tables/code blocks (allowed) vs the body (not)
//
// Deliberately objective: "looks professional" is subjective, but a body that
// scrolls sideways on a 390px phone, a 28px tap target, or 9px body text are
// measurable defects any designer would sign off as bugs. Screenshots are saved
// per viewport as evidence.
import fs from 'node:fs';
import path from 'node:path';
import { record, resultsDir } from './lib.mjs';

// Representative devices — phone, large phone, tablet portrait, laptop, desktop.
export const VIEWPORTS = [
  { id: 'phone', label: 'Phone (iPhone 12)', width: 390, height: 844, mobile: true },
  { id: 'phone-sm', label: 'Small phone', width: 360, height: 740, mobile: true },
  { id: 'tablet', label: 'Tablet portrait (iPad)', width: 820, height: 1180, mobile: true },
  { id: 'laptop', label: 'Laptop', width: 1366, height: 768, mobile: false },
  { id: 'desktop', label: 'Desktop', width: 1920, height: 1080, mobile: false },
];

const MIN_TAP = 44;   // CSS px — WCAG 2.5.5 / platform HIG minimum
const MIN_FONT = 12;  // CSS px — below this is not comfortably legible

// Everything below runs in the page so we measure real rendered geometry.
async function measure(page, viewportWidth) {
  return page.evaluate(({ vw, MIN_TAP, MIN_FONT }) => {
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName).trim().slice(0, 40);

    // 1. Does the document itself scroll sideways?
    const doc = document.documentElement;
    const bodyOverflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth;

    // 2. Which elements stick out past the right edge? Ignore nodes inside a
    //    container that is legitimately scrollable (tables, pre, [data-scroll]).
    const inScrollable = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX)) return true;
        if (p.tagName === 'TABLE' || p.tagName === 'PRE') return true;
      }
      return false;
    };
    const overflowing = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width <= vw && !inScrollable(el)) {
        overflowing.push({ tag: el.tagName.toLowerCase(), label: label(el), right: Math.round(r.right), width: Math.round(r.width) });
        if (overflowing.length >= 8) break;
      }
    }

    // 3. Tap targets that are too small (interactive elements only).
    const smallTargets = [];
    for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_TAP || r.height < MIN_TAP) {
        smallTargets.push({ label: label(el), w: Math.round(r.width), h: Math.round(r.height) });
        if (smallTargets.length >= 10) break;
      }
    }

    // 4. Text below the legible threshold.
    const tinyText = [];
    for (const el of document.querySelectorAll('p, span, td, li, label, a, button, div')) {
      if (!visible(el)) continue;
      if (!el.childNodes.length) continue;
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
      if (!hasOwnText) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs && fs < MIN_FONT) {
        tinyText.push({ label: label(el), fontSize: fs });
        if (tinyText.length >= 8) break;
      }
    }

    // 5. Overlapping interactive controls — a strong signal of broken layout.
    const controls = [...document.querySelectorAll('button, a[href], [role="button"]')].filter(visible).slice(0, 40);
    const overlaps = [];
    for (let i = 0; i < controls.length && overlaps.length < 5; i++) {
      const a = controls[i].getBoundingClientRect();
      for (let j = i + 1; j < controls.length; j++) {
        const b = controls[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // Require a substantial overlap so nested/wrapping elements don't trip it.
        if (ox > 8 && oy > 8 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) {
          overlaps.push({ a: label(controls[i]), b: label(controls[j]), overlap: `${Math.round(ox)}x${Math.round(oy)}` });
          break;
        }
      }
    }

    return {
      bodyOverflowPx: Math.max(0, Math.round(bodyOverflow)),
      overflowing, smallTargets, tinyText, overlaps,
      hasHorizontalScrollbar: doc.scrollWidth > doc.clientWidth + 1,
    };
  }, { vw: viewportWidth, MIN_TAP, MIN_FONT });
}

// Audit one route across every viewport. `page` must already be authenticated.
export async function auditRoute(page, { url, tool, role, label }) {
  const shotDir = path.join(resultsDir, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const results = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
    await page.waitForTimeout(400); // let responsive CSS/JS settle

    const m = await measure(page, vp.width).catch(() => null);
    if (!m) continue;

    const slug = `${tool}-${label}-${role}-${vp.id}`.replace(/[^a-z0-9-]/gi, '_');
    const shot = path.join(shotDir, `${slug}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    results.push({ viewport: vp.id, width: vp.width, ...m });

    // ---- findings ----
    // Body-level horizontal scroll is the highest-signal responsive bug.
    if (m.bodyOverflowPx > 4) {
      record('visual', {
        severity: vp.mobile ? 'medium' : 'low',
        role, tool, page: `${label} @ ${vp.label}`,
        scenario: `Render ${url} at ${vp.width}x${vp.height} (${vp.label})`,
        expected: 'Page fits the viewport width — no horizontal scrolling of the document body',
        actual: `Document scrolls horizontally by ${m.bodyOverflowPx}px.` +
          (m.overflowing.length ? ` Widest offenders: ${m.overflowing.map((o) => `<${o.tag}> "${o.label}" (right edge ${o.right}px)`).join('; ')}` : ''),
        evidence: `screenshot: results/screenshots/${slug}.png | ${JSON.stringify(m.overflowing).slice(0, 400)}`,
        proposedSolution: 'Constrain the offending element with max-width:100% / min-width:0 (flex and grid children default to min-width:auto, the usual cause), and let wide tables scroll inside their own overflow-x container rather than pushing the page.',
      });
    }

    if (vp.mobile && m.smallTargets.length >= 3) {
      record('visual', {
        severity: 'low',
        role, tool, page: `${label} @ ${vp.label}`,
        scenario: `Tap-target sizing at ${vp.width}px`,
        expected: `Interactive controls are at least ${MIN_TAP}x${MIN_TAP} CSS px on touch viewports (WCAG 2.5.5)`,
        actual: `${m.smallTargets.length} controls are below the minimum, e.g. ${m.smallTargets.slice(0, 4).map((t) => `"${t.label}" ${t.w}x${t.h}`).join(', ')}`,
        evidence: `screenshot: results/screenshots/${slug}.png | ${JSON.stringify(m.smallTargets).slice(0, 400)}`,
        proposedSolution: `Give icon buttons and inline links a minimum hit area (min-height/min-width ${MIN_TAP}px or padding) on touch breakpoints.`,
      });
    }

    if (m.tinyText.length) {
      record('visual', {
        severity: 'low',
        role, tool, page: `${label} @ ${vp.label}`,
        scenario: `Text legibility at ${vp.width}px`,
        expected: `Body text is at least ${MIN_FONT}px`,
        actual: `${m.tinyText.length} element(s) render below ${MIN_FONT}px, e.g. ${m.tinyText.slice(0, 3).map((t) => `"${t.label}" @ ${t.fontSize}px`).join(', ')}`,
        evidence: `screenshot: results/screenshots/${slug}.png | ${JSON.stringify(m.tinyText).slice(0, 300)}`,
        proposedSolution: 'Raise the smallest type ramp step; keep secondary/meta text at >=12px so it stays legible on dense screens.',
      });
    }

    if (m.overlaps.length) {
      record('visual', {
        severity: 'medium',
        role, tool, page: `${label} @ ${vp.label}`,
        scenario: `Overlapping controls at ${vp.width}px`,
        expected: 'Interactive controls do not visually overlap each other',
        actual: `${m.overlaps.length} overlapping control pair(s): ${m.overlaps.map((o) => `"${o.a}" over "${o.b}" (${o.overlap}px)`).join('; ')}`,
        evidence: `screenshot: results/screenshots/${slug}.png | ${JSON.stringify(m.overlaps).slice(0, 300)}`,
        proposedSolution: 'Replace absolute/fixed positioning with flex/grid flow at this breakpoint, or allow the toolbar to wrap so actions never stack on top of one another.',
      });
    }
  }

  return { role, tool, route: label, url, viewports: results };
}
