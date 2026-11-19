import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "../server/db";
import { config } from "../server/config";

// Real-PostgreSQL row-security check. Runs only when TEST_DATABASE_URL points to a
// provisioned test database as the non-owner runtime role (`npm run db:migrate`).
// Skipped (not passed) with embedded PGlite, whose single role owns every table.
const url = process.env.TEST_DATABASE_URL || "";
describe.skipIf(!url)("PostgreSQL runtime role and row-level security", () => {
  const cfg = config({
    NODE_ENV: "test",
    DATA_DIR: ".data/tests",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    DATABASE_URL: url,
  });
  const db = new Database(cfg);
  const a = "rls-a-" + randomUUID(),
    b = "rls-b-" + randomUUID();
  afterAll(() => db.close());

  it("runs as a role that neither bypasses RLS nor owns tenant tables", async () => {
    const runtime = new Database({ ...cfg, production: true });
    try {
      await expect(runtime.assertProductionRole()).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("isolates tenant rows by workspace context", async () => {
    for (const w of [a, b])
      await db.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [
        w,
      ]);
    await db.tenant(a, (tx) =>
      tx.query(
        "INSERT INTO sources(id,workspace_id,app,name,timezone,currency,visibility) VALUES($1,$2,'eloqua','A source','UTC','USD','workspace')",
        ["src-" + a, a],
      ),
    );
    const seen = async (w: string) =>
      (
        await db.tenant(w, (tx) =>
          tx.query("SELECT id FROM sources WHERE id=$1", ["src-" + a]),
        )
      ).rows.length;
    expect(await seen(a)).toBe(1);
    expect(await seen(b)).toBe(0);
    // No workspace context: tenant tables are invisible, not unfiltered.
    expect(
      (await db.query("SELECT id FROM sources WHERE id=$1", ["src-" + a])).rows,
    ).toEqual([]);
    // Writing another workspace's row from this context violates the policy.
    await expect(
      db.tenant(b, (tx) =>
        tx.query(
          "INSERT INTO sources(id,workspace_id,app,name,timezone,currency,visibility) VALUES($1,$2,'eloqua','Forged','UTC','USD','workspace')",
          ["forged-" + b, a],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.tenant(b, (tx) =>
        tx.query("UPDATE sources SET name='changed' WHERE id=$1", ["src-" + a]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});
