import "dotenv/config";
import pg from "pg";
import { schema } from "../server/schema";
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl)
  throw Error(
    "Set DATABASE_MIGRATION_URL for this migration process only. Never point it to the Responsys database.",
  );
const role = process.env.RUNTIME_DATABASE_ROLE || "enterprise_runtime";
if (!/^[a-z][a-z0-9_]{2,50}$/.test(role))
  throw Error("Use a lowercase database role name");
const client = new pg.Client({ connectionString: migrationUrl });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(schema);
  const existing = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname=$1",
    [role],
  );
  if (!existing.rows.length) {
    const password = process.env.RUNTIME_DATABASE_PASSWORD;
    if (!password || password.length < 24)
      throw Error(
        "For first provisioning, set RUNTIME_DATABASE_PASSWORD to a unique value of at least 24 characters.",
      );
    await client.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password.replaceAll("'", "''")}'`,
    );
  }
  await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
  );
  await client.query(
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`,
  );
  await client.query("COMMIT");
  console.log(
    "New-platform schema and runtime role are ready. Remove the migration credential from the web/worker environment.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
