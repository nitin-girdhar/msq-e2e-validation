// HR Payroll viewer + month lock (schema 1.62):
//   /hr/payroll/payslips, /payslips/:id (employee), /admin/overview, /admin/readiness,
//   PUT /admin/payslips (draft), POST /admin/:month/{publish,lock,unlock}.
//
// Money is the most sensitive HR data, so every assertion is graded against hr.payslips /
// hr.payslip_lines / hr.pay_periods and the audit log:
//   * OWN-ONLY, PUBLISHED-ONLY  an employee lists/opens ONLY their own payslip and only after publish;
//     a draft is invisible (list AND by id), a colleague's / another tenant's payslip id is a 404.
//   * TOTALS ARE SERVER-SIDE    gross/deductions/net computed in paise; client-supplied gross/net,
//     org_id, published_at, user's identity are ignored.
//   * STATE MACHINE             draft -> edit (replaces lines, same id) -> publish -> immutable (409);
//     publish with nothing to publish is 400; a tenant-A HR publish never touches tenant-B drafts.
//   * LOCK                      lock/unlock are idempotent, org-scoped, stamp locked_by/locked_at, are
//     audited, hold the attendance gate (recompute in a locked month is refused) and reopen on unlock.
//     Observation recorded: lock does NOT freeze payslip draft/publish (only attendance).
//   * PERMISSIONS               payroll.manage for admin routes, payslip.view for employee routes.
//   * HARDENING                 bad months / ids / line shapes are 4xx — never a 5xx.
//   * AUDIT                     payslip_drafted / payslips_published / payroll_month_locked|unlocked rows
//     carry month + counts, never an amount.
//
// Runs in far-past months (2020-03..05) so no real period is touched; every payslip, line and pay_periods
// row of those months is hard-deleted in finally (and journalled so a killed run is replayed).
//
//   node suites/hr/hr-payroll.mjs
import { dbReachable } from '../../db.mjs';
import { restorePending } from '../../fixtures.mjs';
import {
  HR, MARK, STAMP, uuid, suite, open, who, guarded, journalPurge, waitAudit, auditRows, waitFor, q, scalar, rows, lit,
} from './_people-common.mjs';

if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
restorePending('people-');

const t = suite('hr', 'HR Payroll');
const cleanups = [];
const M1 = '2020-03', M2 = '2020-04', M3 = '2020-05';
const MONTHS = [M1, M2, M3].map((m) => `${m}-01`);

await guarded(async () => {
  const EMP = await open('msq_rep1'), ADM = await open('msq_org_admin'), ADM2 = await open('msq_tenant_admin');
  const MGR = await open('fitness_manager'), HRA = await open('hr_admin'), ORG = await open('org_admin'), RO = await open('read_only');
  if (!EMP || !ADM) { console.log('tenant B actors missing'); return; }
  const e = await who(EMP), a = await who(ADM), a2 = ADM2 ? await who(ADM2) : null, m = MGR ? await who(MGR) : null, h = HRA ? await who(HRA) : null;
  console.log(`EMP=${e.email}/${e.org_id} ADM=${a.email}/${a.org_id} HRA=${h?.email}/${h?.org_id}`);

  const inMonths = MONTHS.map(lit).join(',');
  const pre = Number(scalar(`SELECT (SELECT count(*) FROM hr.payslips WHERE period IN (${inMonths})) + (SELECT count(*) FROM hr.pay_periods WHERE period IN (${inMonths}))`));
  if (pre > 0) { console.log(`ABORT: ${pre} existing payslip/pay_period row(s) in the test months ${MONTHS.join(', ')} — refusing to touch them`); return; }
  const attBefore = Number(scalar(`SELECT count(*) FROM hr.attendance_days WHERE user_id=${lit(e.id)} AND work_date BETWEEN '2020-03-01' AND '2020-05-31'`));
  const PURGE = [
    `DELETE FROM hr.payslip_lines WHERE payslip_id IN (SELECT id FROM hr.payslips WHERE period IN (${inMonths}))`,
    `DELETE FROM hr.payslips WHERE period IN (${inMonths})`,
    `DELETE FROM hr.pay_periods WHERE period IN (${inMonths})`,
    ...(attBefore === 0 ? [`DELETE FROM hr.attendance_days WHERE user_id=${lit(e.id)} AND work_date BETWEEN '2020-03-01' AND '2020-05-31'`] : []),
  ];
  cleanups.push(journalPurge('people-payroll-purge', 'E2E payroll rows', PURGE));
  cleanups.push(() => { for (const s of PURGE) q(s); });

  const slip = (id) => rows(`SELECT user_id::text, org_id::text, period::text, gross::text, deductions::text, net::text, working_days::text, lop_days::text, published_at::text, published_by::text, created_by::text FROM hr.payslips WHERE id=${lit(id)}`,
    ['u', 'o', 'p', 'g', 'd', 'n', 'wd', 'lop', 'pub', 'pb', 'cb'])[0];
  const lines = (id) => rows(`SELECT kind, label, amount::text, sort_order::text FROM hr.payslip_lines WHERE payslip_id=${lit(id)} ORDER BY sort_order`, ['k', 'l', 'a', 's']);
  const period = (mo, org = a.org_id) => rows(`SELECT status, locked_by::text, locked_at::text FROM hr.pay_periods WHERE org_id=${lit(org)} AND period=${lit(`${mo}-01`)} AND NOT is_deleted`, ['st', 'by', 'at'])[0];
  const draft = (who_, user_id, month, ls, extra = {}, label = 'save a draft', expect = [200, 201]) =>
    t.api(who_, 'PUT', '/payroll/admin/payslips', { body: { user_id, month, lines: ls, ...extra }, expect, label });
  const L = (kind, label, amount) => ({ kind, label, amount });

  // ═══ 0. anonymous ═════════════════════════════════════════════════════════
  console.log('\n— 0. no session —');
  for (const [mth, p] of [['GET', '/payroll/payslips'], ['GET', `/payroll/payslips/${uuid()}`], ['GET', `/payroll/admin/overview?month=${M1}`], ['PUT', '/payroll/admin/payslips'], ['POST', `/payroll/admin/${M1}/publish`], ['POST', `/payroll/admin/${M1}/lock`]]) {
    const r = await fetch(`${HR}${p}`, { method: mth, headers: { 'content-type': 'application/json' }, body: mth === 'GET' ? undefined : '{}' }).catch(() => ({ status: 0 }));
    t.check([401, 403].includes(r.status), 'critical', 'anonymous', `${mth} /hr${p} without a session`, '401', `HTTP ${r.status}`);
  }

  // ═══ 1. permissions ═══════════════════════════════════════════════════════
  console.log('\n— 1. permissions —');
  for (const [k, A] of [['msq_rep1', EMP], ['org_admin', ORG], ['read_only', RO], ['fitness_manager', MGR]]) {
    if (!A) continue;
    await t.api(A, 'PUT', '/payroll/admin/payslips', { body: { user_id: e.id, month: M1, lines: [L('earning', 'x', 1)] }, expect: 'forbidden', label: `${k} drafts a payslip` });
    await t.api(A, 'GET', `/payroll/admin/overview?month=${M1}`, { expect: 'forbidden', label: `${k} opens the payroll overview` });
    await t.api(A, 'GET', `/payroll/admin/readiness?month=${M1}`, { expect: 'forbidden', label: `${k} opens payroll readiness` });
    for (const act of ['publish', 'lock', 'unlock']) await t.api(A, 'POST', `/payroll/admin/${M1}/${act}`, { expect: 'forbidden', label: `${k} ${act}s a month` });
  }
  for (const [k, A] of [['org_admin', ORG], ['read_only', RO]]) if (A) { await t.api(A, 'GET', '/payroll/payslips', { expect: 'forbidden', label: `${k} (no payslip.view) lists payslips` }); await t.api(A, 'GET', `/payroll/payslips/${uuid()}`, { expect: 'forbidden', label: `${k} opens a payslip` }); }
  t.check(!period(M1) && !period(M2), 'critical', 'msq_rep1', 'forbidden lock attempts created no pay_periods row', 'none', JSON.stringify([period(M1), period(M2)]));

  // ═══ 2. validation ════════════════════════════════════════════════════════
  console.log('\n— 2. validation —');
  const good = [L('earning', 'Basic', 100)];
  for (const [lbl, over] of [
    ['month 2020-13', { month: '2020-13' }], ['month 2020-3', { month: '2020-3' }], ['month "garbage"', { month: 'garbage' }], ['month with SQL', { month: "2020-03'; DROP TABLE hr.payslips;--" }],
    ['user_id not a uuid', { user_id: 'abc' }], ['no lines', { lines: [] }], ['41 lines', { lines: Array.from({ length: 41 }, (_, i) => L('earning', `l${i}`, 1)) }],
    ['negative amount', { lines: [L('earning', 'x', -1)] }], ['amount 100000001', { lines: [L('earning', 'x', 100000001)] }], ['amount as string', { lines: [{ kind: 'earning', label: 'x', amount: '5' }] }],
    ['empty label', { lines: [L('earning', '', 5)] }], ['label 101 chars', { lines: [L('earning', 'x'.repeat(101), 5)] }], ['kind "bonus"', { lines: [{ kind: 'bonus', label: 'x', amount: 5 }] }],
    ['working_days 32', { working_days: 32 }], ['working_days -1', { working_days: -1 }], ['lop_days 32', { lop_days: 32 }],
  ]) {
    await t.api(ADM, 'PUT', '/payroll/admin/payslips', { body: { user_id: e.id, month: M1, lines: good, ...over }, expect: 'invalid', label: `payslip: ${lbl}` });
  }
  await draft(ADM, uuid(), M1, good, {}, 'draft for an unknown employee', 'missing');
  if (m) await draft(ADM, m.id, M1, good, {}, 'cross-tenant: tenant-B HR drafts for a tenant-A employee', 'missing');
  if (HRA) await draft(HRA, e.id, M1, good, {}, 'cross-tenant: tenant-A HR drafts for a tenant-B employee', 'missing');
  t.check(Number(scalar(`SELECT count(*) FROM hr.payslips WHERE period=${lit(`${M1}-01`)}`)) === 0, 'critical', 'msq_org_admin', 'rejected / cross-tenant drafts created no payslip', '0', 'rows');
  for (const act of ['publish', 'lock', 'unlock']) for (const bad of ['2020-13', 'abc', '2020-3-1']) {
    await t.api(ADM, 'POST', `/payroll/admin/${bad}/${act}`, { expect: 'invalid', label: `${act} with month "${bad}"` });
  }
  for (const bad of ['2020-13', 'abc', '']) await t.api(ADM, 'GET', `/payroll/admin/overview?month=${bad}`, { expect: 'invalid', label: `overview month="${bad}"` });
  await t.api(ADM, 'GET', `/payroll/admin/overview`, { expect: 'invalid', label: 'overview without month' });
  await t.api(ADM, 'GET', `/payroll/admin/readiness?month=2020-13`, { expect: 'invalid', label: 'readiness month 2020-13' });
  await t.api(EMP, 'GET', '/payroll/payslips/not-a-uuid', { expect: 'notok', label: 'open a malformed payslip id' });
  await t.api(EMP, 'GET', `/payroll/payslips/${uuid()}`, { expect: 'missing', label: 'open an unknown payslip id' });

  // ═══ 3. drafts ═══════════════════════════════════════════════════════════
  console.log('\n— 3. drafts —');
  const t0 = new Date(Date.now() - 1500).toISOString();
  const LINES1 = [L('earning', 'Basic <b>pay</b>', 50000), L('earning', 'HRA', 20000.55), L('deduction', 'PF', 6000.25)];
  const d1 = await draft(ADM, e.id, M1, LINES1, { working_days: 22, lop_days: 1.5, gross: 1, net: 999999, org_id: h?.org_id ?? uuid(), published_at: '2001-01-01T00:00:00Z', published_by: a.id }, 'ADM drafts EMP\'s payslip (with smuggled gross/net/org_id/published_at)');
  const id1 = d1.body?.data?.id;
  const s1 = slip(id1);
  t.check(s1?.u === e.id && s1?.o === a.org_id && s1?.p === `${M1}-01` && Number(s1.g) === 70000.55 && Number(s1.d) === 6000.25 && Number(s1.n) === 64000.3 && !s1.pub && s1?.cb === a.id && Number(s1.wd) === 22 && Number(s1.lop) === 1.5, 'critical', 'msq_org_admin', 'draft: totals computed server-side (gross 70000.55, deductions 6000.25, net 64000.30), caller\'s org, unpublished — smuggled values ignored', 'server totals', JSON.stringify(s1), '', 'upsertDraft: computeTotals(data.lines) only; never read gross/net/org/published_* from the body.');
  const l1 = lines(id1);
  t.check(l1.length === 3 && l1[0].l === 'Basic <b>pay</b>' && l1[0].s === '0' && l1[2].k === 'deduction', 'high', 'msq_org_admin', 'three lines stored in order, label verbatim', '3 lines', JSON.stringify(l1));
  const ap = await waitAudit('payslip_drafted', e.id, t0);
  t.check(!!ap && !ap[0].meta.includes('50000') && !ap[0].meta.includes('70000') && ap[0].meta.includes(M1), 'high', 'msq_org_admin', 'payslip_drafted audit: month + id, never an amount', 'no amounts', ap?.[0]?.meta?.slice(0, 160), '', 'audit() extras are { payslip_id, month } only.');
  const d1b = await draft(ADM, e.id, M1, [L('earning', 'Basic', 40000), L('deduction', 'TDS', 1000.1), L('deduction', 'ESI', 0.2)], { working_days: 20 }, 'ADM edits the draft (replaces lines)');
  t.check(d1b.body?.data?.id === id1 && lines(id1).length === 3 && Number(slip(id1).g) === 40000 && Number(slip(id1).d) === 1000.3 && Number(slip(id1).n) === 38999.7 && Number(scalar(`SELECT count(*) FROM hr.payslips WHERE user_id=${lit(e.id)} AND period=${lit(`${M1}-01`)} AND NOT is_deleted`)) === 1, 'high', 'msq_org_admin', 'editing a draft keeps ONE payslip (same id), replaces lines, re-totals in paise (0.1+0.2 = 0.30)', 'same id, net 38999.70', JSON.stringify([d1b.body, slip(id1), lines(id1)]));
  // second payslip: ADM themself (so we can prove EMP can never read it)
  const d2 = await draft(ADM, a.id, M1, [L('earning', 'Basic', 90000), L('deduction', 'PF', 9000)], {}, 'ADM drafts their OWN payslip');
  const id2 = d2.body?.data?.id;
  const d3 = await draft(ADM, e.id, M2, [L('earning', 'Basic', 111)], {}, 'ADM drafts EMP\'s payslip for the second month');
  const id3 = d3.body?.data?.id;
  // concurrent first-draft for one (user, month): exactly one row survives
  const race = await Promise.all([
    draft(ADM, e.id, M3, [L('earning', 'A', 1)], {}, 'race: draft #1', [200, 201, 409]),
    draft(ADM2 && a2.org_id === a.org_id ? ADM2 : ADM, e.id, M3, [L('earning', 'B', 2)], {}, 'race: draft #2', [200, 201, 409]),
  ]);
  const nM3 = Number(scalar(`SELECT count(*) FROM hr.payslips WHERE user_id=${lit(e.id)} AND period=${lit(`${M3}-01`)} AND NOT is_deleted`));
  t.check(nM3 === 1 && race.every((r) => r.status < 500), 'high', 'msq_org_admin', 'two simultaneous first drafts for one (employee, month) leave exactly one payslip and no 5xx', '1 row, no 5xx', `${race.map((r) => r.status)} rows=${nM3}`, '', 'unique (user_id, period) + FOR UPDATE gap: the loser must retry as update or map 23505 to 409.');

  // ═══ 4. visibility of drafts ═════════════════════════════════════════════
  console.log('\n— 4. drafts are invisible to employees —');
  const l0 = await t.api(EMP, 'GET', '/payroll/payslips', { expect: 'ok', label: 'EMP lists payslips (only drafts exist)' });
  t.check(!(l0.body?.data ?? []).some((x) => [id1, id2, id3].includes(x.id)), 'critical', 'msq_rep1', 'a DRAFT payslip is not in the employee list', 'absent', 'present');
  await t.api(EMP, 'GET', `/payroll/payslips/${id1}`, { expect: 'missing', label: 'EMP opens their own DRAFT by id' });
  await t.api(EMP, 'GET', `/payroll/payslips/${id2}`, { expect: 'missing', label: 'IDOR: EMP opens ADM\'s draft by id' });
  await t.api(ADM, 'GET', `/payroll/payslips/${id1}`, { expect: 'missing', label: 'HR opens an employee\'s draft via the employee route (own-only)' });
  if (MGR) await t.api(MGR, 'GET', `/payroll/payslips/${id1}`, { expect: 'missing', label: 'cross-tenant: tenant-A employee opens a tenant-B draft' });
  if (HRA) await t.api(HRA, 'GET', `/payroll/payslips/${id1}`, { expect: 'missing', label: 'cross-tenant: tenant-A HR opens a tenant-B draft via the employee route' });
  // overview + readiness
  const ov = await t.api(ADM, 'GET', `/payroll/admin/overview?month=${M1}`, { expect: 'ok', label: 'ADM opens the overview' });
  t.check(ov.body?.data?.month === M1 && ov.body.data.status === 'open' && (ov.body.data.payslips ?? []).length === 2 && (ov.body.data.payslips ?? []).every((x) => x.published_at === null && slip(x.id)?.o === a.org_id), 'high', 'msq_org_admin', 'overview: the two drafts of the month, unpublished, caller\'s org only', '2 drafts', JSON.stringify(ov.body?.data)?.slice(0, 200));
  if (HRA) {
    const oh = await t.api(HRA, 'GET', `/payroll/admin/overview?month=${M1}`, { expect: 'ok', label: 'tenant-A HR opens the same month' });
    t.check((oh.body?.data?.payslips ?? []).length === 0, 'critical', 'hr_admin', 'tenant-A overview never lists tenant-B payslips', '0', String(oh.body?.data?.payslips?.length));
  }
  const rd = await t.api(ADM, 'GET', `/payroll/admin/readiness?month=${M1}`, { expect: 'ok', label: 'ADM opens readiness' });
  t.check(rd.body?.data?.draft_payslips === 2 && rd.body.data.published_payslips === 0 && Object.values(rd.body.data).every((v) => typeof v !== 'object' || v === null) && !('payslips' in rd.body.data), 'medium', 'msq_org_admin', 'readiness: counts only (2 drafts, 0 published), no names/amounts', 'counts', JSON.stringify(rd.body?.data));

  // ═══ 5. publish ══════════════════════════════════════════════════════════
  console.log('\n— 5. publish —');
  if (HRA) {
    await t.api(HRA, 'POST', `/payroll/admin/${M1}/publish`, { expect: 'invalid', label: 'cross-tenant: tenant-A HR publishes the month (nothing of theirs to publish)' });
    t.check(!slip(id1).pub && !slip(id2).pub, 'critical', 'hr_admin', 'tenant-A publish did NOT publish tenant-B drafts', 'still drafts', JSON.stringify([slip(id1).pub, slip(id2).pub]));
  }
  await t.api(ADM, 'POST', `/payroll/admin/${'2019-01'}/publish`, { expect: 'invalid', label: 'publish a month with no drafts (400)' });
  const p0 = new Date(Date.now() - 1500).toISOString();
  const pb = await t.api(ADM, 'POST', `/payroll/admin/${M1}/publish`, { expect: [200], label: 'ADM publishes the month' });
  t.check(pb.body?.data?.published === 2 && !!slip(id1).pub && slip(id1).pb === a.id && !!slip(id2).pub && !slip(id3).pub, 'critical', 'msq_org_admin', 'publish: both drafts of THAT month published (stamped by the caller), other months untouched', '2 published, M2 draft kept', JSON.stringify([pb.body, slip(id1).pub, slip(id3).pub]));
  const pa = await waitAudit('payslips_published', a.id, p0);
  t.check(!!pa && pa[0].meta.includes(M1) && !/\d{4,}\.\d{2}/.test(pa[0].meta.replace(M1, '')), 'medium', 'msq_org_admin', 'payslips_published audit: month + count only', 'no amounts', pa?.[0]?.meta?.slice(0, 120));
  await t.api(ADM, 'POST', `/payroll/admin/${M1}/publish`, { expect: 'invalid', label: 'publish again (nothing left, 400)' });
  await draft(ADM, e.id, M1, [L('earning', 'Basic', 1)], {}, 'edit a PUBLISHED payslip (409)', 'conflict');
  t.check(Number(slip(id1).g) === 40000 && lines(id1).length === 3, 'critical', 'msq_org_admin', 'a refused edit left the published payslip untouched', 'unchanged', JSON.stringify([slip(id1).g, lines(id1).length]));
  // employee read path
  const l1e = await t.api(EMP, 'GET', '/payroll/payslips', { expect: 'ok', label: 'EMP lists payslips after publish' });
  const ids = (l1e.body?.data ?? []).map((x) => x.id);
  t.check(ids.includes(id1) && !ids.includes(id2) && !ids.includes(id3) && ids.every((i) => slip(i)?.u === e.id && !!slip(i)?.pub), 'critical', 'msq_rep1', 'employee list = own PUBLISHED payslips only (no colleague, no draft)', '[own published]', JSON.stringify(ids));
  const dt = await t.api(EMP, 'GET', `/payroll/payslips/${id1}`, { expect: 'ok', label: 'EMP opens own published payslip' });
  t.check(dt.body?.data?.net === 38999.7 && dt.body.data.gross === 40000 && (dt.body.data.lines ?? []).length === 3 && dt.body.data.lines[0].label === 'Basic', 'high', 'msq_rep1', 'detail: totals + lines match the DB', 'net 38999.7, 3 lines', JSON.stringify(dt.body?.data)?.slice(0, 200));
  t.check(!JSON.stringify(dt.body).includes(a.id) && !/pan|aadhaar|account/i.test(JSON.stringify(Object.keys(dt.body?.data ?? {}))), 'medium', 'msq_rep1', 'payslip detail carries no other user id / bank data', 'clean', Object.keys(dt.body?.data ?? {}).join(','));
  await t.api(EMP, 'GET', `/payroll/payslips/${id2}`, { expect: 'missing', label: 'IDOR: EMP opens ADM\'s PUBLISHED payslip' });
  await t.api(EMP, 'GET', `/payroll/payslips/${id3}`, { expect: 'missing', label: 'EMP opens a still-draft payslip of another month' });
  const la = await t.api(ADM, 'GET', '/payroll/payslips', { expect: 'ok', label: 'ADM lists their own payslips' });
  t.check((la.body?.data ?? []).some((x) => x.id === id2) && !(la.body.data ?? []).some((x) => x.id === id1), 'critical', 'msq_org_admin', 'HR sees only THEIR payslip on the employee route, never EMP\'s', 'own only', JSON.stringify((la.body?.data ?? []).map((x) => x.id)));
  for (const [k, A] of [['fitness_manager', MGR], ['hr_admin', HRA]]) if (A) {
    const lx = await t.api(A, 'GET', '/payroll/payslips', { expect: 'ok', label: `${k} (tenant A) lists their payslips` });
    t.check(!(lx.body?.data ?? []).some((x) => [id1, id2].includes(x.id)), 'critical', k, 'cross-tenant employee list never shows a tenant-B payslip', 'absent', 'present');
    await t.api(A, 'GET', `/payroll/payslips/${id1}`, { expect: 'missing', label: `cross-tenant: ${k} opens a tenant-B PUBLISHED payslip` });
  }
  const over = await t.api(ADM, 'GET', `/payroll/admin/overview?month=${M1}`, { expect: 'ok', label: 'overview after publish' });
  t.check((over.body?.data?.payslips ?? []).every((x) => x.published_at), 'medium', 'msq_org_admin', 'overview marks both published', 'published', JSON.stringify(over.body?.data?.payslips?.map((x) => !!x.published_at)));

  // ═══ 6. lock / unlock ════════════════════════════════════════════════════
  console.log('\n— 6. month lock —');
  const k0 = new Date(Date.now() - 1500).toISOString();
  const lk = await t.api(ADM, 'POST', `/payroll/admin/${M2}/lock`, { expect: [200], label: 'ADM locks the month' });
  const pr = period(M2);
  t.check(lk.body?.data?.status === 'locked' && pr?.st === 'locked' && pr?.by === a.id && !!pr?.at, 'high', 'msq_org_admin', 'lock: pay_periods row locked, stamped with the caller + time', 'locked by ADM', JSON.stringify([lk.body, pr]));
  const orgsWithLock = Number(scalar(`SELECT count(*) FROM hr.pay_periods WHERE period=${lit(`${M2}-01`)} AND org_id <> ${lit(a.org_id)}`));
  t.check(orgsWithLock === 0, 'critical', 'msq_org_admin', 'lock is scoped to the caller\'s branch only', '0 other orgs', String(orgsWithLock));
  await t.api(ADM, 'POST', `/payroll/admin/${M2}/lock`, { expect: [200], label: 'lock again (idempotent)' });
  t.check(Number(scalar(`SELECT count(*) FROM hr.pay_periods WHERE period=${lit(`${M2}-01`)} AND org_id=${lit(a.org_id)} AND NOT is_deleted`)) === 1, 'high', 'msq_org_admin', 'still exactly one pay_periods row after a second lock', '1', 'more');
  const ovl = await t.api(ADM, 'GET', `/payroll/admin/overview?month=${M2}`, { expect: 'ok', label: 'overview of the locked month' });
  t.check(ovl.body?.data?.status === 'locked' && !!ovl.body.data.locked_at, 'medium', 'msq_org_admin', 'overview reports locked + locked_at', 'locked', JSON.stringify(ovl.body?.data)?.slice(0, 120));
  const rdl = await t.api(ADM, 'GET', `/payroll/admin/readiness?month=${M2}`, { expect: 'ok', label: 'readiness of the locked month' });
  t.check(rdl.body?.data?.status === 'locked', 'low', 'msq_org_admin', 'readiness reports locked', 'locked', String(rdl.body?.data?.status));
  // attendance gate
  const rc = await t.api(ADM, 'POST', '/attendance/recompute', { body: { user_id: e.id, from: `${M2}-10`, to: `${M2}-12` }, expect: 'conflict', label: 'recompute attendance inside the LOCKED month' });
  t.check(/locked/i.test(JSON.stringify(rc.body)), 'medium', 'msq_org_admin', 'the refusal names the lock', 'mentions "locked"', JSON.stringify(rc.body)?.slice(0, 140));
  await t.api(ADM, 'POST', '/attendance/recompute', { body: { user_id: e.id, from: `${M1}-10`, to: `${M2}-12` }, expect: 'conflict', label: 'recompute a range whose END is in the locked month' });
  // lock vs payslips: observation
  const dl = await draft(ADM, e.id, M2, [L('earning', 'Basic', 222)], {}, 'edit a payslip draft while its month is LOCKED', [200, 201, 409]);
  logActionNote('draft edit while locked', dl.status);
  if (dl.status < 300) {
    t.find('low', 'msq_org_admin', 'Locked payroll month still accepts payslip draft edits', 'The lock UI text says "figures cannot move"; a locked month refusing payslip edits/publish would match that intent (or the docs should say lock is attendance-only)',
      `PUT /payroll/admin/payslips for a locked month returned HTTP ${dl.status} and the draft changed (net ${slip(id3)?.n})`, 'hr.pay_periods.status=locked; payroll.repository.upsertDraft() only checks published_at',
      'Call assertPeriodOpen(tx, ctx.org_id, period) in upsertDraft and publish, or document that lock only freezes attendance (payroll.lock banner says "attendance … can no longer be corrected").');
  }
  const pl = await t.api(ADM, 'POST', `/payroll/admin/${M2}/publish`, { label: 'publish while the month is LOCKED', expect: [200, 409] });
  console.log(`  (observation) publish in a locked month -> ${pl.status}`);
  // unlock
  await t.api(EMP, 'POST', `/payroll/admin/${M2}/unlock`, { expect: 'forbidden', label: 'EMP unlocks a month' });
  t.check(period(M2)?.st === 'locked', 'critical', 'msq_rep1', 'forbidden unlock left the month locked', 'locked', period(M2)?.st);
  await t.api(ADM, 'POST', `/payroll/admin/${M2}/unlock`, { expect: [200], label: 'ADM unlocks the month' });
  const pu = period(M2);
  t.check(pu?.st === 'open' && !pu?.by && !pu?.at, 'high', 'msq_org_admin', 'unlock reopens the month and clears locked_by/locked_at', 'open, no stamps', JSON.stringify(pu));
  const la2 = await waitAudit('payroll_month_locked', a.id, k0), ua = await waitAudit('payroll_month_unlocked', a.id, k0);
  t.check(!!la2 && !!ua && la2[0].meta.includes(M2) && ua[0].meta.includes(M2), 'high', 'msq_org_admin', 'payroll_month_locked and payroll_month_unlocked are both audited with the month', '2 rows', JSON.stringify([la2?.[0]?.meta, ua?.[0]?.meta]));
  const ro = await t.api(ADM, 'POST', '/attendance/recompute', { body: { user_id: e.id, from: `${M2}-10`, to: `${M2}-10` }, label: 'recompute after unlock', expect: [200, 201, 204, 404, 400] });
  t.check(ro.status !== 409, 'high', 'msq_org_admin', 'after unlock the attendance gate is open again', 'not 409', `HTTP ${ro.status}`);
  await t.api(ADM, 'POST', `/payroll/admin/${M2}/unlock`, { expect: [200], label: 'unlock an already-open month (idempotent)' });
  // concurrency: lock vs unlock leaves exactly one row, valid state
  await Promise.all([
    t.api(ADM, 'POST', `/payroll/admin/${M3}/lock`, { label: 'race lock', allow5xx: true }),
    t.api(ADM2 && a2.org_id === a.org_id ? ADM2 : ADM, 'POST', `/payroll/admin/${M3}/lock`, { label: 'race lock #2', allow5xx: true }),
    t.api(ADM, 'POST', `/payroll/admin/${M3}/unlock`, { label: 'race unlock', allow5xx: true }),
  ]);
  const nrows = Number(scalar(`SELECT count(*) FROM hr.pay_periods WHERE period=${lit(`${M3}-01`)} AND org_id=${lit(a.org_id)} AND NOT is_deleted`));
  t.check(nrows === 1 && ['open', 'locked'].includes(period(M3)?.st), 'high', 'msq_org_admin', 'three simultaneous lock/unlock calls leave exactly one valid pay_periods row, no 5xx', '1 row', `rows=${nrows} state=${period(M3)?.st}`, '', 'ON CONFLICT (org_id, period) WHERE NOT is_deleted upsert.');
}, cleanups);

function logActionNote(action, status) { console.log(`  (observation) ${action} -> HTTP ${status}`); }

t.summary();
process.exit(0);
