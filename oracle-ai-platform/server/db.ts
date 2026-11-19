import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import { schema, tenantTables } from "./schema";
export interface SQL {
  query<T = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}
export class Database implements SQL {
  private lite?: PGlite;
  private pool?: pg.Pool;
  private ready: Promise<void>;
  constructor(
    public cfg: Config,
    memory = false,
  ) {
    if (cfg.databaseUrl)
      this.pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 8 });
    else {
      mkdirSync(cfg.dataDir, { recursive: true });
      this.lite = new PGlite(
        memory ? "memory://" : resolve(cfg.dataDir, "postgres"),
      );
    }
    this.ready = this.initialize();
  }
  private async initialize() {
    if (this.lite) {
      await this.lite.waitReady;
      await this.lite.exec(schema);
      return;
    }
    // Migrations can be provisioned separately. Never need a database owner for normal requests.
    if (this.cfg.migrationUrl) {
      const owner = new pg.Pool({
        connectionString: this.cfg.migrationUrl,
        max: 1,
      });
      try {
        await owner.query(schema);
      } finally {
        await owner.end();
      }
    } else if (!this.cfg.production) {
      // A least-privilege runtime role cannot run DDL. Only bootstrap an empty
      // development database; a provisioned schema is left to `npm run db:migrate`.
      const { rows } = await this.pool!.query(
        "SELECT to_regclass('public.workspaces') AS t",
      );
      if (!rows[0]?.t) await this.pool!.query(schema);
    }
    await this.pool!.query("SELECT id FROM workspaces LIMIT 0");
  }
  async query<T = any>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number }> {
    await this.ready;
    if (this.lite) return this.lite.query<T>(sql, params);
    const result = await this.pool!.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? undefined };
  }
  async transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.lite) return this.lite.transaction((tx) => fn(tx as SQL));
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async tenant<T>(workspace: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.workspace_id',$1,true)", [
        workspace,
      ]);
      return fn(tx);
    });
  }
  async assertProductionRole() {
    if (!this.cfg.production) return;
    const { rows } = await this.query(
      "SELECT r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user",
    );
    if (rows[0]?.rolsuper || rows[0]?.rolbypassrls)
      throw Error("Production runtime role must not bypass row-level security");
    const owned = await this.query(
      "SELECT tablename FROM pg_tables WHERE tableowner=current_user AND tablename=ANY($1)",
      [tenantTables],
    );
    if (owned.rows.length)
      throw Error("Runtime role must not own tenant tables");
  }
  async close() {
    await this.ready;
    if (this.lite) await this.lite.close();
    if (this.pool) await this.pool.end();
  }
}
