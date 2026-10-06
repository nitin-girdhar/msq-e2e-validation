import { q } from './db.mjs';
const p=(s)=>{ try{console.log(q(s).map(r=>r.join(' | ')).join('\n'),'\n---');}catch(e){console.log('ERR',String(e.message).split('\n').slice(1,3).join(' '))} };
p(`select key, parent_key from iam.capabilities where key in ('hr.attendance.admin.override','hr.attendance.admin','hr.attendance.roster.manage','hr.attendance.roster.view','hr.attendance.swap.request','hr.attendance.swap.approve','hr.reports.attendance.view','hr.attendance.view.team','hr.attendance.view') order by 1`);
p(`select ur.name, ur.tenant_id from iam.user_roles ur where ur.name in ('fitness_manager','fitness_trainer')`);
