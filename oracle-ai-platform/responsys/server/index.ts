/**
 * Production HTTP entry. Serves the compiled SPA from dist/ and the API. Never imports Vite.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app';
import { bootstrap } from './runtime';
import { logger } from './observability/logger';

process.env.NODE_ENV ??= 'production';
const rt = await bootstrap();
const app = createApp({ cfg: rt.cfg, db: rt.db, storage: rt.storage, ai: rt.ai, responsys: rt.responsys });
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-store') }));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const runner = rt.cfg.RUN_WORKER_IN_PROCESS ? rt.runner() : null;
runner?.start();
const server = app.listen(rt.cfg.PORT, () => logger.info('api listening', { port: rt.cfg.PORT, worker: Boolean(runner) }));

const shutdown = async (signal: string) => {
  logger.info('shutting down', { signal });
  server.close();
  await runner?.stop();
  await rt.db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
