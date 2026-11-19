/**
 * Report contracts shared by the API and the browser. Exact numbers travel as strings;
 * a null value is unavailable (never zero) and always carries a reason.
 */
import { z } from 'zod';
import type { MeasurementOrigin, MetricAvailability, MetricUnit, UnavailableReason } from '../metrics/registry';
import { COMPARISON_POLICIES, PERIOD_PRESETS, type ResolvedPeriod } from '../time/periods';

export interface MetricValue {
  metricId: string;
  label: string;
  value: string | null;
  unit: MetricUnit;
  currency: string | null;
  availability: MetricAvailability;
  origin: MeasurementOrigin | null;
  definitionVersion: string;
  numeratorMetricId: string | null;
  denominatorMetricId: string | null;
  evidenceIds: string[];
  warnings: string[];
  reason: UnavailableReason | null;
  higherIsBetter: boolean | null;
}

export interface MetricChange {
  metricId: string;
  label: string;
  current: MetricValue;
  previous: MetricValue | null;
  /** current − previous; percentage points for percent metrics. */
  absoluteChange: string | null;
  absoluteChangeUnit: 'pp' | 'count' | 'money' | 'money_per_message' | 'ratio' | null;
  /** (current − previous) / previous × 100. Null when undefined, with a note. */
  relativeChangePct: string | null;
  note: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  interpretation: 'better' | 'worse' | 'neutral' | null;
}

export interface EvidenceItem {
  id: string;
  kind: 'metric' | 'comparison' | 'coverage' | 'source_rate' | 'campaign_metric';
  label: string;
  value: string | null;
  unit: MetricUnit | null;
  currency: string | null;
  formula: string | null;
  inputs: { metricId: string; value: string | null }[];
  scope: string;
  source: { datasetVersionIds: string[]; rowCount: number; sourceRows?: number[] };
}

export type CoverageStatus = 'complete' | 'partial' | 'outside_coverage' | 'no_data';

export interface DataSourceInfo {
  datasetId: string;
  datasetName: string;
  datasetVersionId: string;
  version: number;
  sourceType: string;
  grain: string;
  timeBasis: string;
  importFileName: string | null;
  importSha256: string | null;
  sourceAsOf: string | null;
  coverageStart: string | null;
  coverageEndExclusive: string | null;
  activatedAt: string | null;
  currency: string;
  timezone: string;
}

export interface Capability {
  key: 'campaign_detail' | 'campaign_comparison' | 'trend' | 'hourly' | 'segments' | 'recipients' | 'links' | 'domains' | 'connect_jobs' | 'previous_period';
  label: string;
  status: 'available' | 'unavailable';
  reason: string | null;
}

export interface Finding {
  id: string;
  kind: 'observation' | 'limitation';
  severity: 'info' | 'attention' | 'positive';
  text: string;
  evidenceIds: string[];
  strength: 'descriptive';
  ruleVersion: string;
}

export interface ReportMeta {
  reportId: string;
  kind: 'overview' | 'campaign' | 'comparison';
  accountId: string;
  accountName: string;
  generatedAt: string;
  dataRevision: string;
  datasetVersionIds: string[];
  definitionVersion: string;
  sourceAsOf: string | null;
  completeThrough: string | null;
  coverageStatus: CoverageStatus;
  timeBasis: string;
  timezone: string;
  currency: string;
  aiStatus: 'not_requested';
  warnings: string[];
  dataMode: string;
  resultHash: string;
}

export interface CampaignRow {
  campaignId: string;
  externalId: string;
  name: string;
  channel: string;
  program: string | null;
  /** Launches in the selected period (0 when the campaign has no rows in it). */
  launchCount: number;
  firstLaunchDate: string | null;
  lastLaunchDate: string | null;
  /** Whole-dataset history, independent of the selected period. */
  datasetLaunchCount: number;
  datasetFirstLaunchDate: string;
  datasetLastLaunchDate: string;
  metrics: Record<string, MetricValue>;
}

export interface TrendPoint {
  date: string;
  values: Record<string, string | null>;
}

export interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  windowStart: string;
  windowEndExclusive: string;
  channels: string[];
}

export interface DimensionRow {
  value: string;
  campaigns: number;
  launches: number;
  metrics: MetricValue[];
}

export interface OverviewResult {
  meta: ReportMeta;
  source: DataSourceInfo;
  period: (ResolvedPeriod & { windowKey?: string }) | null;
  comparison: (ResolvedPeriod & { derivation?: string }) | null;
  channelFilter: string[];
  totals: MetricChange[];
  sourceRates: MetricChange[];
  byChannel: { channel: string; metrics: MetricValue[] }[];
  /** Program grouping as written in the source ('' = no program given). */
  byProgram: { program: string; campaigns: number; launches: number; metrics: MetricValue[] }[];
  /** Day of week of the reporting date (launch or activity date); 1 = Monday … 7 = Sunday. No hours. */
  byWeekday: { weekday: number; label: string; launches: number; metrics: MetricValue[] }[];
  /** Account-local launch weekday/hour, grouped within each channel. Null hour is the full weekday cohort. */
  sendTime?: { channel: string; weekday: number; hour: number | null; launches: number; metrics: MetricValue[] }[];
  /** Optional source columns as written ('' = not given): Subject Line, Creative Type, Offer. */
  bySubjectLine: DimensionRow[];
  byCreativeType: DimensionRow[];
  byOffer: DimensionRow[];
  campaigns: CampaignRow[];
  trend: TrendPoint[];
  windows: WindowSummary[];
  capabilities: Capability[];
  findings: Finding[];
  evidence: EvidenceItem[];
  counts: { campaigns: number; launches: number; rows: number };
}

export interface CampaignReportResult {
  meta: ReportMeta;
  source: DataSourceInfo;
  period: ResolvedPeriod | null;
  campaign: { campaignId: string; externalId: string; name: string; channel: string; program: string | null };
  launches: { launchExternalId: string | null; launchDate: string; subjectLine: string | null; metrics: Record<string, MetricValue> }[];
  metrics: MetricChange[];
  benchmark: { type: 'account_period' | 'campaign' | 'none'; label: string; campaignId: string | null; metrics: MetricValue[] } | null;
  benchmarkComparison: MetricChange[];
  trend: TrendPoint[];
  capabilities: Capability[];
  findings: Finding[];
  evidence: EvidenceItem[];
}

export interface ComparisonResult {
  meta: ReportMeta;
  source: DataSourceInfo;
  period: ResolvedPeriod | null;
  campaigns: CampaignRow[];
  baselineCampaignId: string;
  differences: { campaignId: string; changes: MetricChange[] }[];
  compatibility: { compatible: boolean; issues: string[] };
  findings: Finding[];
  evidence: EvidenceItem[];
}

// ---------------------------------------------------------------- request scopes
export const PeriodSchema = z.object({
  preset: z.enum(PERIOD_PRESETS),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const OverviewRequestSchema = z.object({
  accountId: z.string().uuid(),
  datasetId: z.string().uuid(),
  /** Campaign-grain datasets use a period; legacy summary datasets use a declared window. */
  period: PeriodSchema.optional(),
  windowKey: z.string().max(60).optional(),
  comparison: z.enum(COMPARISON_POLICIES).default('preceding_equal_duration'),
  channels: z.array(z.string().max(40)).max(10).default([]),
});
export type OverviewRequest = z.infer<typeof OverviewRequestSchema>;

export const CampaignReportRequestSchema = z.object({
  accountId: z.string().uuid(),
  datasetId: z.string().uuid(),
  campaignId: z.string().uuid(),
  period: PeriodSchema.optional(),
  comparison: z.enum(COMPARISON_POLICIES).default('preceding_equal_duration'),
  benchmark: z.discriminatedUnion('type', [
    z.object({ type: z.literal('account_period') }),
    z.object({ type: z.literal('campaign'), campaignId: z.string().uuid() }),
    z.object({ type: z.literal('none') }),
  ]).default({ type: 'account_period' }),
});
export type CampaignReportRequest = z.infer<typeof CampaignReportRequestSchema>;

export const ComparisonRequestSchema = z.object({
  accountId: z.string().uuid(),
  datasetId: z.string().uuid(),
  campaignIds: z.array(z.string().uuid()).min(2).max(10),
  baselineCampaignId: z.string().uuid().optional(),
  period: PeriodSchema.optional(),
});
export type ComparisonRequest = z.infer<typeof ComparisonRequestSchema>;
