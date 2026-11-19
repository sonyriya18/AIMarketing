/**
 * Responsys synchronization jobs.
 *
 * responsys.check — authenticate and probe each documented read capability separately, so a
 *                   denied permission is recorded as "denied", not as a broken connection.
 * responsys.sync  — (1) Connect jobs and runs for the lookback window; (2) aggregate reporting:
 *                   plan ≤30-day partitions, submit (≤5 per minute per connection), persist
 *                   provider request IDs before waiting, poll, split partitions that reach the
 *                   10,000-row ceiling, and activate one new dataset version that REPLACES the
 *                   refreshed date range (never adds a re-fetched cumulative snapshot on top).
 */
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config';
import type { Db, Tx } from '../../db/pool';
import { PermanentJobError, enqueueJob, type JobHandler } from '../../jobs/queue';
import { audit, publishEvent } from '../audit/audit';
import { activateVersion } from '../datasets/service';
import {
  REPORTING_MAX_SPAN_DAYS,
  REPORTING_ROW_CEILING,
  ResponsysError,
  extractReportingRows,
  type ResponsysClient,
  type ResponsysClientFactory,
} from '../../integrations/responsys/client';
import { addDays, diffDays, localDate } from '../../../shared/time/zoned';
import { redact } from '../../observability/logger';

interface ConnRow {
  id: string;
  account_id: string;
  login_base_url: string;
  credential_ref: string;
  status: string;
  reporting_dataset_id: string | null;
  timezone: string;
  currency: string;
  created_by: string | null;
}

async function loadConn(tx: Tx, id: string): Promise<ConnRow> {
  const { rows } = await tx.query<ConnRow>(
    `SELECT c.id, c.account_id, c.login_base_url, c.credential_ref, c.status, c.reporting_dataset_id, a.timezone, a.currency, c.created_by
       FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = $1`,
    [id]
  );
  if (!rows[0]) throw new PermanentJobError('Connection not found');
  return rows[0];
}

const safeError = (e: unknown) => (e instanceof ResponsysError ? `${e.kind}: ${e.message}` : 'unexpected error').slice(0, 300);

async function probe<T>(fn: () => Promise<T>): Promise<{ status: 'available' | 'denied' | 'unavailable'; detail: string | null }> {
  try {
    await fn();
    return { status: 'available', detail: null };
  } catch (e) {
    if (e instanceof ResponsysError && e.kind === 'permission') return { status: 'denied', detail: e.message };
    return { status: 'unavailable', detail: safeError(e) };
  }
}

export function checkHandler(factory: ResponsysClientFactory): JobHandler {
  return async (job, { db }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, (tx) => loadConn(tx, String(job.payload.connectionId)));
    let status: string;
    let lastError: string | null = null;
    const capabilities: Record<string, { status: string; detail: string | null; checkedAt: string }> = {};
    let endpoint: string | null = null;
    const now = new Date().toISOString();
    try {
      const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
      await client.authenticate();
      endpoint = client.serviceEndpoint;
      capabilities.authentication = { status: 'available', detail: null, checkedAt: now };
      const checks: [string, () => Promise<unknown>][] = [
        ['rate_limits', () => client.getRateLimits()],
        ['campaign_metadata', () => client.listCampaigns(1, 0)],
        ['connect_jobs', () => client.listConnectJobs()],
      ];
      for (const [key, fn] of checks) capabilities[key] = { ...(await probe(fn)), checkedAt: now };
      // Reporting access is a separately controlled capability; it is verified by the first sync.
      capabilities.reporting = { status: 'unverified', detail: 'Verified by the first reporting sync', checkedAt: now };
      status = Object.values(capabilities).some((c) => c.status === 'denied' || c.status === 'unavailable') ? 'degraded' : 'available';
    } catch (e) {
      lastError = safeError(e);
      const kind = e instanceof ResponsysError ? e.kind : 'unknown';
      status = kind === 'auth' || kind === 'credentials_missing' ? 'denied' : 'unavailable';
      capabilities.authentication = { status: 'unavailable', detail: lastError, checkedAt: now };
    }
    await db.withTenant(t, async (tx) => {
      await tx.query(
        `UPDATE connections SET status = $2, capabilities = capabilities || $3::jsonb, last_checked_at = now(), last_error = $4, service_endpoint = COALESCE($5, service_endpoint) WHERE id = $1`,
        [conn.id, status, JSON.stringify(capabilities), lastError, endpoint]
      );
      await audit(tx, { workspaceId: job.workspace_id, userId: job.created_by }, 'connection.check', { type: 'connection', id: conn.id }, status === 'available' ? 'success' : 'failure', { status });
      await publishEvent(tx, { workspaceId: job.workspace_id, accountId: conn.account_id, type: 'connection.health', resourceId: conn.id, payload: { status } });
    });
    return { status };
  };
}

// ---------------------------------------------------------------- Connect jobs and runs
const RUN_STATUS: Record<string, string> = { running: 'running', succeeded: 'succeeded', success: 'succeeded', failed: 'failed', failure: 'failed', aborted: 'aborted' };

export function categorizeError(message: string | null): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (/no such file|not found|missing file|file does not exist|no files? (?:were |was )?found/.test(m)) return 'missing_source_file';
  if (/column|header|schema|field/.test(m)) return 'schema_mismatch';
  if (/encoding|charset|utf/.test(m)) return 'encoding';
  if (/date|format/.test(m)) return 'data_format';
  if (/sftp|ssh|connection|timeout|auth/.test(m)) return 'transfer_or_auth';
  return 'other';
}

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const num = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const date = (v: unknown) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : /^\d{13}$/.test(String(v)) ? Number(v) : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function syncConnect(db: Db, t: { workspaceId: string }, conn: ConnRow, client: ResponsysClient, fromIso: string, toIso: string, heartbeat: () => Promise<void> = async () => {}) {
  const jobs = await client.listConnectJobs();
  let runs = 0;
  const warnings: string[] = [];
  for (const j of jobs) {
    await heartbeat();
    const extId = str(j.jobId ?? j.id);
    if (!extId) continue;
    const name = str(j.jobName ?? j.name) ?? extId;
    const type = str(j.jobType ?? j.type);
    const isFeed = /event\s*feed|ced|eventdata/i.test(`${type ?? ''} ${name}`);
    const jobRow = await db.withTenant(t, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO connect_jobs (workspace_id, account_id, connection_id, external_job_id, name, job_type, is_event_feed, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (connection_id, external_job_id) DO UPDATE SET name = EXCLUDED.name, job_type = EXCLUDED.job_type,
           is_event_feed = EXCLUDED.is_event_feed, raw = EXCLUDED.raw, last_synced_at = now() RETURNING id`,
        [t.workspaceId, conn.account_id, conn.id, extId, name, type, isFeed, JSON.stringify(redact(j))]
      )
    );
    let list: Record<string, unknown>[] = [];
    try {
      list = await client.listJobRuns(extId, fromIso, toIso);
    } catch (e) {
      if (e instanceof ResponsysError && (e.kind === 'permission' || e.kind === 'not_found')) { warnings.push(`Job ${extId}: ${safeError(e)}`); continue; }
      throw e;
    }
    for (const r of list) {
      const runId = str(r.jobRunId ?? r.runId ?? r.id);
      if (!runId) continue;
      await heartbeat();
      let detail: Record<string, unknown> = {};
      const detailWarnings: string[] = [];
      try { detail = await client.getJobRunStatus(extId, runId); }
      catch (e) {
        if (!(e instanceof ResponsysError) || e.retryable || e.kind === 'auth') throw e;
        detailWarnings.push(`Run status unavailable: ${safeError(e)}`);
      }
      const value = detail.jobRunStatus ?? r.jobRunStatus ?? r.status;
      const providerState = str(value && typeof value === 'object' ? (value as Record<string, unknown>).value : value);
      const status = RUN_STATUS[(providerState ?? '').toLowerCase()] ?? 'unknown';
      let logs: Awaited<ReturnType<ResponsysClient['getJobRunLogs']>> = [];
      if (['failed', 'aborted'].includes(status)) {
        try { logs = await client.getJobRunLogs(extId, runId); }
        catch (e) {
          if (!(e instanceof ResponsysError) || e.retryable || e.kind === 'auth') throw e;
          detailWarnings.push(`Run logs unavailable: ${safeError(e)}`);
        }
      }
      const logError = logs.filter(l => /error|fatal/i.test(l.logLevel)).map(l => l.logMessage).join('\n');
      const errorValue = detail.errorMessage || detail.errrorMessage || r.errorMessage || r.errrorMessage || logError;
      const errorText = errorValue ? client.redactDiagnostic(errorValue) : null;
      const started = date(r.jobStartTime ?? r.startTime ?? r.startedAt);
      const duration = num(detail.durationInSeconds ?? r.durationInSeconds);
      const ended = date(r.endTime ?? r.endedAt) ?? (started && duration !== null && duration >= 0 && status !== 'running' ? new Date(Date.parse(started) + duration * 1000).toISOString() : null);
      warnings.push(...detailWarnings.map(w => `Job ${extId}, run ${runId}: ${w}`));
      await db.withTenant(t, (tx) =>
        tx.query(
          `INSERT INTO connect_job_runs (workspace_id, connect_job_id, external_run_id, provider_state, status, started_at, ended_at, records_processed, records_rejected, error_category, error_redacted, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (connect_job_id, external_run_id) DO UPDATE SET provider_state = EXCLUDED.provider_state, status = EXCLUDED.status,
             started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, records_processed = EXCLUDED.records_processed, records_rejected = EXCLUDED.records_rejected,
             error_category = EXCLUDED.error_category, error_redacted = EXCLUDED.error_redacted, raw = EXCLUDED.raw, synced_at = now()`,
          [
            t.workspaceId, jobRow.rows[0]!.id, runId, providerState, status, started, ended,
            num(detail.recordsProcessed ?? r.recordsProcessed), num(detail.recordsRejected ?? r.recordsRejected ?? r.recordsFailed), categorizeError(errorText), errorText,
            JSON.stringify({ _diagnostics: { logs, warning: detailWarnings.length ? detailWarnings.join('; ') : null } }),
          ]
        )
      );
      runs++;
    }
  }
  return { jobs: jobs.length, runs, warnings };
}

export function connectPullHandler(factory: ResponsysClientFactory): JobHandler {
  return async (job, { db, heartbeat }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, tx => loadConn(tx, String(job.payload.connectionId)));
    if (conn.status === 'disabled') throw new PermanentJobError('Connection is disabled');
    const mark = async (status: string, detail: string | null) => db.withTenant(t, async tx => {
      await tx.query(`UPDATE connections SET capabilities = jsonb_set(capabilities, '{connect_sync}', $2::jsonb) WHERE id = $1`, [conn.id, JSON.stringify({ status, detail, checkedAt: new Date().toISOString() })]);
      await publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: 'connection.health', resourceId: conn.id, payload: { status } });
    });
    await mark('running', 'Pulling Connect jobs, run status and failure logs');
    try {
      const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
      const out = await syncConnect(db, t, conn, client, String(job.payload.from), String(job.payload.to), heartbeat);
      await mark(out.warnings.length ? 'partial' : 'available', `Pulled ${out.jobs} jobs and ${out.runs} runs` + (out.warnings.length ? `. ${out.warnings.length} history/detail requests were unavailable. Charts include retrieved runs. ${out.warnings.slice(0, 5).join('; ')}` : ''));
      return out;
    } catch (e) {
      await mark('unavailable', safeError(e));
      if (e instanceof ResponsysError && !e.retryable) throw new PermanentJobError(safeError(e));
      throw e;
    }
  };
}

// ---------------------------------------------------------------- reporting partitions
/** Splits an inclusive date range into ≤30-day inclusive partitions without overlap. */
export function planPartitions(fromIso: string, toIso: string, maxDays = REPORTING_MAX_SPAN_DAYS): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = fromIso;
  while (start <= toIso) {
    const endCandidate = addDays(start, maxDays - 1);
    const end = endCandidate < toIso ? endCandidate : toIso;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

const SUBMISSIONS_PER_MINUTE = 5;

async function submitDue(db: Db, t: { workspaceId: string }, conn: ConnRow, client: ResponsysClient, syncRunId: string) {
  const planned = await db.withTenant(t, (tx) =>
    tx.query<{ id: string; channel: 'email'; send_from_date: string; send_to_date: string }>(
      `SELECT id, channel, send_from_date, send_to_date FROM reporting_requests WHERE sync_run_id = $1 AND status = 'planned' ORDER BY send_from_date`,
      [syncRunId]
    )
  );
  for (const p of planned.rows) {
    const recent = await db.withTenant(t, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM reporting_requests WHERE connection_id = $1 AND submitted_at > now() - interval '1 minute'`, [conn.id])
    );
    if (recent.rows[0]!.n >= SUBMISSIONS_PER_MINUTE) return false;
    const requestId = await client.createPerformanceRequest(p.channel, { sendFromDate: p.send_from_date, sendToDate: p.send_to_date });
    // Persist the provider request ID before waiting, so a restart resumes polling.
    await db.withTenant(t, (tx) =>
      tx.query(`UPDATE reporting_requests SET status = 'submitted', provider_request_id = $2, attempts = attempts + 1, submitted_at = now(), updated_at = now() WHERE id = $1`, [p.id, requestId])
    );
  }
  return true;
}

async function pollSubmitted(db: Db, t: { workspaceId: string }, client: ResponsysClient, syncRunId: string) {
  const open = await db.withTenant(t, (tx) =>
    tx.query<{ id: string; provider_request_id: string; send_from_date: string; send_to_date: string; channel: string; connection_id: string; account_id: string }>(
      `SELECT id, provider_request_id, send_from_date, send_to_date, channel, connection_id, account_id FROM reporting_requests
        WHERE sync_run_id = $1 AND status IN ('submitted', 'pending')`,
      [syncRunId]
    )
  );
  for (const p of open.rows) {
    const res = await client.pollPerformanceRequest(p.provider_request_id);
    if (res.state === 'pending') {
      await db.withTenant(t, (tx) => tx.query(`UPDATE reporting_requests SET status = 'pending', updated_at = now() WHERE id = $1`, [p.id]));
      continue;
    }
    const { rows, unknownShape } = extractReportingRows(res.payload);
    if (unknownShape) {
      await db.withTenant(t, (tx) =>
        tx.query(`UPDATE reporting_requests SET status = 'failed', error = $2, bytes = $3, updated_at = now() WHERE id = $1`, [
          p.id,
          'The reporting result did not match a recognised row schema (campaign name and launch date are required); nothing was imported.',
          res.bytes,
        ])
      );
      continue;
    }
    if (rows.length >= REPORTING_ROW_CEILING) {
      // Possibly truncated: never accept it. Split the range, or fail the smallest partition.
      const days = diffDays(p.send_from_date, addDays(p.send_to_date, 1));
      await db.withTenant(t, async (tx) => {
        if (days <= 1) {
          await tx.query(`UPDATE reporting_requests SET status = 'failed', row_count = $2, error = $3, updated_at = now() WHERE id = $1`, [
            p.id,
            rows.length,
            `One day returned ${REPORTING_ROW_CEILING.toLocaleString('en-US')} rows (the documented ceiling); the result may be incomplete and was not imported.`,
          ]);
          return;
        }
        const mid = addDays(p.send_from_date, Math.floor(days / 2) - 1);
        await tx.query(`UPDATE reporting_requests SET status = 'split', row_count = $2, updated_at = now() WHERE id = $1`, [p.id, rows.length]);
        for (const [from, to] of [[p.send_from_date, mid], [addDays(mid, 1), p.send_to_date]] as const) {
          await tx.query(
            `INSERT INTO reporting_requests (workspace_id, connection_id, account_id, channel, send_from_date, send_to_date, status, sync_run_id) VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7)`,
            [t.workspaceId, p.connection_id, p.account_id, p.channel, from, to, syncRunId]
          );
        }
      });
      continue;
    }
    await db.withTenant(t, (tx) =>
      tx.query(`UPDATE reporting_requests SET status = 'received', row_count = $2, bytes = $3, result = $4, updated_at = now() WHERE id = $1`, [p.id, rows.length, res.bytes, JSON.stringify(rows)])
    );
  }
}

/** Activates a new reporting dataset version: refreshed range replaced, older history kept. */
async function activateReporting(db: Db, t: { workspaceId: string }, conn: ConnRow, syncRunId: string, from: string, to: string, actorId: string | null) {
  return db.withTenant(t, async (tx) => {
    const parts = await tx.query<{ id: string; result: { campaignName: string; campaignId: string | null; launchId: string | null; launchDate: string; measures: Record<string, string | null> }[] }>(
      `SELECT id, result FROM reporting_requests WHERE sync_run_id = $1 AND status = 'received'`,
      [syncRunId]
    );
    let datasetId = conn.reporting_dataset_id;
    if (!datasetId) {
      const ds = await tx.query<{ id: string }>(
        `INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis, created_by) VALUES ($1, $2, 'Responsys reporting (email)', 'responsys_reporting', 'campaign_launch', 'send_cohort', $3) RETURNING id`,
        [t.workspaceId, conn.account_id, actorId]
      );
      datasetId = ds.rows[0]!.id;
      await tx.query('UPDATE connections SET reporting_dataset_id = $2 WHERE id = $1', [conn.id, datasetId]);
    }
    const prev = await tx.query<{ id: string; coverage_start: string | null; coverage_end_exclusive: string | null }>(
      `SELECT id, coverage_start, coverage_end_exclusive FROM dataset_versions WHERE dataset_id = $1 AND status = 'active'`,
      [datasetId]
    );
    const next = await tx.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM dataset_versions WHERE dataset_id = $1', [datasetId]);
    const endEx = addDays(to, 1);
    const p = prev.rows[0];
    const covStart = p?.coverage_start && p.coverage_start < from ? p.coverage_start : from;
    const covEnd = p?.coverage_end_exclusive && p.coverage_end_exclusive > endEx ? p.coverage_end_exclusive : endEx;
    const ver = await tx.query<{ id: string }>(
      `INSERT INTO dataset_versions (workspace_id, dataset_id, account_id, version, status, timezone, currency, source_as_of, coverage_start, coverage_end_exclusive, quality, content_signature, created_by)
       VALUES ($1, $2, $3, $4, 'staged', $5, $6, now(), $7, $8, $9, $10, $11) RETURNING id`,
      [t.workspaceId, datasetId, conn.account_id, next.rows[0]!.v, conn.timezone, conn.currency, covStart, covEnd,
        JSON.stringify({ limitations: ['Provider-attributed aggregate reporting; field meanings follow Oracle\'s reporting definitions.'], semantics: { source: 'responsys_reporting' } }), `sync:${syncRunId}`, actorId]
    );
    const versionId = ver.rows[0]!.id;
    if (p) {
      // Keep history outside the refreshed range; the refreshed range is replaced, not added to.
      await tx.query(
        `INSERT INTO campaign_launch_facts (workspace_id, account_id, dataset_version_id, campaign_id, launch_external_id, channel, launch_date, fact_date, campaign_name, program, subject_line, currency,
           sent, delivered, skipped, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, orders, revenue, unsubscribes, complaints, source_row)
         SELECT workspace_id, account_id, $2, campaign_id, launch_external_id, channel, launch_date, fact_date, campaign_name, program, subject_line, currency,
           sent, delivered, skipped, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, orders, revenue, unsubscribes, complaints, source_row
           FROM campaign_launch_facts WHERE dataset_version_id = $1 AND (launch_date < $3 OR launch_date >= $4)`,
        [p.id, versionId, from, endEx]
      );
    }
    let row = 0;
    const seen = new Set<string>();
    for (const part of parts.rows) {
      for (const r of part.result) {
        const ext = r.campaignId ?? r.campaignName;
        const key = `${ext}|${r.launchId ?? ''}|${r.launchDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const camp = await tx.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, account_id, external_id, name, channel) VALUES ($1, $2, $3, $4, 'Email')
           ON CONFLICT (workspace_id, account_id, external_id) DO UPDATE SET updated_at = now() RETURNING id`,
          [t.workspaceId, conn.account_id, ext.slice(0, 200), r.campaignName]
        );
        const m = r.measures;
        await tx.query(
          `INSERT INTO campaign_launch_facts (workspace_id, account_id, dataset_version_id, campaign_id, launch_external_id, channel, launch_date, campaign_name, currency,
             sent, delivered, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, revenue, unsubscribes, complaints, source_row)
           VALUES ($1, $2, $3, $4, $5, 'Email', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [t.workspaceId, conn.account_id, versionId, camp.rows[0]!.id, r.launchId, r.launchDate, r.campaignName, conn.currency,
            m.sent, m.delivered, m.bounces, m.totalOpens, m.uniqueOpens, m.totalClicks, m.uniqueClicks, m.conversionEvents, m.revenue, m.unsubscribes, m.complaints, ++row]
        );
      }
    }
    const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM campaign_launch_facts WHERE dataset_version_id = $1', [versionId]);
    await tx.query('UPDATE dataset_versions SET row_count = $2 WHERE id = $1', [versionId, count.rows[0]!.n]);
    await tx.query(`UPDATE reporting_requests SET status = 'activated', updated_at = now() WHERE sync_run_id = $1 AND status = 'received'`, [syncRunId]);
    const revision = await activateVersion(tx, { workspaceId: t.workspaceId, userId: actorId }, datasetId, versionId, 'sync');
    await tx.query(`UPDATE connections SET last_successful_sync_at = now(), capabilities = jsonb_set(capabilities, '{reporting}', $2) WHERE id = $1`, [
      conn.id,
      JSON.stringify({ status: 'available', detail: null, checkedAt: new Date().toISOString() }),
    ]);
    return { datasetId, versionId, revision, rows: count.rows[0]!.n };
  });
}

export function syncHandler(factory: ResponsysClientFactory, cfg: Pick<AppConfig, 'SYNC_RECONCILIATION_LOOKBACK_DAYS'>): JobHandler {
  return async (job, { db, heartbeat }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, (tx) => loadConn(tx, String(job.payload.connectionId)));
    if (!['available', 'degraded'].includes(conn.status)) throw new PermanentJobError(`Connection is ${conn.status}; run a connection test first`);
    const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
    const syncRunId = String(job.payload.syncRunId ?? '') || randomUUID();
    const today = localDate(new Date(), conn.timezone);
    const to = String(job.payload.to ?? addDays(today, -1));
    const from = String(job.payload.from ?? addDays(today, -Math.max(1, cfg.SYNC_RECONCILIATION_LOOKBACK_DAYS)));
    await db.withTenant(t, (tx) => tx.query('UPDATE connections SET last_sync_attempt_at = now() WHERE id = $1', [conn.id]));

    try {
      let connect: { jobs: number; runs: number } | { error: string } = { jobs: 0, runs: 0 };
      if (!job.payload.syncRunId) {
        try {
          connect = await syncConnect(db, t, conn, client, from, to);
        } catch (e) {
          if (e instanceof ResponsysError && !e.retryable) connect = { error: safeError(e) };
          else throw e;
        }
        await db.withTenant(t, async (tx) => {
          for (const part of planPartitions(from, to)) {
            await tx.query(
              `INSERT INTO reporting_requests (workspace_id, connection_id, account_id, channel, send_from_date, send_to_date, status, sync_run_id) VALUES ($1, $2, $3, 'email', $4, $5, 'planned', $6)`,
              [t.workspaceId, conn.id, conn.account_id, part.from, part.to, syncRunId]
            );
          }
        });
      }
      await submitDue(db, t, conn, client, syncRunId);
      await heartbeat();
      await pollSubmitted(db, t, client, syncRunId);
      const state = await db.withTenant(t, (tx) =>
        tx.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM reporting_requests WHERE sync_run_id = $1 GROUP BY status', [syncRunId])
      );
      const by = Object.fromEntries(state.rows.map((r) => [r.status, r.n]));
      const outstanding = (by.planned ?? 0) + (by.submitted ?? 0) + (by.pending ?? 0);
      if (outstanding > 0) {
        // Accepted is not complete: poll again later from durable state.
        await db.withTenant(t, (tx) =>
          enqueueJob(tx, { workspaceId: t.workspaceId, type: 'responsys.sync', payload: { connectionId: conn.id, syncRunId, from, to }, runAfter: new Date(Date.now() + 60_000), createdBy: job.created_by, dedupeKey: `sync-poll:${syncRunId}` })
        );
        await db.withTenant(t, (tx) => publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: 'sync.status', resourceId: conn.id, payload: { state: 'waiting_for_provider', outstanding } }));
        return { state: 'waiting_for_provider', outstanding, connect };
      }
      if (by.failed) {
        await db.withTenant(t, async (tx) => {
          await tx.query('UPDATE connections SET last_error = $2 WHERE id = $1', [conn.id, `${by.failed} reporting partition(s) failed; no new version was activated`]);
          await publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: 'sync.status', resourceId: conn.id, payload: { state: 'partial_failure', failed: by.failed } });
        });
        return { state: 'partial_failure', failed: by.failed, connect };
      }
      const activated = await activateReporting(db, t, conn, syncRunId, from, to, job.created_by);
      await db.withTenant(t, (tx) => publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: 'sync.status', resourceId: conn.id, payload: { state: 'completed', rows: activated.rows } }));
      return { state: 'completed', ...activated, connect };
    } catch (e) {
      if (e instanceof ResponsysError) {
        await db.withTenant(t, (tx) => tx.query('UPDATE connections SET last_error = $2, status = CASE WHEN $3 THEN status ELSE $4 END WHERE id = $1', [conn.id, safeError(e), e.retryable, e.kind === 'auth' ? 'denied' : 'degraded']));
        if (!e.retryable) throw new PermanentJobError(safeError(e));
      }
      throw e;
    }
  };
}

export function responsysJobHandlers(deps: { cfg: AppConfig; responsys: ResponsysClientFactory }): Record<string, JobHandler> {
  return {
    'responsys.check': checkHandler(deps.responsys),
    'responsys.connect': connectPullHandler(deps.responsys),
    'responsys.sync': syncHandler(deps.responsys, deps.cfg),
  };
}
