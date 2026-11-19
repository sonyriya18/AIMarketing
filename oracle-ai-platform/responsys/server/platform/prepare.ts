/**
 * Prepares a managed PostgreSQL database that provides a single owner login (for example
 * Netlify Database): creates the non-owner runtime role, lets the owner switch to it
 * (`SET LOCAL ROLE`), applies the embedded migrations, and provisions a server-generated
 * session secret that never leaves the database. Idempotent and safe under concurrent starts.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../db/migrate';
import { EMBEDDED_MIGRATIONS } from '../db/migrations.generated';
import { logger } from '../observability/logger';

export const RUNTIME_ROLE = 'rci_app';

export async function prepareManagedDatabase(ownerUrl: string): Promise<{ sessionSecret: string }> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727273)');
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
    if (!role.rows[0]) {
      await client.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      logger.info('created runtime role', { role: RUNTIME_ROLE });
    } else if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error(`Role ${RUNTIME_ROLE} exists but bypasses row-level security; refusing to use it`);
    }
    // PostgreSQL 16+ separates membership from the right to SET ROLE (a CREATEROLE creator
    // only gets ADMIN), so ask for SET explicitly there.
    const v = (await client.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v")).rows[0]!.v;
    const priv = v >= 160000 ? 'SET' : 'MEMBER';
    const can = await client.query<{ ok: boolean }>(`SELECT pg_has_role(current_user, $1, '${priv}') AS ok`, [RUNTIME_ROLE]);
    if (!can.rows[0]?.ok) await client.query(`GRANT ${RUNTIME_ROLE} TO CURRENT_USER${v >= 160000 ? ' WITH SET TRUE, INHERIT FALSE' : ''}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
    throw err;
  }

  try {
    await migrate(ownerUrl, (m) => logger.info('migration', { m }), EMBEDDED_MIGRATIONS);

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS rci_platform_secrets (
      name text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`REVOKE ALL ON rci_platform_secrets FROM PUBLIC, ${RUNTIME_ROLE}`);
    await client.query(`INSERT INTO rci_platform_secrets (name, value) VALUES ('session_secret', $1) ON CONFLICT (name) DO NOTHING`, [
      randomBytes(48).toString('base64url'),
    ]);
    const { rows } = await client.query<{ value: string }>(`SELECT value FROM rci_platform_secrets WHERE name = 'session_secret'`);
    await client.query('COMMIT');
    return { sessionSecret: rows[0]!.value };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
