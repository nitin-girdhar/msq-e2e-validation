// Account & session lifecycle on a THROWAWAY user — password change, canonical
// email login, session invalidation, logout revocation.
//
// These touch the credential itself, so they must never run against a real
// roles.json login: a password change bumps password_changed_at, and
// resolveSession rejects every token whose pwd_iat predates it — every stored
// .auth session for that user would be dead for the rest of the night.
// org_admin creates a user, sets a known password (reset-password with
// new_password, force_password_change:false), and everything below runs as it.
//
//   1. login works; login with the email in UPPER CASE works (canonical emails)
//   2. change-password: wrong current -> 400 (not 500 — ad7b6f2 fixed a 500
//      here), weak new -> 400/422, correct -> 2xx
//   3. after a change, a SECOND session opened before it is dead (pwd_iat);
//      the old password no longer logs in; the new one does
//   4. logout revokes the jti: replaying the cookie afterwards is 401
//
//   node suites/core/account-session-lifecycle.mjs
import { roleMeta, GATEWAY } from '../../lib.mjs';
import { actor, apiPost, apiGet, freshLogin, readResp } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import { finder, isOk, purgeE2eUsers, userIdByEmail, e2eMarker } from '../../fixtures.mjs';
import { chromium } from '@playwright/test';

const TOOL = 'core';
const fail = finder(TOOL, 'Account & session lifecycle');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const MARK = e2eMarker('acct');
const email = `${MARK}-user@e2e.local`;
const PW1 = `E2e!Pw1${Date.now()}Aa`;
const PW2 = `E2e!Pw2${Date.now()}Bb`;
const orgA = scalar(`SELECT org_id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const repRole = scalar(`SELECT role_id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)}`);

async function replay(cookies) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const r = await readResp(await ctx.request.get(`${GATEWAY}/auth/me`, { failOnStatusCode: false }));
  await browser.close();
  return r;
}

const admin = await actor('org_admin');
const sessions = [];
try {
  await apiPost(admin, `${GATEWAY}/users`, {
    first_name: 'E2E', last_name: 'Account', email,
    org_assignments: [{ org_id: orgA, role_id: repRole }], home_org_id: orgA, send_email_notification: false,
  });
  const uid = userIdByEmail(email);
  if (!uid) { console.log('could not create the throwaway user — aborting'); throw new Error('stop'); }
  const reset = await apiPost(admin, `${GATEWAY}/users/${uid}/reset-password`, { new_password: PW1, force_password_change: false, send_email_notification: false });
  console.log(`setup user=${uid} reset http=${reset.status}`);
  if (!isOk(reset.status)) { fail('high', 'org_admin', 'org_admin resets a same-branch rep\'s password to a chosen value', '2xx', `HTTP ${reset.status}`, JSON.stringify(reset.body).slice(0, 200), 'Check resetPassword strength policy / canManageUser for org_admin → sales rep.'); throw new Error('stop'); }

  // ── 1. login + canonical email ────────────────────────────────────────────
  const s1 = await freshLogin(email, PW1); sessions.push(s1);
  const sUpper = await freshLogin(email.toUpperCase(), PW1); sessions.push(sUpper);
  console.log(`1. login http=${s1.loginStatus}; UPPER-CASE email login http=${sUpper.loginStatus}`);
  if (!isOk(s1.loginStatus)) { fail('high', 'throwaway', 'A freshly reset user cannot log in', '2xx', `HTTP ${s1.loginStatus}`, JSON.stringify(s1.loginBody).slice(0, 200), 'Check the reset path wrote password_hash and cleared force_password_change.'); throw new Error('stop'); }
  if (!isOk(sUpper.loginStatus)) fail('medium', 'throwaway', 'Login is case-sensitive on the email', 'Login succeeds for USER@X.COM when stored as user@x.com (normalizeEmail on the lookup)', `HTTP ${sUpper.loginStatus}`, JSON.stringify(sUpper.loginBody).slice(0, 200), 'resolveLoginUser must normalizeEmail() the identifier before the lookup (c2fba5e).');

  // ── 2. change-password validation ─────────────────────────────────────────
  const cp = (s, body) => apiPost(s, `${GATEWAY}/auth/change-password`, body);
  const wrong = await cp(s1, { current_password: 'definitely-wrong', new_password: PW2 });
  const weak = await cp(s1, { current_password: PW1, new_password: '12345' });
  console.log(`2. wrong current http=${wrong.status} (expect 400); weak new http=${weak.status} (expect 400/422)`);
  if (wrong.status >= 500) fail('high', 'throwaway', 'change-password with a wrong current password 5xxs', '400 Current password is incorrect', `HTTP ${wrong.status}`, JSON.stringify(wrong.body).slice(0, 200), 'Regressed ad7b6f2: keep audit/token side effects best-effort and BadRequestError for the mismatch.');
  else if (isOk(wrong.status)) fail('critical', 'throwaway', 'change-password succeeds with a WRONG current password', '400', `HTTP ${wrong.status}`, '', 'comparePassword must gate the update.');
  if (isOk(weak.status)) fail('medium', 'throwaway', 'change-password accepts a weak new password', '400/422 from createStrongPasswordSchema', `HTTP ${weak.status}`, '', 'Parse the body with changePasswordSchema.');

  // ── 3. real change: other sessions die, credentials rotate ────────────────
  const s2 = await freshLogin(email, PW1); sessions.push(s2);
  const s2Cookies = await s2.cookies();
  await new Promise((r) => setTimeout(r, 1100)); // pwd_iat is whole seconds
  const ok = await cp(s1, { current_password: PW1, new_password: PW2 });
  const self = await apiGet(s1, `${GATEWAY}/auth/me`);
  const other = await replay(s2Cookies);
  console.log(`3. change http=${ok.status}; changing session /me=${self.status}; OTHER session /me=${other.status} (expect 401)`);
  if (!isOk(ok.status)) fail('high', 'throwaway', 'change-password with valid input fails', '2xx and a fresh session cookie', `HTTP ${ok.status}`, JSON.stringify(ok.body).slice(0, 200), 'Check changePassword + the audit/token best-effort block.');
  else {
    if (!isOk(self.status)) fail('medium', 'throwaway', 'Changing your password logs YOU out', 'The changing session is re-issued a token with the new pwd_iat', `/auth/me HTTP ${self.status}`, '', 'Set the new cookie from changePassword\'s returned token.');
    if (isOk(other.status)) fail('high', 'throwaway', 'Other sessions stay valid after a password change', '401 Session invalidated — pwd_iat older than password_changed_at', `/auth/me with the pre-change cookie -> HTTP ${other.status}`, '', 'resolveSession must compare payload.pwd_iat against password_changed_at on every request (and the gateway edge verifier must not short-circuit it).');
    const oldPw = await freshLogin(email, PW1); sessions.push(oldPw);
    const newPw = await freshLogin(email, PW2); sessions.push(newPw);
    console.log(`   old password login=${oldPw.loginStatus} (expect 401) new password login=${newPw.loginStatus}`);
    if (isOk(oldPw.loginStatus)) fail('critical', 'throwaway', 'The OLD password still logs in after a change', '401', `HTTP ${oldPw.loginStatus}`, '', 'repo.changePassword must persist the new hash.');
    if (!isOk(newPw.loginStatus)) fail('high', 'throwaway', 'The NEW password does not log in', '2xx', `HTTP ${newPw.loginStatus}`, JSON.stringify(newPw.loginBody).slice(0, 200), 'Hash/compare mismatch or force_password_change loop.');

    // ── 4. logout revokes ─────────────────────────────────────────────────
    if (isOk(newPw.loginStatus)) {
      const c = await newPw.cookies();
      const out = await apiPost(newPw, `${GATEWAY}/auth/logout`, {});
      const after = await replay(c);
      console.log(`4. logout http=${out.status}; replay old cookie /me=${after.status} (expect 401)`);
      if (isOk(after.status)) fail('high', 'throwaway', 'A logged-out session token still works', '401 — logout revokes the jti at the edge and in identity-service', `/auth/me HTTP ${after.status}`, '', 'revokeJti on logout (gateway /auth/logout) and check the revocation list in verifyJwtEdge.');
    }
  }
} catch (e) {
  if (e.message !== 'stop') throw e;
} finally {
  for (const s of sessions) await s.close().catch(() => {});
  await admin.close();
  console.log(`\npurged: ${JSON.stringify(purgeE2eUsers(`${MARK}-%@e2e.local`))}`);
}
