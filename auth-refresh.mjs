// Re-login only the stored sessions that stopped working.
//
// An overnight run is long and several stages exercise the session machinery
// (crawls, capability toggles). If anything revokes a stored jti or bumps a
// user's pwd_iat, every later suite running as that role reads 401 and reports
// it as a product defect. run-all.mjs calls this between bands: probe every
// .auth/<key>.json with GET /auth/me and re-run auth-setup for just the dead ones.
//
//   node auth-refresh.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cfg, dir, authFile, GATEWAY } from './lib.mjs';
import { actor, apiGet } from './conc.mjs';

const keys = [
  ...cfg.roles.map((r) => r.role),
  ...(cfg.secondaryActors ?? []).map((a) => a.actor),
  ...(cfg.crossTenantActors ?? []).map((a) => a.stateKey),
];
const dead = [];
for (const k of keys) {
  if (!fs.existsSync(authFile(k))) { dead.push(k); continue; }
  const a = await actor(k);
  const me = await apiGet(a, `${GATEWAY}/auth/me`).catch(() => ({ status: 0 }));
  await a.close();
  if (me.status !== 200) dead.push(k);
}
if (!dead.length) { console.log(`auth-refresh: all ${keys.length} sessions alive`); process.exit(0); }
console.log(`auth-refresh: re-logging ${dead.length} dead session(s): ${dead.join(', ')}`);
const res = spawnSync('node', [path.join(dir, 'auth-setup.mjs')], { stdio: 'inherit', cwd: dir, env: { ...process.env, AUTH_ONLY: dead.join(',') } });
process.exit(res.status ?? 1);
