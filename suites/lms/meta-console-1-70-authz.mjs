// LMS / Super-admin: Meta console 1.70.0 WRITE routes — authorization + input
// hardening. Complements meta-routing-and-weights (reads) and sa-console (the
// pre-1.70 actions, two roles only).
//
// Routes (gateway, all withSuperAdmin):
//   POST  /meta/campaigns/archive              hide / restore campaigns (visibility only)
//   PATCH /meta/campaigns/:metaCampaignId      confirm / re-type a campaign
//   POST  /meta/lead-pull/runs/:id/selection   tick / untick staged rows
//   POST  /meta/lead-pull/runs/:id/discard     discard a staged batch
//   POST  /meta/pages/health/validate          calls the Meta Graph API
//
// SAFETY: super_admin is only ever sent NIL / unknown ids and invalid bodies, so
// nothing real is archived, discarded or pulled; /meta/pages/health/validate is
// sent to DENIED callers only (it would reach Meta for a permitted one).
//
//   A1  every non-super-admin login + tenant B is refused on every 1.70 write
//   A2  super_admin + unknown run/campaign id -> 4xx (never 2xx, never 5xx)
//   A3  nothing changed in the DB (archived flags, run status) after the pass
//
//   node suites/lms/meta-console-1-70-authz.mjs
import { GATEWAY, ROLES, CROSS_TENANT, authFile } from '../../lib.mjs';
import { actor, apiPost, apiPatch } from '../../conc.mjs';
import { dbReachable, scalar } from '../../db.mjs';
import { finder, isOk, isDenied } from '../../fixtures.mjs';
import fs from 'node:fs';

const fail = finder('lms', 'Meta console 1.70 write routes (authz + input hardening)');
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
const NIL = '00000000-0000-4000-8000-000000000000';
const snap = () => `${scalar(`SELECT COUNT(*) FILTER (WHERE is_archived) FROM ext.meta_campaigns`)}|${scalar(`SELECT COUNT(*) FROM scratch.meta_pull_runs WHERE status='discarded'`)}|${scalar(`SELECT COUNT(*) FROM ext.meta_pull_run_history`)}`;
const before = snap();

const WRITES = [
  ['POST', '/meta/campaigns/archive', { ids: [NIL], archived: true }],
  ['PATCH', `/meta/campaigns/${NIL}`, { e2e_invalid: true }],
  ['POST', `/meta/lead-pull/runs/${NIL}/selection`, { ids: [NIL], selected: false }],
  ['POST', `/meta/lead-pull/runs/${NIL}/discard`, {}],
];
const DENY_ONLY = [['POST', '/meta/pages/health/validate', {}]];
const call = (a, [m, p, body]) => (m === 'PATCH' ? apiPatch(a, `${GATEWAY}${p}`, body) : apiPost(a, `${GATEWAY}${p}`, body));

// A1 — everyone but super_admin
const denyActors = [...ROLES.filter((r) => r !== 'super_admin'), ...CROSS_TENANT.map((c) => c.stateKey)].filter((k) => fs.existsSync(authFile(k)));
let denied = 0, served = 0;
for (const k of denyActors) {
  const a = await actor(k);
  try {
    for (const w of [...WRITES, ...DENY_ONLY]) {
      const res = await call(a, w);
      if (isOk(res.status)) { served++; fail('critical', k, `${w[0]} ${w[1]} served to a non-super-admin`, '403 at the edge (withSuperAdmin)', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 160), 'Meta console actions are platform-level: restore withSuperAdmin on the gateway route and the rank check in meta-conversion-api.'); }
      else if (isDenied(res.status)) denied++;
      else if (res.status >= 500) fail('medium', k, `${w[0]} ${w[1]} 5xx for a denied caller`, '403', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 160), 'Deny at the edge before proxying.');
    }
  } finally { await a.close(); }
}
console.log(`A1: logins=${denyActors.length} denied=${denied} served=${served}`);

// A2 — super_admin, unknown ids
let saOk = 0;
if (fs.existsSync(authFile('super_admin'))) {
  const sa = await actor('super_admin');
  try {
    for (const w of WRITES) {
      const res = await call(sa, w);
      console.log(`  super_admin ${w[0]} ${w[1].replace(NIL, ':nil')} -> ${res.status}`);
      if (res.status >= 500) fail('high', 'super_admin', `${w[0]} ${w[1]} 5xx for an unknown id`, '4xx (404 / 400) with a message', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 200), 'Validate the id/body and map "not found" to 404 in meta-conversion-api before touching the DB.');
      else if (isOk(res.status) && /discard|selection/.test(w[1])) fail('medium', 'super_admin', `${w[0]} ${w[1]} succeeded on an unknown run`, '404 (no such run)', `HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 200), 'Check the UPDATE affected a row; return 404 when rowCount is 0.');
      else saOk++;
    }
  } finally { await sa.close(); }
} else console.log('  (no super_admin session — A2 skipped)');

// A3 — nothing moved
const after = snap();
console.log(`A3: archived|discarded|history before=${before} after=${after}`);
if (before !== after) fail('high', 'data', 'Meta console state changed during a deny/unknown-id pass', 'No archive/discard/history change', `${before} -> ${after}`, '', 'A write ran for an unauthorized caller or an unknown id — inspect the handler for a missing guard.');
