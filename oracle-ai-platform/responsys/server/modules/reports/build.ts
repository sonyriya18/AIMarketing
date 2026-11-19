/**
 * Deterministic report builders. Every number comes from the fact tables through the metric
 * registry; every finding cites evidence items; nothing is invented when data is missing.
 */
import type { Tx } from '../../db/pool';
import { AppError, notFound } from '../../http/errors';
import type {
  Capability,
  CampaignReportRequest,
  CampaignReportResult,
  CampaignRow,
  ComparisonRequest,
  ComparisonResult,
  CoverageStatus,
  DataSourceInfo,
  EvidenceItem,
  Finding,
  MetricChange,
  MetricValue,
  OverviewRequest,
  OverviewResult,
  ReportMeta,
  TrendPoint,
  WindowSummary,
} from '../../../shared/contracts/reports';
import {
  addAggregates,
  compareMetric,
  computeAll,
  dstr,
  Dec,
  emptyAggregates,
  rateMetric,
  type Aggregates,
  type ComputeContext,
} from '../../../shared/metrics/compute';
import {
  BASE_DEFS,
  DEFINITION_VERSION,
  RATE_DEFS,
  SOURCE_RATE_HIGHER_IS_BETTER,
  SOURCE_RATE_LABEL,
  type BaseMeasure,
  type SourceRateId,
} from '../../../shared/metrics/registry';
import { fmtChange, fmtMetric, fmtNumber } from '../../../shared/format';
import type { Clock } from '../../../shared/time/clock';
import { resolveComparison, resolvePeriod, type ResolvedPeriod } from '../../../shared/time/periods';
import { addDays, diffDays } from '../../../shared/time/zoned';
import { aggregateFacts, campaignMeta, loadQuality, windowFacts, type AccountInfo, type AggRow, type CampaignMeta, type WindowFactRow } from './data';

export const FINDINGS_RULE_VERSION = 'findings-2026-10-15.1';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const KEY_METRICS = [
  'sent',
  'delivered',
  'delivered_rate',
  'bounce_rate',
  'unique_open_rate',
  'total_open_rate',
  'unique_click_rate',
  'total_click_rate',
  'unique_click_to_open_rate',
  'conversion_event_rate',
  'unsubscribe_rate',
  'revenue',
  'revenue_per_delivered',
  'revenue_per_1000_delivered',
  'average_order_value',
];

const ALL_METRICS = [...Object.keys(BASE_DEFS), ...Object.keys(RATE_DEFS)];
const TREND_METRICS = ['sent', 'delivered', 'revenue', 'unique_open_rate', 'total_open_rate', 'unique_click_rate', 'total_click_rate', 'conversion_event_rate', 'unsubscribe_rate'];

export interface BuildCtx {
  tx: Tx;
  account: AccountInfo;
  source: DataSourceInfo;
  clock: Clock;
  reportId: string;
  dataMode: string;
}

function meta(ctx: BuildCtx, kind: ReportMeta['kind'], coverage: CoverageStatus, warnings: string[], completeThrough: string | null): ReportMeta {
  return {
    reportId: ctx.reportId,
    kind,
    accountId: ctx.account.id,
    accountName: ctx.account.name,
    generatedAt: ctx.clock.now().toISOString(),
    dataRevision: ctx.account.dataRevision,
    datasetVersionIds: [ctx.source.datasetVersionId],
    definitionVersion: DEFINITION_VERSION,
    sourceAsOf: ctx.source.sourceAsOf,
    completeThrough,
    coverageStatus: coverage,
    timeBasis: ctx.source.timeBasis,
    timezone: ctx.source.timezone,
    currency: ctx.source.currency,
    aiStatus: 'not_requested',
    warnings: [...new Set(warnings)],
    dataMode: ctx.dataMode,
    resultHash: '',
  };
}

function coverageOf(source: DataSourceInfo, start: string, endExclusive: string): { status: CoverageStatus; warning: string | null } {
  const cs = source.coverageStart;
  const ce = source.coverageEndExclusive;
  if (!cs || !ce) return { status: 'complete', warning: null };
  if (start >= cs && endExclusive <= ce) return { status: 'complete', warning: null };
  const overlapStart = start > cs ? start : cs;
  const overlapEnd = endExclusive < ce ? endExclusive : ce;
  if (overlapStart < overlapEnd) {
    return {
      status: 'partial',
      warning: `The data covers ${cs} – ${addDays(ce, -1)}; this period (${start} – ${addDays(endExclusive, -1)}) is only partly covered (${diffDays(overlapStart, overlapEnd)} of ${diffDays(start, endExclusive)} days), so totals may be incomplete.`,
    };
  }
  return { status: 'outside_coverage', warning: `The data covers ${cs} – ${addDays(ce, -1)}; this period has no coverage.` };
}

function withWarning(values: Record<string, MetricValue>, warning: string | null) {
  if (!warning) return values;
  for (const v of Object.values(values)) if (!v.warnings.includes(warning)) v.warnings.push(warning);
  return values;
}

function evidenceFor(values: Record<string, MetricValue>, scope: string, source: DataSourceInfo, rows: number, sourceRows: number[], kind: EvidenceItem['kind'] = 'metric'): EvidenceItem[] {
  return Object.values(values).map((v) => ({
    id: v.evidenceIds[0]!,
    kind,
    label: `${v.label} — ${scope}`,
    value: v.value,
    unit: v.unit,
    currency: v.currency,
    formula: v.metricId in RATE_DEFS ? RATE_DEFS[v.metricId as keyof typeof RATE_DEFS].formula : v.origin === 'derived' && v.warnings.length ? v.warnings[0]! : `sum of ${v.label.toLowerCase()} over matching rows`,
    inputs:
      v.numeratorMetricId && v.denominatorMetricId
        ? [
            { metricId: v.numeratorMetricId, value: values[v.numeratorMetricId]?.value ?? null },
            { metricId: v.denominatorMetricId, value: values[v.denominatorMetricId]?.value ?? null },
          ]
        : [],
    scope,
    source: { datasetVersionIds: [source.datasetVersionId], rowCount: rows, sourceRows: sourceRows.slice(0, 50) },
  }));
}

function pick(values: Record<string, MetricValue>, ids: string[]) {
  return ids.filter((id) => values[id]).map((id) => values[id]!);
}

/** Launch counts and dates describe the selected period; the dataset-wide history is kept separately. */
function campaignRow(meta: CampaignMeta, values: Record<string, MetricValue>, agg: AggRow | undefined): CampaignRow {
  return {
    ...meta,
    launchCount: agg?.launches ?? 0,
    firstLaunchDate: agg?.firstLaunch ?? null,
    lastLaunchDate: agg?.lastLaunch ?? null,
    datasetLaunchCount: meta.launchCount,
    datasetFirstLaunchDate: meta.firstLaunchDate,
    datasetLastLaunchDate: meta.lastLaunchDate,
    metrics: values,
  };
}

function trendFrom(rows: AggRow[], ctx: ComputeContext): TrendPoint[] {
  return rows.map((r) => {
    const v = computeAll(r.aggs, { ...ctx, evidencePrefix: `ev:day:${r.key}` });
    return { date: r.key!, values: Object.fromEntries(TREND_METRICS.map((k) => [k, v[k]?.value ?? null])) };
  });
}

function changeFindings(changes: MetricChange[], scopeText: string): Finding[] {
  const ids = ['delivered_rate', 'unique_open_rate', 'total_open_rate', 'unique_click_rate', 'total_click_rate', 'conversion_event_rate', 'unsubscribe_rate', 'bounce_rate', 'revenue'];
  return changes
    .filter((c) => ids.includes(c.metricId) || c.metricId.startsWith('reported_'))
    .filter((c) => c.absoluteChange !== null && c.direction !== 'flat' && c.previous)
    .sort((a, b) => Math.abs(Number(b.relativeChangePct ?? 0)) - Math.abs(Number(a.relativeChangePct ?? 0)))
    .slice(0, 6)
    .map((c) => ({
      id: `f:change:${c.metricId}`,
      kind: 'observation' as const,
      severity: c.interpretation === 'better' ? ('positive' as const) : c.interpretation === 'worse' ? ('attention' as const) : ('info' as const),
      text: `${c.label} was ${fmtMetric(c.current)} compared with ${fmtMetric(c.previous)} ${scopeText} (${fmtChange(c)}).`,
      evidenceIds: [...c.current.evidenceIds, ...(c.previous?.evidenceIds ?? [])],
      strength: 'descriptive' as const,
      ruleVersion: FINDINGS_RULE_VERSION,
    }));
}

function limitationFindings(values: Record<string, MetricValue>, extra: string[]): Finding[] {
  const missing = Object.values(values).filter((v) => v.reason === 'missing_field' && ['unique_opens', 'total_opens', 'unique_clicks', 'total_clicks', 'conversion_events', 'revenue', 'bounces', 'orders'].includes(v.metricId));
  const out: Finding[] = [];
  if (missing.length) {
    out.push({
      id: 'f:limit:missing_fields',
      kind: 'limitation',
      severity: 'info',
      text: `Not in this data source: ${missing.map((m) => m.label.toLowerCase()).join(', ')}. Metrics that depend on them are shown as unavailable, not zero.`,
      evidenceIds: missing.flatMap((m) => m.evidenceIds),
      strength: 'descriptive',
      ruleVersion: FINDINGS_RULE_VERSION,
    });
  }
  extra.forEach((t, i) => out.push({ id: `f:limit:${i}`, kind: 'limitation', severity: 'attention', text: t, evidenceIds: [], strength: 'descriptive', ruleVersion: FINDINGS_RULE_VERSION }));
  return out;
}

function outlierFindings(account: Record<string, MetricValue>, rows: CampaignRow[], evidence: EvidenceItem[], source: DataSourceInfo): Finding[] {
  const rate = ['unique_click_rate', 'total_click_rate', 'unique_open_rate', 'total_open_rate'].find((k) => account[k]?.value !== null && account[k]?.value !== undefined);
  if (!rate || !account.delivered?.value) return [];
  const acct = account[rate]!;
  const minDelivered = Dec.max(500, new Dec(account.delivered.value).mul('0.01'));
  const candidates = rows
    .filter((r) => r.metrics.delivered?.value && new Dec(r.metrics.delivered.value).gte(minDelivered) && r.metrics[rate]?.value)
    .map((r) => ({ r, rel: new Dec(r.metrics[rate]!.value!).minus(acct.value!).div(new Dec(acct.value!).isZero() ? 1 : acct.value!) }))
    .filter((x) => x.rel.abs().gte('0.3'));
  const low = candidates.filter((x) => x.rel.isNeg()).sort((a, b) => a.rel.cmp(b.rel)).slice(0, 3);
  const high = candidates.filter((x) => x.rel.isPos()).sort((a, b) => b.rel.cmp(a.rel)).slice(0, 3);
  return [...high, ...low].map(({ r, rel }) => {
    const v = r.metrics[rate]!;
    const evId = `ev:campaign:${r.campaignId}:${rate}`;
    const delId = `ev:campaign:${r.campaignId}:delivered`;
    evidence.push(
      { id: evId, kind: 'campaign_metric', label: `${v.label} — ${r.name}`, value: v.value, unit: v.unit, currency: null, formula: RATE_DEFS[rate as keyof typeof RATE_DEFS].formula, inputs: [], scope: `campaign ${r.externalId}`, source: { datasetVersionIds: [source.datasetVersionId], rowCount: r.launchCount } },
      { id: delId, kind: 'campaign_metric', label: `Delivered — ${r.name}`, value: r.metrics.delivered!.value, unit: 'count', currency: null, formula: 'sum of delivered', inputs: [], scope: `campaign ${r.externalId}`, source: { datasetVersionIds: [source.datasetVersionId], rowCount: r.launchCount } }
    );
    return {
      id: `f:outlier:${r.campaignId}`,
      kind: 'observation' as const,
      severity: rel.isNeg() ? ('attention' as const) : ('positive' as const),
      text: `"${r.name}" had a ${v.label.toLowerCase()} of ${fmtMetric(v)} on ${fmtNumber(r.metrics.delivered!.value!)} delivered, versus ${fmtMetric(acct)} across all campaigns in this period. This is an observed difference, not a measured cause.`,
      evidenceIds: [evId, delId, ...acct.evidenceIds],
      strength: 'descriptive' as const,
      ruleVersion: FINDINGS_RULE_VERSION,
    };
  });
}

function defaultPeriod(source: DataSourceInfo) {
  if (!source.coverageStart || !source.coverageEndExclusive) throw new AppError('unprocessable', 'This data source has no declared coverage; choose a period');
  return { preset: 'custom' as const, startDate: source.coverageStart, endDate: addDays(source.coverageEndExclusive, -1) };
}

// ================================================================ overview (campaign grain)
export async function buildOverview(ctx: BuildCtx, req: OverviewRequest): Promise<OverviewResult> {
  if (ctx.source.grain === 'account_window') return buildWindowOverview(ctx, req);
  const { tx, source } = ctx;
  const tz = source.timezone;
  const period = resolvePeriod(req.period ?? defaultPeriod(source), tz, ctx.clock);
  const cmp = resolveComparison(period, req.comparison);
  const dateColumn = source.timeBasis === 'event_time' ? 'fact_date' : 'launch_date';
  const base = { versionId: source.datasetVersionId, dateColumn, channels: req.channels } as const;
  const cov = coverageOf(source, period.startDate, period.endDateExclusive);
  const ctxC: ComputeContext = { currency: source.currency, launchUniqueSummable: source.grain !== 'campaign_day', coverageComplete: cov.status !== 'outside_coverage', evidencePrefix: 'ev:current' };

  const [cur] = await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'none');
  const curM = withWarning(computeAll(cur!.aggs, ctxC), cov.warning);
  const warnings: string[] = [];
  if (cov.warning) warnings.push(cov.warning);
  if (period.partial) warnings.push('The period includes today, so recent results are still maturing.');

  let prevM: Record<string, MetricValue> | null = null;
  let prevRows: AggRow | null = null;
  if (cmp) {
    const pc = coverageOf(source, cmp.startDate, cmp.endDateExclusive);
    const [p] = await aggregateFacts(tx, { ...base, start: cmp.startDate, endExclusive: cmp.endDateExclusive }, 'none');
    prevRows = p!;
    prevM = withWarning(computeAll(p!.aggs, { ...ctxC, coverageComplete: pc.status !== 'outside_coverage', evidencePrefix: 'ev:previous' }), pc.warning);
    if (pc.status === 'outside_coverage') warnings.push('The comparison period is outside the data coverage, so no trend is claimed.');
    else if (pc.warning) warnings.push(`Comparison: ${pc.warning}`);
  }
  const totals = ALL_METRICS.map((k) => compareMetric(curM[k]!, prevM ? prevM[k]! : null));

  const byChannelRows = await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'channel');
  const byChannel = byChannelRows.map((r) => ({ channel: r.key!, metrics: pick(computeAll(r.aggs, { ...ctxC, evidencePrefix: `ev:channel:${r.key}` }), KEY_METRICS) }));

  const byProgram = (await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'program')).map((r) => ({
    program: r.key ?? '',
    campaigns: r.campaigns,
    launches: r.launches,
    metrics: pick(computeAll(r.aggs, { ...ctxC, evidencePrefix: `ev:program:${r.key}` }), KEY_METRICS),
  }));
  const byWeekday = (await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'weekday')).map((r) => ({
    weekday: Number(r.key),
    label: WEEKDAYS[Number(r.key) - 1] ?? String(r.key),
    launches: r.launches,
    metrics: pick(computeAll(r.aggs, { ...ctxC, evidencePrefix: `ev:weekday:${r.key}` }), KEY_METRICS),
  }));
  const sendTime: NonNullable<OverviewResult['sendTime']> = [];
  for (const group of ['send_hour', 'send_weekday'] as const) {
    for (const row of await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, group)) {
      const [channel, weekday, hour] = JSON.parse(row.key!) as [string, number, number | null];
      sendTime.push({ channel, weekday, hour, launches: row.launches, metrics: pick(computeAll(row.aggs, { ...ctxC, evidencePrefix: `ev:${group}:${row.key}` }), KEY_METRICS) });
    }
  }

  const dimension = async (by: 'subject' | 'creative' | 'offer') =>
    (await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, by)).map((r) => ({
      value: r.key ?? '',
      campaigns: r.campaigns,
      launches: r.launches,
      metrics: pick(computeAll(r.aggs, { ...ctxC, evidencePrefix: `ev:${by}:${r.key}` }), KEY_METRICS),
    }));
  const bySubjectLine = await dimension('subject');
  const byCreativeType = await dimension('creative');
  const byOffer = await dimension('offer');

  const campRows = await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'campaign');
  const metas = await campaignMeta(tx, source.datasetVersionId, campRows.map((r) => r.key!));
  const campaigns = campRows
    .map((r) => campaignRow(metas.get(r.key!)!, computeAll(r.aggs, { ...ctxC, evidencePrefix: `ev:campaign:${r.key}` }), r))
    .filter((r) => r.campaignId)
    .sort((a, b) => Number(b.metrics.delivered?.value ?? -1) - Number(a.metrics.delivered?.value ?? -1));

  const trend = trendFrom(await aggregateFacts(tx, { ...base, start: period.startDate, endExclusive: period.endDateExclusive }, 'date'), ctxC);

  const evidence = [
    ...evidenceFor(curM, `current period ${period.startDate} – ${period.endDateInclusive}`, source, cur!.rows, cur!.sourceRows),
    ...(prevM && cmp ? evidenceFor(prevM, `comparison period ${cmp.startDate} – ${cmp.endDateInclusive}`, source, prevRows!.rows, prevRows!.sourceRows) : []),
  ];
  const quality = await loadQuality(tx, source.datasetVersionId);
  const findings = [
    ...changeFindings(totals, 'in the comparison period'),
    ...outlierFindings(curM, campaigns, evidence, source),
    ...limitationFindings(curM, [...(cov.warning ? [cov.warning] : []), ...quality.conflicts]),
  ];

  const capabilities: Capability[] = [
    { key: 'campaign_detail', label: 'Campaign detail', status: 'available', reason: null },
    { key: 'campaign_comparison', label: 'Campaign comparison', status: 'available', reason: null },
    { key: 'trend', label: `Daily trend (${source.timeBasis === 'event_time' ? 'activity date' : 'launch date'})`, status: 'available', reason: null },
    { key: 'previous_period', label: 'Comparison period', status: cmp && prevM && prevM.sent?.reason !== 'missing_history' ? 'available' : 'unavailable', reason: cmp ? (prevM?.sent?.reason === 'missing_history' ? 'Outside data coverage' : null) : 'Comparison turned off' },
    { key: 'hourly', label: 'Hourly send-time analysis', status: sendTime.some((r) => r.hour !== null) ? 'available' : 'unavailable', reason: sendTime.some((r) => r.hour !== null) ? null : 'Import Launch Time (HH:mm) to compare launch hours' },
    { key: 'segments', label: 'Audience segments', status: 'unavailable', reason: 'No segment membership data is connected' },
    { key: 'recipients', label: 'Recipient-level behaviour', status: 'unavailable', reason: 'Only aggregate campaign rows are imported' },
    { key: 'links', label: 'Link placement', status: 'unavailable', reason: 'No link-level data is imported' },
    { key: 'domains', label: 'Mailbox domains', status: 'unavailable', reason: 'No domain-level data is imported' },
  ];

  return {
    meta: meta(ctx, 'overview', cur!.rows === 0 && cov.status === 'complete' ? 'no_data' : cov.status, [...warnings, ...quality.warnings.slice(0, 5)], source.coverageEndExclusive ? addDays(source.coverageEndExclusive, -1) : null),
    source,
    period,
    comparison: cmp,
    channelFilter: req.channels,
    totals,
    sourceRates: [],
    byChannel,
    byProgram,
    byWeekday,
    sendTime,
    bySubjectLine,
    byCreativeType,
    byOffer,
    campaigns,
    trend,
    windows: [],
    capabilities,
    findings,
    evidence,
    counts: { campaigns: cur!.campaigns, launches: cur!.launches, rows: cur!.rows },
  };
}

// ================================================================ overview (legacy windows)
const MONTHS: Record<string, number> = { last_3_months: 3, last_6_months: 6, last_12_months: 12, last_2_years: 24 };

function windowAggs(rows: WindowFactRow[], conversionsAreEvents: boolean): Aggregates {
  const aggs = emptyAggregates();
  const sum = (field: keyof WindowFactRow, measure: BaseMeasure) => {
    const present = rows.map((r) => r[field] as string | null).filter((v): v is string => v !== null);
    aggs[measure] = { sum: present.length ? dstr(present.reduce((s, v) => s.plus(v), new Dec(0)), 4) : null, rowsWithValue: present.length, rowsTotal: rows.length };
  };
  sum('sent', 'sent');
  sum('delivered', 'delivered');
  sum('skipped', 'skipped');
  sum('revenue', 'revenue');
  if (conversionsAreEvents) sum('conversions', 'conversion_events');
  for (const k of Object.keys(aggs) as BaseMeasure[]) if (aggs[k].rowsTotal === 0) aggs[k].rowsTotal = rows.length;
  return aggs;
}

const LEGACY_METRICS = ['sent', 'delivered', 'skipped', 'delivered_rate', 'revenue', 'revenue_per_delivered', 'revenue_per_1000_delivered', 'conversion_events', 'conversion_event_rate'];

function sourceRateValues(row: WindowFactRow, semantics: Record<string, string>, prefix: string): MetricValue[] {
  const openId: SourceRateId = semantics.open_rate === 'unique' ? 'reported_unique_open_rate' : semantics.open_rate === 'total' ? 'reported_total_open_rate' : 'reported_open_rate';
  const clickId: SourceRateId = semantics.click_rate === 'unique' ? 'reported_unique_click_rate' : semantics.click_rate === 'total' ? 'reported_total_click_rate' : 'reported_click_rate';
  const pairs: [SourceRateId, string | null][] = [
    ['reported_bounce_rate', row.bounce_rate],
    ['reported_soft_bounce_rate', row.soft_bounce_rate],
    ['reported_hard_bounce_rate', row.hard_bounce_rate],
    [openId, row.open_rate],
    [clickId, row.click_rate],
    ['reported_unsubscribe_rate', row.unsubscribe_rate],
  ];
  return pairs.map(([id, value]) => ({
    metricId: id,
    label: SOURCE_RATE_LABEL[id],
    value: value === null ? null : dstr(value),
    unit: 'percent',
    currency: null,
    availability: value === null ? 'missing' : 'available',
    origin: value === null ? null : 'observed',
    definitionVersion: DEFINITION_VERSION,
    numeratorMetricId: null,
    denominatorMetricId: null,
    evidenceIds: [`${prefix}:${id}`],
    warnings: value === null ? ['Not in the source file'] : ['Rate as reported by the source; its numerator is not in the file'],
    reason: value === null ? 'missing_field' : null,
    higherIsBetter: SOURCE_RATE_HIGHER_IS_BETTER[id],
  }));
}

async function buildWindowOverview(ctx: BuildCtx, req: OverviewRequest): Promise<OverviewResult> {
  const { tx, source } = ctx;
  const all = await windowFacts(tx, source.datasetVersionId);
  const quality = await loadQuality(tx, source.datasetVersionId);
  const conversionsAreEvents = quality.semantics.conversions === 'events';
  const windowMap = new Map<string, WindowSummary & { days: number }>();
  for (const r of all) {
    const w = windowMap.get(r.window_key) ?? { windowKey: r.window_key, windowLabel: r.window_label, windowStart: r.window_start, windowEndExclusive: r.window_end_exclusive, channels: [], days: r.window_days };
    w.channels.push(r.channel);
    windowMap.set(r.window_key, w);
  }
  const windows = [...windowMap.values()].sort((a, b) => a.days - b.days);
  if (!windows.length) throw new AppError('unprocessable', 'This data source has no rows');
  const key = req.windowKey ?? windows.find((w) => w.windowKey === 'last_30_days')?.windowKey ?? windows[0]!.windowKey;
  const w = windowMap.get(key);
  if (!w) throw new AppError('unprocessable', `The uploaded export has no "${key}" window. Available: ${windows.map((x) => x.windowLabel).join(', ')}`);
  const inChannel = (r: WindowFactRow) => !req.channels.length || req.channels.includes(r.channel);
  const sel = all.filter((r) => r.window_key === key && inChannel(r));
  if (!sel.length) throw new AppError('unprocessable', 'No rows match the selected channels in this window');

  const ctxC: ComputeContext = { currency: source.currency, launchUniqueSummable: true, coverageComplete: true, evidencePrefix: 'ev:current' };
  const curAll = computeAll(windowAggs(sel, conversionsAreEvents), ctxC);
  const curM = Object.fromEntries(LEGACY_METRICS.map((k) => [k, curAll[k]!]));
  const warnings: string[] = ['Summary export: account-period totals for declared windows only.'];

  // Comparison: the preceding equal window derived as (2N window − N window) from the same export.
  let prevM: Record<string, MetricValue> | null = null;
  let derivation: string | null = null;
  let comparison: (ResolvedPeriod & { derivation?: string }) | null = null;
  const conflicts: string[] = [];
  if (req.comparison !== 'none') {
    const longer = windows.find(
      (x) => x.windowEndExclusive === w.windowEndExclusive && x.windowKey !== w.windowKey && (x.days === 2 * w.days || (MONTHS[x.windowKey] && MONTHS[w.windowKey] && MONTHS[x.windowKey] === 2 * MONTHS[w.windowKey]!))
    );
    if (longer) {
      const lrows = all.filter((r) => r.window_key === longer.windowKey && inChannel(r));
      const channelsMatch = lrows.length === sel.length && sel.every((s) => lrows.some((l) => l.channel === s.channel));
      if (channelsMatch) {
        derivation = `"${longer.windowLabel}" minus "${w.windowLabel}" from the same export`;
        const L = windowAggs(lrows, conversionsAreEvents);
        const S = windowAggs(sel, conversionsAreEvents);
        const P = emptyAggregates();
        for (const k of Object.keys(P) as BaseMeasure[]) {
          const a = L[k];
          const b = S[k];
          if (a.sum !== null && b.sum !== null && a.rowsWithValue === a.rowsTotal && b.rowsWithValue === b.rowsTotal) {
            P[k] = { sum: dstr(new Dec(a.sum).minus(b.sum), 4), rowsWithValue: a.rowsTotal, rowsTotal: a.rowsTotal };
          } else P[k] = { sum: null, rowsWithValue: 0, rowsTotal: Math.max(a.rowsTotal, 1) };
        }
        const prevAll = computeAll(P, { ...ctxC, evidencePrefix: 'ev:previous' });
        prevM = {};
        for (const k of LEGACY_METRICS) {
          const v = { ...prevAll[k]!, warnings: [...prevAll[k]!.warnings] };
          if (k in BASE_DEFS && v.value !== null) {
            v.origin = 'derived';
            v.warnings.unshift(`Derived as ${derivation}`);
            if (new Dec(v.value).isNeg()) {
              conflicts.push(`${v.label}: ${derivation} is negative (${v.value}); the export's windows are inconsistent, so no comparison is shown.`);
              v.availability = 'conflicted';
              v.value = null;
              v.reason = null;
            }
          }
          prevM[k] = v;
        }
        // Rates depend on the corrected base values.
        for (const k of LEGACY_METRICS.filter((x) => x in RATE_DEFS)) {
          const def = RATE_DEFS[k as keyof typeof RATE_DEFS];
          prevM[k] = rateMetric(def.id, prevM[def.numerator] ?? prevAll[def.numerator]!, prevM[def.denominator] ?? prevAll[def.denominator]!, { ...ctxC, evidencePrefix: 'ev:previous' });
        }
        const start = longer.windowStart;
        comparison = {
          preset: 'custom',
          label: `Preceding ${w.windowLabel.replace(/^last\s*/i, '')} (${start} – ${addDays(w.windowStart, -1)}), derived`,
          timezone: source.timezone,
          startDate: start,
          endDateExclusive: w.windowStart,
          endDateInclusive: addDays(w.windowStart, -1),
          startInclusive: start,
          endExclusive: w.windowStart,
          days: diffDays(start, w.windowStart),
          partial: false,
          calendarUnit: 'day',
          derivation,
        };
      } else warnings.push('The comparison window does not have the same channels, so no comparison is shown.');
    } else {
      warnings.push(`The export has no window twice as long as "${w.windowLabel}" ending on the same date, so no previous period can be derived.`);
    }
  }
  const totals = LEGACY_METRICS.map((k) => compareMetric(curM[k]!, prevM ? prevM[k]! : null));

  const channels = [...new Set(sel.map((r) => r.channel))];
  let sourceRates: MetricChange[] = [];
  if (channels.length === 1) {
    sourceRates = sourceRateValues(sel[0]!, quality.semantics, 'ev:current').map((v) => {
      const c = compareMetric(v, null);
      c.note = prevM ? 'Reported rates cannot be compared: the export has no numerators to difference' : 'No comparison period';
      return c;
    });
  } else {
    warnings.push('Reported rates are shown per channel; they cannot be combined across channels without their numerators.');
  }
  const byChannel = channels.map((ch) => {
    const rows = sel.filter((r) => r.channel === ch);
    const m = computeAll(windowAggs(rows, conversionsAreEvents), { ...ctxC, evidencePrefix: `ev:channel:${ch}` });
    return { channel: ch, metrics: [...LEGACY_METRICS.map((k) => m[k]!), ...sourceRateValues(rows[0]!, quality.semantics, `ev:channel:${ch}`)] };
  });

  const period: ResolvedPeriod & { windowKey: string } = {
    preset: 'custom',
    label: `${w.windowLabel} (${w.windowStart} – ${addDays(w.windowEndExclusive, -1)}, export dated ${source.sourceAsOf?.slice(0, 10) ?? 'unknown'})`,
    timezone: source.timezone,
    startDate: w.windowStart,
    endDateExclusive: w.windowEndExclusive,
    endDateInclusive: addDays(w.windowEndExclusive, -1),
    startInclusive: w.windowStart,
    endExclusive: w.windowEndExclusive,
    days: w.days,
    partial: false,
    calendarUnit: 'day',
    windowKey: w.windowKey,
  };
  const sourceRows = sel.map((r) => r.source_row);
  const evidence: EvidenceItem[] = [
    ...evidenceFor(curM, `window "${w.windowLabel}"`, source, sel.length, sourceRows),
    ...(prevM ? evidenceFor(prevM, `derived preceding window (${derivation})`, source, sel.length * 2, sourceRows) : []),
    ...sourceRates.map((c) => ({
      id: c.current.evidenceIds[0]!,
      kind: 'source_rate' as const,
      label: `${c.label} — window "${w.windowLabel}"`,
      value: c.current.value,
      unit: 'percent' as const,
      currency: null,
      formula: 'as reported in the export (no numerator available)',
      inputs: [],
      scope: `window "${w.windowLabel}"`,
      source: { datasetVersionIds: [source.datasetVersionId], rowCount: 1, sourceRows },
    })),
  ];
  const findings = [
    ...changeFindings(totals, `in the ${comparison ? 'derived preceding window' : 'comparison period'}`),
    ...limitationFindings({}, [...quality.conflicts, ...conflicts]),
    {
      id: 'f:limit:summary',
      kind: 'limitation' as const,
      severity: 'info' as const,
      text: 'This is a summary export: it supports account totals for its declared windows only. Campaign, segment, hourly, link, and recipient analysis need a campaign-level file or a Responsys connection.',
      evidenceIds: [],
      strength: 'descriptive' as const,
      ruleVersion: FINDINGS_RULE_VERSION,
    },
  ];
  const unavailable = (key: Capability['key'], label: string, reason: string): Capability => ({ key, label, status: 'unavailable', reason });
  return {
    meta: meta(ctx, 'overview', 'complete', [...warnings, ...conflicts], source.sourceAsOf?.slice(0, 10) ?? null),
    source,
    period,
    comparison,
    channelFilter: req.channels,
    totals,
    sourceRates,
    byChannel,
    byProgram: [],
    byWeekday: [],
    bySubjectLine: [],
    byCreativeType: [],
    byOffer: [],
    campaigns: [],
    trend: [],
    windows: windows.map(({ days: _d, ...x }) => x),
    capabilities: [
      unavailable('campaign_detail', 'Campaign detail', 'A summary export has no campaign rows'),
      unavailable('campaign_comparison', 'Campaign comparison', 'A summary export has no campaign rows'),
      unavailable('trend', 'Daily trend', 'A summary export has no daily rows'),
      { key: 'previous_period', label: 'Comparison period', status: prevM ? 'available' : 'unavailable', reason: prevM ? `Derived: ${derivation}` : 'No suitable nested window in the export' },
      unavailable('hourly', 'Hourly send-time analysis', 'Not in a summary export'),
      unavailable('segments', 'Audience segments', 'Not in a summary export'),
      unavailable('recipients', 'Recipient-level behaviour', 'Not in a summary export'),
      unavailable('links', 'Link placement', 'Not in a summary export'),
      unavailable('domains', 'Mailbox domains', 'Not in a summary export'),
    ],
    findings,
    evidence,
    counts: { campaigns: 0, launches: 0, rows: sel.length },
  };
}

// ================================================================ single campaign
export async function buildCampaignReport(ctx: BuildCtx, req: CampaignReportRequest): Promise<CampaignReportResult> {
  const { tx, source } = ctx;
  if (source.grain === 'account_window') throw new AppError('unprocessable', 'Campaign detail needs campaign-level data; this source is a summary export');
  const metas = await campaignMeta(tx, source.datasetVersionId, [req.campaignId]);
  const cm = metas.get(req.campaignId);
  if (!cm) throw notFound('Campaign');
  const period = resolvePeriod(req.period ?? defaultPeriod(source), source.timezone, ctx.clock);
  const cmp = resolveComparison(period, req.comparison);
  const dateColumn = source.timeBasis === 'event_time' ? 'fact_date' : 'launch_date';
  const cov = coverageOf(source, period.startDate, period.endDateExclusive);
  const ctxC: ComputeContext = { currency: source.currency, launchUniqueSummable: source.grain !== 'campaign_day', coverageComplete: cov.status !== 'outside_coverage', evidencePrefix: 'ev:campaign' };
  const f = { versionId: source.datasetVersionId, dateColumn, start: period.startDate, endExclusive: period.endDateExclusive, campaignIds: [req.campaignId] } as const;

  const [cur] = await aggregateFacts(tx, f, 'none');
  const curM = withWarning(computeAll(cur!.aggs, ctxC), cov.warning);
  let prevM: Record<string, MetricValue> | null = null;
  if (cmp) {
    const pc = coverageOf(source, cmp.startDate, cmp.endDateExclusive);
    const [p] = await aggregateFacts(tx, { ...f, start: cmp.startDate, endExclusive: cmp.endDateExclusive }, 'none');
    prevM = computeAll(p!.aggs, { ...ctxC, coverageComplete: pc.status !== 'outside_coverage', evidencePrefix: 'ev:campaign_previous' });
  }
  const metrics = ALL_METRICS.map((k) => compareMetric(curM[k]!, prevM ? prevM[k]! : null));

  const launchRows = await aggregateFacts(tx, f, 'launch');
  const subjects = await tx.query<{ key: string; subject_line: string | null }>(
    `SELECT DISTINCT ON (key) f.campaign_id::text || '|' || COALESCE(f.launch_external_id, '') || '|' || f.launch_date::text AS key, f.subject_line
       FROM campaign_launch_facts f WHERE f.dataset_version_id = $1 AND f.campaign_id = $2 ORDER BY key, f.subject_line NULLS LAST`,
    [source.datasetVersionId, req.campaignId]
  );
  const subjectByKey = new Map(subjects.rows.map((r) => [r.key, r.subject_line]));
  const launches = launchRows.map((r) => {
    const [, launchExt, date] = r.key!.split('|');
    return {
      launchExternalId: launchExt || null,
      launchDate: date!,
      subjectLine: subjectByKey.get(r.key!) ?? null,
      metrics: Object.fromEntries(Object.entries(computeAll(r.aggs, { ...ctxC, launchUniqueSummable: true, evidencePrefix: `ev:launch:${r.key}` })).filter(([k]) => KEY_METRICS.includes(k))),
    };
  });

  let benchmark: CampaignReportResult['benchmark'] = null;
  let benchmarkComparison: MetricChange[] = [];
  const warnings: string[] = cov.warning ? [cov.warning] : [];
  if (req.benchmark.type !== 'none') {
    let bAgg: AggRow;
    let label: string;
    let bId: string | null = null;
    if (req.benchmark.type === 'campaign') {
      if (req.benchmark.campaignId === req.campaignId) throw new AppError('unprocessable', 'Choose a different campaign as the benchmark');
      const bm = (await campaignMeta(tx, source.datasetVersionId, [req.benchmark.campaignId])).get(req.benchmark.campaignId);
      if (!bm) throw notFound('Benchmark campaign');
      [bAgg] = (await aggregateFacts(tx, { ...f, campaignIds: [bm.campaignId] }, 'none')) as [AggRow];
      label = `Campaign "${bm.name}" in the same period`;
      bId = bm.campaignId;
      if (bm.channel !== cm.channel) warnings.push(`The benchmark is a ${bm.channel} campaign; ${cm.channel} metrics are not directly comparable.`);
    } else {
      const rows = await aggregateFacts(tx, { versionId: source.datasetVersionId, dateColumn, start: period.startDate, endExclusive: period.endDateExclusive, channels: [cm.channel] }, 'campaign');
      const others = rows.filter((r) => r.key !== req.campaignId);
      bAgg = { key: null, aggs: others.reduce((a, r) => addAggregates(a, r.aggs), emptyAggregates()), rows: others.reduce((s, r) => s + r.rows, 0), launches: 0, campaigns: others.length, firstLaunch: null, lastLaunch: null, sourceRows: [] };
      if (!others.length) for (const k of Object.keys(bAgg.aggs) as BaseMeasure[]) bAgg.aggs[k] = { sum: null, rowsWithValue: 0, rowsTotal: 1 };
      label = `All other ${cm.channel} campaigns in the same period (${others.length})`;
    }
    const bM = computeAll(bAgg.aggs, { ...ctxC, evidencePrefix: 'ev:benchmark' });
    benchmark = { type: req.benchmark.type, label, campaignId: bId, metrics: pick(bM, KEY_METRICS) };
    benchmarkComparison = KEY_METRICS.map((k) => {
      const c = compareMetric(curM[k]!, bM[k]!);
      c.note = c.note ?? 'Difference versus the benchmark';
      return c;
    });
  }

  const trend = trendFrom(await aggregateFacts(tx, f, 'date'), ctxC);
  const evidence = [...evidenceFor(curM, `campaign ${cm.externalId}, ${period.startDate} – ${period.endDateInclusive}`, source, cur!.rows, cur!.sourceRows, 'campaign_metric')];
  if (prevM && cmp) evidence.push(...evidenceFor(prevM, `campaign ${cm.externalId}, ${cmp.startDate} – ${cmp.endDateInclusive}`, source, 0, []));
  if (benchmark) {
    for (const v of benchmark.metrics) {
      evidence.push({ id: v.evidenceIds[0]!, kind: 'metric', label: `${v.label} — benchmark`, value: v.value, unit: v.unit, currency: v.currency, formula: v.metricId in RATE_DEFS ? RATE_DEFS[v.metricId as keyof typeof RATE_DEFS].formula : 'sum', inputs: [], scope: benchmark.label, source: { datasetVersionIds: [source.datasetVersionId], rowCount: 0 } });
    }
  }
  const bFindings: Finding[] = benchmarkComparison
    .filter((c) => c.relativeChangePct !== null && Math.abs(Number(c.relativeChangePct)) >= 20 && ['unique_open_rate', 'total_open_rate', 'unique_click_rate', 'total_click_rate', 'conversion_event_rate', 'unsubscribe_rate', 'bounce_rate', 'revenue_per_delivered'].includes(c.metricId))
    .map((c) => ({
      id: `f:benchmark:${c.metricId}`,
      kind: 'observation',
      severity: c.interpretation === 'better' ? 'positive' : c.interpretation === 'worse' ? 'attention' : 'info',
      text: `${c.label} was ${fmtMetric(c.current)} versus ${fmtMetric(c.previous)} for the benchmark (${fmtChange(c)}). This is an observed difference, not a measured cause.`,
      evidenceIds: [...c.current.evidenceIds, ...(c.previous?.evidenceIds ?? [])],
      strength: 'descriptive',
      ruleVersion: FINDINGS_RULE_VERSION,
    }));
  const findings = [...bFindings, ...changeFindings(metrics, 'for this campaign in the comparison period'), ...limitationFindings(curM, cov.warning ? [cov.warning] : [])];
  return {
    meta: meta(ctx, 'campaign', cov.status, warnings, source.coverageEndExclusive ? addDays(source.coverageEndExclusive, -1) : null),
    source,
    period,
    campaign: { campaignId: cm.campaignId, externalId: cm.externalId, name: cm.name, channel: cm.channel, program: cm.program },
    launches,
    metrics,
    benchmark,
    benchmarkComparison,
    trend,
    capabilities: [
      { key: 'trend', label: 'Daily trend', status: 'available', reason: null },
      { key: 'hourly', label: 'Hourly opens/clicks', status: 'unavailable', reason: 'The data has no event times' },
      { key: 'links', label: 'Link placement', status: 'unavailable', reason: 'No link-level data is imported' },
      { key: 'domains', label: 'Mailbox domains', status: 'unavailable', reason: 'No domain-level data is imported' },
      { key: 'segments', label: 'Audience segments', status: 'unavailable', reason: 'No segment membership data is connected' },
    ],
    findings,
    evidence,
  };
}

// ================================================================ multi-campaign comparison
export async function buildComparison(ctx: BuildCtx, req: ComparisonRequest): Promise<ComparisonResult> {
  const { tx, source } = ctx;
  if (source.grain === 'account_window') throw new AppError('unprocessable', 'Campaign comparison needs campaign-level data; this source is a summary export');
  const ids = [...new Set(req.campaignIds)];
  if (ids.length < 2) throw new AppError('unprocessable', 'Choose at least two different campaigns');
  const metas = await campaignMeta(tx, source.datasetVersionId, ids);
  for (const id of ids) if (!metas.has(id)) throw notFound('Campaign');
  const baselineId = req.baselineCampaignId ?? ids[0]!;
  if (!ids.includes(baselineId)) throw new AppError('unprocessable', 'The baseline must be one of the selected campaigns');
  const period = resolvePeriod(req.period ?? defaultPeriod(source), source.timezone, ctx.clock);
  const dateColumn = source.timeBasis === 'event_time' ? 'fact_date' : 'launch_date';
  const cov = coverageOf(source, period.startDate, period.endDateExclusive);
  const ctxC: ComputeContext = { currency: source.currency, launchUniqueSummable: source.grain !== 'campaign_day', coverageComplete: cov.status !== 'outside_coverage', evidencePrefix: '' };
  const rows = await aggregateFacts(tx, { versionId: source.datasetVersionId, dateColumn, start: period.startDate, endExclusive: period.endDateExclusive, campaignIds: ids }, 'campaign');
  const byId = new Map(rows.map((r) => [r.key!, r]));
  const campaigns = ids.map((id) => {
    const r = byId.get(id);
    const aggs = r?.aggs ?? emptyAggregates();
    return campaignRow(metas.get(id)!, withWarning(computeAll(aggs, { ...ctxC, evidencePrefix: `ev:campaign:${id}` }), cov.warning), r);
  });
  const baseline = campaigns.find((c) => c.campaignId === baselineId)!;
  const differences = campaigns
    .filter((c) => c.campaignId !== baselineId)
    .map((c) => ({ campaignId: c.campaignId, changes: KEY_METRICS.map((k) => ({ ...compareMetric(c.metrics[k]!, baseline.metrics[k]!), note: `Versus baseline "${baseline.name}"` })) }));
  const issues: string[] = [];
  const channels = new Set(campaigns.map((c) => c.channel));
  if (channels.size > 1) issues.push(`Selected campaigns use different channels (${[...channels].join(', ')}); email engagement metrics do not apply to other channels.`);
  for (const c of campaigns) if (!byId.has(c.campaignId)) issues.push(`"${c.name}" has no launches in this period.`);
  if (cov.warning) issues.push(cov.warning);
  const evidence: EvidenceItem[] = campaigns.flatMap((c) => evidenceFor(Object.fromEntries(KEY_METRICS.map((k) => [k, c.metrics[k]!])), `campaign ${c.externalId}`, source, c.launchCount, [], 'campaign_metric'));
  const findings: Finding[] = [];
  for (const k of ['unique_click_rate', 'total_click_rate', 'unique_open_rate', 'total_open_rate', 'conversion_event_rate']) {
    const avail = campaigns.filter((c) => c.metrics[k]?.value !== null && c.metrics[k]?.value !== undefined);
    if (avail.length < 2) continue;
    const best = avail.reduce((a, b) => (new Dec(b.metrics[k]!.value!).gt(a.metrics[k]!.value!) ? b : a));
    findings.push({
      id: `f:compare:${k}`,
      kind: 'observation',
      severity: 'info',
      text: `Among the selected campaigns, "${best.name}" had the highest ${best.metrics[k]!.label.toLowerCase()} (${fmtMetric(best.metrics[k])} on ${fmtMetric(best.metrics.delivered)} delivered). Rates on small volumes vary more.`,
      evidenceIds: avail.flatMap((c) => c.metrics[k]!.evidenceIds),
      strength: 'descriptive',
      ruleVersion: FINDINGS_RULE_VERSION,
    });
    break;
  }
  return {
    meta: meta(ctx, 'comparison', cov.status, issues, source.coverageEndExclusive ? addDays(source.coverageEndExclusive, -1) : null),
    source,
    period,
    campaigns,
    baselineCampaignId: baselineId,
    differences,
    compatibility: { compatible: channels.size === 1, issues },
    findings,
    evidence,
  };
}
