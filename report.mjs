// Reporter: fold every results/findings-*.json into one severity-ranked
// SUMMARY.md, grouped by tool, each finding carrying its expected/actual,
// evidence, and proposed solution. This is the deliverable the task asks for —
// "if anything is breaking, list the entire summary, propose a solution, and
// categorize by severity".
//
//   node report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { resultsDir } from './lib.mjs';
import { TOOLS } from './tools.config.mjs';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const sevRank = (s) => { const i = SEV_ORDER.indexOf(String(s || 'info').toLowerCase()); return i < 0 ? SEV_ORDER.length : i; };
const TOOL_LABEL = { ...Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, v.label])), concurrency: 'Multi-user / Concurrency' };

function loadFindings() {
  if (!fs.existsSync(resultsDir)) return [];
  const files = fs.readdirSync(resultsDir).filter((f) => /^findings-.*\.json$/.test(f));
  const all = [];
  for (const f of files) {
    const area = f.replace(/^findings-|\.json$/g, '');
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')); } catch { continue; }
    for (const r of rows) all.push({ tool: r.tool || area, ...r });
  }
  return all;
}

function esc(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }

const findings = loadFindings();
findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));

const byTool = {};
const bySev = Object.fromEntries(SEV_ORDER.map((s) => [s, 0]));
for (const f of findings) {
  (byTool[f.tool] ??= []).push(f);
  bySev[String(f.severity || 'info').toLowerCase()] = (bySev[String(f.severity || 'info').toLowerCase()] ?? 0) + 1;
}

const lines = [];
lines.push('# MSQ Platforms — E2E Validation Summary');
lines.push('');
lines.push(`_Generated ${new Date().toISOString()} · ${findings.length} finding(s) across ${Object.keys(byTool).length} tool area(s)._`);
lines.push('');
lines.push('## Severity totals');
lines.push('');
lines.push('| Severity | Count |');
lines.push('| --- | --- |');
for (const s of SEV_ORDER) if (bySev[s]) lines.push(`| ${s} | ${bySev[s]} |`);
lines.push('');

lines.push('## Findings by tool');
lines.push('');
lines.push('| Tool | critical | high | medium | low | info |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const tool of Object.keys(byTool)) {
  const c = Object.fromEntries(SEV_ORDER.map((s) => [s, byTool[tool].filter((f) => String(f.severity).toLowerCase() === s).length]));
  lines.push(`| ${TOOL_LABEL[tool] || tool} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${c.info} |`);
}
lines.push('');

for (const tool of Object.keys(byTool)) {
  lines.push(`## ${TOOL_LABEL[tool] || tool}`);
  lines.push('');
  const rows = byTool[tool].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  let i = 0;
  for (const f of rows) {
    i++;
    lines.push(`### ${i}. [${String(f.severity || 'info').toUpperCase()}] ${esc(f.scenario || f.page || 'Finding')}`);
    lines.push('');
    if (f.role) lines.push(`- **Role(s):** ${esc(f.role)}`);
    if (f.page) lines.push(`- **Where:** ${esc(f.page)}`);
    if (f.expected) lines.push(`- **Expected:** ${esc(f.expected)}`);
    if (f.actual) lines.push(`- **Actual:** ${esc(f.actual)}`);
    if (f.proposedSolution) lines.push(`- **Proposed fix:** ${esc(f.proposedSolution)}`);
    if (f.evidence) lines.push(`- **Evidence:** \`${esc(String(f.evidence).slice(0, 500))}\``);
    if (f.at) lines.push(`- _observed ${f.at}_`);
    lines.push('');
  }
}

const out = path.join(resultsDir, 'SUMMARY.md');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
// Machine-readable roll-up alongside the human summary.
fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), total: findings.length, bySeverity: bySev,
  byTool: Object.fromEntries(Object.entries(byTool).map(([k, v]) => [k, v.length])),
}, null, 2));

console.log(`Wrote ${out}`);
console.log(`Total findings: ${findings.length} — ` + SEV_ORDER.filter((s) => bySev[s]).map((s) => `${s}:${bySev[s]}`).join(' '));
