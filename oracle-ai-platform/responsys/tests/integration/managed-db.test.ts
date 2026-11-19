/**
 * Managed-database bootstrap (Netlify Database style: one owner login, no superuser).
 * Runs only when TEST_OWNER_ROLE_MODE_URL points at such a database; the rest of the
 * integration suite then also runs through DATABASE_RUNTIME_ROLE against it.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { prepareManagedDatabase, RUNTIME_ROLE } from '../../server/platform/prepare';
import { Db } from '../../server/db/pool';
import { EMBEDDED_MIGRATIONS } from '../../server/db/migrations.generated';

const url = process.env.TEST_OWNER_ROLE_MODE_URL;

describe.skipIf(!url)('managed database preparation', () => {
  it('is idempotent under concurrent cold starts and returns one stable secret', async () => {
    const results = await Promise.all([prepareManagedDatabase(url!), prepareManagedDatabase(url!), prepareManagedDatabase(url!)]);
    const secrets = new Set(results.map((r) => r.sessionSecret));
    expect(secrets.size).toBe(1);
    expect([...secrets][0]!.length).toBeGreaterThanOrEqual(32);
    expect((await prepareManagedDatabase(url!)).sessionSecret).toBe(results[0]!.sessionSecret);
  });

  it('runs application queries as the non-owner role, which cannot read platform secrets', async () => {
    const db = new Db(url!, 2, { runtimeRole: RUNTIME_ROLE });
    try {
      await expect(db.assertRuntimeRoleIsSafe()).resolves.toBeUndefined();
      const who = await db.query<{ u: string }>('SELECT current_user AS u');
      expect(who.rows[0]?.u).toBe(RUNTIME_ROLE);
      await expect(db.query('SELECT value FROM rci_platform_secrets')).rejects.toThrow(/permission denied/);
      expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts')).rows[0]?.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('the same login without the runtime role is refused as unsafe (owner bypasses RLS)', async () => {
    const db = new Db(url!, 1);
    try {
      await expect(db.assertRuntimeRoleIsSafe()).rejects.toThrow(/bypasses row-level security/);
    } finally {
      await db.close();
    }
  });

  it('records every embedded migration', async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    await c.end();
    expect(rows.map((r) => r.name)).toEqual(EMBEDDED_MIGRATIONS.map((m) => m.name));
    expect(rows.map((r) => r.name)).toContain('003_content_offer.sql');
  });
});
