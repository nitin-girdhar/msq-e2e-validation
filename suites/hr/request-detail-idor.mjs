// HR request detail routes — IDOR matrix.
//
// The gateway now proxies two detail reads that hr-web's detail modals always
// called but that 404'd at the edge (server.ts, uncommitted 2026-09-29):
//
//   GET /hr/leave/requests/:id              -> leave.controller getMine
//   GET /hr/attendance/regularizations/:id  -> attendance.controller getRegularization
//
// Both resolve through repo.getOwn*Detail with `user_id = ctx.user_id`, i.e.
// OWNER-ONLY. The detail modals are mounted only on the requester's own
// dashboards (LeaveDashboardShell / AttendanceDashboardShell), so that is the
// intended contract. Opening a route that used to be dead is exactly when an
// IDOR appears, so this proves it per actor:
//
//   owner (rep1)                      200 + the request, approval chain present
//   peer in the same branch (rep2)    404, no body data
//   manager / org_admin / hr_admin    404 (they use the team/approvals views)
//   tenant B rep and tenant B admin   404
//   anonymous                         401
//   malformed id                      4xx, never 500
//
// A 403 is accepted as "denied" but noted (low): it confirms the record exists,
// which a 404 does not.
//
//   node suites/hr/request-detail-idor.mjs
import { APPS, record, roleMeta, CROSS_TENANT } from '../../lib.mjs';
import { leaveTypeFor, seedLeaveBalance } from '../../fixtures.mjs';
import { actor, apiGet, apiPost, readResp } from '../../conc.mjs';
import { dbReachable, scalar, q, lit } from '../../db.mjs';
import { logAction, outcomeOf } from '../../journal.mjs';
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
const LEAVE_TYPE = leaveTypeFor(roleMeta('sales_representative').email);

const TOOL = 'hr';
const HR = APPS['hr-web'];
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }

const stamp = Date.now();
const repEmail = roleMeta('sales_representative').email;
const repId = scalar(`SELECT id FROM iam.users WHERE email=${lit(repEmail)} LIMIT 1`);
const tenantId = scalar(`SELECT o.tenant_id FROM iam.users u JOIN entity.organizations o ON o.id=u.org_id WHERE u.id=${lit(repId)}`);
const typeId = scalar(`SELECT id FROM hr.leave_types WHERE name=${lit(LEAVE_TYPE)} AND tenant_id=${lit(tenantId)}::uuid LIMIT 1`);
if (!repId || !typeId) { console.log('Could not resolve rep1 / casual leave type — aborting'); process.exit(0); }

const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
let findings = 0;
const fail = (severity, role, page, scenario, expected, actual, evidence, fix) => {
  findings++;
  record(TOOL, { severity, role, tool: TOOL, page, scenario, expected, actual, evidence: String(evidence ?? '').slice(0, 400), proposedSolution: fix });
};
const bodyHasRecord = (body, id) => JSON.stringify(body ?? '').includes(id) && !!body?.data;

const actors = {};
const open = async (key) => { try { actors[key] = await actor(key); } catch { actors[key] = null; } return actors[key]; };
await open('sales_representative');
await open('org_admin');
const createdLeave = []; const createdReg = [];

try {
  const rep = actors.sales_representative; const admin = actors.org_admin;
  // Seed balance, then apply one leave as rep1 (API — the UI round trip is covered in ui/ui-write-roundtrip).
  seedLeaveBalance(repEmail, LEAVE_TYPE, 2, `E2E-idor-seed-${stamp}`);
  const apply = await apiPost(rep, `${HR}/api/hr/leave/requests`, { leave_type_name: LEAVE_TYPE, start_date: d(24), end_date: d(24), reason: `E2E-idor-${stamp}` });
  const leaveId = apply.body?.data?.id ?? apply.body?.id ?? scalar(`SELECT id FROM hr.leave_requests WHERE user_id=${lit(repId)} AND reason=${lit(`E2E-idor-${stamp}`)} LIMIT 1`);
  if (leaveId) createdLeave.push(leaveId);
  logAction({ tool: TOOL, role: 'sales_representative', area: 'Leave', action: 'apply 1-day casual leave (fixture for detail IDOR)', method: 'POST', endpoint: '/hr/leave/requests', status: apply.status, outcome: outcomeOf(apply.status, !!leaveId), verified: !!leaveId });

  let regId = null;
  for (const off of [-1, -2, -3]) {
    const r = await apiPost(rep, `${HR}/api/hr/attendance/regularizations`, { work_date: d(off), reason: `E2E-idor-reg-${stamp}` });
    regId = r.body?.data?.id ?? scalar(`SELECT id FROM hr.attendance_regularizations WHERE user_id=${lit(repId)} AND reason=${lit(`E2E-idor-reg-${stamp}`)} LIMIT 1`);
    logAction({ tool: TOOL, role: 'sales_representative', area: 'Attendance', action: `request regularization for ${d(off)} (fixture)`, method: 'POST', endpoint: '/hr/attendance/regularizations', status: r.status, outcome: outcomeOf(r.status, !!regId), verified: !!regId });
    if (regId) { createdReg.push(regId); break; }
  }

  const peerKeys = ['rep2', 'org_manager', 'hr_admin', 'org_admin', 'tenant_admin', 'super_admin'];
  for (const k of peerKeys) if (!(k in actors)) await open(k);
  for (const x of CROSS_TENANT) if (!(x.stateKey in actors)) await open(x.stateKey);
  const browser = await chromium.launch();
  const anonCtx = (await browser.newContext()).request;

  const matrix = async (label, path, id) => {
    if (!id) { fail('info', 'sales_representative', label, `Create a ${label} fixture`, 'created', 'not created', '', 'Precondition — see the lifecycle suites.'); return; }
    // owner
    const own = await apiGet(actors.sales_representative, `${HR}/api${path}/${id}`);
    const ownOk = own.status === 200 && bodyHasRecord(own.body, id);
    logAction({ tool: TOOL, role: 'sales_representative', area: label, action: `owner opens ${label} detail`, method: 'GET', endpoint: `${path}/:id`, status: own.status, outcome: outcomeOf(own.status, ownOk), verified: ownOk, expected: '200' });
    if (!ownOk) fail('high', 'sales_representative', label, `Owner opens their ${label} detail (View modal)`, '200 with the request + approval chain', `HTTP ${own.status}`, JSON.stringify(own.body).slice(0, 200),
      `Gateway GET ${path}/:id must proxy to hr-service; the modal is dead without it.`);
    // everybody else (super_admin included: the route is owner-only by design, SA uses the admin views)
    const others = [...peerKeys, ...CROSS_TENANT.map((x) => x.stateKey)].filter((k) => actors[k]);
    for (const k of others) {
      const r = await apiGet(actors[k], `${HR}/api${path}/${id}`);
      const leaked = r.status === 200 && bodyHasRecord(r.body, id);
      const crossTenant = CROSS_TENANT.some((x) => x.stateKey === k);
      logAction({ tool: TOOL, role: k, area: label, action: `non-owner opens rep1's ${label} detail`, method: 'GET', endpoint: `${path}/:id`, status: r.status, outcome: outcomeOf(r.status), verified: !leaked, expected: '404' });
      if (leaked) fail(crossTenant ? 'critical' : 'high', k, label, `${k} reads another user's ${label} by id`, '404 (owner-only detail)', '200 with the record', JSON.stringify(r.body).slice(0, 200),
        `repo.getOwn*Detail must keep user_id = ctx.user_id; add tenant_id to the WHERE as defence in depth.`);
      else if (r.status >= 500) fail('high', k, label, `${k} opens another user's ${label} detail`, '404', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200), 'NotFoundError, not a thrown Error.');
      else if (r.status === 403) {
        // A capability-gate 403 is the same for every id and reveals nothing;
        // it is an existence oracle only if a random id answers differently.
        const probe = await apiGet(actors[k], `${HR}/api${path}/${crypto.randomUUID()}`);
        if (probe.status !== 403) fail('low', k, label, `${k} opens another user's ${label} detail`, '404, same as a non-existent id',
          `403 for a real id vs ${probe.status} for a random one — confirms the id exists`, '', 'Return NotFoundError for non-owners.');
      }
    }
    const anon = await readResp(await anonCtx.get(`${HR}/api${path}/${id}`, { failOnStatusCode: false }));
    logAction({ tool: TOOL, role: 'anonymous', area: label, action: `anonymous opens ${label} detail`, method: 'GET', endpoint: `${path}/:id`, status: anon.status, outcome: outcomeOf(anon.status), verified: anon.status === 401, expected: '401' });
    if (anon.status !== 401) fail(anon.status === 200 ? 'critical' : 'medium', 'anonymous', label, `Anonymous GET ${path}/:id`, '401', `HTTP ${anon.status}`, JSON.stringify(anon.body).slice(0, 200), 'withAuth on the gateway route.');
    for (const bad of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const r = await apiGet(actors.sales_representative, `${HR}/api${path}/${bad}`);
      logAction({ tool: TOOL, role: 'sales_representative', area: label, action: `open ${label} detail with id "${bad.slice(0, 12)}"`, method: 'GET', endpoint: `${path}/:id`, status: r.status, outcome: outcomeOf(r.status), verified: r.status < 500, expected: '400/404' });
      if (r.status >= 500) fail('medium', 'sales_representative', label, `GET ${path}/${bad}`, '400/404', `HTTP ${r.status}`, JSON.stringify(r.body).slice(0, 200),
        'Validate :id as a uuid before the query (a bad uuid cast surfaces as a 500 from Postgres).');
    }
  };
  await matrix('Leave request', '/hr/leave/requests', leaveId);
  await matrix('Regularization', '/hr/attendance/regularizations', regId);
  await browser.close();
} finally {
  for (const id of createdLeave) {
    q(`DELETE FROM hr.leave_ledger WHERE leave_request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_request_approvals WHERE leave_request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_request_status_log WHERE request_id=${lit(id)}`);
    q(`DELETE FROM hr.leave_requests WHERE id=${lit(id)}`);
  }
  q(`DELETE FROM hr.leave_ledger WHERE note LIKE ${lit(`E2E-idor-seed-${stamp}`)}`);
  for (const id of createdReg) {
    q(`DELETE FROM hr.attendance_regularization_approvals WHERE regularization_id=${lit(id)}`);
    q(`DELETE FROM hr.attendance_regularizations WHERE id=${lit(id)}`);
  }
  for (const a of Object.values(actors)) await a?.close().catch(() => {});
  console.log(`cleaned ${createdLeave.length} leave / ${createdReg.length} regularization fixture(s); ${findings} finding(s).`);
}
