import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import type { Db } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError, notFound } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { enqueueJob } from '../../jobs/queue';
import { audit } from '../audit/audit';
import { ResponsysError, validateEndpoint, type ResponsysClientFactory } from '../../integrations/responsys/client';

const CONN_COLUMNS = `c.id, c.account_id AS "accountId", c.provider, c.display_name AS "displayName", c.login_base_url AS "loginBaseUrl",
  c.credential_ref AS "credentialRef", c.status, c.capabilities, c.service_endpoint AS "serviceEndpoint", c.last_checked_at AS "lastCheckedAt",
  c.last_error AS "lastError", c.sync_enabled AS "syncEnabled", c.reporting_dataset_id AS "reportingDatasetId",
  c.last_sync_attempt_at AS "lastSyncAttemptAt", c.last_successful_sync_at AS "lastSuccessfulSyncAt", c.created_at AS "createdAt"`;

export function connectionRoutes(deps: { cfg: AppConfig; db: Db; responsys?: ResponsysClientFactory }): Router {
  const { cfg, db } = deps;
  const r = Router();

  r.get(
    '/accounts/:accountId/connections',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const accountId = uuidParam(req, 'accountId', 'Account');
      const { rows } = await db.withTenant(t, async (tx) => {
        const a = await tx.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
        if (!a.rowCount) throw notFound('Account');
        return tx.query(`SELECT ${CONN_COLUMNS} FROM connections c WHERE c.account_id = $1 ORDER BY c.created_at`, [accountId]);
      });
      const admin = req.auth!.permissions.has('workspace.manage');
      res.json({ data: rows.map((c) => (admin ? c : { ...c, credentialRef: undefined, loginBaseUrl: undefined })) });
    })
  );

  r.post(
    '/accounts/:accountId/connections',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const accountId = uuidParam(req, 'accountId', 'Account');
      const b = parse(
        z.object({
          displayName: z.string().trim().min(1).max(120),
          loginBaseUrl: z.string().trim().url(),
          credentialRef: z.string().trim().regex(/^(file|env):[A-Za-z0-9_.-]{1,80}$/, 'Use a server-side secret reference such as env:MAIN or file:main'),
        }),
        req.body
      );
      try {
        validateEndpoint(b.loginBaseUrl, cfg.responsysAllowedHostSuffixes);
      } catch (e) {
        throw new AppError('unprocessable', (e as ResponsysError).message);
      }
      const row = await db.withTenant(t, async (tx) => {
        const a = await tx.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
        if (!a.rowCount) throw notFound('Account');
        const { rows } = await tx.query(
          `INSERT INTO connections (workspace_id, account_id, provider, display_name, login_base_url, credential_ref, created_by)
           VALUES ($1, $2, 'responsys', $3, $4, $5, $6) RETURNING id`,
          [t.workspaceId, accountId, b.displayName, new URL(b.loginBaseUrl).origin, b.credentialRef, t.userId]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'connection.create', { type: 'connection', id: rows[0].id }, 'success', { loginHost: new URL(b.loginBaseUrl).host });
        return (await tx.query(`SELECT ${CONN_COLUMNS} FROM connections c WHERE c.id = $1`, [rows[0].id])).rows[0];
      });
      res.status(201).json({ data: row });
    })
  );

  const enqueue = (type: 'responsys.check' | 'responsys.sync', permission: 'workspace.manage' | 'data.import') =>
    ah(async (req, res) => {
      const t = tenantOf(req);
      const id = uuidParam(req, 'connectionId', 'Connection');
      const jobId = await db.withTenant(t, async (tx) => {
        const c = await tx.query<{ status: string }>('SELECT status FROM connections WHERE id = $1', [id]);
        if (!c.rows[0]) throw notFound('Connection');
        if (c.rows[0].status === 'disabled') throw new AppError('conflict', 'The connection is disabled');
        if (type === 'responsys.sync' && !['available', 'degraded'].includes(c.rows[0].status)) {
          throw new AppError('conflict', 'Test the connection successfully before syncing');
        }
        if (type === 'responsys.check') await tx.query(`UPDATE connections SET status = 'checking' WHERE id = $1`, [id]);
        const jid = await enqueueJob(tx, { workspaceId: t.workspaceId, type, payload: { connectionId: id }, dedupeKey: `${type}:${id}`, maxAttempts: 3, createdBy: t.userId });
        await audit(tx, { ...t, requestId: req.requestId }, type === 'responsys.check' ? 'connection.test_requested' : 'connection.sync_requested', { type: 'connection', id }, 'success', { jobId: jid });
        return jid;
      });
      res.status(202).json({ data: { jobId, status: 'queued' } });
      void permission;
    });

  r.post('/connections/:connectionId/test', requirePermission('workspace.manage'), enqueue('responsys.check', 'workspace.manage'));
  r.post('/connections/:connectionId/sync', requirePermission('data.import'), enqueue('responsys.sync', 'data.import'));

  r.patch(
    '/connections/:connectionId',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const id = uuidParam(req, 'connectionId', 'Connection');
      const b = parse(z.object({ syncEnabled: z.boolean().optional(), disabled: z.boolean().optional() }), req.body);
      const row = await db.withTenant(t, async (tx) => {
        const c = await tx.query('SELECT 1 FROM connections WHERE id = $1', [id]);
        if (!c.rowCount) throw notFound('Connection');
        await tx.query(
          `UPDATE connections SET sync_enabled = COALESCE($2, sync_enabled),
             status = CASE WHEN $3::boolean IS TRUE THEN 'disabled' WHEN $3::boolean IS FALSE AND status = 'disabled' THEN 'not_checked' ELSE status END
           WHERE id = $1`,
          [id, b.syncEnabled ?? null, b.disabled ?? null]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'connection.update', { type: 'connection', id }, 'success', b);
        return (await tx.query(`SELECT ${CONN_COLUMNS} FROM connections c WHERE c.id = $1`, [id])).rows[0];
      });
      res.json({ data: row });
    })
  );

  /** Connect diagnostics computed only from synchronized job-run records. */
  r.get(
    '/accounts/:accountId/connect-summary',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const accountId = uuidParam(req, 'accountId', 'Account');
      const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      // Period days are account-timezone calendar days: `from` and `to` are inclusive,
      // `toExclusive` is the day after the period (as report periods give it).
      const from = day(req.query.from);
      const to = day(req.query.to);
      const toExclusive = day(req.query.toExclusive);
      const out = await db.withTenant(t, async (tx) => {
        const conns = await tx.query<{ id: string; status: string; last_successful_sync_at: Date | null; capabilities: Record<string, { status: string }> }>(
          'SELECT id, status, last_successful_sync_at, capabilities FROM connections WHERE account_id = $1',
          [accountId]
        );
        if (!conns.rows.length) return { state: 'source_not_configured' as const, jobs: [], totals: null };
        const denied = conns.rows.every((c) => c.capabilities?.connect_jobs?.status === 'denied');
        const params: unknown[] = [accountId];
        let range = '';
        if (from || to || toExclusive) {
          const tz = (await tx.query<{ timezone: string }>('SELECT timezone FROM accounts WHERE id = $1', [accountId])).rows[0]?.timezone ?? 'UTC';
          params.push(tz);
          const localDay = `(COALESCE(r.started_at, r.synced_at) AT TIME ZONE $${params.length})::date`;
          if (from) {
            params.push(from);
            range += ` AND ${localDay} >= $${params.length}::date`;
          }
          if (toExclusive) {
            params.push(toExclusive);
            range += ` AND ${localDay} < $${params.length}::date`;
          } else if (to) {
            params.push(to);
            range += ` AND ${localDay} <= $${params.length}::date`;
          }
        }
        const jobs = await tx.query(
          `SELECT j.id, j.external_job_id AS "externalJobId", j.name, j.job_type AS "jobType", j.is_event_feed AS "isEventFeed", j.last_synced_at AS "lastSyncedAt",
                  count(r.id)::int AS runs,
                  count(r.id) FILTER (WHERE r.status = 'succeeded')::int AS succeeded,
                  count(r.id) FILTER (WHERE r.status = 'failed')::int AS failed,
                  count(r.id) FILTER (WHERE r.status = 'running')::int AS running,
                  max(r.ended_at) FILTER (WHERE r.status = 'succeeded') AS "lastSuccessAt",
                  sum(r.records_processed)::text AS "recordsProcessed",
                  (array_agg(r.error_redacted ORDER BY r.started_at DESC NULLS LAST) FILTER (WHERE r.status = 'failed'))[1] AS "lastError",
                  (array_agg(r.error_category ORDER BY r.started_at DESC NULLS LAST) FILTER (WHERE r.status = 'failed'))[1] AS "lastErrorCategory"
             FROM connect_jobs j LEFT JOIN connect_job_runs r ON r.connect_job_id = j.id ${range}
            WHERE j.account_id = $1 GROUP BY j.id ORDER BY failed DESC, j.name`,
          params
        );
        const totals = jobs.rows.reduce((a, j) => ({ jobs: a.jobs + 1, runs: a.runs + j.runs, succeeded: a.succeeded + j.succeeded, failed: a.failed + j.failed }), { jobs: 0, runs: 0, succeeded: 0, failed: 0 });
        return {
          state: denied ? ('permission_denied' as const) : jobs.rows.length ? ('available' as const) : ('no_jobs_synced' as const),
          jobs: jobs.rows,
          totals,
          lastSuccessfulSyncAt: conns.rows.map((c) => c.last_successful_sync_at).filter(Boolean).sort().at(-1) ?? null,
        };
      });
      res.json({ data: out });
    })
  );

  r.post(
    '/connect-jobs/:jobId/trigger',
    requirePermission('action.execute'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const id = uuidParam(req, 'jobId', 'Connect job');
      const job = await db.withTenant(t, (tx) => tx.query<{ is_event_feed: boolean }>('SELECT is_event_feed FROM connect_jobs WHERE id = $1', [id]));
      if (!job.rows[0]) throw notFound('Connect job');
      if (job.rows[0].is_event_feed) {
        throw new AppError(
          'unprocessable',
          'Oracle does not support triggering Event Feed (CED) export jobs through the API. Configure the export schedule in Responsys Connect and the next scheduled run will be picked up automatically.'
        );
      }
      throw new AppError('capability_unavailable', 'Connect job triggers are disabled in this deployment: the Responsys integration is read-only until an authorized write path is verified.');
    })
  );

  return r;
}
