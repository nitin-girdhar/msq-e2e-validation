import { openAs, APPS, record } from '../../lib.mjs';

const BASE = APPS['hr-web'];
const role = 'org_admin';

const { browser, page, log } = await openAs(role);
try {
  await page.goto(`${BASE}/leave/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  console.log('heading:', await page.locator('h1,h2').first().innerText().catch(() => ''));

  // Policies tab is default. Create a casual-leave policy so downstream apply-leave tests work.
  const createBtn = page.getByRole('button', { name: /create \/ revise policy/i });
  await createBtn.click({ timeout: 10000 }).catch((e) => console.log('create policy click failed', e.message));
  await page.waitForTimeout(500);

  const typeName = `E2E-casual-${Date.now()}`.slice(0, 30); // custom type to avoid clobbering existing seeded ones
  // Prefer a real recognizable type so ApplyLeaveModal picks it cleanly:
  await page.locator('#pf-type').fill('casual');
  await page.locator('#pf-freq').selectOption('monthly');
  await page.locator('#pf-amount').fill('1.5');
  await page.locator('#pf-levels').fill('1');

  const saveBtn = page.getByRole('button', { name: /save policy/i });
  await saveBtn.click().catch((e) => console.log('save policy click failed', e.message));
  await page.waitForTimeout(1500);

  const notice = await page.locator('text=Policy revision saved').isVisible().catch(() => false);
  console.log('policy save notice visible?', notice);

  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(800);
  const rowVisible = await page.locator('td:has-text("casual")').first().isVisible().catch(() => false);
  console.log('casual policy row visible after reload?', rowVisible);
  if (!rowVisible) {
    record('hr', {
      severity: 'high',
      role,
      page: '/leave/admin',
      scenario: 'Create leave policy (Policies tab) then reload - persistence check',
      expected: 'Newly created "casual" policy row visible in the Policies table after reload',
      actual: `Save notice shown=${notice}; row visible after reload=${rowVisible}`,
      evidence: (await page.locator('body').innerText().catch(() => '')).slice(0, 800),
    });
  } else {
    console.log('PASS: leave policy persisted');
  }

  // ---- Holidays tab ----
  await page.getByRole('button', { name: /^holidays$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Holidays tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\n+/g, ' | '));

  // ---- Leave cycle tab ----
  await page.getByRole('button', { name: /leave cycle/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Leave cycle tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\n+/g, ' | '));

  // ---- Employees tab ----
  await page.getByRole('button', { name: /^employees$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Employees tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  // ---- Adjustment tab ----
  await page.getByRole('button', { name: /^adjustment$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Adjustment tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  console.log('badRequests so far:', log.badRequests);
  console.log('pageErrors so far:', log.pageErrors);

  // ---- Now Attendance admin ----
  log.badRequests.length = 0;
  await page.goto(`${BASE}/attendance/admin`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  console.log('attendance admin heading:', await page.locator('h1,h2').first().innerText().catch(() => ''));

  // Rules tab (default)
  console.log('Rules tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  await page.getByRole('button', { name: /^shifts$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Shifts tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  await page.getByRole('button', { name: /^assignments$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Assignments tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  await page.getByRole('button', { name: /^reports$/i }).click().catch(() => {});
  await page.waitForTimeout(500);
  console.log('Reports tab body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '));

  console.log('attendance admin badRequests:', log.badRequests);
  console.log('attendance admin pageErrors:', log.pageErrors);
} catch (e) {
  console.log('SCRIPT ERROR', e.message);
} finally {
  await browser.close();
}
