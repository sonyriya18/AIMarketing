/**
 * Express application factory. No listen() side effects, so tests can mount it directly.
 * Production static serving and the development Vite middleware are attached by the
 * entry points (`server/index.ts`, `server/dev.ts`), never here.
 */
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { ObjectStorage } from './integrations/storage/storage';
import { errorHandler, AppError } from './http/errors';
import { csrfProtection, sessionMiddleware } from './auth/sessions';
import { identityRoutes } from './modules/identity/routes';
import { importRoutes } from './modules/imports/routes';
import { datasetRoutes } from './modules/datasets/routes';
import { reportRoutes } from './modules/reports/routes';
import { eventRoutes } from './modules/events/routes';
import { connectionRoutes } from './modules/connections/routes';
import { connectDiagnosticsRoutes } from './modules/connections/diagnostics';
import { scenarioRoutes } from './modules/scenarios/routes';
import { draftRoutes } from './modules/drafts/routes';
import { chatRoutes } from './modules/chat/routes';
import { insightRoutes } from './modules/insights/routes';
import type { ResponsysClientFactory } from './integrations/responsys/client';
import type { AiProvider } from './integrations/ai/provider';
import type { Clock } from '../shared/time/clock';
import { systemClock } from '../shared/time/clock';

export interface AppDeps {
  cfg: AppConfig;
  db: Db;
  storage: ObjectStorage;
  ai?: AiProvider;
  clock?: Clock;
  responsys?: ResponsysClientFactory;
}

export function createApp(deps: AppDeps): Express {
  const { cfg, db, storage } = deps;
  const clock = deps.clock ?? systemClock;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: cfg.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
              connectSrc: ["'self'"],
              frameSrc: ["'self'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // Public liveness/readiness: report dependency health without disclosing configuration.
  app.get('/api/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, res) => {
    const [database, objectStorage] = await Promise.all([db.ping(), storage.healthy()]);
    const ok = database && objectStorage;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks: { database, objectStorage } });
  });

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
  api.use(express.json({ limit: '1mb' }));
  api.use(sessionMiddleware(db));
  api.use(csrfProtection(['/auth/dev-login', '/auth/logout']));
  api.use(identityRoutes(cfg, db));
  api.use(importRoutes({ cfg, db, storage }));
  api.use(datasetRoutes({ db }));
  api.use(reportRoutes({ db, clock }));
  if (cfg.LIVE_UPDATES === 'poll') {
    // Serverless hosts cannot hold long-lived streams; clients poll GET /events instead.
    api.get('/events/stream', (_req, res) => res.status(503).json({ error: { code: 'dependency_unavailable', message: 'Live stream disabled; poll /api/v1/events' } }));
  }
  api.use(eventRoutes({ db }));
  api.use(connectionRoutes({ cfg, db, responsys: deps.responsys }));
  api.use(connectDiagnosticsRoutes(db));
  api.use(scenarioRoutes({ db }));
  api.use(draftRoutes({ cfg, db }));
  api.use(chatRoutes({ cfg, db, ai: deps.ai, clock }));
  api.use(insightRoutes({ cfg, db, ai: deps.ai, clock }));
  app.use('/api/v1', api);

  app.use('/api', (_req, _res, next) => next(new AppError('not_found', 'API route not found')));
  app.use(errorHandler);
  return app;
}
