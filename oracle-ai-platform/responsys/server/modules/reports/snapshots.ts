/**
 * Immutable report snapshots. A snapshot is keyed by its normalized scope, the account's data
 * revision, and the metric definition version, so identical requests reuse one snapshot and any
 * data change produces a new one. Screens, chat, scenarios, and exports all read snapshots by ID.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db, Tx } from '../../db/pool';
import { notFound } from '../../http/errors';
import type { Clock } from '../../../shared/time/clock';
import { localDate } from '../../../shared/time/zoned';
import { DEFINITION_VERSION } from '../../../shared/metrics/registry';

/** Bump when the snapshot shape changes (new sections or fields). */
export const REPORT_FORMAT_VERSION = 'report-format-2026-11-16.send-time.1';
import type { CampaignReportRequest, ComparisonRequest, OverviewRequest } from '../../../shared/contracts/reports';
import { buildCampaignReport, buildComparison, buildOverview, type BuildCtx } from './build';
import { loadAccount, loadSource } from './data';

export type ReportKind = 'overview' | 'campaign' | 'comparison';
type AnyReport = { meta: { reportId: string; generatedAt: string; resultHash: string; accountId: string; kind: string } & Record<string, unknown> } & Record<string, unknown>;

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function resultHash(result: AnyReport): string {
  const { meta, ...rest } = result;
  const { reportId: _r, generatedAt: _g, resultHash: _h, ...m } = meta;
  return sha256(stableStringify({ meta: m, ...rest }));
}

export async function createReport(
  db: Db,
  t: { workspaceId: string; userId: string },
  kind: ReportKind,
  req: OverviewRequest | CampaignReportRequest | ComparisonRequest,
  clock: Clock,
  dataMode: string
): Promise<AnyReport> {
  return db.withTenant(t, async (tx) => {
    const account = await loadAccount(tx, req.accountId);
    const source = await loadSource(tx, req.accountId, req.datasetId);
    // The result format version is part of the scope: a new report layout never reuses snapshots
    // built by older code (they lack the new sections).
    const scope = { kind, req, datasetVersionId: source.datasetVersionId, today: localDate(clock.now(), source.timezone), format: REPORT_FORMAT_VERSION };
    const scopeHash = sha256(stableStringify(scope));
    const cached = await findSnapshot(tx, req.accountId, kind, scopeHash, account.dataRevision);
    if (cached) return cached;
    const ctx: BuildCtx = { tx, account, source, clock, reportId: randomUUID(), dataMode };
    const result = (
      kind === 'overview'
        ? await buildOverview(ctx, req as OverviewRequest)
        : kind === 'campaign'
          ? await buildCampaignReport(ctx, req as CampaignReportRequest)
          : await buildComparison(ctx, req as ComparisonRequest)
    ) as unknown as AnyReport;
    result.meta.resultHash = resultHash(result);
    const ins = await tx.query(
      `INSERT INTO report_snapshots (workspace_id, id, account_id, kind, scope, scope_hash, data_revision, dataset_version_ids, definition_version, result, result_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workspace_id, account_id, kind, scope_hash, data_revision, definition_version) DO NOTHING RETURNING id`,
      [t.workspaceId, result.meta.reportId, req.accountId, kind, JSON.stringify(scope), scopeHash, account.dataRevision, [source.datasetVersionId], DEFINITION_VERSION, JSON.stringify(result), result.meta.resultHash, t.userId]
    );
    if (!ins.rowCount) return (await findSnapshot(tx, req.accountId, kind, scopeHash, account.dataRevision))!;
    return result;
  });
}

async function findSnapshot(tx: Tx, accountId: string, kind: ReportKind, scopeHash: string, revision: string): Promise<AnyReport | null> {
  const { rows } = await tx.query<{ result: AnyReport }>(
    `SELECT result FROM report_snapshots WHERE account_id = $1 AND kind = $2 AND scope_hash = $3 AND data_revision = $4 AND definition_version = $5`,
    [accountId, kind, scopeHash, revision, DEFINITION_VERSION]
  );
  return rows[0]?.result ?? null;
}

export async function getReport(db: Db, t: { workspaceId: string }, reportId: string): Promise<AnyReport & { kind: ReportKind }> {
  const { rows } = await db.withTenant(t, (tx) => tx.query<{ result: AnyReport; kind: ReportKind }>('SELECT result, kind FROM report_snapshots WHERE id = $1', [reportId]));
  if (!rows[0]) throw notFound('Report');
  return { ...rows[0].result, kind: rows[0].kind };
}
