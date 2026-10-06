// Platform: Web Push send switch + notifications SSE stream — the parts
// push-and-stream.mjs does not assert.
//
// push-and-stream.mjs proves identity (a smuggled user_id, another user's DELETE,
// a malformed body, every role gets a 200 stream). Still unasserted:
//
//   P1  WEB_PUSH_ENABLED — this laptop's database is a copy of production with REAL
//       device subscriptions; sending is switched off by `WEB_PUSH_ENABLED=false` in
//       the root .env, while UAT / production must say `true` or nobody is ever
//       notified. Asserted from the three env files (only that ONE line is read),
//       and against what the DB says (subscriptions exist on a stack that cannot send).
//   P2  Subscriptions are still RECORDED while sending is off (so enabling later needs
//       no re-subscribe), and the row's org/tenant come from the session, not the body.
//   P3  The endpoint URL is stored and later POSTed to BY THE SERVER. zod `.url()` accepts
//       http://169.254.169.254/... and https://127.0.0.1/... : an SSRF vector if the
//       sender does not constrain hosts. Probed with throwaway rows that are deleted.
//   P4  Oversized endpoint / keys => 422 (never 5xx); non-https => 4xx.
//   P5  Table hygiene: devices of deactivated users, absurd device counts, tenant drift.
//   S1  Stream handshake: `event: connected` first, SSE headers (no-cache, no-transform,
//       X-Accel-Buffering: no), no tenant-A ids for a tenant-B caller, and the payload
//       carries only a connection id — no user data.
//   S2  The stream is reachable through every web app's /api proxy (lms/hr/todo/auth).
//   S3  Anonymous and logged-out sessions are refused. The logout check uses a FRESH
//       login (own jti) — stored .auth sessions are never revoked.
//
//   node suites/platform/push-flag-and-stream.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, GATEWAY, GATEWAY_DIRECT, authFile, roleMeta, CROSS_TENANT, primaryTenant } from '../../lib.mjs';
import { LOCAL_ENV } from '../../localenv.mjs';
import { actor, apiPost, apiGet, freshLogin } from '../../conc.mjs';
import { dbReachable, scalar, rows, q, lit } from '../../db.mjs';
import { finder, isOk } from '../../fixtures.mjs';

const TOOL = 'platform';
const fail = finder(TOOL, 'Web push switch & notifications stream');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };
const MARK = `https://fcm.googleapis.com/fcm/send/e2e-flag-${Date.now()}`;
const cleanup = [];

// ── P1. The switch, per environment ──────────────────────────────────────────
console.log('— P1: WEB_PUSH_ENABLED —');
const flagIn = (file) => {
  if (!fs.existsSync(file)) return { file, present: false };
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^\s*WEB_PUSH_ENABLED\s*=/.test(l));
  return { file: path.basename(file), present: true, value: line ? line.split('=')[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase() : null };
};
const local = LOCAL_ENV.WEB_PUSH_ENABLED?.trim().toLowerCase() ?? null;
const root = path.resolve(here, '../../..');
const envs = [flagIn(path.join(root, 'msq-deploy', '.env-uat')), flagIn(path.join(root, 'msq-deploy', '.env-prd'))];
const subs = Number(safe(() => scalar(`SELECT COUNT(*) FROM notify.push_subscriptions WHERE endpoint NOT LIKE '%e2e-%'`), 0));
console.log(`  local .env WEB_PUSH_ENABLED=${local ?? '(unset => sends!)'}  real device subscriptions in this DB=${subs}`);
for (const e of envs) console.log(`  ${e.file.padEnd(10)} ${e.present ? `WEB_PUSH_ENABLED=${e.value ?? '(absent => defaults to on)'}` : 'not found (skipped)'}`);
if (local !== 'false' && subs > 0) {
  fail('critical', 'local stack', 'This laptop can SEND web pushes to real production devices', 'Local .env sets WEB_PUSH_ENABLED=false while the DB is a copy of production subscriptions',
    `WEB_PUSH_ENABLED=${local ?? '(unset)'} with ${subs} non-test subscriptions`, 'root .env', 'Set WEB_PUSH_ENABLED=false in the platform .env (and msq-lms/.env) before running the stack or any suite that creates leads/tasks/leave — every assignment would buzz a real handset.');
}
for (const e of envs.filter((x) => x.present)) {
  if (e.value === 'false') fail('high', e.file, `${e.file} disables web push`, 'UAT and production send pushes (WEB_PUSH_ENABLED=true or absent)', `WEB_PUSH_ENABLED=${e.value}`, e.file, 'Nobody is notified in that environment; the local value must not be copied into the deploy env file.');
  else if (e.value === null) fail('low', e.file, `${e.file} does not state WEB_PUSH_ENABLED`, 'Explicit WEB_PUSH_ENABLED=true (the default is on, but the intent should be written down)', 'line absent', e.file, 'Add WEB_PUSH_ENABLED=true so a future default flip cannot silently change production.');
}
const rootEnv = flagIn(path.join(root, '.env')), lmsEnv = flagIn(path.join(root, 'msq-lms', '.env'));
if (rootEnv.present && lmsEnv.present && rootEnv.value !== lmsEnv.value) {
  fail('medium', 'local stack', 'Root .env and msq-lms/.env disagree on WEB_PUSH_ENABLED', 'One value for the whole local stack', `root=${rootEnv.value} msq-lms=${lmsEnv.value}`, '', 'notifications-service reads whichever .env its compose service loads; make them agree.');
}

// ── P2-P4. Subscribe behaviour ───────────────────────────────────────────────
console.log('\n— P2-P4: subscribe —');
const P = `${GATEWAY}/notifications/push`;
const ok = (p) => fs.existsSync(authFile(p));
if (ok('sales_representative') && ok('rep2')) {
  const rep = await actor('sales_representative');
  const rep2 = await actor('rep2');
  const meta = roleMeta('sales_representative');
  const keys = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) };
  const row = (endpoint) => rows(`SELECT user_id, org_id, tenant_id FROM notify.push_subscriptions WHERE endpoint=${lit(endpoint)}`, ['user', 'org', 'tenant'])[0];
  const me = rows(`SELECT u.id, u.org_id, o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.email=${lit(meta.email)}`, ['id', 'org', 'tenant'])[0];
  try {
    // P2: org/tenant from the session even when the body smuggles others.
    cleanup.push(MARK);
    const other = scalar(`SELECT id FROM entity.tenants WHERE id<>${lit(me.tenant)}::uuid LIMIT 1`);
    const s = await apiPost(rep, `${P}/subscribe`, { endpoint: MARK, keys, tenant_id: other, org_id: other, user_id: other });
    const r = row(MARK);
    console.log(`  P2 subscribe http=${s.status} row.org=${r?.org === me.org ? 'session' : r?.org} row.tenant=${r?.tenant === me.tenant ? 'session' : r?.tenant}`);
    if (!isOk(s.status)) fail('medium', 'sales_representative', 'Subscribing a device fails', '201', `HTTP ${s.status}`, JSON.stringify(s.body).slice(0, 200), 'Sending being off must not stop recording subscriptions (so enabling later needs no re-subscribe).');
    else if (r && (r.org !== me.org || r.tenant !== me.tenant)) fail('critical', 'sales_representative', 'Push subscription org/tenant taken from the request body', 'org_id / tenant_id from parseAuthContext only', `row.org=${r.org} row.tenant=${r.tenant}`, MARK, 'Strip body keys; the zod object already drops unknown keys — check saveSubscription callers.');

    // P2b: re-subscribing an existing endpoint as another user (shared device vs hijack) — observation only.
    const s2 = await apiPost(rep2, `${P}/subscribe`, { endpoint: MARK, keys });
    const r2 = row(MARK);
    const moved = r2 && r2.user !== r.user;
    console.log(`  P2b same endpoint, other user http=${s2.status} owner ${moved ? 'CHANGED to the second user' : 'unchanged'}`);
    if (moved) fail('info', 'rep2', 'Re-subscribing an existing endpoint transfers it to the new user', 'Documented device model: one device, last logged-in user wins (shared handset). Confirm that is intended', 'owner changed', MARK, 'Upsert on endpoint is by design ("makes re-subscribe idempotent"); an attacker needs the endpoint URL, which is a capability secret. If a device must never move between users, scope the upsert by (endpoint, user_id).');

    // P3: SSRF — hosts the server would POST to.
    for (const [label, ep] of [['cloud metadata (http)', 'http://169.254.169.254/latest/meta-data/e2e'], ['loopback https', 'https://127.0.0.1:4000/health?e2e=1'], ['internal service name', 'https://identity-service:3001/e2e'], ['localhost http', 'http://localhost/e2e']]) {
      cleanup.push(ep);
      const res = await apiPost(rep, `${P}/subscribe`, { endpoint: ep, keys });
      const stored = !!row(ep);
      console.log(`  P3 ${label.padEnd(24)} http=${res.status} stored=${stored}`);
      if (isOk(res.status) && stored) {
        fail(/^https:\/\/(127|identity|localhost)|169\.254/.test(ep) ? 'high' : 'medium', 'sales_representative', `Push endpoint accepts an internal/non-push host (${label})`,
          'Only https endpoints on real push services are stored (fcm.googleapis.com, *.push.services.mozilla.com, *.push.apple.com, *.notify.windows.com)',
          `HTTP ${res.status}; row stored for ${ep}`, ep,
          'The sender POSTs to this URL from inside the network: an authenticated user can aim it at metadata / internal services (SSRF). Allow-list push-service hosts (and https only) in subscriptionSchema before saveSubscription.');
      }
    }
    // P4: robustness.
    for (const [label, body, want] of [
      ['endpoint 2001 chars', { endpoint: 'https://fcm.googleapis.com/' + 'a'.repeat(1980), keys }, 'reject'],
      ['non-url endpoint', { endpoint: 'not-a-url', keys }, 'reject'],
      ['missing keys', { endpoint: MARK + '-nokeys' }, 'reject'],
      ['oversized key', { endpoint: MARK + '-bigkey', keys: { p256dh: 'x'.repeat(501), auth: 'a' } }, 'reject'],
      ['array body', [], 'reject'],
    ]) {
      const res = await apiPost(rep, `${P}/subscribe`, body);
      cleanup.push(MARK + '-nokeys', MARK + '-bigkey');
      console.log(`  P4 ${label.padEnd(20)} http=${res.status}`);
      if (res.status >= 500) fail('medium', 'sales_representative', `Push subscribe 5xx: ${label}`, '422', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 160), 'subscriptionSchema.safeParse before any DB call.');
      else if (want === 'reject' && isOk(res.status)) fail('medium', 'sales_representative', `Push subscribe accepted: ${label}`, '422', `HTTP ${res.status}`, '', 'Tighten subscriptionSchema.');
    }
    // Public key must not be the private one.
    const pk = await apiGet(rep, `${P}/public-key`);
    const priv = LOCAL_ENV.VAPID_PRIVATE_KEY;
    if (priv && JSON.stringify(pk.body ?? '').includes(priv)) fail('critical', 'sales_representative', 'public-key endpoint returns the VAPID PRIVATE key', 'Only VAPID_PUBLIC_KEY', 'private key in body', '', 'Return vapidPublicKey() only.');
  } finally {
    await rep.close(); await rep2.close();
    for (const ep of new Set(cleanup)) safe(() => scalar(`DELETE FROM notify.push_subscriptions WHERE endpoint=${lit(ep)} RETURNING 1`));
  }
} else console.log('  (needs sales_representative + rep2 sessions — P2-P4 skipped)');

// ── P5. Table hygiene (read-only) ────────────────────────────────────────────
console.log('\n— P5: notify.push_subscriptions hygiene —');
const dead = rows(`SELECT COUNT(*)::int FROM notify.push_subscriptions s JOIN iam.users u ON u.id=s.user_id WHERE (NOT u.is_active OR u.is_deleted) AND s.endpoint NOT LIKE '%e2e-%' HAVING COUNT(*)>0`, ['n'])[0];
const hosts = rows(`SELECT substring(endpoint from '^https?://([^/]+)') AS host, COUNT(*)::int FROM notify.push_subscriptions WHERE endpoint NOT LIKE '%e2e-%' GROUP BY 1 ORDER BY 2 DESC`, ['host', 'n']);
const odd = hosts.filter((h) => !/(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com|push\.microsoft\.com|fcm\.gcm\.com)$/.test(h.host ?? ''));
const heavy = rows(`SELECT user_id::text, COUNT(*)::int FROM notify.push_subscriptions GROUP BY user_id HAVING COUNT(*) > 10`, ['user', 'n']);
console.log(`  devices of deactivated users=${dead?.n ?? 0}; hosts=${hosts.map((h) => `${h.host}:${h.n}`).join(', ') || '-'}; users with >10 devices=${heavy.length}`);
if (dead?.n) fail('low', 'data', `${dead.n} push subscription(s) belong to deactivated/deleted users`, 'Subscriptions are removed when a user is deactivated (a former employee\'s phone keeps getting lead alerts)', `${dead.n} rows`, '', 'Delete notify.push_subscriptions rows in the deactivate/delete user path.');
if (odd.length) fail('high', 'data', `Push endpoints on non-push hosts exist: ${odd.map((o) => o.host).join(', ')}`, 'Only known push-service hosts', odd.map((o) => `${o.host} x${o.n}`).join(' | '), '', 'Delete the rows and add the host allow-list (see P3).');
if (heavy.length) fail('low', 'data', `${heavy.length} user(s) hold more than 10 push devices`, 'Stale endpoints are pruned (410/404 from the push service deletes the row)', heavy.slice(0, 5).map((h) => `${h.user.slice(0, 8)} x${h.n}`).join(' | '), '', 'Prune on send failure and cap devices per user.');

// ── S1-S3. Notifications stream ──────────────────────────────────────────────
console.log('\n— S1-S3: stream —');
async function openStream(cookie, url, ms = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out = { status: 0, headers: {}, text: '' };
  try {
    const res = await fetch(url, { headers: { cookie, accept: 'text/event-stream' }, signal: ctl.signal });
    out.status = res.status;
    res.headers.forEach((v, k) => { out.headers[k.toLowerCase()] = v; });
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    while (reader && out.text.length < 4000) {
      const { value, done } = await reader.read();
      if (done) break;
      out.text += dec.decode(value);
      if (/event: connected[\s\S]*\n\n/.test(out.text)) break;
    }
    ctl.abort();
  } catch (e) { if (!out.status) out.status = e.name === 'AbortError' ? -2 : -1; }
  clearTimeout(timer);
  return out;
}
const cookieOf = async (a) => (await a.request.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');

const A = primaryTenant();
const aIds = new Set(safe(() => q(`SELECT u.id::text FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id JOIN entity.tenants t ON t.id=o.tenant_id WHERE o.name=${lit(A.org)} OR t.id=(SELECT tenant_id FROM entity.organizations WHERE name=${lit(A.org)} LIMIT 1)`), []).map((r) => r[0]));

if (ok('sales_representative')) {
  const a = await actor('sales_representative');
  try {
    const cookie = await cookieOf(a);
    const r = await openStream(cookie, `${APPS['lms-web']}/api/notifications/stream`);
    console.log(`  S1 handshake http=${r.status} type=${(r.headers['content-type'] ?? '').split(';')[0]} first=${r.text.split('\n')[0]}`);
    if (r.status === 200) {
      if (!/^event: connected/m.test(r.text)) fail('medium', 'sales_representative', 'Stream does not open with `event: connected`', 'First frame is `event: connected` (the client uses it to know the stream is live)', r.text.slice(0, 120), '', 'notifications-service routes/stream.ts writes it right after writeHead.');
      const cc = r.headers['cache-control'] ?? '';
      if (!/no-cache/.test(cc) || !/no-transform/.test(cc)) fail('medium', 'sales_representative', 'Stream Cache-Control lacks no-cache/no-transform', 'no-cache, no-transform', cc || '(none)', '', 'Proxies that cache or transform an SSE response hold events back or merge them.');
      if (r.headers['x-accel-buffering'] && r.headers['x-accel-buffering'] !== 'no') fail('low', 'sales_representative', 'X-Accel-Buffering is not `no`', 'no', r.headers['x-accel-buffering'], '', 'Buffering proxy would stall events.');
      if (/access-control-allow-origin:\s*\*/i.test(Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))) fail('high', 'sales_representative', 'Authenticated stream sends Access-Control-Allow-Origin: *', 'No wildcard CORS on a cookie-authenticated stream', 'ACAO *', '', 'Remove wildcard CORS.');
      const data = (r.text.match(/data: (.*)/) || [])[1] ?? '';
      let parsed = null; try { parsed = JSON.parse(data); } catch { /* not json */ }
      const extra = parsed ? Object.keys(parsed).filter((k) => k !== 'connId') : [];
      if (extra.length) fail('medium', 'sales_representative', 'Stream handshake payload carries more than a connection id', 'Only { connId }', `keys: ${Object.keys(parsed).join(',')}`, data.slice(0, 160), 'Handshake must not echo identity (user/org/tenant) — the client already knows it.');
    } else fail('high', 'sales_representative', 'Notifications stream does not open for a sales rep', '200 text/event-stream', `HTTP ${r.status}`, '', 'See push-and-stream.mjs step 5.');

    // S2: through every app that proxies it.
    for (const app of ['lms-web', 'hr-web', 'todo-web', 'auth-web']) {
      const res = await openStream(cookie, `${APPS[app]}/api/notifications/stream`, 5000);
      console.log(`  S2 via ${app.padEnd(9)} http=${res.status} type=${(res.headers['content-type'] ?? '').split(';')[0]}`);
      if (res.status === 200 && !/event-stream/.test(res.headers['content-type'] ?? '')) fail('medium', app, `${app} serves /api/notifications/stream with the wrong content type`, 'text/event-stream', res.headers['content-type'] ?? '', '', 'proxySSE must pass the upstream content type through.');
      else if (res.status >= 500 || res.status === -1) fail('medium', app, `${app} stream proxy errors`, '200 or 404 (app has no stream proxy)', `HTTP ${res.status}`, '', 'Every app shell opens this stream; a 5xx loop floods the gateway.');
      else if (res.status === -2) fail('medium', app, `${app} stream proxy does not answer within 5 s`, 'Headers flush immediately', 'no response', '', 'Buffering in the Next rewrite / Caddy.');
    }
  } finally { await a.close(); }
}
const bKey = CROSS_TENANT.find((c) => ok(c.stateKey))?.stateKey;
if (bKey) {
  const b = await actor(bKey);
  try {
    const r = await openStream(await cookieOf(b), `${APPS['lms-web']}/api/notifications/stream`);
    const leaked = [...new Set((r.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).map((x) => x.toLowerCase()))].filter((x) => aIds.has(x));
    console.log(`  S1b tenant-B stream http=${r.status} tenant-A ids in first frames=${leaked.length}`);
    if (leaked.length) fail('critical', bKey, 'Tenant B\'s notification stream carries tenant-A ids', 'Only the caller\'s own events', leaked.join(', '), r.text.slice(0, 200), 'connectionManager must key clients by (tenant, user) and broadcast per user.');
  } finally { await b.close(); }
}
// S3: anonymous + logged-out.
{
  const anon = await openStream('', `${GATEWAY_DIRECT}/notifications/stream`, 5000);
  console.log(`  S3 anonymous http=${anon.status}`);
  if (anon.status === 200) fail('critical', 'anonymous', 'Notifications stream opens with no session', '401', 'HTTP 200 text/event-stream', '', 'withAuth must run before the SSE proxy.');
  const email = roleMeta('sales_representative')?.email;
  if (email) {
    const fresh = await freshLogin(email);
    try {
      if (fresh.loginStatus >= 200 && fresh.loginStatus < 300) {
        const cookie = (await fresh.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
        const live = await openStream(cookie, `${APPS['lms-web']}/api/notifications/stream`, 4000);
        const lo = await fresh.request.post(`${APPS['auth-web']}/api/auth/logout`, { data: {}, failOnStatusCode: false });
        const after = await openStream(cookie, `${APPS['lms-web']}/api/notifications/stream`, 4000);
        console.log(`  S3 fresh session: stream=${live.status} logout=${lo.status()} stream-after-logout=${after.status}`);
        if (live.status === 200 && after.status === 200) fail('high', 'sales_representative', 'The stream still opens after logout (revoked jti honoured?)', '401 once the session\'s jti is revoked', 'HTTP 200 after logout', '', 'The SSE route must run the same revocation check as every other gateway route (authPreHandler -> token_blocklist).');
      } else console.log(`  S3 fresh login unavailable (${fresh.loginStatus}) — logout check skipped`);
    } finally { await fresh.close(); }
  }
}
