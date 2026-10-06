import { chromium } from '@playwright/test';
import path from 'node:path';
import { cfg, authDir } from './lib.mjs';
const A=cfg.apps; const b=await chromium.launch();
const tests=[['lms-web','/dashboard/assignments',['org_admin','sales_manager','sales_head','msq_org_admin','super_admin','org_manager']],
['hr-web','/org-chart',['hr_admin','msq_hr_head','hr_manager','hr_executive','tenant_admin','hr_head']]];
for(const [app,p,states] of tests) for(const s of states){
 const c=await b.newContext({storageState:path.join(authDir,s+'.json')});const pg=await c.newPage();
 await pg.goto(A[app]+p,{waitUntil:'domcontentloaded'}).catch(()=>{});await pg.waitForTimeout(2500);
 console.log(app,p,s,'->',pg.url().replace(/^https?:\/\/[^/]+/,'').slice(0,70));await c.close();}
await b.close();
