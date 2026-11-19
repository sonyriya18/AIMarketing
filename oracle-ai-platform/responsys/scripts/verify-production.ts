/**
 * Production readiness checks against the CURRENT environment. Every check executes; the script
 * exits non-zero if any fails. Run it with the production environment loaded.
 */
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';
import { loadConfig } from '../server/config';
import { Db } from '../server/db/pool';
import { FilesystemStorage } from '../server/integrations/storage/storage';

dotenv.config({ path: ['.env.production', '.env'], quiet: true });
const results: [string, boolean, string][] = [];
const check = async (name: string, fn: () => Promise<string | void>) => {
  try {
    results.push([name, true, (await fn()) ?? '']);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

let cfg: ReturnType<typeof loadConfig> | null = null;
await check('configuration is valid for production', async () => {
  if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production');
  cfg = loadConfig();
  if (!cfg.isProduction) throw new Error('not a production configuration');
  return `auth=${cfg.AUTH_MODE}, data mode=${cfg.APP_DATA_MODE}, AI=${cfg.AI_PROVIDER}`;
});
await check('runtime database role cannot bypass RLS', async () => {
  if (!cfg) throw new Error('skipped: invalid configuration');
  const db = new Db(cfg.DATABASE_URL, 1);
  try {
    await db.assertRuntimeRoleIsSafe();
  } finally {
    await db.close();
  }
});
await check('all migrations are applied', async () => {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is needed to read schema_migrations');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir('server/db/migrations')).filter((f) => f.endsWith('.sql'));
    const missing = files.filter((f) => !rows.some((r) => r.name === f));
    if (missing.length) throw new Error(`pending: ${missing.join(', ')}`);
    return `${rows.length} applied`;
  } finally {
    await c.end();
  }
});
await check('object storage is writable', async () => {
  if (!cfg) throw new Error('skipped: invalid configuration');
  if (!(await new FilesystemStorage(cfg.STORAGE_ROOT).healthy())) throw new Error(`${cfg.STORAGE_ROOT} is not writable`);
});
await check('production builds exist', async () => {
  await access('dist/index.html');
  await access('dist-server/index.js');
  await access('dist-server/worker.js');
});
await check('no demo/fixture/dev code in production entry points', async () => {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/verify-no-demo.ts'], { stdio: 'pipe' });
});

for (const [name, ok, detail] of results) console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
const failed = results.filter((r) => !r[1]).length;
console.log(failed ? `${failed} check(s) failed` : 'all production checks passed');
process.exit(failed ? 1 : 0);
