// Endpoint -> source-code map.
//
// A finding that says "PATCH /api/leads/:id returned 204 but nothing persisted"
// is only half an answer. This scans the product's own routers and reconstructs
// the chain behind each endpoint, so the report can say WHERE to look and WHAT
// the request passes through:
//
//   POST /leads/:id/follow-ups
//     router     msq-lms/.../leads/leads.router.ts:40
//     guards     authenticate -> requireModule('lms') -> requireCapability(LMS_FOLLOWUPS_CREATE) -> validate(createFollowUpSchema)
//     handler    fuCtrl.create
//     controller follow-ups.controller.ts
//     service    follow-ups.service.ts
//     repository follow-ups.repository.ts
//
// Everything is derived by scanning, not hardcoded, so it stays accurate when
// the product moves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultsDir } from './lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTS = ['msq-core', 'msq-lms', 'msq-hrms', 'msq-todo'];

function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.name.endsWith('.router.ts')) out.push(p);
  }
  return out;
}

// Pull the guard names out of a preHandler array, in order.
function parseGuards(line) {
  const guards = [];
  const cap = line.match(/requireCapability\(\s*([A-Za-z0-9_.]+)/);
  if (/\bauthenticateSuperAdmin\b/.test(line)) guards.push('authenticateSuperAdmin');
  else if (/\bauthenticate\b/.test(line)) guards.push('authenticate');
  const mod = line.match(/requireModule\(\s*'([^']+)'/);
  if (mod) guards.push(`requireModule('${mod[1]}')`);
  if (/\.\.\.gate\b/.test(line)) guards.push('...gate');
  if (cap) guards.push(`requireCapability(${cap[1]})`);
  const val = line.match(/validate\(\s*\{([^}]*)\}/);
  if (val) guards.push(`validate({${val[1].trim().replace(/\s+/g, ' ')}})`);
  return guards;
}

function siblings(dir) {
  const found = {};
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return found; }
  for (const f of entries) {
    if (f.endsWith('.controller.ts')) found.controller = f;
    else if (f.endsWith('.service.ts')) found.service = f;
    else if (f.endsWith('.repository.ts')) found.repository = f;
    else if (f.endsWith('.schema.ts')) found.schema = f;
  }
  return found;
}

export function buildCodemap() {
  const routes = [];
  for (const product of PRODUCTS) {
    const base = path.join(REPO, product, 'services');
    for (const file of walk(base)) {
      const rel = path.relative(REPO, file).replace(/\\/g, '/');
      const service = rel.split('/')[2] ?? '';
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const sib = siblings(path.dirname(file));
      lines.forEach((line, i) => {
        const m = line.match(/\b(?:app|router)\.(get|post|patch|put|delete)\(\s*'([^']+)'/);
        if (!m) return;
        const handler = (line.match(/\}\s*,\s*([A-Za-z0-9_.]+)\s*\)\s*;?\s*$/) || [])[1] || null;
        routes.push({
          method: m[1].toUpperCase(),
          routePath: m[2],
          service,
          router: `${rel}:${i + 1}`,
          guards: parseGuards(line),
          handler,
          controller: sib.controller ? path.posix.join(path.dirname(rel), sib.controller) : null,
          serviceFile: sib.service ? path.posix.join(path.dirname(rel), sib.service) : null,
          repository: sib.repository ? path.posix.join(path.dirname(rel), sib.repository) : null,
          schema: sib.schema ? path.posix.join(path.dirname(rel), sib.schema) : null,
        });
      });
    }
  }
  return routes;
}

// Normalise a URL the suites used into something comparable with router paths:
// strip origin, the /api prefix, and a product prefix the web app adds (/hr).
function normalise(url) {
  let p = String(url || '');
  p = p.replace(/^https?:\/\/[^/]+/, '');
  p = p.split('?')[0];
  // Only strip /api when it is a path segment — `/api-clients` (the gateway
  // route) must survive, and \b would happily match before the hyphen.
  p = p.replace(/^\/api(?=\/)/, '');
  // hr-web is the only app that namespaces its proxy (/api/hr/...); its service
  // routes are /leave, /attendance, /holidays. `tasks` and `leads` are real
  // resources, not prefixes — stripping them loses the route entirely.
  p = p.replace(/^\/hr(?=\/)/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/$/, '') || '/';
}

const toRegex = (routePath) =>
  new RegExp('^' + routePath.replace(/:[A-Za-z0-9_]+/g, '[^/]+').replace(/\//g, '\\/') + '$');

let CACHE = null;
export function codemap() {
  if (!CACHE) CACHE = buildCodemap();
  return CACHE;
}

// Best match for a (method, url) pair. Prefers an exact path, then a param match
// with the fewest wildcards (so /leads/:id doesn't beat /leads/:id/transfer).
export function resolveEndpoint(method, url) {
  const p = normalise(url);
  const M = String(method || '').toUpperCase();
  const candidates = codemap().filter((r) => (!M || r.method === M) && toRegex(r.routePath).test(p));
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (a.routePath.split(':').length - b.routePath.split(':').length) ||
    (b.routePath.length - a.routePath.length));
  return candidates[0];
}

// Render the chain a request passes through, as report-ready lines.
export function controlFlow(entry, { table = null } = {}) {
  if (!entry) return null;
  const steps = [];
  steps.push(`route      ${entry.method} ${entry.routePath}  [${entry.service}]`);
  steps.push(`router     ${entry.router}`);
  if (entry.guards?.length) steps.push(`guards     ${entry.guards.join('  ->  ')}`);
  if (entry.handler) steps.push(`handler    ${entry.handler}`);
  if (entry.controller) steps.push(`controller ${entry.controller}`);
  if (entry.serviceFile) steps.push(`service    ${entry.serviceFile}`);
  if (entry.repository) steps.push(`repository ${entry.repository}`);
  if (table) steps.push(`table      ${table}`);
  return steps;
}

// Persist for inspection / reuse.
export function saveCodemap() {
  const all = codemap();
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'codemap.json'), JSON.stringify(all, null, 2));
  return all.length;
}
