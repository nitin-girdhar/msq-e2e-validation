import { openAs, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const reasonText = process.argv[2];
const role = process.argv[3];

const { browser, page } = await openAs(role);
try {
  await page.goto(`${BASE}/leave/approvals`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  const row = page.locator('tr', { hasText: reasonText });
  const visible = await row.isVisible().catch(() => false);
  console.log(`[${role}] row visible: ${visible}`);
  if (!visible) { await browser.close(); process.exit(0); }
  await row.getByRole('button', { name: /review/i }).click({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.locator('#ad-comment').fill('E2E-approve-attempt');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /\/leave\/requests\/.*\/approve/.test(r.url()), { timeout: 15000 }).catch(() => null),
    page.getByRole('button', { name: /^approve$/i }).click(),
  ]);
  console.log(`[${role}] approve response:`, resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
} finally {
  await browser.close();
}
