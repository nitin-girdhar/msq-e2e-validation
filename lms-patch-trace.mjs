// Focused: watch the PATCH /api/leads/:id request+response around Save, and
// check whether the modal closes before the request completes.
import { openAs, visit, save, APPS } from './lib.mjs';

const role = process.argv[2] ?? 'org_admin';
const { browser, page } = await openAs(role);
const events = [];
const t0 = Date.now();
const at = () => Date.now() - t0;

page.on('request', (r) => { if (/\/api\/leads\//.test(r.url()) && r.method() !== 'GET') events.push({ t: at(), kind: 'request', method: r.method(), url: r.url(), body: r.postData()?.slice(0, 400) }); });
page.on('response', async (r) => {
  if (/\/api\/leads\//.test(r.url()) && r.request().method() !== 'GET') {
    events.push({ t: at(), kind: 'response', status: r.status(), url: r.url(), body: await r.text().then((b) => b.slice(0, 400)).catch(() => '<unreadable>') });
  }
});
page.on('requestfailed', (r) => { if (/\/api\/leads\//.test(r.url())) events.push({ t: at(), kind: 'FAILED', method: r.method(), url: r.url(), err: r.failure()?.errorText }); });

try {
  await visit(page, APPS['lms-web'] + '/dashboard/leads');
  await page.waitForTimeout(3000);
  await page.locator('button[title="Edit"]').first().click();
  await page.waitForTimeout(1500);

  const sel = page.locator('select').first();
  const cur = await sel.inputValue();
  const target = (await sel.locator('option').evaluateAll((os) => os.map((o) => o.value))).find((v) => v && v !== cur);
  await sel.selectOption(target);
  await page.waitForTimeout(1000);

  const marker = `E2E-trace-${Date.now()}`;
  await page.locator('textarea').first().fill(marker).catch(() => {});
  const sel2 = page.locator('select');
  if (await sel2.count() > 1) {
    const ov = await sel2.nth(1).locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (ov.length) await sel2.nth(1).selectOption(ov[0]).catch(() => {});
  }

  events.push({ t: at(), kind: 'CLICK_SAVE', targetStatus: target, marker });
  await page.locator('button', { hasText: /save changes/i }).first().click();

  // Poll modal visibility every 100ms to see exactly when it closes.
  for (let i = 0; i < 60; i++) {
    const open = await page.locator('button', { hasText: /save changes/i }).count();
    if (open === 0) { events.push({ t: at(), kind: 'MODAL_CLOSED' }); break; }
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(4000);
  events.push({ t: at(), kind: 'END' });
} catch (e) {
  events.push({ kind: 'EXCEPTION', message: String(e.message).split('\n')[0] });
} finally {
  for (const e of events) console.log(`${String(e.t).padStart(6)}ms ${e.kind.padEnd(14)} ${e.method ?? ''} ${e.status ?? ''} ${e.err ?? ''} ${(e.body ?? '').slice(0, 200)}`);
  save('lms', `patch-trace-${role}`, events);
  await browser.close();
}
