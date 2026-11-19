/**
 * Development entry: the same API plus Vite middleware for the frontend. Refuses production.
 */
import { createServer as createViteServer } from 'vite';
import { createApp } from './app';
import { bootstrap } from './runtime';
import { logger } from './observability/logger';

if (process.env.NODE_ENV === 'production') {
  console.error('server/dev.ts is for development only; use npm run start:api in production');
  process.exit(1);
}
const rt = await bootstrap();
const app = createApp({ cfg: rt.cfg, db: rt.db, storage: rt.storage, ai: rt.ai, responsys: rt.responsys });
const vite = await createViteServer({ server: { middlewareMode: true, hmr: process.env.DISABLE_HMR === 'true' ? false : undefined }, appType: 'spa' });
app.use(vite.middlewares);
const runner = rt.cfg.RUN_WORKER_IN_PROCESS ? rt.runner() : null;
runner?.start();
app.listen(rt.cfg.PORT, () => logger.info('dev server listening', { url: rt.cfg.APP_BASE_URL, worker: Boolean(runner) }));
