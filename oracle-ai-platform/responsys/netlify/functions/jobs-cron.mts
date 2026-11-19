/**
 * Every 5 minutes (UTC): enqueue due Responsys syncs and run queued jobs that the request-time
 * drain did not finish. Scheduled functions have a 30-second limit, so work is time-boxed.
 */
import type { Config } from '@netlify/functions';
import { drainJobs, netlifyRuntime } from '../../server/platform/netlify';
import { schedulerTick } from '../../server/modules/connections/scheduler';
import { logger } from '../../server/observability/logger';

export default async () => {
  try {
    const rt = await netlifyRuntime();
    await schedulerTick(rt.db, rt.cfg);
    const n = await drainJobs(rt, 20_000);
    if (n) logger.info('scheduled drain', { jobs: n });
  } catch (err) {
    logger.error('scheduled run failed', { error: (err as Error).message });
  }
};

export const config: Config = { schedule: '*/5 * * * *' };
