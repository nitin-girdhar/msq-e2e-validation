import { openState } from './lib.mjs';
const pages = process.argv.slice(3);
const { browser, page } = await openState(process.argv[2]);
for (const w of [1366, 1024]) {
  await page.setViewportSize({ width: w, height: 768 });
  for (const path of pages) {
    await page.goto(`http://app.localhost${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const root = document.querySelector('.ag-root-wrapper'); if (!root) return null;
      const cols = [...document.querySelectorAll('.ag-header-cell[col-id]')].map((h) => ({ id: h.getAttribute('col-id'), w: Math.round(h.getBoundingClientRect().width), txt: h.querySelector('.ag-header-cell-text')?.textContent?.trim() }));
      const hs = document.querySelector('.ag-body-horizontal-scroll-viewport');
      return { grid: Math.round(root.getBoundingClientRect().width), cols, hscroll: hs ? hs.scrollWidth > hs.clientWidth + 1 : false };
    });
    if (!r) { console.log(`${w} ${path}: no grid`); continue; }
    const ws = r.cols.filter((c) => c.id !== '__actions').map((c) => c.w);
    console.log(`${w} ${path} grid=${r.grid}px cols=${r.cols.length} widths=[${r.cols.map((c) => `${c.txt || c.id}:${c.w}`).join(', ')}] spread=${Math.max(...ws) - Math.min(...ws)}px hscroll=${r.hscroll}`);
  }
}
await browser.close();
