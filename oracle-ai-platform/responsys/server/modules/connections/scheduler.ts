/**
 * Enqueues scheduled syncs for connections that opted in. The schedule is application policy
 * (SYNC_REPORTING_INTERVAL_MINUTES), not a statement about how fresh Oracle's data is.
 */
import type { AppConfig } from '../../config';
import type { Db } from '../../db/pool';
import { enqueueJob } from '../../jobs/queue';
import { logger } from '../../observability/logger';

/** One scheduling pass: enqueue a sync for every connection that is due. */
export async function schedulerTick(db: Db, cfg: AppConfig): Promise<void> {
  try {
    const { rows } = await db.query<{ workspace_id: string; connection_id: string }>('SELECT * FROM rci_due_connections($1)', [cfg.SYNC_REPORTING_INTERVAL_MINUTES]);
    for (const r of rows) {
      await db.withTenant({ workspaceId: r.workspace_id }, async (tx) => {
        await tx.query('UPDATE connections SET last_sync_attempt_at = now() WHERE id = $1', [r.connection_id]);
        await enqueueJob(tx, { workspaceId: r.workspace_id, type: 'responsys.sync', payload: { connectionId: r.connection_id }, dedupeKey: `sync:${r.connection_id}` });
      });
    }
  } catch (e) {
    logger.warn('scheduler tick failed', { error: (e as Error).message });
  }
}

export function startScheduler(db: Db, cfg: AppConfig) {
  const tick = () => schedulerTick(db, cfg);
  const timer = setInterval(tick, 60_000);
  void tick();
  return { stop: () => clearInterval(timer) };
}
