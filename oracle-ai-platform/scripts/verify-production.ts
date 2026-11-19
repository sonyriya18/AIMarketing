import { config } from "../server/config";
import { Database } from "../server/db";
const cfg = config();
if (!cfg.production)
  throw Error("Set NODE_ENV=production before this verification.");
const db = new Database(cfg);
let failed = false;
try {
  await db.assertProductionRole();
  console.log(
    "PASS: PostgreSQL runtime role, schema and production authentication configuration.",
  );
  const policies = await db.query(
    "SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='public'",
  );
  const { tenantTables } = await import("../server/schema");
  for (const table of tenantTables)
    if (!policies.rows.some((r) => r.tablename === table && r.rowsecurity)) {
      failed = true;
      console.error("FAIL: row security missing on " + table);
    }
  if (!cfg.bootstrapEmail) {
    failed = true;
    console.error(
      "FAIL: BOOTSTRAP_EMAIL is required for first workspace setup.",
    );
  }
  if (cfg.aiProvider === "none") {
    failed = true;
    console.error(
      "NOT LIVE VERIFIED: Generative AI is not configured. Deterministic assessments still work.",
    );
  }
  if (!cfg.allowedHosts.length) {
    failed = true;
    console.error("NOT LIVE VERIFIED: No outbound Oracle/AI hosts approved.");
  }
  const workspaces = await db.query("SELECT id,name FROM workspaces");
  if (!workspaces.rows.length) {
    failed = true;
    console.error("NOT LIVE VERIFIED: No customer workspace provisioned yet.");
  }
  for (const workspace of workspaces.rows) {
    const result = await db.tenant(workspace.id, (tx) =>
      tx.query(
        "SELECT s.app,s.name,c.status,c.last_success_at FROM sources s LEFT JOIN connections c ON c.source_id=s.id WHERE s.workspace_id=$1",
        [workspace.id],
      ),
    );
    for (const source of result.rows) {
      if (
        !source.last_success_at ||
        !["available", "streaming"].includes(source.status)
      ) {
        failed = true;
        console.error(
          `NOT LIVE VERIFIED: ${workspace.name} / ${source.app} / ${source.name} has no successful active connection.`,
        );
      }
    }
  }
  console.log(
    "This check cannot certify Oracle permissions, SSO login, data reconciliation, provider uptime or a restore drill. Complete docs/GO_LIVE_CHECKLIST.md with evidence.",
  );
} finally {
  await db.close();
}
if (failed) process.exitCode = 1;
