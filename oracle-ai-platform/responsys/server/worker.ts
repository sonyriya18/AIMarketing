/**
 * Background worker entry: claims durable jobs and runs scheduled source synchronization.
 */
import { bootstrap } from './runtime';
import { logger } from './observability/logger';
import { startScheduler } from './modules/connections/scheduler';

// Compiled entry points run in production mode unless explicitly told otherwise.
process.env.NODE_ENV ??= 'production';

const rt = await bootstrap();
const runner = rt.runner();
runner.start();
const scheduler = startScheduler(rt.db, rt.cfg);
logger.info('worker started', { workerId: runner.workerId });

const shutdown = async (signal: string) => {
  logger.info('worker stopping', { signal });
  scheduler.stop();
  await runner.stop();
  await rt.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
