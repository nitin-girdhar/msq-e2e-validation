// Meta Conversions API v2 console (schema 1.79.0) — the /meta/connection, /meta/portfolios,
// /meta/datasets, /meta/org-datasets and /meta/capi-outbox surface lookup-admin drives.
//
//   W  wall      every route x every tenant login (both tenants, read_only -> tenant_admin) and
//                anonymous: 401/403, never 2xx, never 5xx. withSuperAdmin at the gateway, and
//                requireSuperAdmin in meta-conversion-api behind it.
//   R  reads     super_admin: every GET answers 200 (never 5xx).
//   S  secrets   GET /meta/connection never returns a token, app secret or verify token, nor the
//                stored ciphertext (ext.meta_platform_credentials.access_token).
//   C  CRUD      super_admin registers a portfolio + dataset for tenant B, renames the dataset,
//                links an ad account, then tries to file tenant B's dataset as tenant A's branch
//                fallback (composite FK must refuse it), and removes everything. Verified in Postgres.
//   O  outbox    read-only invariants over ext.meta_capi_outbox (status set, tenant/org agree with
//                the lead, nothing PENDING past expires_at, (dataset_id,event_id) unique).
//
// Never calls anything that reaches Graph: credentials/:id/verify, datasets/:id/verify, outbox
// retry / dismiss / requeue-skipped, pages/:id/subscribe are probed for the WALL only, with a
// random id, as non-super-admins.
//
//   node suites/lms/meta-capi-v2-console.mjs
import { GATEWAY, cfg } from '../../lib.mjs';
import { actor } from '../../conc.mjs';
import { dbReachable, q, scalar, rows, lit } from '../../db.mjs';
import { req, anon, reporter, isOk } from '../../kit.mjs';
import { randomUUID } from 'node:crypto';

if (!dbReachable()) { console.log('DB not reachable - aborting'); process.exit(0); }
const rep = reporter('lms', 'Meta CAPI v2 console (/sa)');
const { fail, log } = rep;
const AREA = 'Meta CAPI v2';
const rid = randomUUID();
const tA = scalar(`SELECT id FROM entity.tenants WHERE name='Fitclass' AND NOT is_deleted LIMIT 1`);
const tB = scalar(`SELECT id FROM entity.tenants WHERE name ILIKE 'MSquare%' AND NOT is_deleted LIMIT 1`);
const orgA = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tA)} AND is_active ORDER BY created_at LIMIT 1`);
const orgB = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tB)} AND is_active ORDER BY created_at LIMIT 1`);

const ROUTES = [
  ['GET', '/meta/connection'], ['PUT', '/meta/connection/app'], ['POST', '/meta/connection/credentials'],
  ['POST', `/meta/connection/credentials/${rid}/verify`], ['POST', `/meta/connection/credentials/${rid}/revoke`],
  ['GET', '/meta/portfolios'], ['POST', '/meta/portfolios'], ['PATCH', `/meta/portfolios/${rid}`], ['DELETE', `/meta/portfolios/${rid}`],
  ['GET', '/meta/datasets'], ['POST', '/meta/datasets'], ['PATCH', `/meta/datasets/${rid}`], ['DELETE', `/meta/datasets/${rid}`],
  ['POST', `/meta/datasets/${rid}/verify`], ['PUT', `/meta/datasets/${rid}/ad-accounts`],
  ['GET', `/meta/org-datasets?tenant_id=${tA}&org_id=${orgA}`], ['PUT', '/meta/org-datasets'], ['DELETE', `/meta/org-datasets?tenant_id=${tA}&org_id=${orgA}`],
  ['GET', `/meta/capi-outbox?tenant_id=${tA}`], ['GET', `/meta/capi-outbox/summary?tenant_id=${tA}`], ['GET', `/meta/capi-outbox/worklist?tenant_id=${tA}`], ['GET', `/meta/capi-outbox/${rid}`],
  ['POST', '/meta/capi-outbox/retry'], ['POST', '/meta/capi-outbox/dismiss'], ['POST', '/meta/capi-outbox/requeue-skipped'],
];
const writeBody = (m) => (m === 'GET' || m === 'DELETE' ? undefined : {});

// ── W wall ─────────────────────────────────────────────────────────────────
const logins = [
  ...cfg.roles.filter((r) => r.role !== 'super_admin').map((r) => r.role),
  ...(cfg.crossTenantActors ?? []).map((r) => r.stateKey),
];
const an = await anon();
for (const [m, p] of ROUTES) {
  const r = await req(an, m, `${GATEWAY}${p}`, { data: writeBody(m) });
  log({ role: 'anonymous', area: AREA, action: `${m} ${p.split('?')[0]}`, method: m, endpoint: p.split('?')[0], status: r.status, verified: r.status === 401, expected: '401' });
  if (isOk(r.status) || r.status >= 500) fail(isOk(r.status) ? 'critical' : 'high', 'anonymous', `${m} ${p.split('?')[0]} without a session`, '401', `HTTP ${r.status}`, r.text.slice(0, 160), 'withSuperAdmin (authPreHandler) on the gateway route.');
}
await an.close();

for (const key of logins) {
  const a = await actor(key).catch(() => null);
  if (!a) { log({ role: key, area: AREA, action: 'no stored session', status: null, outcome: 'visible' }); continue; }
  try {
    let leaks = 0;
    for (const [m, p] of ROUTES) {
      const r = await req(a, m, `${GATEWAY}${p}`, { data: writeBody(m) });
      const denied = r.status === 403 || r.status === 401;
      log({ role: key, area: AREA, action: `${m} ${p.split('?')[0]}`, method: m, endpoint: p.split('?')[0], status: r.status, verified: denied, expected: '403' });
      if (isOk(r.status)) { leaks++; fail('critical', key, `Tenant login reached the super-admin Meta CAPI console: ${m} ${p.split('?')[0]}`, '403', `HTTP ${r.status}`, r.text.slice(0, 200), 'api-gateway server.ts: route must use withSuperAdmin; meta-conversion-api requireSuperAdmin(ctx).'); }
      else if (r.status >= 500) fail('high', key, `${m} ${p.split('?')[0]} crashed for a tenant login`, '403', `HTTP ${r.status}`, r.text.slice(0, 160), '');
      else if (!denied) fail('low', key, `${m} ${p.split('?')[0]} answered ${r.status} before the super-admin guard`, '403', `HTTP ${r.status}`, r.text.slice(0, 120), 'Authorize before validating (superAdminGuard runs as preHandler).');
    }
    console.log(`  ${key.padEnd(26)} wall: ${leaks ? leaks + ' LEAK(S)' : 'ok'}`);
  } finally { await a.close(); }
}

// ── R / S / C as super_admin ───────────────────────────────────────────────
const sa = await actor('super_admin').catch(() => null);
const made = { portfolio: null, dataset: null, map: false };
if (!sa) {
  fail('high', 'super_admin', 'No super_admin session for the CAPI v2 console checks', 'session', 'none', '', 'Run auth-setup.mjs.');
} else {
  try {
    // R
    for (const [m, p] of ROUTES.filter(([m, p]) => m === 'GET' && !p.includes(rid))) {
      const r = await req(sa, m, `${GATEWAY}${p}`);
      log({ role: 'super_admin', area: AREA, action: `${m} ${p.split('?')[0]}`, method: m, endpoint: p.split('?')[0], status: r.status, verified: isOk(r.status), expected: '200' });
      if (!isOk(r.status)) fail(r.status >= 500 ? 'high' : 'medium', 'super_admin', `${m} ${p.split('?')[0]} failed for super_admin`, '200', `HTTP ${r.status}`, r.text.slice(0, 200), 'meta-conversion-api datasets / capi-outbox / meta-connection controller.');
    }
    // S
    const c = await req(sa, 'GET', `${GATEWAY}/meta/connection`);
    if (isOk(c.status)) {
      const blob = c.text;
      const secretish = [];
      const walk = (o, path = '') => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (/^(access_token|app_secret|verify_token|token|secret)$/i.test(k) && typeof v === 'string' && v.length > 0) secretish.push(`${path}${k}`);
          walk(v, `${path}${k}.`);
        }
      };
      walk(c.body);
      const stored = rows(`SELECT left(access_token, 24) FROM ext.meta_platform_credentials WHERE access_token IS NOT NULL`, ['t']).map((x) => x.t).filter((t) => t && t.length >= 12);
      const cipherLeak = stored.some((t) => blob.includes(t));
      log({ role: 'super_admin', area: AREA, tab: 'Connection', action: `secrets in GET /meta/connection: fields=${secretish.length} stored=${cipherLeak}`, endpoint: '/meta/connection', status: c.status, verified: !secretish.length && !cipherLeak, expected: 'write-only secrets' });
      if (secretish.length || cipherLeak) fail('critical', 'super_admin', 'GET /meta/connection returns a secret', 'tokens/secrets are write-only', `${secretish.join(', ')}${cipherLeak ? ' + stored token' : ''}`, '', 'meta-connection.controller / credentials.service: project the safe columns only.');
    }
    // C
    const bizId = `9${String(Date.now()).slice(-10)}`;
    const p = await req(sa, 'POST', `${GATEWAY}/meta/portfolios`, { data: { tenant_id: tB, meta_business_id: bizId, name: 'E2E c9 portfolio', kind: 'BRAND' } });
    made.portfolio = p.body?.data?.id ?? null;
    const pRow = made.portfolio ? scalar(`SELECT tenant_id FROM ext.meta_business_portfolios WHERE id=${lit(made.portfolio)}`) : null;
    log({ role: 'super_admin', area: AREA, tab: 'Portfolios', action: 'register a portfolio for tenant B', method: 'POST', endpoint: '/meta/portfolios', status: p.status, verified: pRow === tB, expected: '201, row owned by tenant B' });
    if (!isOk(p.status) || pRow !== tB) fail(p.status >= 500 ? 'high' : 'medium', 'super_admin', 'Register a Meta portfolio', '201 + row in tenant B', `HTTP ${p.status}, tenant=${pRow}`, p.text.slice(0, 200), 'datasets.service createPortfolio.');

    if (made.portfolio) {
      const dsNum = `8${String(Date.now()).slice(-12)}`;
      const d = await req(sa, 'POST', `${GATEWAY}/meta/datasets`, { data: { portfolio_id: made.portfolio, dataset_id: dsNum, name: 'E2E c9 pixel' } });
      made.dataset = d.body?.data?.id ?? null;
      const dRow = made.dataset ? scalar(`SELECT tenant_id FROM ext.meta_datasets WHERE id=${lit(made.dataset)}`) : null;
      log({ role: 'super_admin', area: AREA, tab: 'Datasets', action: 'add a dataset under it', method: 'POST', endpoint: '/meta/datasets', status: d.status, verified: dRow === tB, expected: '201, inherits tenant B' });
      if (!isOk(d.status) || dRow !== tB) fail(d.status >= 500 ? 'high' : 'medium', 'super_admin', 'Add a Meta dataset', '201 + row in tenant B', `HTTP ${d.status}, tenant=${dRow}`, d.text.slice(0, 200), 'datasets.service createDataset must derive tenant_id from the portfolio.');

      if (made.dataset) {
        const u = await req(sa, 'PATCH', `${GATEWAY}/meta/datasets/${made.dataset}`, { data: { name: 'E2E c9 pixel renamed' } });
        const nm = scalar(`SELECT name FROM ext.meta_datasets WHERE id=${lit(made.dataset)}`);
        log({ role: 'super_admin', area: AREA, tab: 'Datasets', action: 'rename the dataset', method: 'PATCH', endpoint: '/meta/datasets/:id', status: u.status, verified: nm === 'E2E c9 pixel renamed', expected: '204 + renamed' });
        if (!isOk(u.status) || nm !== 'E2E c9 pixel renamed') fail('medium', 'super_admin', 'Rename a Meta dataset', '204 + renamed', `HTTP ${u.status}, name=${nm}`, u.text.slice(0, 160), '');

        // A disabled, never-synced placeholder account: linking a REAL account would route live
        // conversions to this throwaway pixel for the life of the link.
        const act = `act_${String(Date.now()).slice(-12)}`;
        q(`INSERT INTO ext.meta_ad_accounts (ad_account_id, name, is_enabled) VALUES (${lit(act)}, 'E2E c9 placeholder', false)`);
        made.act = act;
        const l = await req(sa, 'PUT', `${GATEWAY}/meta/datasets/${made.dataset}/ad-accounts`, { data: { ad_account_ids: [act] } });
        const linked = scalar(`SELECT count(*) FROM ext.meta_dataset_ad_accounts WHERE dataset_id=${lit(made.dataset)} AND ad_account_id=${lit(act)}`);
        log({ role: 'super_admin', area: AREA, tab: 'Datasets', action: 'link an ad account', method: 'PUT', endpoint: '/meta/datasets/:id/ad-accounts', status: l.status, verified: linked === '1', expected: '2xx + 1 link' });
        if (!isOk(l.status) || linked !== '1') fail(l.status >= 500 ? 'high' : 'medium', 'super_admin', 'Link an ad account to a dataset', '2xx + link row', `HTTP ${l.status}, rows=${linked}`, l.text.slice(0, 200), 'datasets.service setDatasetAdAccounts.');

        // cross-tenant fallback: tenant B's dataset as tenant A's branch fallback, two shapes
        for (const [label, body] of [
          ['tenant A + A branch + B dataset', { tenant_id: tA, org_id: orgA, dataset_id: made.dataset }],
          ['tenant B + A branch + B dataset', { tenant_id: tB, org_id: orgA, dataset_id: made.dataset }],
        ]) {
          const x = await req(sa, 'PUT', `${GATEWAY}/meta/org-datasets`, { data: body });
          const row = scalar(`SELECT count(*) FROM ext.meta_org_dataset_map WHERE org_id=${lit(orgA)} AND dataset_id=${lit(made.dataset)}`);
          const refused = !isOk(x.status) && row === '0';
          log({ role: 'super_admin', area: AREA, tab: 'Branch fallback', action: `cross-tenant fallback (${label})`, method: 'PUT', endpoint: '/meta/org-datasets', status: x.status, verified: refused, expected: '4xx, no row' });
          if (!refused) fail('critical', 'super_admin', `Cross-tenant dataset accepted as a branch fallback (${label})`, '4xx and no map row', `HTTP ${x.status}, rows=${row}`, x.text.slice(0, 200), 'ext.meta_org_dataset_map composite FKs (tenant_id, org_id) and (tenant_id, dataset_id) must both hold.');
          else if (x.status >= 500) fail('medium', 'super_admin', `Cross-tenant fallback refused with a 500 (${label})`, '409/422', `HTTP ${x.status}`, x.text.slice(0, 200), 'Translate 23503 to a 4xx in datasets.service setOrgDataset.');
          if (row !== '0') q(`DELETE FROM ext.meta_org_dataset_map WHERE org_id=${lit(orgA)} AND dataset_id=${lit(made.dataset)}`);
        }
        // legitimate fallback for tenant B's own branch, then clear it
        if (orgB) {
          const ok = await req(sa, 'PUT', `${GATEWAY}/meta/org-datasets`, { data: { tenant_id: tB, org_id: orgB, dataset_id: made.dataset } });
          made.map = isOk(ok.status);
          log({ role: 'super_admin', area: AREA, tab: 'Branch fallback', action: 'set tenant B branch fallback', method: 'PUT', endpoint: '/meta/org-datasets', status: ok.status, verified: isOk(ok.status), expected: '2xx' });
          if (!isOk(ok.status)) fail(ok.status >= 500 ? 'high' : 'medium', 'super_admin', 'Set a same-tenant branch fallback', '2xx', `HTTP ${ok.status}`, ok.text.slice(0, 200), '');
          const clr = await req(sa, 'DELETE', `${GATEWAY}/meta/org-datasets?tenant_id=${tB}&org_id=${orgB}`);
          log({ role: 'super_admin', area: AREA, tab: 'Branch fallback', action: 'clear it', method: 'DELETE', endpoint: '/meta/org-datasets', status: clr.status, verified: isOk(clr.status), expected: '2xx' });
        }
        const del = await req(sa, 'DELETE', `${GATEWAY}/meta/datasets/${made.dataset}`);
        const gone = scalar(`SELECT count(*) FROM ext.meta_datasets WHERE id=${lit(made.dataset)}`);
        log({ role: 'super_admin', area: AREA, tab: 'Datasets', action: 'remove the dataset', method: 'DELETE', endpoint: '/meta/datasets/:id', status: del.status, verified: isOk(del.status), expected: '204' });
        if (!isOk(del.status)) fail(del.status >= 500 ? 'high' : 'medium', 'super_admin', 'Remove a Meta dataset', '204', `HTTP ${del.status} (rows left ${gone})`, del.text.slice(0, 200), '');
      }
      const delp = await req(sa, 'DELETE', `${GATEWAY}/meta/portfolios/${made.portfolio}`);
      log({ role: 'super_admin', area: AREA, tab: 'Portfolios', action: 'remove the portfolio', method: 'DELETE', endpoint: '/meta/portfolios/:id', status: delp.status, verified: isOk(delp.status), expected: '204' });
      if (!isOk(delp.status)) fail(delp.status >= 500 ? 'high' : 'medium', 'super_admin', 'Remove a Meta portfolio', '204', `HTTP ${delp.status}`, delp.text.slice(0, 200), '');
    }
  } finally {
    await sa.close();
    // FK-ordered residue removal (only our own rows)
    if (made.dataset) for (const s of [
      `DELETE FROM ext.meta_org_dataset_map WHERE dataset_id=${lit(made.dataset)}`,
      `DELETE FROM ext.meta_dataset_ad_accounts WHERE dataset_id=${lit(made.dataset)}`,
      `DELETE FROM ext.meta_datasets WHERE id=${lit(made.dataset)}`]) { try { q(s); } catch {} }
    if (made.portfolio) { try { q(`DELETE FROM ext.meta_business_portfolios WHERE id=${lit(made.portfolio)}`); } catch {} }
    if (made.act) { try { q(`DELETE FROM ext.meta_dataset_ad_accounts WHERE ad_account_id=${lit(made.act)}`); q(`DELETE FROM ext.meta_ad_accounts WHERE ad_account_id=${lit(made.act)}`); } catch {} }
  }
}

// ── O outbox invariants (read-only) ────────────────────────────────────────
const inv = [
  ['unknown status', `SELECT count(*) FROM ext.meta_capi_outbox WHERE status NOT IN ('PENDING','SENDING','SENT','FAILED','DEAD','EXPIRED') AND status NOT LIKE 'SKIPPED%'`],
  ['PENDING past expires_at', `SELECT count(*) FROM ext.meta_capi_outbox WHERE status IN ('PENDING','FAILED') AND expires_at < now() - interval '1 hour'`],
  ['dataset owned by another tenant', `SELECT count(*) FROM ext.meta_capi_outbox o JOIN ext.meta_datasets d ON d.id=o.dataset_id WHERE d.tenant_id <> o.tenant_id`],
  ['branch of another tenant', `SELECT count(*) FROM ext.meta_capi_outbox o JOIN entity.organizations g ON g.id=o.org_id WHERE g.tenant_id <> o.tenant_id`],
];
for (const [label, sql] of inv) {
  let n = null;
  try { n = scalar(sql); } catch (e) { n = `error: ${String(e.message).slice(0, 80)}`; }
  const ok = n === '0';
  log({ role: 'db', area: AREA, tab: 'Outbox', action: `outbox invariant: ${label} = ${n}`, status: null, outcome: 'visible', verified: ok });
  if (!ok) fail(label.includes('tenant') ? 'critical' : 'medium', 'db', `CAPI outbox invariant broken: ${label}`, '0 rows', String(n), sql, label.includes('expires') ? 'The capi-outbox worker should move expired rows to EXPIRED.' : 'Outbox enqueue must take tenant/org from the lead row.');
}
console.log(`\n${rep.state.actions} actions, ${rep.state.findings} findings`);
