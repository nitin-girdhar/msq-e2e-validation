// Decisive authorization test: have each role attempt a REAL stage change
// (not a no-op) on the same lead, then verify against the DB what actually
// changed. Only a persisted change proves a write went through.
import { chromium } from '@playwright/test';
import { save, APPS, dir } from '../../lib.mjs';
import path from 'node:path';

const LEAD = '019f8436-e834-7833-8437-370ee87c30a0';
const STAGES = {
  contacting: '019f85df-251e-7d8a-86e5-91fd3c3d1120',
  on_hold: '019f85df-251f-7eaa-b9ff-3e464ecc1d91',
  qualified: '019f85df-251f-7189-8a78-6fd0bf267b01',
  new: '019f85df-2519-7adf-9bc3-50c73ecb2d3d',
};
// Each role targets a DIFFERENT stage so the DB tells us exactly who succeeded.
const PLAN = [
  ['read_only', STAGES.on_hold],
  ['sales_representative', STAGES.qualified],
  ['org_manager', STAGES.new],
  ['org_admin', STAGES.contacting],
];

const results = [];
for (const [role, stageId] of PLAN) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: path.join(dir, '.auth', `${role}.json`) });
  const res = await ctx.request.patch(`${APPS['lms-web']}/api/leads/${LEAD}`, {
    data: { stage_id: stageId, transition_note: `E2E-decisive-${role}` },
  });
  const row = { role, targetStage: stageId, status: res.status(), body: (await res.text().catch(() => '')).slice(0, 200) };
  results.push(row);
  console.log(`${role.padEnd(22)} PATCH -> ${row.status} ${row.body.slice(0, 80)}`);
  await browser.close();
  await new Promise((r) => setTimeout(r, 800));
}
save('lms', 'authz-decisive', results);
