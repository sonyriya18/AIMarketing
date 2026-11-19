/**
 * Integration-test harness: the real Express app against the real PostgreSQL test database
 * (runtime role rci_app), with filesystem storage in a temporary directory. Each test creates its
 * own workspaces, so tests do not depend on each other's data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import request from 'supertest';
import type { Express } from 'express';
import { createApp, type AppDeps } from '../../server/app';
import { loadConfig, type AppConfig } from '../../server/config';
import { Db } from '../../server/db/pool';
import { FilesystemStorage } from '../../server/integrations/storage/storage';
import { JobRunner } from '../../server/jobs/queue';
import { buildHandlers } from '../../server/jobs/handlers';
import { configureLogger } from '../../server/observability/logger';
import { fixedClock, type Clock } from '../../shared/time/clock';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
configureLogger({ level: 'error' });

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Owner-login + SET ROLE mode (managed databases such as Netlify Database) when
  // TEST_OWNER_ROLE_MODE_URL is set: the same suite then runs through DATABASE_RUNTIME_ROLE.
  const roleModeUrl = process.env.TEST_OWNER_ROLE_MODE_URL;
  const url = roleModeUrl || process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set — run npm run setup:local');
  return {
    NODE_ENV: 'test',
    APP_DATA_MODE: 'test',
    DATABASE_URL: url,
    ...(roleModeUrl ? { DATABASE_RUNTIME_ROLE: 'rci_app' } : {}),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
    AUTH_MODE: 'dev',
    ALLOW_WORKSPACE_CREATION: 'true',
    STORAGE_ROOT: mkdtempSync(path.join(tmpdir(), 'rci-objects-')),
    APP_BASE_URL: 'http://localhost:3000',
    ...overrides,
  };
}

export interface Harness {
  app: Express;
  cfg: AppConfig;
  db: Db;
  storage: FilesystemStorage;
  runner: JobRunner;
  drainJobs: () => Promise<number>;
  close: () => Promise<void>;
}

export function createHarness(opts: { clock?: Clock; env?: Record<string, string>; deps?: Partial<AppDeps> } = {}): Harness {
  const cfg = loadConfig(testEnv(opts.env));
  const db = new Db(cfg.DATABASE_URL, 5, { runtimeRole: cfg.DATABASE_RUNTIME_ROLE });
  const storage = new FilesystemStorage(cfg.STORAGE_ROOT);
  const app = createApp({ cfg, db, storage, clock: opts.clock ?? fixedClock('2026-10-15T12:00:00Z'), ...opts.deps });
  const runner = new JobRunner(db, buildHandlers({ storage }), { leaseSeconds: 30 });
  return {
    app,
    cfg,
    db,
    storage,
    runner,
    drainJobs: async () => {
      let n = 0;
      while (await runner.runOnce()) n++;
      return n;
    },
    close: () => db.close(),
  };
}

export interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  email: string;
  get: (url: string) => request.Test;
  post: (url: string, body?: unknown) => request.Test;
  patch: (url: string, body?: unknown) => request.Test;
  del: (url: string) => request.Test;
  refresh: () => Promise<void>;
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 7)}@example.test`;

export async function signIn(app: Express, email = uniqueEmail()): Promise<Client> {
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/dev-login').send({ email });
  if (login.status !== 201) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const c: Client = {
    agent,
    csrf: '',
    email,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set('X-CSRF-Token', c.csrf).send(body as object),
    patch: (url, body) => agent.patch(url).set('X-CSRF-Token', c.csrf).send(body as object),
    del: (url) => agent.delete(url).set('X-CSRF-Token', c.csrf),
    refresh: async () => {
      const s = await agent.get('/api/v1/session');
      c.csrf = s.body.data.csrfToken;
    },
  };
  await c.refresh();
  return c;
}

export async function setupWorkspace(c: Client, account: { timezone?: string; currency?: string } = {}) {
  const ws = await c.post('/api/v1/workspaces', { name: `WS ${Math.random().toString(36).slice(2, 8)}` });
  if (ws.status !== 201) throw new Error(`workspace failed: ${ws.status} ${JSON.stringify(ws.body)}`);
  await c.refresh();
  const acct = await c.post('/api/v1/accounts', { name: 'Main account', timezone: account.timezone ?? 'America/New_York', currency: account.currency ?? 'USD' });
  if (acct.status !== 201) throw new Error(`account failed: ${acct.status} ${JSON.stringify(acct.body)}`);
  return { workspaceId: ws.body.data.id as string, accountId: acct.body.data.id as string };
}

export function upload(c: Client, accountId: string, content: string | Buffer, fileName = 'export.csv') {
  return c.agent
    .post(`/api/v1/accounts/${accountId}/imports`)
    .set('X-CSRF-Token', c.csrf)
    .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), { filename: fileName, contentType: 'text/csv' });
}
