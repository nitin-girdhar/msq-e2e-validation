// Regression pass for the cycle-8 items (2026-10-09), run in cycle 9.
//   C8-2  overlapping forgot-password requests leave at most ONE live reset link and never
//         exceed the per-user cap (advisory lock in createResetToken). Fired concurrently from
//         inside the identity container, so the gateway's 5/15-min IP bucket is not spent.
//   C8-3  PATCH / DELETE / POST rotate on /api-clients/:id with a malformed id is a 4xx, never 500
//   N4    React hydration error #418 on /hrms/attendance (sales_representative) — still open in
//         cycle 8; recorded with the console text so it can be root-caused
//   (N6 tenant_admin lead edit is driven through the browser by suites/ui/ui-write-roundtrip.mjs S1.)
// Every row it creates is removed in finally.
//
//   node suites/regression/cycle8-fixes.mjs
import { execFileSync } from 'node:child_process';
import { APPS, GATEWAY, openState, visit } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable, q, scalar, lit } from '../../db.mjs';
import { req, reporter, isOk, sleep } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('regression', 'Cycle-8 fixes');
const { fail, log } = rep;
const cleanup = [];

try {
  // ── C8-2 concurrent reset requests ────────────────────────────────────────
  {
    const email = 'readonly.fitclass@e2e-fixture.test';
    const uid = scalar(`SELECT id FROM iam.users WHERE email=${lit(email)} LIMIT 1`);
    if (!uid) log({ role: 'anonymous', action: 'C8-2 skipped (fixture user missing)', status: null, outcome: 'visible' });
    else {
      const t0 = scalar(`SELECT now()::text`);
      cleanup.push(`DELETE FROM iam.password_reset_tokens WHERE user_id=${lit(uid)} AND created_at >= ${lit(t0)}::timestamptz`);
      // Clear the window so the cap starts at 0 for this user.
      q(`UPDATE iam.password_reset_tokens SET created_at = created_at - interval '1 day' WHERE user_id=${lit(uid)} AND created_at > now() - interval '1 day'`);
      const js = `const s=process.env.INTERNAL_SERVICE_SECRET;const f=()=>fetch('http://localhost:4001/api/v1/auth/forgot-password',{method:'POST',headers:{'content-type':'application/json','x-internal-secret':s},body:JSON.stringify({email:${JSON.stringify(email)}})}).then(r=>r.status).catch(()=>-1);Promise.all([f(),f(),f(),f(),f()]).then(a=>console.log(a.join(',')));`;
      let statuses = '';
      try { statuses = execFileSync('docker', ['exec', 'msq-identity-service-1', 'node', '-e', js], { encoding: 'utf8', timeout: 60000 }).trim(); } catch (e) { statuses = `exec failed: ${String(e.message).slice(0, 80)}`; }
      await sleep(4000); // the token write runs after the response
      const total = Number(scalar(`SELECT count(*) FROM iam.password_reset_tokens WHERE user_id=${lit(uid)} AND created_at >= ${lit(t0)}::timestamptz`));
      const live = Number(scalar(`SELECT count(*) FROM iam.password_reset_tokens WHERE user_id=${lit(uid)} AND used_at IS NULL AND expires_at > now()`));
      const ok = live <= 1 && total <= 3 && total >= 1;
      log({ role: 'anonymous', area: 'Password recovery', action: `5 concurrent forgot requests -> tokens=${total} live=${live} (${statuses})`, method: 'POST', endpoint: '/auth/forgot-password', status: 200, verified: ok, expected: '1..3 tokens, at most 1 live' });
      if (live > 1) fail('high', 'anonymous', `Concurrent reset requests leave ${live} live reset links`, 'at most 1', `${live}`, statuses, 'auth.repository createResetToken: pg_advisory_xact_lock(hashtextextended(user_id,0)) then retire older tokens inside the lock.');
      if (total > 3) fail('medium', 'anonymous', `Per-user reset cap exceeded under concurrency (${total})`, '<= 3 per window', `${total}`, statuses, 'Re-check the cap inside the advisory lock.');
      if (total === 0) fail('high', 'anonymous', 'Concurrent forgot-password created no token', '>= 1', '0', statuses, '');
    }
  }

  // ── C8-3 malformed api-client id ──────────────────────────────────────────
  for (const key of ['tenant_admin', 'org_admin']) {
    const a = await actor(key).catch(() => null); if (!a) continue;
    try {
      for (const [m, p, body] of [['PATCH', '/api-clients/not-a-uuid', { name: 'x' }], ['DELETE', '/api-clients/not-a-uuid'], ['POST', '/api-clients/not-a-uuid/rotate', {}], ['DELETE', '/api-clients/12345']]) {
        const r = await req(a, m, `${GATEWAY}${p}`, { data: body });
        const ok = r.status >= 400 && r.status < 500;
        log({ role: key, area: 'API Tokens', action: `${m} ${p}`, method: m, endpoint: p, status: r.status, verified: ok, expected: '4xx (422 or 403)' });
        if (!ok) fail(r.status >= 500 ? 'medium' : 'low', key, `${m} ${p} with a malformed id`, '4xx', `HTTP ${r.status}`, r.text.slice(0, 160), 'api-clients.router.ts: validate({ params: z.object({ id: z.string().uuid() }) }).');
      }
    } finally { await a.close(); }
  }

  // ── N4 hydration #418 ─────────────────────────────────────────────────────
  for (const key of ['sales_representative', 'org_admin', 'hr_admin']) {
    const { browser, page } = await openState(key);
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' && /#418|#423|#425|hydrat/i.test(m.text())) errs.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => { if (/#418|#423|#425|hydrat/i.test(String(e.message))) errs.push(String(e.message).slice(0, 240)); });
    try {
      for (const path of ['/attendance', '/leave', '/']) {
        errs.length = 0;
        await visit(page, `${APPS['hr-web']}${path}`);
        await page.waitForTimeout(3000);
        log({ role: key, area: 'HR', tab: path, action: `hydration errors on /hrms${path}: ${errs.length}`, status: null, outcome: errs.length ? 'error' : 'visible', verified: errs.length === 0 });
        if (errs.length) fail('medium', key, `React hydration error on /hrms${path}`, 'no hydration mismatch', errs[0], errs.join(' | '), 'Server and browser render a different date: MyMonthCalendar.tsx:65 / TeamRosterShell.tsx:24 / PunchLog.tsx:44 derive "today" from new Date() in the render path. Compute it in useEffect or from the server-provided date in the org timezone.', `/hrms${path}`);
      }
    } finally { await browser.close(); }
  }

} finally {
  for (const s of cleanup) { try { q(s); } catch { /* best effort */ } }
  console.log(`\n${rep.state.actions} actions, ${rep.state.findings} findings`);
}
