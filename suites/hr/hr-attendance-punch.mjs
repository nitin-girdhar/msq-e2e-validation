import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { APPS, record, dir } from '../../lib.mjs';
const BASE = APPS['hr-web'];
const role = process.argv[2] || 'org_manager';

const statePath = path.join(dir, '.auth', `${role}.json`);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({
  storageState: statePath,
  geolocation: { latitude: 28.4595, longitude: 77.0266 },
  permissions: ['geolocation', 'camera'],
});
const page = await ctx.newPage();
const log = { consoleErrors: [], pageErrors: [], badRequests: [] };
page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => log.pageErrors.push(String(e.message).slice(0, 300)));
page.on('response', (r) => { if (r.status() >= 400) log.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

try {
  await page.goto(`${BASE}/attendance`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  const bodyBefore = await page.locator('body').innerText().catch(() => '');
  console.log('Today card area:', bodyBefore.slice(0, 400).replace(/\n+/g, ' | '));

  const checkInBtn = page.getByRole('button', { name: /check in/i });
  const hasCheckIn = await checkInBtn.isVisible().catch(() => false);
  console.log('Check in button visible?', hasCheckIn);
  if (!hasCheckIn) {
    console.log('User appears already checked in today (or button not found) - skipping punch, checking check-out instead.');
  } else {
    await checkInBtn.click();
    const dialog = page.locator('[role="dialog"]');
    const opened = await dialog.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    console.log('Modal (role=dialog) opened after click?', opened);
    if (!opened) {
      console.log('body right after click:', (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\n+/g, ' | '));
    }
    await page.waitForTimeout(1000);
    const bodyModal = await page.locator('body').innerText().catch(() => '');
    const idx = bodyModal.indexOf('Location');
    console.log('Modal state after opening:', idx >= 0 ? bodyModal.slice(idx, idx + 500).replace(/\n+/g, ' | ') : '(no "Location" section found)');

    // Wait for geolocation to resolve inside the modal
    await page.waitForTimeout(1500);
    const captureBtn = page.getByRole('button', { name: /capture photo/i });
    if (await captureBtn.isVisible().catch(() => false)) {
      await captureBtn.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    const submitBtn = page.getByRole('button', { name: /^check in$/i }).last();
    const disabled = await submitBtn.isDisabled().catch(() => true);
    console.log('Submit (check in) disabled after geo capture?', disabled);
    if (!disabled) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/attendance/check-in'), { timeout: 15000 }).catch(() => null),
        submitBtn.click(),
      ]);
      console.log('check-in response:', resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
      console.log('check-in response Date header:', resp ? resp.headers()['date'] : 'none');
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(800);
      const bodyAfter = await page.locator('body').innerText().catch(() => '');
      console.log('Today card after reload:', bodyAfter.slice(0, 400).replace(/\n+/g, ' | '));
      const hasCheckOutNow = await page.getByRole('button', { name: /check out/i }).isVisible().catch(() => false);
      console.log('Check-out button now visible (implies check-in persisted)?', hasCheckOutNow);
      if (!hasCheckOutNow) {
        record('hr', {
          severity: 'high',
          role,
          page: '/attendance',
          scenario: 'Check-in then reload - persistence check',
          expected: 'After a successful check-in, reloading the page should show a Check-out option (state persisted)',
          actual: `check-in response status=${resp ? resp.status() : 'none'}; after reload, Check-out button visible=${hasCheckOutNow}`,
          evidence: bodyAfter.slice(0, 600),
        });
      } else {
        console.log('PASS: check-in persisted after reload');
      }
    } else {
      const modalBody = await page.locator('body').innerText().catch(() => '');
      console.log('Blocked submit - modal body:', modalBody.slice(0, 700).replace(/\n+/g, ' | '));
    }
  }
  console.log('badRequests:', log.badRequests);
  console.log('pageErrors:', log.pageErrors);
} catch (e) {
  console.log('SCRIPT ERROR', e.message);
} finally {
  await browser.close();
}
