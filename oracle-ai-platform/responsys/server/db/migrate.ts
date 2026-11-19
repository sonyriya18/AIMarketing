/**
 * Applies SQL migrations in filename order as the migration (owner) role.
 * Each file is recorded with a checksum; editing an already-applied file fails the run instead
 * of silently diverging. The whole run is one transaction guarded by a transaction-level
 * advisory lock, so it is safe behind a transaction-mode connection pooler and concurrent
 * starts (several serverless instances) apply each migration exactly once.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
}

export async function readMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })));
}

export async function migrate(
  connectionString: string,
  log: (m: string) => void = console.log,
  source?: MigrationFile[]
): Promise<string[]> {
  const migrations = [...(source ?? (await readMigrationFiles()))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727272)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum])
    );
    for (const m of migrations) {
      const checksum = createHash('sha256').update(m.sql).digest('hex');
      const prior = done.get(m.name);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${m.name} was modified after being applied`);
        continue;
      }
      try {
        await client.query(m.sql);
      } catch (err) {
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, checksum]);
      applied.push(m.name);
    }
    await client.query('COMMIT');
    applied.forEach((n) => log(`applied ${n}`));
    return applied;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error('DATABASE_MIGRATION_URL (owner role) is required to run migrations');
    process.exit(1);
  }
  migrate(url)
    .then((a) => console.log(a.length ? `${a.length} migration(s) applied` : 'database is up to date'))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
