// Self-service password recovery: POST /auth/forgot-password, POST /auth/reset-password
// and the three auth-web pages /forgot-password, /reset-password, /offline.
//
// Contract (auth.controller.ts / auth.service.ts / auth.repository.ts):
//   * forgot: ALWAYS the same 200 {success:true,data:null}, sent before the lookup runs, so
//     neither body nor timing says whether the email exists; gateway cap 5 / 15 min / IP; per
//     user 3 emails / 15 min; a newer request kills the older unused token.
//   * reset: token = 32 random bytes base64url (43 chars), only SHA-256 stored; one UPDATE ...
//     RETURNING spends it (single use even under a race); 15 min TTL; inactive users refused;
//     sets password, clears force_password_change + lockout; ALL sessions revoked.
//   * the raw token only ever exists in the email: the harness plants a token it knows by
//     inserting sha256(token) into iam.password_reset_tokens (superuser), which is exactly
//     what the service would have stored.
//
// Checks: R1 happy path + DB  R2 replay  R3 expired  R4 unknown/used/expired indistinguishable
//   R5 malformed  R6 weak password does not burn the token  R7 concurrent double submit
//   R8 old sessions dead  R9 inactive user  R10 flags cleared  R11 forgot: no enumeration (body,
//   headers, timing), per-user cap, token supersession, rate limit  R12 token/password never in
//   logs or responses  R13 identity-service refuses without the gateway secret  R14 limiter
//   coupling (reset shares the login bucket)  U1-U3 browser pages.
//
// Throwaway users only (@e2e.local); nothing from roles.json is touched. NOTE: the forgot
// route's IP bucket (5 / 15 min) cannot be reset without restarting the gateway - a second run
// inside 15 minutes reports "bucket already spent" and skips the gateway-side forgot checks.
//
//   node suites/core/auth-recovery.mjs
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { roleMeta, GATEWAY, GATEWAY_DIRECT, APPS, authFile } from '../../lib.mjs';
import { actor, apiPost, freshLogin, simultaneously } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { purgeE2eUsers, userIdByEmail, e2eMarker, restorePending } from '../../fixtures.mjs';
import { req, anon, reporter, sleep, isOk } from '../../kit.mjs';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('core', 'Password recovery (forgot / reset / offline)');
const { fail, log } = rep;
restorePending('auth-recovery-');

const MARK = e2eMarker('recov');
const mail = (t) => `${MARK}-${t}@e2e.local`;
const PW0 = `E2e!Pw0${Date.now()}Aa`;
const pw = (n) => `E2e!Reset${n}${Date.now()}Zz`;
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const GENERIC = /invalid or has expired/i;

const orgA = scalar(`SELECT org_id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const repRole = scalar(`SELECT role_id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)}`);
const ctr = { created: [] };

async function mkUser(tag, admin) {
  const email = mail(tag);
  await apiPost(admin, `${GATEWAY}/users`, { first_name: 'E2E', last_name: `Recov-${tag}`, email, org_assignments: [{ org_id: orgA, role_id: repRole }], home_org_id: orgA, send_email_notification: false });
  const id = userIdByEmail(email);
  if (!id) throw new Error(`could not create throwaway ${email}`);
  const r = await apiPost(admin, `${GATEWAY}/users/${id}/reset-password`, { new_password: PW0, force_password_change: false, send_email_notification: false });
  if (r.status >= 300) throw new Error(`could not set a password for ${email}: ${r.status}`);
  ctr.created.push(email);
  return { email, id };
}
const plant = (uid, token, { ttlMin = 15, used = false } = {}) => q(
  `INSERT INTO iam.password_reset_tokens (user_id, token_hash, created_at, expires_at, used_at, requested_ip)
   VALUES (${lit(uid)}, ${lit(sha(token))}, CLOCK_TIMESTAMP() + make_interval(mins => ${ttlMin - 15}), CLOCK_TIMESTAMP() + make_interval(mins => ${ttlMin}), ${used ? 'CLOCK_TIMESTAMP()' : 'NULL'}, '127.0.0.1')`);
const tokState = (token) => rows(`SELECT used_at IS NOT NULL, expires_at > now() FROM iam.password_reset_tokens WHERE token_hash=${lit(sha(token))}`, ['used', 'live'])[0] ?? null;
const pwHash = (uid) => scalar(`SELECT password_hash FROM iam.users WHERE id=${lit(uid)}`);

// reset through the gateway (host IP bucket), waiting out the shared 10/min limiter instead of failing on it
const D = await anon();
async function reset(token, password, { noRetry = false } = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: { token, new_password: password } });
    if (r.status !== 429 || noRetry) return r;
    const w = Math.min(Math.max(Number(r.headers['retry-after']) || 15, 2), 65);
    console.log(`  (reset-password 429, waiting ${w}s)`);
    await sleep(w * 1000 + 300);
  }
  return req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: { token, new_password: password } });
}
async function canLogin(email, password) {
  const s = await freshLogin(email, password);
  const ok = s.loginStatus >= 200 && s.loginStatus < 300;
  await s.close();
  return ok;
}

const IDC = 'msq-identity-service-1';
function inIdentity(js) {
  return execFileSync('docker', ['exec', IDC, 'node', '-e', js], { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
}

const admin = await actor('org_admin');
const sinceIso = new Date(Date.now() - 2000).toISOString();
try {
  const U = await mkUser('main', admin);
  const U2 = await mkUser('conc', admin);
  const U3 = await mkUser('ui', admin);
  const UT = await mkUser('timing', admin);
  const UI_ = await mkUser('inactive', admin);
  const UF = await mkUser('forgot', admin);
  console.log(`throwaway users ready (6)`);

  // ── R8 prepare: a live session BEFORE the reset ───────────────────────────
  const sessBefore = await freshLogin(U.email, PW0);
  const meBefore = (await req(sessBefore, 'GET', `${GATEWAY}/auth/me`)).status;
  const cookiesBefore = await sessBefore.cookies();
  await sleep(1100); // password_changed_at / iat are whole seconds

  // ── R10 prepare flags that the reset must clear ───────────────────────────
  q(`UPDATE iam.users SET force_password_change=TRUE, failed_login_attempts=4, locked_until=now()+interval '30 minutes' WHERE id=${lit(U.id)}`);

  // ── R1 happy path ─────────────────────────────────────────────────────────
  console.log('\n== R1-R10 reset-password ==');
  const T1 = newToken(); plant(U.id, T1);
  const hashBefore = pwHash(U.id);
  const PW1 = pw(1);
  const r1 = await reset(T1, PW1);
  const st1 = tokState(T1);
  const hashAfter = pwHash(U.id);
  const leaked = r1.text.includes(T1) || r1.text.includes(sha(T1)) || r1.text.includes(PW1);
  log({ role: 'anonymous', action: 'reset-password with a valid planted token', method: 'POST', endpoint: '/auth/reset-password', status: r1.status, verified: r1.status === 200 && st1?.used === 't' && hashAfter !== hashBefore, expected: '200, token spent, password changed' });
  if (r1.status !== 200 || r1.body?.success !== true) fail('high', 'anonymous', 'Reset with a valid token failed', '200 {success:true,data:null}', `HTTP ${r1.status}`, r1.text.slice(0, 200), 'consumeResetTokenAndSetPassword / strong-password schema.');
  if (st1?.used !== 't') fail('high', 'anonymous', 'Token not marked used after a successful reset', 'used_at set', JSON.stringify(st1), '', 'Single-use guard.');
  if (hashAfter === hashBefore) fail('critical', 'anonymous', 'Reset returned success but the password hash did not change', 'password_hash updated', 'unchanged', '', 'Same transaction as the token spend.');
  if (leaked) fail('high', 'anonymous', 'Reset response echoes the token / hash / password', 'body is {success:true,data:null}', r1.text.slice(0, 200), '', 'Never reflect secrets.');
  if (r1.headers['set-cookie']) fail('medium', 'anonymous', 'Reset sets a session cookie', 'no session minted (user signs in again)', String(r1.headers['set-cookie']).slice(0, 80), '', 'resetPassword must not log the user in.');
  const fl = rows(`SELECT force_password_change::text, failed_login_attempts::text, COALESCE(locked_until::text,'') FROM iam.users WHERE id=${lit(U.id)}`, ['f', 'n', 'l'])[0];
  log({ role: U.email, action: 'reset clears force_password_change + lockout', method: 'GET', endpoint: 'db', status: 200, verified: fl.f === 'false' && fl.n === '0' && fl.l === '', expected: 'false / 0 / null' });
  if (!(fl.f === 'false' && fl.n === '0' && fl.l === '')) fail('medium', 'throwaway', 'Reset leaves the account locked or flagged', 'force_password_change=false, failed_login_attempts=0, locked_until=null', JSON.stringify(fl), '', 'consumeResetTokenAndSetPassword UPDATE.');

  const loginNew = await canLogin(U.email, PW1);
  const loginOld = await canLogin(U.email, PW0);
  log({ role: U.email, action: 'login with the NEW password / the OLD password after reset', method: 'POST', endpoint: '/auth/login', status: loginNew ? 200 : 401, verified: loginNew && !loginOld, expected: 'new works, old refused' });
  if (!loginNew) fail('high', 'throwaway', 'New password does not log in after a reset', '2xx', 'login refused', '', 'password_hash/policy mismatch.');
  if (loginOld) fail('critical', 'throwaway', 'OLD password still logs in after a reset', 'refused', 'login ok', '', 'Reset must replace the hash.');
  // R8 old session dead
  const meAfter = (await req(sessBefore, 'GET', `${GATEWAY}/auth/me`)).status;
  const replayCtx = await chromium.launch();
  const rc = await replayCtx.newContext(); await rc.addCookies(cookiesBefore);
  const replay = await req({ request: rc.request }, 'GET', `${GATEWAY}/auth/me`);
  await replayCtx.close();
  log({ role: U.email, action: 'session opened before the reset is revoked', method: 'GET', endpoint: '/auth/me', status: meAfter, verified: meBefore === 200 && meAfter === 401 && replay.status === 401, expected: '200 before, 401 after (replayed cookie too)' });
  if (meBefore !== 200) console.log(`  (pre-reset session status ${meBefore})`);
  else if (meAfter !== 401 || replay.status !== 401) fail('critical', U.email, 'A session opened BEFORE the password reset still works', '401 on every pre-reset session (revokeAllUserSessions)', `live=${meAfter} replayed cookie=${replay.status}`, '', 'resetPassword must revoke all sessions / pwd_iat check.');
  await sessBefore.close();

  // R2 replay
  const r2 = await reset(T1, pw(2));
  const stillNew = await canLogin(U.email, PW1);
  log({ role: 'anonymous', action: 'replay a spent token', method: 'POST', endpoint: '/auth/reset-password', status: r2.status, verified: r2.status === 400 && stillNew, expected: '400 generic, password unchanged' });
  if (isOk(r2.status) || !stillNew) fail('critical', 'anonymous', 'A reset token can be used twice', '400 on the second use', `HTTP ${r2.status}, password changed=${!stillNew}`, r2.text.slice(0, 200), 'The conditional UPDATE ... used_at IS NULL is the single-use guard.');

  // R3 expired / R4 indistinguishable / R9 inactive
  const Te = newToken(); plant(U.id, Te, { ttlMin: -2 });
  const Tu = newToken();                     // never planted
  const Tused = newToken(); plant(U.id, Tused, { used: true });
  const Ti = newToken(); plant(UI_.id, Ti); q(`UPDATE iam.users SET is_active=FALSE WHERE id=${lit(UI_.id)}`);
  const hBefore = pwHash(U.id);
  const out = {};
  for (const [n, t] of [['expired', Te], ['unknown', Tu], ['already used', Tused], ['inactive user', Ti]]) out[n] = await reset(t, pw(3));
  const msgs = new Set(Object.values(out).map((r) => `${r.status}|${r.body?.error?.message ?? r.body?.message ?? r.text}`));
  log({ role: 'anonymous', action: 'expired / unknown / used / inactive tokens all answer identically', method: 'POST', endpoint: '/auth/reset-password', status: out.expired.status, verified: msgs.size === 1 && Object.values(out).every((r) => r.status === 400), expected: 'one 400 message' });
  for (const [n, r] of Object.entries(out)) if (isOk(r.status)) fail('critical', 'anonymous', `Reset accepted a ${n} token`, '400', `HTTP ${r.status}`, r.text.slice(0, 160), 'Check expires_at, used_at and is_active in the conditional UPDATE.');
  if (msgs.size > 1) fail('medium', 'anonymous', 'Reset failure reasons are distinguishable (token oracle)', 'identical status+message for expired/unknown/used/inactive', [...msgs].join(' || ').slice(0, 300), '', 'Always throw the same BadRequestError.');
  if (pwHash(U.id) !== hBefore) fail('critical', 'anonymous', 'A rejected token changed the password', 'unchanged', 'hash changed', '', '');
  if (tokState(Ti)?.used === 't') fail('low', 'anonymous', 'Token of an inactive user was marked used', 'untouched (UPDATE .. FROM users WHERE is_active)', 'used_at set', '', '');

  // R5 malformed + injection: schema must refuse (4xx), never 5xx, no internals
  for (const [n, body] of [
    ['short token', { token: 'abc', new_password: pw(4) }],
    ['43 chars with illegal characters', { token: `${'a'.repeat(42)}!`, new_password: pw(4) }],
    ['SQL injection in token', { token: `' OR '1'='1' -- ${'x'.repeat(30)}`.slice(0, 43), new_password: pw(4) }],
    ['missing password', { token: newToken() }],
    ['extra field (strict)', { token: newToken(), new_password: pw(4), user_id: U.id }],
    ['array token', { token: [newToken()], new_password: pw(4) }],
    ['oversized password (10 KB)', { token: newToken(), new_password: `Aa1${'x'.repeat(10000)}` }],
  ]) {
    const r = await req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: body });
    if (r.status === 429) { await sleep(63000); }
    const ok = (r.status >= 400 && r.status < 500) && !/(\bat [\w$.<>]+ \(|SELECT|violates|node_modules)/i.test(r.text);
    log({ role: 'anonymous', action: `reset-password rejects ${n}`, method: 'POST', endpoint: '/auth/reset-password', status: r.status, verified: ok, expected: '4xx without internals' });
    if (!ok && r.status !== 429) fail(r.status >= 500 ? 'high' : 'medium', 'anonymous', `reset-password with ${n}`, '400/422 without backend internals', `HTTP ${r.status}`, r.text.slice(0, 200), 'Zod strict schema before the DB.');
  }

  // R6 weak password must not burn the token
  const T6 = newToken(); plant(U.id, T6);
  const weak = await reset(T6, 'short1A');
  const afterWeak = tokState(T6);
  const good = await reset(T6, pw(6));
  log({ role: 'anonymous', action: 'a weak password is refused and the token survives', method: 'POST', endpoint: '/auth/reset-password', status: weak.status, verified: !isOk(weak.status) && afterWeak?.used === 'f' && good.status === 200, expected: '4xx, token still live, retry works' });
  if (isOk(weak.status)) fail('high', 'anonymous', 'Reset accepts a weak password', '422', `HTTP ${weak.status}`, '', 'createStrongPasswordSchema.');
  else if (afterWeak?.used === 't') fail('medium', 'anonymous', 'A rejected (weak) password burned the single-use token', 'validation precedes spending the token', 'used_at set', '', 'Parse the body before consumeResetTokenAndSetPassword (it does) - the user would otherwise need a fresh email.');
  if (good.status !== 200) fail('medium', 'anonymous', 'Retry after a weak-password rejection fails', '200', `HTTP ${good.status}`, good.text.slice(0, 160), '');

  // R7 concurrent double submit of ONE live token, two different passwords
  const T7 = newToken(); plant(U2.id, T7);
  const pa = pw('A'), pb = pw('B');
  const res = await simultaneously([() => req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: { token: T7, new_password: pa } }), () => req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: { token: T7, new_password: pb } })]);
  const wins = res.filter((r) => r.status === 200).length;
  const aOk = await canLogin(U2.email, pa), bOk = await canLogin(U2.email, pb);
  log({ role: 'anonymous', action: 'two simultaneous submits of one token', method: 'POST', endpoint: '/auth/reset-password', status: res.map((r) => r.status).join('/'), verified: wins === 1 && (aOk !== bOk), expected: 'exactly one 200; only the winner\'s password works' });
  if (wins !== 1) fail('critical', 'anonymous', `Single-use token race: ${wins} of 2 concurrent submits succeeded`, 'exactly one', res.map((r) => r.status).join('/'), `aOk=${aOk} bOk=${bOk}`, 'Keep the conditional UPDATE...RETURNING; no read-then-write.');
  else if (aOk === bOk) fail('high', 'anonymous', 'After the race neither/both passwords work', 'the winner\'s only', `a=${aOk} b=${bOk}`, '', 'Token spend and password write must be one transaction.');

  // ── R11 forgot-password ──────────────────────────────────────────────────
  console.log('\n== R11 forgot-password ==');
  const fp = (email, via = GATEWAY_DIRECT) => req(D, 'POST', `${via}/auth/forgot-password`, { data: { email } });
  const calls = [];
  const K1 = await fp(UF.email); calls.push(K1);
  if (K1.status === 429) {
    console.log('  forgot-password bucket already spent by a previous run (5 / 15 min / IP) - gateway-side checks skipped');
    log({ role: 'anonymous', action: 'forgot-password IP bucket already spent', method: 'POST', endpoint: '/auth/forgot-password', status: 429, verified: null, outcome: 'no-op', expected: 'rerun after 15 min', note: 'skipped' });
  } else {
    const UNK = await fp(`nobody-${Date.now()}@e2e.local`); calls.push(UNK);
    const K2 = await fp(UF.email.toUpperCase()); calls.push(K2);
    const K3 = await fp(UF.email); calls.push(K3);
    const K4 = await fp(UF.email); calls.push(K4);
    await sleep(2500); // the token write is fire-and-forget after the response
    const same = (a, b) => a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body);
    const hdrKeys = (r) => Object.keys(r.headers).filter((h) => !['date', 'content-length', 'etag', 'x-request-id', 'retry-after'].includes(h)).sort().join(',');
    log({ role: 'anonymous', action: 'known vs unknown email: identical status + body + headers', method: 'POST', endpoint: '/auth/forgot-password', status: K1.status, verified: same(K1, UNK) && hdrKeys(K1) === hdrKeys(UNK), expected: '200 {success:true,data:null} both' });
    if (!same(K1, UNK)) fail('high', 'anonymous', 'forgot-password reveals whether an email exists (response differs)', 'identical 200 body', `known=${K1.status} ${K1.text.slice(0, 80)} | unknown=${UNK.status} ${UNK.text.slice(0, 80)}`, '', 'Controller replies before the lookup - keep it that way.');
    if (hdrKeys(K1) !== hdrKeys(UNK)) fail('medium', 'anonymous', 'forgot-password response headers differ known vs unknown', 'same header set', `${hdrKeys(K1)} | ${hdrKeys(UNK)}`, '', 'e.g. Set-Cookie or cache headers set on one path only.');
    if (K1.status !== 200 || K1.body?.success !== true) fail('high', 'anonymous', 'forgot-password for a real account does not answer 200', '200', `HTTP ${K1.status}`, K1.text.slice(0, 160), '');
    const toks = Number(scalar(`SELECT COUNT(*) FROM iam.password_reset_tokens WHERE user_id=${lit(UF.id)}`));
    const unused = Number(scalar(`SELECT COUNT(*) FROM iam.password_reset_tokens WHERE user_id=${lit(UF.id)} AND used_at IS NULL`));
    log({ role: UF.email, action: '4 forgot requests -> at most 3 tokens, only the newest live', method: 'GET', endpoint: 'iam.password_reset_tokens', status: 200, verified: toks === 3 && unused === 1, expected: '3 rows (cap), 1 unused' });
    if (toks > 3) fail('medium', 'anonymous', `Per-user reset-email cap not enforced (${toks} tokens in one window)`, 'max 3 per 15 min (RESET_MAX_PER_WINDOW)', `${toks} rows`, '', 'countRecentResetRequests gate in requestPasswordReset.');
    if (toks === 0) fail('high', 'anonymous', 'forgot-password for a real account created no reset token', '>=1 row', '0', '', 'requestPasswordReset (is the canonical email lookup failing?).');
    if (unused > 1) fail('high', 'anonymous', `Older reset links stay valid when a newer one is requested (${unused} live tokens)`, 'only the most recent link works', `${unused} unused`, '', 'createResetToken must retire older unused tokens.');
    // forgot with no per-account side effect for the unknown email
    const unkRows = Number(scalar(`SELECT COUNT(*) FROM iam.password_reset_tokens t JOIN iam.users u ON u.id=t.user_id WHERE u.email LIKE '%nobody-%@e2e.local'`));
    if (unkRows) fail('medium', 'anonymous', 'A token row exists for a non-existent account', '0', String(unkRows), '', '');
    // invalid emails (6th call is also the 429 probe, so use the identity service for the rest)
    const K5 = await fp(UF.email); calls.push(K5);          // 5th: still allowed
    const K6 = await fp(UF.email); calls.push(K6);          // 6th: 429
    log({ role: 'anonymous', action: 'forgot-password IP rate limit (5 / 15 min)', method: 'POST', endpoint: '/auth/forgot-password', status: K6.status, verified: K5.status === 200 && K6.status === 429, expected: '5th 200, 6th 429 + Retry-After' });
    if (K6.status !== 429) fail('high', 'anonymous', 'forgot-password is not rate limited (each hit can send an email)', '429 on the 6th request inside 15 min', `6th -> HTTP ${K6.status}`, '', 'forgotPasswordRateLimit must stay on the route and key on a trustworthy client IP.');
    else if (!K6.headers['retry-after']) fail('low', 'anonymous', '429 on forgot-password without Retry-After', 'header present', '(none)', '', '');
    // the 429 body must not differ per account either
    const K7 = await fp(`nobody-x-${Date.now()}@e2e.local`);
    if (K7.status !== 429) fail('medium', 'anonymous', 'Rate limit is per-account rather than per-IP (unknown email still allowed)', '429 for any email once the IP bucket is spent', `HTTP ${K7.status}`, '', 'Limiter keys on request.ip only.');
    if (calls.some((c) => c.status >= 500)) fail('high', 'anonymous', 'forgot-password 5xx', '200', calls.map((c) => c.status).join(','), '', '');
  }

  // timing + validation + secret via the identity service from inside its container (no gateway bucket)
  try {
    const js = `
      const s=process.env.INTERNAL_SERVICE_SECRET;
      const post=(p,b,h)=>fetch('http://localhost:4001/api/v1'+p,{method:'POST',headers:Object.assign({'content-type':'application/json'},h||{}),body:JSON.stringify(b)});
      const sec={'x-internal-secret':s};
      const t=async(e)=>{const a=performance.now();const r=await post('/auth/forgot-password',{email:e},sec);await r.text();return performance.now()-a;};
      (async()=>{
        const kn=[],un=[];
        for(let i=0;i<30;i++){ kn.push(await t(${JSON.stringify(UT.email)})); un.push(await t('nobody'+i+'@e2e.local')); }
        const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
        const bad=await post('/auth/forgot-password',{email:'not-an-email'},sec);
        const nosec=await post('/auth/forgot-password',{email:'a@b.co'});
        const nosec2=await post('/auth/reset-password',{token:'${'a'.repeat(43)}',new_password:'Abcdefghij1k'});
        const wrong=await post('/auth/forgot-password',{email:'a@b.co'},{'x-internal-secret':'wrong'});
        console.log(JSON.stringify({known:med(kn),unknown:med(un),bad:bad.status,nosec:nosec.status,nosec2:nosec2.status,wrong:wrong.status}));
      })();`;
    const t = JSON.parse(inIdentity(js));
    const ratio = Math.max(t.known, t.unknown) / Math.max(0.1, Math.min(t.known, t.unknown));
    log({ role: 'anonymous', action: 'forgot-password timing known vs unknown (30 samples each, direct)', method: 'POST', endpoint: 'identity /auth/forgot-password', status: 200, verified: ratio < 3 || Math.abs(t.known - t.unknown) < 8, expected: 'indistinguishable', note: `median known=${t.known.toFixed(1)}ms unknown=${t.unknown.toFixed(1)}ms` });
    if (ratio >= 3 && Math.abs(t.known - t.unknown) >= 8) fail('medium', 'anonymous', 'forgot-password timing differs for known vs unknown email', 'medians within noise (response is sent before the lookup)', `known=${t.known.toFixed(1)}ms unknown=${t.unknown.toFixed(1)}ms`, '', 'Keep the reply ahead of requestPasswordReset.');
    log({ role: 'anonymous', action: 'malformed email refused; routes need the gateway secret', method: 'POST', endpoint: 'identity /auth/forgot-password|reset-password', status: t.bad, verified: t.bad >= 400 && t.bad < 500 && [401, 403].includes(t.nosec) && [401, 403].includes(t.nosec2) && [401, 403].includes(t.wrong), expected: '4xx; 401 without/with wrong secret' });
    if (!(t.bad >= 400 && t.bad < 500)) fail('medium', 'anonymous', 'forgot-password with a malformed email is not a clean 4xx', '400/422', `HTTP ${t.bad}`, '', 'forgotPasswordSchema.');
    if (![t.nosec, t.nosec2, t.wrong].every((s) => [401, 403].includes(s))) fail('high', 'anonymous', 'identity-service forgot/reset reachable without the internal secret', '401', `nosecret forgot=${t.nosec} reset=${t.nosec2} wrong=${t.wrong}`, '', 'requireInternalSecret on both routes.');
  } catch (e) { console.log(`  (identity container probe skipped: ${String(e.message).split('\n')[0]})`); }

  // ── R12 secrets in logs ──────────────────────────────────────────────────
  const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n').filter((n) => /identity-service|api-gateway|auth-web/.test(n));
  const secrets = { [T1]: 'reset token T1', [sha(T1)]: 'sha256(T1)', [PW1]: 'new password', [pa]: 'password A', [pb]: 'password B', [PW0]: 'initial password' };
  const hits = [];
  for (const n of names) {
    let txt = '';
    try { txt = execFileSync('docker', ['logs', '--since', sinceIso, n], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }) + ''; } catch (e) { txt = String(e.stdout ?? '') + String(e.stderr ?? ''); }
    for (const [s, label] of Object.entries(secrets)) if (txt.includes(s)) hits.push(`${n}: ${label}`);
  }
  log({ role: 'anonymous', action: 'tokens/passwords never appear in service logs', method: 'GET', endpoint: names.join(','), status: 200, verified: hits.length === 0, expected: 'no secret in logs' });
  if (hits.length) fail('high', 'anonymous', 'Reset token / password written to a service log', 'no secrets in logs', hits.join('; '), '', 'Redact the body/URL of /auth/reset-password in request logging (pino redact) and never log the emailed URL.');

  // ── R14 limiter coupling ─────────────────────────────────────────────────
  console.log('\n== R14 reset/login limiter coupling ==');
  await sleep(61000);
  let first429 = null;
  for (let i = 0; i < 14; i++) { const r = await req(D, 'POST', `${GATEWAY_DIRECT}/auth/reset-password`, { data: { token: newToken(), new_password: pw('L') } }); if (r.status === 429) { first429 = i + 1; break; } }
  const loginAfter = await req(D, 'POST', `${GATEWAY_DIRECT}/auth/login`, { data: { email: `nobody-${Date.now()}@e2e.local`, password: 'x' } });
  log({ role: 'anonymous', action: 'reset-password attempts are rate limited (10/min/IP)', method: 'POST', endpoint: '/auth/reset-password', status: first429 ? 429 : 400, verified: first429 != null && first429 <= 12, expected: '429 after 10' });
  if (!first429) fail('high', 'anonymous', 'reset-password is not rate limited (token brute force)', '429 after 10/min/IP', '14 attempts, no 429', '', 'loginRateLimit on the route.');
  if (loginAfter.status === 429) fail('low', 'anonymous', 'Failed reset-password attempts lock the same IP out of /auth/login (one shared limiter instance)', 'separate buckets for login and reset', 'login -> 429 right after reset attempts', 'server.ts: loginRateLimit is reused for /auth/login, /auth/switch-org and /auth/reset-password', 'Give reset-password its own createRateLimiter instance so token guessing cannot be used to lock out sign-in for an office behind one NAT (and vice versa).');
  await sleep(62000);

  // ── UI ───────────────────────────────────────────────────────────────────
  console.log('\n== UI pages ==');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message)));
    const settle = async () => { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(500); };
    const text = async () => page.locator('body').innerText().catch(() => '');
    const AUTH = APPS['auth-web'];

    // U1 /forgot-password
    const resp = await page.goto(`${AUTH}/forgot-password`, { waitUntil: 'domcontentloaded' }); await settle();
    let body = await text();
    const hasForm = (await page.locator('#reset-email').count()) > 0;
    log({ role: 'anonymous', area: 'auth-web /forgot-password', action: 'page renders', method: 'UI', endpoint: '/forgot-password', status: resp?.status() ?? null, outcome: 'visible', verified: hasForm && /reset your password/i.test(body), expected: 'heading + email field + back link' });
    if (!hasForm || !/reset your password/i.test(body)) fail('high', 'anonymous', '/forgot-password does not render the form', 'heading, #reset-email, Send reset link', body.slice(0, 120).replace(/\n/g, ' '), '', 'auth-web page.', 'auth-web /forgot-password');
    const back = await page.locator('a[href="/login"]').first().getAttribute('href').catch(() => null);
    if (back !== '/login') fail('low', 'anonymous', 'Forgot page lacks a working "Back to sign in" link', '/login', String(back), '', '', 'auth-web /forgot-password');
    await page.locator('#reset-email').fill('not-an-email');
    await page.getByRole('button', { name: /send reset link/i }).click();
    body = await text();
    log({ role: 'anonymous', area: 'auth-web /forgot-password', action: 'malformed email shows client validation', method: 'UI', endpoint: '#reset-email', status: null, outcome: 'visible', verified: /enter the email/i.test(body), expected: 'inline error, no request' });
    if (!/enter the email/i.test(body)) fail('low', 'anonymous', 'Malformed email gives no inline error', '"Enter the email address you sign in with."', body.slice(0, 100), '', '', 'auth-web /forgot-password');
    // mocked server answers (do not spend the gateway bucket)
    const mock = async (status, json) => { await page.unroute('**/api/auth/forgot-password').catch(() => {}); await page.route('**/api/auth/forgot-password', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })); };
    await mock(200, { success: true, data: null });
    await page.locator('#reset-email').fill('someone@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click(); await page.waitForTimeout(600);
    body = await text();
    const confirm = /if an account exists/i.test(body);
    const resendDisabled = await page.getByRole('button', { name: /resend link in/i }).isDisabled().catch(() => false);
    log({ role: 'anonymous', area: 'auth-web /forgot-password', action: 'success state is account-agnostic, resend has a cooldown', method: 'UI', endpoint: 'Send reset link', status: 200, outcome: 'visible', verified: confirm && resendDisabled, expected: '"If an account exists..." + disabled Resend' });
    if (!confirm) fail('medium', 'anonymous', 'Success state does not use the neutral "If an account exists" copy', 'neutral confirmation', body.slice(0, 160), '', '', 'auth-web /forgot-password');
    if (!resendDisabled) fail('low', 'anonymous', 'Resend is clickable immediately (no cooldown)', 'disabled for 45 s', 'enabled', '', '', 'auth-web /forgot-password');
    await page.getByRole('button', { name: /use a different email/i }).click(); await page.waitForTimeout(300);
    await mock(429, { error: 'Too many requests. Please try again later.' });
    await page.locator('#reset-email').fill('someone@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click(); await page.waitForTimeout(600);
    body = await text();
    log({ role: 'anonymous', area: 'auth-web /forgot-password', action: 'HTTP 429 renders a friendly message', method: 'UI', endpoint: 'Send reset link', status: 429, outcome: 'visible', verified: /too many requests/i.test(body), expected: 'friendly rate-limit text' });
    if (!/too many/i.test(body)) fail('medium', 'anonymous', 'A 429 from forgot-password is not explained to the user', '"Too many requests. Please wait..."', body.slice(0, 160), '', 'ForgotPasswordForm maps /too many/ only; the client request() must surface the gateway\'s {error} text.', 'auth-web /forgot-password');
    await mock(500, { success: false, error: { message: 'Internal server error' } });
    await page.locator('#reset-email').fill('someone@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click(); await page.waitForTimeout(600);
    body = await text();
    log({ role: 'anonymous', area: 'auth-web /forgot-password', action: 'HTTP 500 does not crash the page', method: 'UI', endpoint: 'Send reset link', status: 500, outcome: 'visible', verified: !errs.length && (await page.locator('#reset-email').count()) > 0, expected: 'form stays, error shown' });
    if (errs.length) fail('high', 'anonymous', 'Page error on /forgot-password', 'none', errs.join(' | ').slice(0, 200), '', '', 'auth-web /forgot-password');
    await page.unroute('**/api/auth/forgot-password').catch(() => {});

    // branded forgot page
    const keyA = scalar(`SELECT public_key FROM entity.tenant_branding WHERE tenant_id=(SELECT id FROM entity.tenants WHERE name='Fitclass')`);
    if (keyA) {
      await page.goto(`${AUTH}/forgot-password?t=${keyA}`, { waitUntil: 'domcontentloaded' }); await settle();
      body = await text();
      log({ role: 'anonymous', area: 'auth-web /forgot-password?t=', action: 'branded like /login', method: 'UI', endpoint: '/forgot-password?t=<key>', status: null, outcome: 'visible', verified: /fitclass/i.test(body) || (await page.locator('img[src*="branding"]').count()) > 0, expected: 'tenant brand name or logo' });
    }

    // U2 /reset-password
    const refer = async () => page.locator('meta[name="referrer"]').getAttribute('content').catch(() => null);
    for (const [n, url, expectInvalid] of [
      ['no token', `${AUTH}/reset-password`, true],
      ['malformed token', `${AUTH}/reset-password?token=abc`, true],
      ['token with markup', `${AUTH}/reset-password?token=${encodeURIComponent('"><script>alert(1)</script>')}`, true],
      ['well-formed unknown token', `${AUTH}/reset-password?token=${newToken()}`, false],
    ]) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }); await settle();
      body = await text();
      const invalid = /invalid or has expired/i.test(body);
      const formShown = (await page.locator('#new-pw').count()) > 0;
      const ref = await refer();
      const echoed = body.includes('<script>') || (n === 'well-formed unknown token' && body.includes(new URL(url).searchParams.get('token')));
      log({ role: 'anonymous', area: 'auth-web /reset-password', action: `open with ${n}`, method: 'UI', endpoint: '/reset-password', status: null, outcome: 'visible', verified: expectInvalid ? invalid && !formShown : formShown && !echoed, expected: expectInvalid ? 'invalid/expired + "Request a new link"' : 'password form' });
      if (expectInvalid && (!invalid || formShown)) fail('medium', 'anonymous', `/reset-password with ${n} still shows the form`, 'invalid or expired + link to /forgot-password', body.slice(0, 120).replace(/\n/g, ' '), url, 'TOKEN_RE guard in page.tsx.', 'auth-web /reset-password');
      if (!expectInvalid && !formShown) fail('medium', 'anonymous', 'A well-formed token does not render the reset form', '#new-pw', body.slice(0, 120), '', '', 'auth-web /reset-password');
      if (echoed) fail('medium', 'anonymous', `/reset-password echoes the token / markup into the page (${n})`, 'never printed', 'present in body text', '', 'Do not render the token.', 'auth-web /reset-password');
      if (ref !== 'no-referrer') fail('medium', 'anonymous', '/reset-password does not send Referrer-Policy no-referrer', 'meta referrer = no-referrer (token is in the URL)', String(ref), url, 'metadata.referrer.', 'auth-web /reset-password');
      if (expectInvalid && !(await page.locator('a[href="/forgot-password"]').count())) fail('low', 'anonymous', 'Invalid-link page has no "Request a new link" action', 'link to /forgot-password', 'absent', '', '', 'auth-web /reset-password');
    }
    // form behaviour on the unknown-token page (current page)
    await page.locator('#new-pw').fill('weak');
    const submitDisabled = await page.getByRole('button', { name: /set new password/i }).isDisabled().catch(() => false);
    await page.locator('#new-pw').fill(pw('ui'));
    await page.locator('#confirm-pw').fill('Different!1');
    const mismatch = /do not match/i.test(await text());
    log({ role: 'anonymous', area: 'auth-web /reset-password', action: 'client rules: weak password disabled, mismatch flagged', method: 'UI', endpoint: '#new-pw', status: null, outcome: 'visible', verified: submitDisabled && mismatch, expected: 'submit disabled; "Passwords do not match."' });
    if (!submitDisabled) fail('low', 'anonymous', 'Submit enabled with a weak password', 'disabled until the rules pass', 'enabled', '', '', 'auth-web /reset-password');
    if (!mismatch) fail('low', 'anonymous', 'Mismatched confirmation not flagged', '"Passwords do not match."', 'no message', '', '', 'auth-web /reset-password');
    await page.locator('#confirm-pw').fill(pw('ui'));
    await page.locator('#new-pw').fill(pw('ui'));
    // Same value in both: submit -> real API -> unknown token -> friendly error with a way out
    const typed = pw('uiMatch');
    await page.locator('#new-pw').fill(typed); await page.locator('#confirm-pw').fill(typed);
    await page.getByRole('button', { name: /set new password/i }).click(); await page.waitForTimeout(1500);
    body = await text();
    const friendly = /invalid|expired/i.test(body) && !!(await page.locator('a[href="/forgot-password"]').count());
    log({ role: 'anonymous', area: 'auth-web /reset-password', action: 'submit with an unknown token shows a friendly error + way out', method: 'UI', endpoint: 'Set new password', status: 400, outcome: 'visible', verified: friendly && !errs.length, expected: 'invalid/expired + Request a new link' });
    if (!friendly) fail('medium', 'anonymous', 'Unknown token on submit gives no friendly error / recovery link', 'invalid or expired + link', body.slice(0, 160).replace(/\n/g, ' '), '', 'ResetPasswordForm catch.', 'auth-web /reset-password');
    if (body.includes(typed)) fail('high', 'anonymous', 'Typed password is printed back into the page', 'never', 'visible in text', '', '', 'auth-web /reset-password');

    // U2b real round trip through the UI with a planted live token
    const TUI = newToken(); plant(U3.id, TUI);
    const PWUI = pw('uiReal');
    await page.goto(`${AUTH}/reset-password?token=${TUI}`, { waitUntil: 'domcontentloaded' }); await settle();
    await page.locator('#new-pw').fill(PWUI); await page.locator('#confirm-pw').fill(PWUI);
    await page.getByRole('button', { name: /set new password/i }).click(); await page.waitForTimeout(2500);
    body = await text();
    const uiOk = /password has been updated/i.test(body) && tokState(TUI)?.used === 't';
    const canNow = await canLogin(U3.email, PWUI);
    log({ role: U3.email, area: 'auth-web /reset-password', action: 'reset through the UI with a live token', method: 'UI', endpoint: 'Set new password', status: 200, outcome: uiOk ? 'allowed' : 'error', verified: uiOk && canNow, expected: 'success copy, token spent, new password logs in' });
    if (!uiOk || !canNow) fail('high', U3.email, 'UI password reset round trip failed', 'success state + new password works', `${body.slice(0, 120).replace(/\n/g, ' ')} login=${canNow}`, '', 'ResetPasswordForm / reset API.', 'auth-web /reset-password');
    // the used link now reads invalid in the UI
    await page.goto(`${AUTH}/reset-password?token=${TUI}`, { waitUntil: 'domcontentloaded' }); await settle();
    await page.locator('#new-pw').fill(pw('again')); await page.locator('#confirm-pw').fill(pw('again'));
    await page.getByRole('button', { name: /set new password/i }).click(); await page.waitForTimeout(1500);
    body = await text();
    if (!/invalid|expired/i.test(body)) fail('high', 'anonymous', 'A spent link can be reused from the UI', 'invalid or expired', body.slice(0, 120), '', '', 'auth-web /reset-password');

    // U3 /offline
    const off = await page.goto(`${AUTH}/offline`, { waitUntil: 'domcontentloaded' }); await settle();
    body = await text();
    const offHdr = off?.headers() ?? {};
    const userish = new RegExp(`${roleMeta('org_admin').email.split('@')[0]}|e2e\\.local`, 'i').test(body);
    log({ role: 'anonymous', area: 'auth-web /offline', action: 'offline fallback renders statically with no session data', method: 'UI', endpoint: '/offline', status: off?.status() ?? null, outcome: 'visible', verified: off?.status() === 200 && /you are offline/i.test(body) && !userish && !offHdr['set-cookie'], expected: '200, "You are offline", no user data, no Set-Cookie' });
    if (off?.status() !== 200 || !/you are offline/i.test(body)) fail('medium', 'anonymous', '/offline does not render', '200 "You are offline"', `HTTP ${off?.status()} ${body.slice(0, 80)}`, '', 'Service worker navigation fallback.', 'auth-web /offline');
    if (userish || offHdr['set-cookie']) fail('high', 'anonymous', '/offline carries session/user data', 'static, session-free (cached on the device past logout)', userish ? 'user data in body' : 'Set-Cookie sent', '', 'Keep it statically rendered.', 'auth-web /offline');
    // offline page as a logged-in user: still session-free
    const ctx2 = await browser.newContext({ storageState: authFile('org_admin') });
    const p2 = await ctx2.newPage();
    await p2.goto(`${AUTH}/offline`, { waitUntil: 'domcontentloaded' }); await p2.waitForTimeout(800);
    const b2 = await p2.locator('body').innerText().catch(() => '');
    if (new RegExp(roleMeta('org_admin').email.split('@')[0], 'i').test(b2) || /Sector 69|Fitclass -/i.test(b2)) fail('high', 'org_admin', '/offline shows tenant/user data to a logged-in visitor', 'session-free', b2.slice(0, 120), '', '', 'auth-web /offline');
    await ctx2.close();
    // /forgot-password and /reset-password while logged in must not leak the session or crash
    const ctx3 = await browser.newContext({ storageState: authFile('sales_representative') });
    const p3 = await ctx3.newPage();
    for (const u of ['/forgot-password', '/reset-password']) { const r = await p3.goto(`${AUTH}${u}`, { waitUntil: 'domcontentloaded' }); if ((r?.status() ?? 0) >= 500) fail('medium', 'sales_representative', `${u} 5xx for a logged-in user`, '200', `HTTP ${r?.status()}`, '', '', 'auth-web'); }
    await ctx3.close();
  } finally { await browser.close(); }
} catch (e) {
  console.log(e.stack);
  fail('high', 'harness', 'auth-recovery suite aborted', 'completes', String(e.message).slice(0, 200), String(e.stack).slice(0, 300), 'see log');
} finally {
  await D.close();
  await admin.close();
  try {
    const ids = `SELECT id FROM iam.users WHERE email LIKE ${lit(`${MARK}-%@e2e.local`)}`;
    q(`DELETE FROM iam.password_reset_tokens WHERE user_id IN (${ids})`);
    q(`DELETE FROM iam.token_blocklist WHERE user_id IN (${ids})`);
  } catch (e) { console.log('cleanup:', String(e.message).split(String.fromCharCode(10))[0]); }
  const p = purgeE2eUsers(`${MARK}-%@e2e.local`);
  console.log(`\npurged throwaway users: ${JSON.stringify(p)}; findings=${rep.state.findings} actions=${rep.state.actions}`);
}
