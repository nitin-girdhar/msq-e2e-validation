// Build ../openissues.md — the extensive deliverable the validation task asks for.
//
// Two parts, from two data sources produced by the run:
//   Part A — COVERAGE: every action the suites actually performed, grouped
//            tool -> page/area -> tab -> role -> action -> outcome. Source:
//            results/actions/*.json (the journal, successes included).
//   Part B — ISSUES: every defect, severity-ranked, grouped by tool, each with
//            role, where, expected, actual, evidence and a proposed fix.
//            Source: results/findings-*.json.
//
// The per-issue "root cause / control flow / code fix" narrative for the top
// findings is authored by hand on top of this generated skeleton.
import fs from 'node:fs';
import path from 'node:path';
import { resultsDir, dir, cfg } from './lib.mjs';
import { readAllActions } from './journal.mjs';
import { TOOLS } from './tools.config.mjs';

const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const sevRank = (s) => { const i = SEV.indexOf(String(s || 'info').toLowerCase()); return i < 0 ? SEV.length : i; };
const TOOL_LABEL = { ...Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, v.label])), concurrency: 'Multi-user / Concurrency', tenant: 'Cross-tenant isolation', capability: 'Capability toggling', admin: 'Lookup Admin' };
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

// ── load ────────────────────────────────────────────────────────────────────
function loadFindings() {
  if (!fs.existsSync(resultsDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(resultsDir).filter((f) => /^findings-.*\.json$/.test(f))) {
    const area = f.replace(/^findings-|\.json$/g, '');
    try { for (const r of JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'))) out.push({ tool: r.tool || area, ...r }); } catch {}
  }
  return out;
}
const findings = loadFindings().sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
const actions = readAllActions();

const bySev = Object.fromEntries(SEV.map((s) => [s, 0]));
for (const f of findings) bySev[String(f.severity || 'info').toLowerCase()]++;

const L = [];
const p = (s = '') => L.push(s);

// ── header ────────────────────────────────────────────────────────────────────
p('# MSQ Platforms — End-to-End Validation: Open Issues & Coverage Report');
p('');
p(`_Generated ${new Date().toISOString()}._`);
p('');
p('This report is produced by the `msq-e2e-validation` harness: browser-driven');
p('agents that log in as **every role**, open **every tool / tab / dropdown /');
p('button**, attempt real writes, run **two users against one record**, toggle');
p('**capabilities**, and cross-check **tenant isolation** — verifying each UI');
p('action against the source-of-truth Postgres.');
p('');
p('## How the validation was run');
p('');
p('| Dimension | Coverage |');
p('| --- | --- |');
p(`| Roles | ${cfg.roles.length} distinct roles, rank 0 (read_only) → 1000 (super_admin) |`);
p(`| Tenants | ${(cfg.tenants || []).map((t) => t.name).join(' + ')} (cross-tenant isolation probed) |`);
p(`| Tools | ${Object.values(TOOLS).map((t) => t.label).join('; ')} |`);
p('| Layers | deep-crawl · role-matrix writes · cross-tenant IDOR · capability toggle · concurrency · responsive |');
p(`| Actions journalled | ${actions.length} |`);
p(`| Findings | ${findings.length} (` + SEV.filter((s) => bySev[s]).map((s) => `${s}: ${bySev[s]}`).join(', ') + ') |');
p('');

// ── severity roll-up ──────────────────────────────────────────────────────────
p('## Severity totals');
p('');
p('| Severity | Count |');
p('| --- | --- |');
for (const s of SEV) if (bySev[s]) p(`| ${s} | ${bySev[s]} |`);
p('');

const tools = [...new Set(findings.map((f) => f.tool))];
p('## Findings by tool');
p('');
p('| Tool | critical | high | medium | low | info |');
p('| --- | --- | --- | --- | --- | --- |');
for (const t of tools) {
  const c = Object.fromEntries(SEV.map((s) => [s, findings.filter((f) => f.tool === t && String(f.severity).toLowerCase() === s).length]));
  p(`| ${TOOL_LABEL[t] || t} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${c.info} |`);
}
p('');

// ═══════════════════════════════════════════════════════════════════════════
// PART A — COVERAGE (what each role actually did, per tab)
// ═══════════════════════════════════════════════════════════════════════════
p('---');
p('');
p('# Part A — Coverage: what every role did on every tab');
p('');
p('Each row is one real action the agent performed, with the backend-verified');
p('outcome. `outcome` legend: **allowed** (2xx + persisted), **denied** (401/403/404),');
p('**no-op** (2xx but nothing changed — a silent drop), **error** (5xx / thrown),');
p('**hidden/visible** (UI presence).');
p('');
if (!actions.length) {
  p('_No journalled actions found — the matrix/capability/tenant suites did not run or wrote no journal._');
  p('');
} else {
  // group tool -> area -> tab
  const g = {};
  for (const a of actions) {
    const tool = a.tool || 'unknown';
    const area = a.area || a.endpoint || '(general)';
    const tab = a.tab || '—';
    ((g[tool] ??= {})[area] ??= {})[tab] ??= [];
    g[tool][area][tab].push(a);
  }
  for (const tool of Object.keys(g).sort()) {
    p(`## ${TOOL_LABEL[tool] || tool}`);
    p('');
    for (const area of Object.keys(g[tool]).sort()) {
      p(`### ${esc(area)}`);
      p('');
      for (const tab of Object.keys(g[tool][area]).sort()) {
        if (tab !== '—') p(`**Tab: ${esc(tab)}**`);
        p('');
        p('| Role | Action | Method | Endpoint | Status | Outcome | Verified | Expected |');
        p('| --- | --- | --- | --- | --- | --- | --- | --- |');
        const rows = g[tool][area][tab].sort((a, b) => sevRank(a.role) - sevRank(b.role) || String(a.role).localeCompare(String(b.role)));
        for (const a of rows) {
          p(`| ${esc(a.role)} | ${esc(a.action)} | ${esc(a.method)} | ${esc(a.endpoint)} | ${a.status ?? '—'} | ${esc(a.outcome)} | ${a.verified === null || a.verified === undefined ? '—' : a.verified} | ${esc(a.expected)} |`);
        }
        p('');
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — ISSUES
// ═══════════════════════════════════════════════════════════════════════════
p('---');
p('');
p('# Part B — Issues identified');
p('');
if (!findings.length) {
  p('_No defects recorded in this run._');
  p('');
} else {
  for (const t of tools) {
    const rows = findings.filter((f) => f.tool === t).sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    if (!rows.length) continue;
    p(`## ${TOOL_LABEL[t] || t}`);
    p('');
    let i = 0;
    for (const f of rows) {
      i++;
      p(`### ${t}-${i} · [${String(f.severity || 'info').toUpperCase()}] ${esc(f.scenario || f.page || 'Finding')}`);
      p('');
      if (f.role) p(`- **Role(s):** ${esc(f.role)}`);
      if (f.page) p(`- **Where:** ${esc(f.page)}`);
      if (f.expected) p(`- **Expected:** ${esc(f.expected)}`);
      if (f.actual) p(`- **Actual:** ${esc(f.actual)}`);
      if (f.proposedSolution) p(`- **Proposed fix:** ${esc(f.proposedSolution)}`);
      if (f.evidence) p(`- **Evidence:** \`${esc(String(f.evidence).slice(0, 500))}\``);
      if (f.at) p(`- _observed ${f.at}_`);
      p('');
    }
  }
}

const out = path.join(dir, '..', 'openissues.md');
fs.writeFileSync(out, L.join('\n'));
console.log(`Wrote ${out} — ${findings.length} findings, ${actions.length} actions.`);
