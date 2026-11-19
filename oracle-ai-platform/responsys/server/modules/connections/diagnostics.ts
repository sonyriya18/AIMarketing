import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { ah, parse, uuidParam } from '../../http/util';
import { AppError, notFound } from '../../http/errors';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../audit/audit';
import { addDays, diffDays, localDate } from '../../../shared/time/zoned';
import { connectAdvice, type ConnectRun } from '../../../shared/contracts/connect';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Use a valid calendar date');
function range(input: unknown, timezone: string) {
  const v = parse(z.object({ from: day.optional(), to: day.optional() }), input);
  const to = v.to ?? localDate(new Date(), timezone);
  const from = v.from ?? addDays(to, -13);
  if (from > to || diffDays(from, addDays(to, 1)) > 90) throw new AppError('unprocessable', 'Choose a date range of 1–90 days.');
  return { from, to };
}

export function connectDiagnosticsRoutes(db: Db): Router {
  const r = Router();
  r.post('/connections/:connectionId/pull-jobs', requirePermission('data.import'), ah(async (req, res) => {
    const t = tenantOf(req), id = uuidParam(req, 'connectionId', 'Connection');
    const jobId = await db.withTenant(t, async tx => {
      const c = (await tx.query<{ status: string; timezone: string }>('SELECT c.status, a.timezone FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = $1', [id])).rows[0];
      if (!c) throw notFound('Connection');
      if (c.status === 'disabled') throw new AppError('conflict', 'Enable the connection before pulling jobs.');
      const period = range(req.body ?? {}, c.timezone);
      const jobId = await enqueueJob(tx, { workspaceId: t.workspaceId, type: 'responsys.connect', payload: { connectionId: id, ...period }, dedupeKey: `connect-pull:${id}:${period.from}:${period.to}`, maxAttempts: 3, createdBy: t.userId });
      await tx.query(`UPDATE connections SET capabilities = jsonb_set(capabilities, '{connect_sync}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify({ status: 'queued', detail: 'Waiting for the local worker', checkedAt: new Date().toISOString() })]);
      await audit(tx, { ...t, requestId: req.requestId }, 'connection.connect_pull', { type: 'connection', id }, 'success', { jobId, ...period });
      return jobId;
    });
    res.status(202).json({ data: { jobId, status: 'queued' } });
  }));

  r.get('/accounts/:accountId/connect-diagnostics', requirePermission('report.view'), ah(async (req, res) => {
    const t = tenantOf(req), id = uuidParam(req, 'accountId', 'Account');
    const data = await db.withTenant(t, async tx => {
      const account = (await tx.query<{ timezone: string }>('SELECT timezone FROM accounts WHERE id = $1', [id])).rows[0];
      if (!account) throw notFound('Account');
      const { from, to } = range(req.query, account.timezone);
      const params = [id, from, to, account.timezone];
      const filter = `j.account_id = $1 AND (r.started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
      const connections = (await tx.query(`SELECT id, display_name AS name, status, last_error AS "lastError",
        capabilities->'connect_sync'->>'checkedAt' AS "lastSyncAt", capabilities->'connect_sync'->>'status' AS "syncStatus",
        capabilities->'connect_sync'->>'detail' AS "syncDetail" FROM connections WHERE account_id = $1 ORDER BY created_at`, [id])).rows;
      const jobs = (await tx.query(`SELECT j.id, j.name, j.external_job_id AS "externalJobId", j.job_type AS "jobType", c.display_name AS "connectionName", j.last_synced_at AS "lastSyncedAt",
        count(r.id)::int AS runs, count(r.id) FILTER(WHERE r.status='succeeded')::int AS succeeded,
        count(r.id) FILTER(WHERE r.status='failed')::int AS failed, count(r.id) FILTER(WHERE r.status='running')::int AS running,
        count(r.id) FILTER(WHERE r.status='aborted')::int AS aborted, count(r.id) FILTER(WHERE r.status='unknown')::int AS unknown
        FROM connect_jobs j JOIN connections c ON c.id=j.connection_id LEFT JOIN connect_job_runs r ON r.connect_job_id=j.id
        AND (r.started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        WHERE j.account_id=$1 GROUP BY j.id,c.display_name ORDER BY failed DESC,j.name`, params)).rows;
      const trend = (await tx.query(`SELECT (r.started_at AT TIME ZONE $4)::date::text AS date,
        count(*) FILTER(WHERE r.status='succeeded')::int AS succeeded, count(*) FILTER(WHERE r.status='failed')::int AS failed,
        count(*) FILTER(WHERE r.status='running')::int AS running, count(*) FILTER(WHERE r.status='aborted')::int AS aborted,
        count(*) FILTER(WHERE r.status='unknown')::int AS unknown FROM connect_job_runs r JOIN connect_jobs j ON j.id=r.connect_job_id
        WHERE ${filter} GROUP BY 1 ORDER BY 1`, params)).rows;
      const errors = (await tx.query(`SELECT COALESCE(r.error_category,'other') AS category,count(*)::int AS count
        FROM connect_job_runs r JOIN connect_jobs j ON j.id=r.connect_job_id WHERE ${filter} AND r.status IN ('failed','aborted') GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
      const limit = 200;
      const rows = (await tx.query(`SELECT r.id, j.id AS "jobId",j.name AS "jobName",j.external_job_id AS "externalJobId",r.external_run_id AS "externalRunId",
        r.status,r.started_at AS "startedAt",r.ended_at AS "endedAt",r.records_processed::text AS "recordsProcessed",r.records_rejected::text AS "recordsRejected",
        r.error_category AS "errorCategory",r.error_redacted AS "errorMessage",COALESCE(r.raw->'_diagnostics'->'logs','[]'::jsonb) AS logs,
        r.raw->'_diagnostics'->>'warning' AS "detailWarning" FROM connect_job_runs r JOIN connect_jobs j ON j.id=r.connect_job_id
        WHERE ${filter} ORDER BY r.started_at DESC,r.id LIMIT 201`, params)).rows;
      const totals = jobs.reduce((a, j) => ({ jobs: a.jobs + 1, runs: a.runs+j.runs, succeeded: a.succeeded+j.succeeded, failed: a.failed+j.failed, running: a.running+j.running, aborted: a.aborted+j.aborted, unknown: a.unknown+j.unknown }), { jobs: 0, runs: 0, succeeded: 0, failed: 0, running: 0, aborted: 0, unknown: 0 });
      return { from, to, timezone: account.timezone, connections: connections.map(c => ({ ...c, advice: c.lastError || ['unavailable','partial'].includes(c.syncStatus) ? connectAdvice(null, `${c.lastError ?? ''} ${c.syncDetail ?? ''}`) : null })), jobs, trend, errors, totals,
        runs: rows.slice(0,limit).map(r => ({ ...r, advice: ['failed','aborted'].includes(r.status) ? connectAdvice(r.errorCategory, r.errorMessage ?? '') : null })) as ConnectRun[], runLimit: limit, truncated: rows.length > limit };
    });
    res.json({ data });
  }));
  return r;
}
