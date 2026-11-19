/**
 * Exports rendered from an immutable report snapshot (never a recalculation). Each export carries
 * the report ID, scope, data source, dataset versions, definitions, coverage, and limitations.
 * Unavailable values are written as "Unavailable" with their reason, never as zero.
 */
import type { MetricChange, MetricValue } from '../../../shared/contracts/reports';
import { fmtChange, fmtMetric, reasonText } from '../../../shared/format';

type Snapshot = Record<string, any> & { meta: Record<string, any>; kind: string };

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** CSV cell with formula-injection protection for text (numbers are written as numbers). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  if (!NUMERIC.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: unknown[]) => cells.map(csvCell).join(',');

function metaRows(s: Snapshot): [string, unknown][] {
  const m = s.meta;
  const src = s.source ?? {};
  return [
    ['Report type', s.kind === 'overview' ? 'Account overview (measured results)' : s.kind === 'campaign' ? 'Campaign report (measured results)' : 'Campaign comparison (measured results)'],
    ['Data mode', m.dataMode === 'demo' ? 'DEMO — NOT CUSTOMER DATA' : m.dataMode],
    ['Account', m.accountName],
    ['Report ID', m.reportId],
    ['Generated at', m.generatedAt],
    ['Data revision', m.dataRevision],
    ['Result hash', m.resultHash],
    ['Metric definitions', m.definitionVersion],
    ['Period', s.period?.label ?? 'Not applicable'],
    ['Comparison', s.comparison?.label ?? 'None'],
    ['Timezone', m.timezone],
    ['Currency', m.currency],
    ['Time basis', m.timeBasis],
    ['Coverage status', m.coverageStatus],
    ['Source as of', m.sourceAsOf ?? 'Not stated'],
    ['Complete through', m.completeThrough ?? 'Unknown'],
    ['Data source', `${src.datasetName} (version ${src.version}, ${src.sourceType})`],
    ['Dataset version IDs', (m.datasetVersionIds ?? []).join(' ')],
    ['Source file', src.importFileName ? `${src.importFileName} (sha256 ${src.importSha256})` : 'n/a'],
    ['Channels', (s.channelFilter ?? []).length ? s.channelFilter.join(' ') : 'All'],
    ['AI generation', 'Not used: all values are deterministic'],
    ['Warnings', (m.warnings ?? []).join(' | ') || 'None'],
  ];
}

function metricRow(v: MetricValue | null, c?: MetricChange) {
  return [
    v?.metricId,
    v?.label,
    v?.value ?? 'Unavailable',
    v?.unit,
    v?.currency ?? '',
    v?.availability,
    v?.origin ?? '',
    v?.value === null ? reasonText(v?.reason) : '',
    c?.previous?.value ?? (c?.previous ? 'Unavailable' : ''),
    c?.absoluteChange ?? '',
    c?.absoluteChangeUnit ?? '',
    c?.relativeChangePct ?? '',
    c?.note ?? '',
    (v?.warnings ?? []).join(' | '),
    (v?.evidenceIds ?? []).join(' '),
  ];
}

const METRIC_HEADER = ['metric_id', 'label', 'value', 'unit', 'currency', 'availability', 'origin', 'unavailable_reason', 'comparison_value', 'absolute_change', 'change_unit', 'relative_change_pct', 'note', 'warnings', 'evidence_ids'];

export function toCsv(s: Snapshot): string {
  const out: string[] = [row(['section', 'key', 'value'])];
  for (const [k, v] of metaRows(s)) out.push(row(['metadata', k, v]));
  out.push('');
  const changes: MetricChange[] = s.kind === 'campaign' ? s.metrics : s.kind === 'overview' ? [...s.totals, ...(s.sourceRates ?? [])] : [];
  if (changes.length) {
    out.push(row(['metrics']), row(METRIC_HEADER));
    for (const c of changes) out.push(row(metricRow(c.current, c)));
    out.push('');
  }
  const campaigns = s.campaigns ?? [];
  if (Array.isArray(campaigns) && campaigns.length) {
    const keys = ['delivered', 'unique_open_rate', 'total_open_rate', 'unique_click_rate', 'total_click_rate', 'conversion_event_rate', 'unsubscribe_rate', 'revenue'];
    out.push(row(['campaigns']), row(['campaign_id', 'external_id', 'name', 'channel', 'launches', ...keys]));
    for (const c of campaigns) out.push(row([c.campaignId, c.externalId, c.name, c.channel, c.launchCount, ...keys.map((k) => c.metrics[k]?.value ?? 'Unavailable')]));
    out.push('');
  }
  if (s.kind === 'campaign' && s.benchmarkComparison?.length) {
    out.push(row(['benchmark', s.benchmark?.label ?? '']), row(METRIC_HEADER));
    for (const c of s.benchmarkComparison as MetricChange[]) out.push(row(metricRow(c.current, c)));
    out.push('');
  }
  out.push(row(['findings']), row(['id', 'kind', 'severity', 'text', 'evidence_ids', 'rule_version']));
  for (const f of s.findings ?? []) out.push(row([f.id, f.kind, f.severity, f.text, f.evidenceIds.join(' '), f.ruleVersion]));
  out.push('', row(['capabilities']), row(['key', 'status', 'reason']));
  for (const c of s.capabilities ?? []) out.push(row([c.key, c.status, c.reason ?? '']));
  return '﻿' + out.join('\r\n') + '\r\n';
}

export function toMarkdown(s: Snapshot): string {
  const lines: string[] = [];
  const m = s.meta;
  if (m.dataMode === 'demo') lines.push('> **DEMO — NOT CUSTOMER DATA**', '');
  lines.push(`# ${s.kind === 'overview' ? 'Account overview' : s.kind === 'campaign' ? `Campaign report: ${s.campaign?.name}` : 'Campaign comparison'} — ${m.accountName}`, '');
  lines.push('_Measured results. All values are computed deterministically from the data source below; no AI-generated numbers._', '');
  lines.push('| Field | Value |', '|---|---|');
  for (const [k, v] of metaRows(s)) lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);
  const changes: MetricChange[] = s.kind === 'campaign' ? s.metrics : s.kind === 'overview' ? [...s.totals, ...(s.sourceRates ?? [])] : [];
  if (changes.length) {
    lines.push('', '## Metrics', '', '| Metric | Value | Comparison | Change | Notes |', '|---|---|---|---|---|');
    for (const c of changes) {
      const note = c.current.value === null ? `Unavailable: ${reasonText(c.current.reason)}` : c.current.warnings.join('; ');
      lines.push(`| ${c.label} | ${fmtMetric(c.current)} | ${c.previous ? fmtMetric(c.previous) : '—'} | ${c.absoluteChange !== null ? fmtChange(c) : c.note ?? '—'} | ${note.replace(/\|/g, '\\|')} |`);
    }
  }
  if (Array.isArray(s.campaigns) && s.campaigns.length) {
    lines.push('', '## Campaigns', '', '| Campaign | Channel | Delivered | Unique open rate | Unique click rate | Revenue |', '|---|---|---|---|---|---|');
    for (const c of s.campaigns.slice(0, 200)) {
      lines.push(`| ${String(c.name).replace(/\|/g, '\\|')} | ${c.channel} | ${fmtMetric(c.metrics.delivered)} | ${fmtMetric(c.metrics.unique_open_rate)} | ${fmtMetric(c.metrics.unique_click_rate)} | ${fmtMetric(c.metrics.revenue)} |`);
    }
  }
  lines.push('', '## Findings', '');
  for (const f of s.findings ?? []) lines.push(`- **${f.kind === 'limitation' ? 'Limitation' : 'Observation'}:** ${f.text} _(evidence: ${f.evidenceIds.join(', ') || 'none'})_`);
  lines.push('', '## What this data cannot show', '');
  for (const c of (s.capabilities ?? []).filter((c: { status: string }) => c.status === 'unavailable')) lines.push(`- ${c.label}: ${c.reason}`);
  return lines.join('\n') + '\n';
}
