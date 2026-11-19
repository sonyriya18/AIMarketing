/**
 * Database access. Every tenant-owned query runs inside `withTenant`, which opens a
 * transaction and sets transaction-local `app.workspace_id` / `app.user_id` so PostgreSQL
 * row-level security applies even if a query forgets a WHERE clause. Settings are
 * transaction-local (`set_config(..., true)`), so they cannot leak through pooled connections.
 *
 * Runtime-role mode (managed databases that hand out a single owner login, e.g. Netlify
 * Database): every transaction starts with `SET LOCAL ROLE <runtimeRole>`, so queries run as
 * the non-owner role and RLS applies exactly as with a dedicated runtime login. All application
 * queries go through `transaction()`/`query()`; the raw pool is not used for tenant data.
 */
import pg from 'pg';

// NUMERIC stays a string (exact); bigint (int8) counts also stay strings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
// DATE stays 'YYYY-MM-DD' — never shifted through a JS Date in the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Tx = pg.PoolClient;

export interface TenantContext {
  workspaceId: string;
  userId?: string | null;
}

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export class Db {
  readonly pool: pg.Pool;
  private readonly runtimeRole: string | null;

  constructor(connectionString: string, max = 10, opts: { runtimeRole?: string | null } = {}) {
    if (opts.runtimeRole && !ROLE_RE.test(opts.runtimeRole)) throw new Error('Invalid runtime role name');
    this.runtimeRole = opts.runtimeRole || null;
    this.pool = new pg.Pool({ connectionString, max, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 });
  }

  /** One statement outside tenant context (system functions, health). Runs as the runtime role. */
  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    if (!this.runtimeRole) return this.pool.query<R>(sql, params);
    return this.transaction(null, (tx) => tx.query<R>(sql, params));
  }

  /** Transaction without tenant context: only identity tables (users, sessions) are visible. */
  async withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(null, fn);
  }

  /** Transaction scoped to one user (sees only that user's memberships/workspaces). */
  async withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction({ userId }, fn);
  }

  async withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!ctx.workspaceId) throw new Error('withTenant requires a workspaceId');
    return this.transaction(ctx, fn);
  }

  private async transaction<T>(ctx: { workspaceId?: string; userId?: string | null } | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (this.runtimeRole) await client.query(`SET LOCAL ROLE ${this.runtimeRole}`);
      if (ctx?.workspaceId) await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      if (ctx?.userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Refuse to run the application as a role that would bypass row-level security. */
  async assertRuntimeRoleIsSafe(): Promise<void> {
    const { rows } = await this.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
              EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'accounts' AND t.tableowner = r.rolname) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`
    );
    const r = rows[0];
    if (!r) throw new Error('Could not inspect the database role');
    if (r.rolsuper || r.rolbypassrls || r.owns) {
      throw new Error(
        `Database role "${r.rolname}" bypasses row-level security (superuser, BYPASSRLS, or table owner). ` +
          'Connect the application as the non-owner runtime role (rci_app).'
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
