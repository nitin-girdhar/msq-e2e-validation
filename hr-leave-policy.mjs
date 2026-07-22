import { openAs, APPS, record } from './lib.mjs';

const BASE = APPS['hr-web'];
const role = 'org_admin';
const { browser, page, log } = await openAs(role);
try {
  await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);

  const createBtn = page.getByRole('button', { name: /create \/ revise policy/i });
  await createBtn.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  await page.locator('#pf-type').fill('casual');
  await page.locator('#pf-freq').selectOption('monthly');
  await page.locator('#pf-amount').fill('1.5');
  await page.locator('#pf-levels').fill('1');

  const saveBtn = page.getByRole('button', { name: /save policy/i });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/hr/leave/policies') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
    saveBtn.click(),
  ]);
  console.log('POST policies response status:', resp ? resp.status() : 'NO RESPONSE CAPTURED');
  if (resp) console.log('POST policies response body:', (await resp.text().catch(() => '')).slice(0, 500));

  await page.waitForTimeout(1000);
  const notice = await page.locator('text=Policy revision saved').isVisible().catch(() => false);
  console.log('notice visible?', notice);

  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1000);
  const rowVisible = await page.locator('td:has-text("casual")').first().isVisible().catch(() => false);
  console.log('casual row visible after reload?', rowVisible);

  if (!rowVisible) {
    record('hr', {
      severity: 'high',
      role,
      page: '/leave/admin (Policies tab)',
      scenario: 'Create leave policy then reload - persistence check',
      expected: 'A newly created "casual" leave policy row appears in the Policies table after page reload',
      actual: `POST /api/hr/leave/policies responded ${resp ? resp.status() : 'no response captured'}; success notice shown=${notice}; row visible after reload=${rowVisible}`,
      evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 800),
    });
  } else {
    console.log('PASS: policy persisted across reload');
  }
  console.log('badRequests:', log.badRequests);
  console.log('pageErrors:', log.pageErrors);
} catch (e) {
  console.log('SCRIPT ERROR', e.message);
} finally {
  await browser.close();
}
