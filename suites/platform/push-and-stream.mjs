// Web push device registration + the notifications SSE stream (05bbd80 PWA
// support). Self-service, ungated by design — so the only thing standing
// between one user and another's lock-screen notifications is that identity is
// taken from the session and never from the body.
//
//   1. subscribe with a smuggled `user_id` of someone else -> the row in
//      notify.push_subscriptions belongs to the CALLER (critical otherwise)
//   2. another user DELETEs my endpoint -> my row survives (204, no oracle)
//   3. I DELETE my endpoint -> row gone
//   4. malformed subscription -> 422, not 500
//   5. GET /notifications/stream answers 200 text/event-stream for every role
//      within 10 s (the shell opens it on every page)
//
//   node suites/platform/push-and-stream.mjs
import { ROLES, roleMeta, APPS, GATEWAY, authFile } from '../../lib.mjs';
import { actor, apiPost, apiGet } from '../../conc.mjs';
import { dbReachable, scalar, lit } from '../../db.mjs';
import { finder, isOk } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'platform';
const fail = finder(TOOL, 'Web push & notifications stream');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
for (const k of ['sales_representative', 'rep2']) if (!fs.existsSync(authFile(k))) { console.log(`${k} login required — aborting`); process.exit(0); }

const P = `${GATEWAY}/notifications/push`;
const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`;
const sub = { endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
const victimId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(roleMeta('sales_representative').email)}`);
const owner = () => scalar(`SELECT user_id FROM notify.push_subscriptions WHERE endpoint=${lit(endpoint)}`);

const rep = await actor('sales_representative');
const rep2 = await actor('rep2');
try {
  const key = await apiGet(rep, `${P}/public-key`);
  if (!isOk(key.status)) fail('medium', 'sales_representative', 'GET /notifications/push/public-key fails', '200 with the VAPID public key', `HTTP ${key.status}`, JSON.stringify(key.body).slice(0, 200), 'Set VAPID keys for notifications-service; without them no device can subscribe.');

  const s = await apiPost(rep, `${P}/subscribe`, { ...sub, user_id: victimId, org_id: '00000000-0000-4000-8000-000000000000' });
  const who = owner();
  console.log(`1. subscribe (smuggled user_id) http=${s.status} row.user=${who === repId ? 'caller' : who === victimId ? 'VICTIM' : who}`);
  if (who && who !== repId) fail('critical', 'sales_representative', 'A push subscription can be registered as ANOTHER user', 'notify.push_subscriptions.user_id = the caller (identity from the session only)', `user_id=${who}`, endpoint, 'saveSubscription must take userId from parseAuthContext only; strip body keys.');
  if (!isOk(s.status)) fail('medium', 'sales_representative', 'Registering a push device fails', '201', `HTTP ${s.status}`, JSON.stringify(s.body).slice(0, 200), 'Check notify.push_subscriptions grants for the notifications service login.');

  const del2 = await rep2.request.delete(`${P}/subscribe`, { data: { endpoint }, failOnStatusCode: false });
  console.log(`2. other user deletes my endpoint http=${del2.status()} row still mine=${owner() === repId}`);
  if (who === repId && owner() !== repId) fail('high', 'rep2', 'Another user can remove my push device', 'Row survives; 204 with no existence oracle', 'row deleted', endpoint, 'deleteSubscription must scope by (endpoint, user_id, org_id).');

  const del = await rep.request.delete(`${P}/subscribe`, { data: { endpoint }, failOnStatusCode: false });
  console.log(`3. owner deletes http=${del.status()} row gone=${!owner()}`);
  if (owner()) fail('medium', 'sales_representative', 'Unsubscribing does not remove my push device', 'Row deleted', `HTTP ${del.status()}, row present`, endpoint, 'Check deleteSubscription.');

  const bad = await apiPost(rep, `${P}/subscribe`, { endpoint: 'not-a-url' });
  if (bad.status >= 500) fail('medium', 'sales_representative', 'Malformed push subscription 5xxs', '422', `HTTP ${bad.status}`, JSON.stringify(bad.body).slice(0, 200), 'subscriptionSchema.safeParse before touching the DB.');
} finally {
  await rep.close(); await rep2.close();
  try { scalar(`DELETE FROM notify.push_subscriptions WHERE endpoint=${lit(endpoint)} RETURNING 1`); } catch {}
}

// ── 5. SSE handshake per role ───────────────────────────────────────────────
for (const role of ROLES) {
  if (!fs.existsSync(authFile(role))) continue;
  const a = await actor(role);
  try {
    const state = await a.request.storageState();
    const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let status = 0, ctype = '';
    try {
      const res = await fetch(`${APPS['lms-web']}/api/notifications/stream`, { headers: { cookie, accept: 'text/event-stream' }, signal: ctl.signal });
      status = res.status; ctype = res.headers.get('content-type') || '';
      ctl.abort();
    } catch (e) { if (!status) status = e.name === 'AbortError' ? -2 : -1; }
    clearTimeout(timer);
    console.log(`5. ${role.padEnd(26)} stream http=${status} type=${ctype.split(';')[0]}`);
    if (status === -2) fail('medium', role, 'Notifications stream does not answer within 10 s', '200 text/event-stream headers immediately', 'no response headers in 10 s', '', 'proxySSE must flush headers on connect; a buffered proxy (Next rewrite / Caddy) holding the response makes every page hang on this request.');
    else if (status >= 500 || status === -1) fail('high', role, 'Notifications stream errors', '200 text/event-stream', `HTTP ${status}`, '', 'Check notifications-service /api/v1/notifications/stream for this role.');
    else if (status === 200 && !/text\/event-stream/.test(ctype)) fail('medium', role, 'Notifications stream has the wrong content type', 'text/event-stream', ctype, '', 'Set Content-Type: text/event-stream in proxySSE.');
  } finally { await a.close(); }
}
