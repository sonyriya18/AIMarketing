/**
 * Data access for reports: resolves the explicit data source (one dataset, its active version)
 * and aggregates facts in SQL with exact NUMERIC sums plus per-field non-null counts, so
 * missing values are distinguishable from zero.
 */
import type { Tx } from '../../db/pool';
import { AppError, notFound } from '../../http/errors';
import type { DataSourceInfo } from '../../../shared/contracts/reports';
import { BASE_MEASURES, type BaseMeasure } from '../../../shared/metrics/registry';
import { emptyAggregates, type Aggregates } from '../../../shared/metrics/compute';

export interface AccountInfo {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  dataRevision: string;
}

export async function loadAccount(tx: Tx, accountId: string): Promise<AccountInfo> {
  const { rows } = await tx.query<AccountInfo>(
    'SELECT id, name, timezone, currency, data_revision AS "dataRevision" FROM accounts WHERE id = $1',
    [accountId]
  );
  if (!rows[0]) throw notFound('Account');
  return rows[0];
}

export async function loadSource(tx: Tx, accountId: string, datasetId: string): Promise<DataSourceInfo> {
  const { rows } = await tx.query<DataSourceInfo & { accountId: string }>(
    `SELECT d.id AS "datasetId", d.name AS "datasetName", d.account_id AS "accountId", v.id AS "datasetVersionId", v.version,
            d.source_type AS "sourceType", d.grain, d.time_basis AS "timeBasis", r.original_filename AS "importFileName",
            r.sha256 AS "importSha256", v.source_as_of AS "sourceAsOf", v.coverage_start AS "coverageStart",
            v.coverage_end_exclusive AS "coverageEndExclusive", v.activated_at AS "activatedAt", v.currency, v.timezone
       FROM datasets d
       LEFT JOIN dataset_versions v ON v.id = d.active_version_id
       LEFT JOIN import_jobs i ON i.id = v.import_job_id
       LEFT JOIN raw_objects r ON r.id = i.raw_object_id
      WHERE d.id = $1`,
    [datasetId]
  );
  const s = rows[0];
  if (!s || s.accountId !== accountId) throw notFound('Dataset');
  if (!s.datasetVersionId) throw new AppError('unprocessable', 'This dataset has no active version. Restore a version or choose another data source.');
  const { accountId: _a, ...info } = s;
  return {
    ...info,
    sourceAsOf: s.sourceAsOf ? new Date(s.sourceAsOf).toISOString() : null,
    activatedAt: s.activatedAt ? new Date(s.activatedAt).toISOString() : null,
  };
}

export async function loadQuality(tx: Tx, versionId: string): Promise<{ warnings: string[]; conflicts: string[]; limitations: string[]; semantics: Record<string, string> }> {
  const { rows } = await tx.query<{ quality: Record<string, unknown> }>('SELECT quality FROM dataset_versions WHERE id = $1', [versionId]);
  const q = rows[0]?.quality ?? {};
  return {
    warnings: (q.warnings as string[]) ?? [],
    conflicts: (q.conflicts as string[]) ?? [],
    limitations: (q.limitations as string[]) ?? [],
    semantics: (q.semantics as Record<string, string>) ?? {},
  };
}

const AGG_SELECT = [
  ...BASE_MEASURES.map((m) => `SUM(f.${m})::text AS "${m}__sum", COUNT(f.${m})::int AS "${m}__n"`),
  'COUNT(*)::int AS "__rows"',
  `COUNT(DISTINCT (COALESCE(f.launch_external_id, ''), f.launch_date, f.campaign_id))::int AS "__launches"`,
  'COUNT(DISTINCT f.campaign_id)::int AS "__campaigns"',
  'MIN(f.launch_date)::text AS "__first_launch", MAX(f.launch_date)::text AS "__last_launch"',
  'array_agg(f.source_row ORDER BY f.source_row) AS "__source_rows"',
].join(', ');

export interface AggRow {
  key: string | null;
  aggs: Aggregates;
  rows: number;
  launches: number;
  campaigns: number;
  /** Launch dates of the rows in this group (within the filter), or null when it has no rows. */
  firstLaunch: string | null;
  lastLaunch: string | null;
  sourceRows: number[];
}

function toAggs(row: Record<string, unknown>): Aggregates {
  const aggs = emptyAggregates();
  const total = Number(row.__rows ?? 0);
  for (const m of BASE_MEASURES as readonly BaseMeasure[]) {
    aggs[m] = { sum: (row[`${m}__sum`] as string | null) ?? null, rowsWithValue: Number(row[`${m}__n`] ?? 0), rowsTotal: total };
  }
  return aggs;
}

export interface FactFilter {
  versionId: string;
  dateColumn: 'launch_date' | 'fact_date';
  start?: string | null;
  endExclusive?: string | null;
  channels?: readonly string[];
  campaignIds?: readonly string[];
}

export async function aggregateFacts(tx: Tx, f: FactFilter, groupBy: 'none' | 'channel' | 'campaign' | 'date' | 'launch' | 'program' | 'weekday' | 'subject' | 'creative' | 'offer' | 'send_hour' | 'send_weekday'): Promise<AggRow[]> {
  const params: unknown[] = [f.versionId];
  const where = ['f.dataset_version_id = $1'];
  if (groupBy === 'send_hour') where.push('f.launch_time IS NOT NULL');
  if (f.start) {
    params.push(f.start);
    where.push(`f.${f.dateColumn} >= $${params.length}`);
  }
  if (f.endExclusive) {
    params.push(f.endExclusive);
    where.push(`f.${f.dateColumn} < $${params.length}`);
  }
  if (f.channels?.length) {
    params.push(f.channels);
    where.push(`f.channel = ANY($${params.length})`);
  }
  if (f.campaignIds?.length) {
    params.push(f.campaignIds);
    where.push(`f.campaign_id = ANY($${params.length})`);
  }
  const keyExpr: Record<typeof groupBy, string> = {
    none: 'NULL::text',
    channel: 'f.channel',
    campaign: 'f.campaign_id::text',
    date: `f.${f.dateColumn}::text`,
    launch: `f.campaign_id::text || '|' || COALESCE(f.launch_external_id, '') || '|' || f.launch_date::text`,
    program: `COALESCE(NULLIF(TRIM(f.program), ''), '')`,
    subject: `COALESCE(NULLIF(TRIM(f.subject_line), ''), '')`,
    creative: `COALESCE(NULLIF(TRIM(f.creative_type), ''), '')`,
    offer: `COALESCE(NULLIF(TRIM(f.offer), ''), '')`,
    // ISO day of week of the reporting date: 1 = Monday … 7 = Sunday.
    weekday: `EXTRACT(ISODOW FROM f.${f.dateColumn})::int::text`,
    send_hour: `json_build_array(f.channel, EXTRACT(ISODOW FROM f.launch_date)::int, EXTRACT(HOUR FROM f.launch_time)::int)::text`,
    send_weekday: `json_build_array(f.channel, EXTRACT(ISODOW FROM f.launch_date)::int, NULL)::text`,
  };
  const group = groupBy === 'none' ? '' : `GROUP BY 1 ORDER BY 1`;
  const { rows } = await tx.query(`SELECT ${keyExpr[groupBy]} AS key, ${AGG_SELECT} FROM campaign_launch_facts f WHERE ${where.join(' AND ')} ${group} LIMIT 10000`, params);
  if (groupBy === 'none' && !rows.length) return [{ key: null, aggs: emptyAggregates(), rows: 0, launches: 0, campaigns: 0, firstLaunch: null, lastLaunch: null, sourceRows: [] }];
  return rows.map((r) => ({
    key: r.key as string | null,
    aggs: toAggs(r),
    rows: Number(r.__rows ?? 0),
    launches: Number(r.__launches ?? 0),
    campaigns: Number(r.__campaigns ?? 0),
    firstLaunch: (r.__first_launch as string | null) ?? null,
    lastLaunch: (r.__last_launch as string | null) ?? null,
    sourceRows: ((r.__source_rows as number[] | null) ?? []).slice(0, 200),
  }));
}

export interface CampaignMeta {
  campaignId: string;
  externalId: string;
  name: string;
  channel: string;
  program: string | null;
  launchCount: number;
  firstLaunchDate: string;
  lastLaunchDate: string;
}

export async function campaignMeta(tx: Tx, versionId: string, campaignIds?: string[]): Promise<Map<string, CampaignMeta>> {
  const params: unknown[] = [versionId];
  let filter = '';
  if (campaignIds?.length) {
    params.push(campaignIds);
    filter = 'AND f.campaign_id = ANY($2)';
  }
  const { rows } = await tx.query<CampaignMeta>(
    `SELECT c.id AS "campaignId", c.external_id AS "externalId",
            (ARRAY_AGG(f.campaign_name ORDER BY f.launch_date DESC))[1] AS name,
            (ARRAY_AGG(f.channel ORDER BY f.launch_date DESC))[1] AS channel,
            (ARRAY_AGG(f.program ORDER BY f.launch_date DESC))[1] AS program,
            COUNT(DISTINCT (COALESCE(f.launch_external_id, ''), f.launch_date))::int AS "launchCount",
            MIN(f.launch_date) AS "firstLaunchDate", MAX(f.launch_date) AS "lastLaunchDate"
       FROM campaign_launch_facts f JOIN campaigns c ON c.id = f.campaign_id
      WHERE f.dataset_version_id = $1 ${filter}
      GROUP BY c.id, c.external_id`,
    params
  );
  return new Map(rows.map((r) => [r.campaignId, r]));
}

export interface WindowFactRow {
  channel: string;
  window_key: string;
  window_label: string;
  window_days: number;
  window_start: string;
  window_end_exclusive: string;
  sent: string | null;
  delivered: string | null;
  skipped: string | null;
  bounce_rate: string | null;
  soft_bounce_rate: string | null;
  hard_bounce_rate: string | null;
  open_rate: string | null;
  click_rate: string | null;
  unsubscribe_rate: string | null;
  revenue: string | null;
  conversions: string | null;
  source_row: number;
}

export async function windowFacts(tx: Tx, versionId: string): Promise<WindowFactRow[]> {
  const { rows } = await tx.query<WindowFactRow>(
    `SELECT channel, window_key, window_label, window_days, window_start, window_end_exclusive, sent, delivered, skipped,
            bounce_rate, soft_bounce_rate, hard_bounce_rate, open_rate, click_rate, unsubscribe_rate, revenue, conversions, source_row
       FROM summary_window_facts WHERE dataset_version_id = $1 ORDER BY window_days, channel`,
    [versionId]
  );
  return rows;
}
