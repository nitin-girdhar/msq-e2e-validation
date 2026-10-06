import { actor, apiGet } from './conc.mjs';
import { GATEWAY, cfg, CROSS_TENANT } from './lib.mjs';
const keys = [...cfg.roles.map(r=>r.role), ...CROSS_TENANT.map(c=>c.stateKey)];
const want = /^(lms\.leads\.(bulk\.update|edit.*|create|view.*|interaction\.log|assign.*)|lms\.followups\.(bulk\.reschedule|create)|platform\.write|lms\.analytics.*|lms\.users.*)$/;
for (const k of keys) { const a = await actor(k); const me = await apiGet(a, `${GATEWAY}/auth/me`); const u=me.body?.data?.user; console.log(k.padEnd(26), u?.org_name,'|',(u?.capabilities||[]).filter(c=>want.test(c)).join(',')); await a.close(); }
