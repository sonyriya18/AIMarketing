/**
 * Shared bootstrap for the API and worker processes: validated config, database (with the
 * runtime-role safety check), storage, AI provider, job handlers. No demo data is ever seeded.
 */
import dotenv from 'dotenv';
import { loadConfig, type AppConfig } from './config';
import { Db } from './db/pool';
import { FilesystemStorage, type ObjectStorage } from './integrations/storage/storage';
import { createAiProvider, type AiProvider } from './integrations/ai/provider';
import { JobRunner } from './jobs/queue';
import { buildHandlers } from './jobs/handlers';
import { configureLogger, logger } from './observability/logger';
import { createResponsysFactory, type ResponsysClientFactory } from './integrations/responsys/client';
import { responsysJobHandlers } from './modules/connections/sync';

export interface Runtime {
  cfg: AppConfig;
  db: Db;
  storage: ObjectStorage;
  ai: AiProvider;
  responsys: ResponsysClientFactory;
  runner: () => JobRunner;
}

export interface BootstrapOptions {
  /** Storage for drivers constructed by the host platform (e.g. Netlify Blobs). */
  storage?: ObjectStorage;
  /** Pool size; serverless instances keep this small. */
  poolSize?: number;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Runtime> {
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
  const cfg = loadConfig();
  configureLogger({ level: cfg.LOG_LEVEL });
  const db = new Db(cfg.DATABASE_URL, opts.poolSize ?? 10, { runtimeRole: cfg.DATABASE_RUNTIME_ROLE });
  await db.assertRuntimeRoleIsSafe();
  if (cfg.STORAGE_DRIVER !== 'filesystem' && !opts.storage) throw new Error(`STORAGE_DRIVER=${cfg.STORAGE_DRIVER} must be provided by the host platform`);
  const storage = opts.storage ?? new FilesystemStorage(cfg.STORAGE_ROOT);
  if (!(await storage.healthy())) throw new Error(`Object storage (${cfg.STORAGE_DRIVER}) is not available`);
  const ai = createAiProvider(cfg);
  const responsys = createResponsysFactory(cfg);
  logger.info('runtime ready', { mode: cfg.APP_DATA_MODE, auth: cfg.AUTH_MODE, ai: cfg.AI_PROVIDER });
  return {
    cfg,
    db,
    storage,
    ai,
    responsys,
    runner: () => new JobRunner(db, buildHandlers({ storage, extra: responsysJobHandlers({ cfg, responsys }) })),
  };
}
