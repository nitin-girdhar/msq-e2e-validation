import { chromium } from '@playwright/test';
import { APPS, dir } from '../../lib.mjs';
import path from 'node:path';
const LEAD='019f88fd-49c6-7369-92c3-d9ca3d115f25', STAGE='019f88fc-035b-7334-bba8-9d363b86fedb';
for (const role of ['read_only','sales_representative','org_admin']) {
  const b = await chromium.launch();
  const c = await b.newContext({ storageState: path.join(dir,'.auth',`${role}.json`) });
  const r = await c.request.patch(`${APPS['lms-web']}/api/leads/${LEAD}`, { data: { stage_id: STAGE, transition_note: `E2E-c2-${role}` } });
  console.log(`${role.padEnd(22)} PATCH lead -> ${r.status()} ${(await r.text().catch(()=>'')).slice(0,60)}`);
  await b.close();
}
