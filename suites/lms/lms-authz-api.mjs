// Hiding an Edit button is not authorization. Confirm the SERVER rejects
// writes from roles whose UI does not offer them.
import { chromium } from '@playwright/test';
import { save, APPS, dir } from '../../lib.mjs';
import path from 'node:path';

const results = [];
// Pick a real lead id as org_admin first.
const b0 = await chromium.launch();
const c0 = await b0.newContext({ storageState: path.join(dir, '.auth', 'org_admin.json') });
const r0 = await c0.request.get(`${APPS['lms-web']}/api/leads?page=1&page_size=1`);
const body = await r0.json().catch(() => ({}));
const leadId = body?.data?.[0]?.lead_id ?? body?.data?.[0]?.id ?? body?.leads?.[0]?.lead_id;
console.log('probe lead id =', leadId, '(status', r0.status(), ')');
await b0.close();

for (const role of ['read_only', 'sales_representative', 'org_manager', 'org_admin']) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: path.join(dir, '.auth', `${role}.json`) });

  const read = await ctx.request.get(`${APPS['lms-web']}/api/leads?page=1&page_size=1`);
  // Mirror the exact payload the Edit modal sends; a partial body makes the
  // handler 404 for everyone, which would mask the authorization signal.
  const write = await ctx.request.patch(`${APPS['lms-web']}/api/leads/${leadId}`, {
    data: {
      stage_id: '019f85df-251e-7d8a-86e5-91fd3c3d1120',
      outcome_id: '019f85df-2528-73e5-b4b5-e908d23d411b',
      transition_note: `E2E-authz-probe-${role}`,
    },
  });
  const wtext = (await write.text().catch(() => '')).slice(0, 200);

  const row = { role, readStatus: read.status(), writeStatus: write.status(), writeBody: wtext };
  results.push(row);
  console.log(`${role.padEnd(22)} GET=${row.readStatus}  PATCH=${row.writeStatus}  ${wtext.slice(0, 90)}`);
  await browser.close();
}

save('lms', 'authz-api', results);
