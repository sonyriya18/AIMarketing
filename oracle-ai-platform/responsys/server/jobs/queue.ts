/**
 * Durable PostgreSQL-backed job queue (decision D04).
 *
 * - Jobs are inserted in the same transaction as the business change that requests them
 *   (transactional outbox), so accepted work is never lost.
 * - Workers claim with SKIP LOCKED and hold a renewable lease; a crashed worker's job is
 *   reclaimed after its lease expires.
 * - Handlers must be idempotent: database constraints and per-job state make a retry safe.
 * - Retryable failures back off exponentially with jitter; permanent failures stop at once;
 *   exhausted attempts become `dead`.
 */
import { hostname } from 'node:os';
import type { Db, Tx } from '../db/pool';
import { logger } from '../observability/logger';

export interface JobRow {
  id: string;
  workspace_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  created_by: string | null;
}

export class PermanentJobError extends Error {}

export interface JobContext {
  db: Db;
  heartbeat: () => Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<Record<string, unknown> | void>;

export async function enqueueJob(
  tx: Tx,
  job: { workspaceId: string; type: string; payload?: Record<string, unknown>; dedupeKey?: string; maxAttempts?: number; runAfter?: Date; createdBy?: string | null }
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO jobs (workspace_id, type, payload, dedupe_key, max_attempts, run_after, created_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO UPDATE SET updated_at = now()
     RETURNING id`,
    [job.workspaceId, job.type, JSON.stringify(job.payload ?? {}), job.dedupeKey ?? null, job.maxAttempts ?? 5, job.runAfter ?? null, job.createdBy ?? null]
  );
  return rows[0]!.id;
}

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

export class JobRunner {
  readonly workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly opts: { leaseSeconds?: number; pollMs?: number } = {}
  ) {}

  get leaseSeconds() {
    return this.opts.leaseSeconds ?? 60;
  }

  start() {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (err) {
          logger.error('job loop error', { error: (err as Error).message });
        }
        if (!worked && !this.stopped) await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1000));
      }
    })();
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    await this.loop;
  }

  /** Claims and runs at most one job. Returns true when a job was processed. */
  async runOnce(): Promise<boolean> {
    const types = Object.keys(this.handlers);
    const { rows } = await this.db.query<JobRow>('SELECT * FROM rci_claim_jobs($1, $2, 1, $3)', [this.workerId, this.leaseSeconds, types]);
    const job = rows[0];
    if (!job) return false;
    const t = { workspaceId: job.workspace_id };

    if (job.attempts > job.max_attempts) {
      await this.db.withTenant(t, (tx) =>
        tx.query(`UPDATE jobs SET status = 'dead', finished_at = now(), updated_at = now(), locked_by = NULL WHERE id = $1`, [job.id])
      );
      logger.warn('job dead-lettered', { jobId: job.id, type: job.type, attempts: job.attempts });
      return true;
    }

    const handler = this.handlers[job.type]!;
    const heartbeat = async () => {
      await this.db.withTenant(t, (tx) =>
        tx.query(`UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1 AND locked_by = $2`, [
          job.id,
          this.workerId,
          this.leaseSeconds,
        ])
      );
    };
    const timer = setInterval(() => heartbeat().catch(() => undefined), Math.max(1000, (this.leaseSeconds * 1000) / 3));
    try {
      const result = await handler(job, { db: this.db, heartbeat, signal: this.abort.signal });
      await this.db.withTenant(t, (tx) =>
        tx.query(
          `UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now(), updated_at = now(), locked_by = NULL, last_error = NULL
            WHERE id = $1 AND locked_by = $3`,
          [job.id, JSON.stringify(result ?? {}), this.workerId]
        )
      );
      logger.info('job succeeded', { jobId: job.id, type: job.type, attempts: job.attempts });
    } catch (err) {
      const message = (err as Error).message?.slice(0, 1000) || 'job failed';
      const permanent = err instanceof PermanentJobError;
      const exhausted = job.attempts >= job.max_attempts;
      const providerDelay = Number((err as { retryAfterSec?: number }).retryAfterSec);
      const retryDelay = Math.max(backoffMs(job.attempts) / 1000, Number.isFinite(providerDelay) && providerDelay > 0 ? Math.min(providerDelay, 86400) : 0);
      await this.db.withTenant(t, (tx) =>
        permanent || exhausted
          ? tx.query(
              `UPDATE jobs SET status = $2, last_error = $3, finished_at = now(), updated_at = now(), locked_by = NULL WHERE id = $1`,
              [job.id, permanent ? 'failed' : 'dead', message]
            )
          : tx.query(
              `UPDATE jobs SET status = 'queued', last_error = $2, run_after = now() + make_interval(secs => $3), updated_at = now(), locked_by = NULL WHERE id = $1`,
              [job.id, message, retryDelay]
            )
      );
      logger.warn('job failed', { jobId: job.id, type: job.type, attempts: job.attempts, permanent, exhausted, error: message });
    } finally {
      clearInterval(timer);
    }
    return true;
  }
}
