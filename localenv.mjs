// The platform's own root .env, read once — so the harness follows whatever
// topology THIS laptop's stack is configured for instead of hardcoding one.
//
// The stack runs locally in one of two shapes, both described in the root .env:
//   * full docker + Caddy   `docker compose --profile sso-proxy up --build`
//                           AUTH_URL=http://app.localhost, LMS_URL=http://app.localhost/lms ...
//   * native pnpm dev       `make dev` (pnpm turbo dev)
//                           AUTH_URL=http://localhost:3000, LMS_URL=http://localhost:3001/lms ...
//                           (and COOKIE_DOMAIN=localhost)
// Whichever is active, the web apps, the identity service's cookie and this
// harness must agree on the URLs — reading the same file guarantees it.
//
// Location: E2E_PLATFORM_ENV, else <this folder>/../.env (the msq-platforms root).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLATFORM_ENV_FILE = process.env.E2E_PLATFORM_ENV || path.resolve(here, '../.env');

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export const LOCAL_ENV = (() => {
  try { return parse(fs.readFileSync(PLATFORM_ENV_FILE, 'utf8')); } catch { return {}; }
})();
export const hasLocalEnv = Object.keys(LOCAL_ENV).length > 0;
