import { openAs, APPS } from '../../lib.mjs';

const BASE = APPS['hr-web'];

async function attempt(typeName, useToday) {
  const { browser, page } = await openAs('org_admin');
  try {
    await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /create \/ revise policy/i }).click({ timeout: 10000 });
    await page.waitForTimeout(400);
    await page.locator('#pf-type').fill(typeName);
    await page.locator('#pf-levels').fill('1');
    if (!useToday) {
      const d = new Date(); d.setDate(d.getDate() + 5 + Math.floor(Math.random() * 20));
      await page.locator('#pf-from').fill(d.toISOString().slice(0, 10));
    }
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/hr/leave/policies') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
      page.getByRole('button', { name: /save policy/i }).click(),
    ]);
    console.log(`[${typeName} useToday=${useToday}] status=`, resp ? resp.status() : 'none', 'body=', resp ? (await resp.text().catch(() => '')) : '');
  } finally {
    await browser.close();
  }
}

await attempt('earned', true);
await attempt('earned', false);
await attempt('casual', true);
