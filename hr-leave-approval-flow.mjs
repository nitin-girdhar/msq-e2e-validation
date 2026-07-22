import { openAs, APPS, record, ROLES } from './lib.mjs';

const BASE = APPS['hr-web'];
const reasonText = `E2E-approval-flow-${Date.now()}`;

// 1. Apply as sales_representative
async function applyAsRep() {
  const { browser, page } = await openAs('sales_representative');
  try {
    await page.goto(`${BASE}/leave`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.getByRole('button', { name: /apply leave/i }).click();
    await page.waitForTimeout(400);
    const typeSelect = page.locator('#al-type');
    await typeSelect.selectOption({ label: 'Casual Leave' }).catch(async () => {
      const val = await typeSelect.locator('option').nth(1).getAttribute('value');
      await typeSelect.selectOption(val);
    });
    const start = new Date(); start.setDate(start.getDate() + 15);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const iso = (d) => d.toISOString().slice(0, 10);
    await page.locator('#al-start').fill(iso(start));
    await page.locator('#al-end').fill(iso(end));
    await page.locator('#al-reason').fill(reasonText);
    await page.waitForTimeout(1500);
    const submitBtn = page.getByRole('button', { name: /submit request/i });
    if (await submitBtn.isDisabled()) {
      console.log('APPLY FAILED: submit disabled (insufficient balance or no policy). Aborting approval-flow test.');
      return false;
    }
    await submitBtn.click();
    await page.waitForTimeout(1500);
    console.log('applied leave request:', reasonText);
    return true;
  } finally {
    await browser.close();
  }
}

// 2. Check which roles see it as pending in /leave/approvals
async function findApprover() {
  const seenBy = [];
  for (const role of ROLES) {
    const { browser, page } = await openAs(role);
    await page.goto(`${BASE}/leave/approvals`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const visible = await page.locator(`text=${reasonText}`).isVisible().catch(() => false);
    console.log(`[${role}] sees pending request? ${visible}`);
    if (visible) seenBy.push(role);
    await browser.close();
  }
  return seenBy;
}

// 3. Approve as the given role, verify persistence
async function approveAs(role) {
  const { browser, page } = await openAs(role);
  try {
    await page.goto(`${BASE}/leave/approvals`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const row = page.locator('tr', { hasText: reasonText });
    await row.getByRole('button', { name: /review/i }).click({ timeout: 10000 });
    await page.waitForTimeout(500);
    await page.locator('#ad-comment').fill('E2E-approved-by-test');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /\/leave\/requests\/.*\/approve/.test(r.url()), { timeout: 15000 }).catch(() => null),
      page.getByRole('button', { name: /^approve$/i }).click(),
    ]);
    console.log('approve response:', resp ? resp.status() : 'none', resp ? await resp.text().catch(() => '') : '');
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(600);
    const stillPending = await page.locator(`text=${reasonText}`).isVisible().catch(() => false);
    console.log('still shown in pending queue after reload?', stillPending, '(expected: false, since approved)');
    return !stillPending;
  } finally {
    await browser.close();
  }
}

// 4. Verify status on the requester's own dashboard
async function verifyStatusForRequester() {
  const { browser, page } = await openAs('sales_representative');
  try {
    await page.goto(`${BASE}/leave`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const rowText = await page.locator('tr', { hasText: reasonText }).innerText().catch(() => '');
    console.log('requester row after approval:', rowText.replace(/\n/g, ' | '));
    return rowText;
  } finally {
    await browser.close();
  }
}

const applied = await applyAsRep();
if (applied) {
  const approvers = await findApprover();
  if (approvers.length === 0) {
    record('hr', {
      severity: 'high',
      role: 'sales_representative (as requester); all 6 roles checked as viewers',
      page: '/leave/approvals',
      scenario: 'Leave request approval routing - no role can see the pending request',
      expected: 'At least one role (the requester\'s resolved manager-chain approver, or org_admin via canManageLeave override) should see the pending request in /leave/approvals',
      actual: `None of [${ROLES.join(', ')}] saw the pending request "${reasonText}" in their approvals queue.`,
      evidence: 'See console output of hr-leave-approval-flow.mjs run',
    });
    console.log('No approver found; cannot continue approval test.');
  } else {
    console.log('Approvers who can see the request:', approvers);
    const approverRole = approvers.includes('org_admin') && approvers.length > 1
      ? approvers.find((r) => r !== 'org_admin')
      : approvers[0];
    console.log('Approving as:', approverRole);
    const ok = await approveAs(approverRole);
    if (!ok) {
      record('hr', {
        severity: 'high',
        role: approverRole,
        page: '/leave/approvals',
        scenario: 'Approve a leave request then reload - persistence check',
        expected: 'After approving, the request should disappear from the pending queue on reload',
        actual: 'Request still shown as pending after reload',
        evidence: 'See console output of hr-leave-approval-flow.mjs run',
      });
    } else {
      console.log('PASS: approval persisted (removed from pending queue)');
    }
    const rowText = await verifyStatusForRequester();
    if (!/approved/i.test(rowText)) {
      record('hr', {
        severity: 'high',
        role: 'sales_representative',
        page: '/leave',
        scenario: 'Requester view after their leave request is approved',
        expected: 'Row status should read "Approved" on the requester\'s My Leave dashboard',
        actual: `Row text: "${rowText}"`,
        evidence: rowText,
      });
    } else {
      console.log('PASS: requester sees Approved status');
    }
  }
}
