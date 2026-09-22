import { CODE_TITLES } from './findings.js';

export function toJson(state) {
  const { findings, summary, sources, settings } = state;
  return JSON.stringify({
    generated: new Date().toISOString(),
    sources,
    settings,
    summary,
    skipped: findings.skipped,
    findings: findings.grouped().map((g) => ({
      code: g.code,
      title: CODE_TITLES[g.code] || g.code,
      severity: g.severity,
      count: g.items.length,
      occurrences: g.items.map((i) => ({ message: i.message, context: i.context })),
    })),
  }, null, 2);
}

export function toMarkdown(state) {
  const { findings, summary, sources, settings } = state;
  const L = [];
  L.push('# TripModifications validation report');
  L.push('');
  L.push(`Generated ${new Date().toISOString()}`);
  L.push('');
  L.push('## Sources');
  L.push('');
  L.push('| Input | Source |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(sources)) L.push(`| ${k} | ${v || '_not loaded_'} |`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Entities in the TripModifications feed | ${summary.totalEntities} |`);
  for (const [k, v] of Object.entries(summary.entityCounts)) L.push(`| \`${k}\` entities | ${v} |`);
  L.push(`| Modifications | ${summary.modifications} |`);
  L.push(`| Distinct trips | ${summary.distinctTrips} |`);
  L.push(`| Service dates | ${summary.serviceDates.join(', ') || 'none'} |`);
  if (summary.alertEntities !== null) L.push(`| Alerts feed entities | ${summary.alertEntities} |`);
  if (summary.tripUpdateEntities !== null) L.push(`| TripUpdates feed entities | ${summary.tripUpdateEntities} |`);
  L.push(`| Errors | ${summary.errors} |`);
  L.push(`| Warnings | ${summary.warnings} |`);
  L.push(`| Information | ${summary.infos} |`);
  L.push('');

  if (findings.skipped.length) {
    L.push('## Checks that did not run');
    L.push('');
    for (const s of findings.skipped) L.push(`- ${s.what}: ${s.why}.`);
    L.push('');
  }

  const groups = findings.grouped();
  if (!groups.length) {
    L.push('No findings.');
    return L.join('\n') + '\n';
  }

  L.push('## Findings');
  L.push('');
  L.push('| Severity | Code | Finding | Count |');
  L.push('| --- | --- | --- | --- |');
  for (const g of groups) L.push(`| ${g.severity} | \`${g.code}\` | ${CODE_TITLES[g.code] || g.code} | ${g.items.length} |`);
  L.push('');

  for (const g of groups) {
    L.push(`### \`${g.code}\` — ${CODE_TITLES[g.code] || g.code}`);
    L.push('');
    L.push(`${g.severity}, ${g.items.length} occurrence${g.items.length === 1 ? '' : 's'}.`);
    L.push('');
    const shown = g.items.slice(0, 50);
    for (const i of shown) L.push(`- ${i.message}`);
    if (g.items.length > shown.length) L.push(`- _…and ${g.items.length - shown.length} more._`);
    L.push('');
  }

  L.push('## Thresholds used');
  L.push('');
  L.push('| Setting | Value |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(settings)) L.push(`| ${k} | ${v} |`);
  return L.join('\n') + '\n';
}

export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
