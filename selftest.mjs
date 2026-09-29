import fs from 'node:fs';
import { absUrl, appPath, APPS, GATEWAY, PREFIXES } from './lib.mjs';
import { LOCAL_ENV } from './localenv.mjs';
import { leakOf, idsOf } from './fixtures.mjs';

let bad = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// crawl.mjs RX — re-evaluate the literal from source so the test tracks the file.
const src = fs.readFileSync('./crawl.mjs', 'utf8');
const RX = eval(`(${src.match(/const RX = (\{[\s\S]*?\n\});/)[1]})`);
const kind = (label, title = null) => (/^Branch:/i.test(title || '') || RX.logout.test(label)) ? 'logout'
  : RX.destructive.test(label) ? 'destructive' : RX.sideEffect.test(label) ? 'sideEffect'
  : RX.openForm.test(label) ? 'openForm' : RX.submit.test(label) ? 'submit' : RX.safe.test(label) ? 'safe' : 'other';
for (const [l, want, title] of [
  ['Sync campaigns', 'sideEffect'], ['Pull leads', 'sideEffect'], ['Apply', 'sideEffect'], ['Retry', 'sideEffect'],
  ['Ignore', 'sideEffect'], ['Re-run assignment', 'sideEffect'], ['Rerun', 'sideEffect'], ['Remap', 'sideEffect'],
  ['Transfer', 'sideEffect'], ['Rotate key', 'sideEffect'], ['Test rules', 'sideEffect'],
  ['Apply for leave', 'openForm'], ['Add member', 'openForm'], ['Edit', 'openForm'], ['Check in', 'openForm'],
  ['Delete', 'destructive'], ['Sign out', 'logout'], ['Gurugram - Sector 69', 'logout', 'Branch: Gurugram - Sector 69'],
  ['View', 'safe'], ['Next', 'safe'], ['Save', 'submit'],
]) eq(`classify "${l}"`, kind(l, title), want);

// Expectations follow the resolved topology (app.localhost or localhost:300x).
eq('absUrl basePath href', absUrl(APPS['lookup-admin'], '/sa/dashboard/lookups/x'), `${APPS['lookup-admin']}/dashboard/lookups/x`);
eq('absUrl app-relative', absUrl(APPS['lms-web'], '/dashboard/leads'), `${APPS['lms-web']}/dashboard/leads`);
eq('absUrl root app', absUrl(APPS['auth-web'], '/login'), `${APPS['auth-web']}/login`);
eq('appPath strips prefix', appPath('http://app.localhost/hrms/leave/admin'), '/leave/admin');
eq('appPath /sa vs /s…', appPath('http://app.localhost/sales'), '/sales');

eq('leak: stack', !!leakOf({ error: 'at Object.handler (/app/src/api/v1/x.ts:12:3)' }), true);
eq('leak: pg', !!leakOf({ error: 'duplicate key value violates unique constraint "uq_x"' }), true);
eq('leak: none', leakOf({ success: false, error: 'Lead not found' }), null);
eq('idsOf envelope', idsOf({ success: true, data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
eq('idsOf items', idsOf({ data: { items: [{ id: 'c' }] } }), ['c']);

if (LOCAL_ENV.AUTH_URL && !process.env.E2E_ORIGIN && !process.env.E2E_MODE) {
  eq('auth-web URL follows platform .env AUTH_URL', APPS['auth-web'], LOCAL_ENV.AUTH_URL.replace(/\/$/, ''));
  eq('gateway goes through the auth-web /api rewrite', GATEWAY, APPS['auth-web'] + '/api');
}
eq('lms basePath', PREFIXES['lms-web'], '/lms');

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
