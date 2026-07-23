import { openAs, APPS, record } from '../../lib.mjs';

const BASE = APPS['hr-web'];

// Try calling leave admin-only endpoints directly as a non-admin role, to make sure
// the backend enforces authorization even if the UI hides the controls.
const role = 'sales_representative';
const { browser, page, log } = await openAs(role);
try {
  await page.goto(`${BASE}/leave`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

  const results = await page.evaluate(async () => {
    const out = {};
    // 1. Try to create a leave policy (HR admin only)
    try {
      const r1 = await fetch('/api/hr/leave/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leave_type_name: 'casual',
          org_id: null,
          accrual_frequency: 'none',
          accrual_amount: 0,
          carry_forward: false,
          min_notice_days: 0,
          allow_half_day: true,
          approval_levels: 1,
          applicable_from: '2026-01-01',
        }),
      });
      out.createPolicy = { status: r1.status, body: await r1.text() };
    } catch (e) { out.createPolicy = { error: String(e) }; }

    // 2. Try to record a manual leave ledger adjustment (HR admin only)
    try {
      const r2 = await fetch('/api/hr/leave/adjustment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: '00000003-0000-0000-0001-000000000000', leave_type_name: 'casual', amount: 999, note: 'E2E-unauthorized-attempt' }),
      });
      out.adjustment = { status: r2.status, body: await r2.text() };
    } catch (e) { out.adjustment = { error: String(e) }; }

    // 3. Try to view team-scope regularizations directly (requires manager+ rank)
    try {
      const r3 = await fetch('/api/hr/attendance/regularizations?scope=team&status=pending&limit=10');
      out.teamRegularizations = { status: r3.status, body: (await r3.text()).slice(0, 300) };
    } catch (e) { out.teamRegularizations = { error: String(e) }; }

    return out;
  });

  console.log(JSON.stringify(results, null, 2));

  if (results.createPolicy?.status && results.createPolicy.status < 400) {
    record('hr', {
      severity: 'critical',
      role,
      page: 'API: POST /api/hr/leave/policies',
      scenario: 'Non-admin role directly calls the create-leave-policy endpoint (bypassing UI, which hides this control)',
      expected: 'HTTP 403 Forbidden (only HR admins/org admins may create leave policies, per leave.service.ts#createPolicy)',
      actual: `HTTP ${results.createPolicy.status}: ${results.createPolicy.body}`,
      evidence: JSON.stringify(results.createPolicy),
    });
  } else {
    console.log('PASS: createPolicy correctly blocked for sales_representative:', results.createPolicy?.status);
  }

  if (results.adjustment?.status && results.adjustment.status < 400) {
    record('hr', {
      severity: 'critical',
      role,
      page: 'API: POST /api/hr/leave/adjustment',
      scenario: 'Non-admin role directly calls the manual leave-ledger-adjustment endpoint',
      expected: 'HTTP 403 Forbidden',
      actual: `HTTP ${results.adjustment.status}: ${results.adjustment.body}`,
      evidence: JSON.stringify(results.adjustment),
    });
  } else {
    console.log('PASS: adjustment correctly blocked for sales_representative:', results.adjustment?.status);
  }

  if (results.teamRegularizations?.status && results.teamRegularizations.status < 400) {
    console.log('NOTE: team regularizations scope=team returned', results.teamRegularizations.status, '- checking if data is actually scoped/empty (already known: backend 403s here, see earlier finding).');
  }

  console.log('badRequests during this probe:', log.badRequests);
} finally {
  await browser.close();
}
