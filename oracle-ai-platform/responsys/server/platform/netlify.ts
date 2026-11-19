/**
 * Netlify runtime: maps the platform onto the application's configuration and prepares the
 * managed database once per function instance. Defaults are production-safe and can be
 * overridden with Netlify environment variables (never with netlify.toml, which is committed).
 */
import { getStore } from '@netlify/blobs';
import { getConnectionString } from '@netlify/database';
import { bootstrap, type Runtime } from '../runtime';
import { BlobStorage } from '../integrations/storage/storage';
import { prepareManagedDatabase, RUNTIME_ROLE } from './prepare';

const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'production',
  APP_DATA_MODE: 'production',
  AUTH_MODE: 'oidc',
  STORAGE_DRIVER: 'netlify_blobs',
  LIVE_UPDATES: 'poll',
  // Netlify buffers request bodies up to 6 MB (≈4.5 MB of binary after encoding).
  UPLOAD_MAX_BYTES: '4000000',
  RUN_WORKER_IN_PROCESS: 'false',
  // Synchronous functions are stopped after about 10 s, so an AI call must give up first and let
  // the request return its rule-based answer instead of a gateway error.
  AI_TIMEOUT_MS: '9000',
};

let runtime: Promise<Runtime> | null = null;

export function netlifyRuntime(siteUrl?: string): Promise<Runtime> {
  runtime ??= init(siteUrl).catch((err) => {
    runtime = null;
    throw err;
  });
  return runtime;
}

function ownerConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return getConnectionString();
  } catch {
    if (process.env.NETLIFY_DB_URL) return process.env.NETLIFY_DB_URL;
    throw new Error('No database is provisioned for this site (Netlify Database)');
  }
}

async function init(siteUrl?: string): Promise<Runtime> {
  for (const [k, v] of Object.entries(DEFAULTS)) process.env[k] ??= v;
  process.env.APP_BASE_URL ??= process.env.URL || siteUrl;
  // A public URL with self-service workspaces must say who may sign in.
  if (!process.env.ALLOWED_SIGNIN_EMAILS?.trim() && process.env.ALLOW_ANY_SIGNIN !== 'true') {
    throw new Error('Set ALLOWED_SIGNIN_EMAILS (or ALLOW_ANY_SIGNIN=true) before the app accepts sign-ins');
  }
  const ownerUrl = ownerConnectionString();
  const { sessionSecret } = await prepareManagedDatabase(ownerUrl);
  process.env.DATABASE_URL = ownerUrl;
  process.env.DATABASE_RUNTIME_ROLE ??= RUNTIME_ROLE;
  process.env.SESSION_SECRET ??= sessionSecret;
  return bootstrap({ storage: new BlobStorage(getStore({ name: 'rci-objects', consistency: 'strong' })), poolSize: 3 });
}

/** Runs queued jobs until none are left or the time budget is spent. */
export async function drainJobs(rt: Runtime, budgetMs: number): Promise<number> {
  const runner = rt.runner();
  const end = Date.now() + budgetMs;
  let n = 0;
  while (Date.now() < end && (await runner.runOnce())) n++;
  return n;
}
