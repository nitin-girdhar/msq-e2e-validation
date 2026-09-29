// Two admins transfer the SAME lead at the same instant.
//
// leads.repository.ts transferLead reads the source lead (is_active = true)
// without SELECT ... FOR UPDATE, inserts the copy into the target branch, then
// UPDATEs the source by id+org only — it does not re-assert is_active. Two
// overlapping transactions can therefore BOTH pass the read, BOTH insert a copy
// and BOTH write a lms.lead_links row: one enquiry becomes two leads in the
// receiving branch (two reps call the same person; reports double-count).
//
// Correct behaviour: exactly one transfer wins; the loser gets a clean 4xx
// (409/404), never a second copy and never a 500. Run several rounds — a race
// that loses once can still be real.
//
//   node suites/concurrency/lms-lead-transfer-race.mjs
import { roleMeta, APPS, authFile } from '../../lib.mjs';
import { actor, apiPost, simultaneously } from '../../conc.mjs';
import { dbReachable, scalar, rows, lit } from '../../db.mjs';
import { finder, isOk, purgeById } from '../../fixtures.mjs';
import fs from 'node:fs';

const TOOL = 'concurrency';
const fail = finder(TOOL, 'Lead transfer race');
const LMS = `${APPS['lms-web']}/api`;
const ROUNDS = Number(process.env.E2E_RACE_ROUNDS || 5);
if (!dbReachable()) { console.log('DB not reachable — aborting'); process.exit(0); }
for (const k of ['tenant_admin', 'org_admin']) if (!fs.existsSync(authFile(k))) { console.log(`${k} login required — aborting`); process.exit(0); }

const MARK = `E2E-xrace-${Date.now()}`;
const orgA = scalar(`SELECT org_id FROM iam.users WHERE email=${lit(roleMeta('org_admin').email)}`);
const tenantA = scalar(`SELECT tenant_id FROM entity.organizations WHERE id=${lit(orgA)}`);
const orgT = scalar(`SELECT id FROM entity.organizations WHERE tenant_id=${lit(tenantA)} AND id<>${lit(orgA)} AND is_active AND NOT is_deleted ORDER BY name LIMIT 1`);
if (!orgT) { console.log('Need a second branch — aborting'); process.exit(0); }

// Two different users, both allowed to transfer an orgA lead: tenant_admin
// (session home = orgA) and org_admin of orgA.
const a1 = await actor('tenant_admin');
const a2 = await actor('org_admin');
let doubles = 0, fivexx = 0;
try {
  for (let i = 0; i < ROUNDS; i++) {
    const tag = `${MARK}-${i}`;
    await apiPost(a1, `${LMS}/leads`, { first_name: tag, phone: `+9197${String(Date.now()).slice(-6)}${String(i).padStart(2, '0')}`, org_id: orgA });
    const id = scalar(`SELECT id FROM lms.marketing_leads WHERE first_name=${lit(tag)} ORDER BY created_at DESC LIMIT 1`);
    if (!id) { console.log(`round ${i}: could not seed a lead`); continue; }
    const [r1, r2] = await simultaneously([
      () => a1.request.post(`${LMS}/leads/${id}/transfer`, { data: { target_org_id: orgT, notes: 'race A' }, failOnStatusCode: false }).then((r) => r.status()),
      () => a2.request.post(`${LMS}/leads/${id}/transfer`, { data: { target_org_id: orgT, notes: 'race B' }, failOnStatusCode: false }).then((r) => r.status()),
    ]);
    const links = Number(scalar(`SELECT COUNT(*) FROM lms.lead_links WHERE source_lead_id=${lit(id)} AND link_type='transfer'`));
    const copies = Number(scalar(`SELECT COUNT(*) FROM lms.marketing_leads WHERE org_id=${lit(orgT)} AND first_name=${lit(tag)}`));
    const wins = [r1, r2].filter(isOk).length;
    console.log(`round ${i}: statuses=${r1}/${r2} wins=${wins} copiesInTarget=${copies} links=${links}`);
    if (copies > 1 || links > 1 || wins > 1) doubles++;
    if ([r1, r2].some((s) => s >= 500)) fivexx++;
  }
  if (doubles) fail('high', 'tenant_admin + org_admin', 'Two simultaneous transfers of one lead both succeed', 'Exactly one transfer wins; one copy in the target branch; one lms.lead_links row', `double transfer in ${doubles}/${ROUNDS} round(s)`, MARK,
    'In transferLead: `SELECT ... FOR UPDATE` the source row, and make the closing UPDATE `WHERE id = $1 AND org_id = $2 AND is_active` returning a row — abort (409) when it updates nothing. A partial unique index on lms.lead_links(source_lead_id) WHERE link_type=\'transfer\' is a cheap backstop.');
  if (fivexx) fail('medium', 'tenant_admin + org_admin', 'The losing concurrent transfer returns 5xx', 'A clean 409/404 for the loser', `5xx in ${fivexx}/${ROUNDS} round(s)`, MARK, 'Map the "already inactive" path to a ConflictError instead of a plain Error.');
} finally {
  await a1.close(); await a2.close();
  const ids = rows(`SELECT id FROM lms.marketing_leads WHERE first_name LIKE ${lit(`${MARK}-%`)}`, ['id']).map((r) => r.id);
  for (const id of ids) purgeById('lms.marketing_leads', id);
  console.log(`\npurged ${ids.length} throwaway lead(s).`);
}
