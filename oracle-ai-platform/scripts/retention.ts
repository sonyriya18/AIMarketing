import { config } from "../server/config";
import { Database } from "../server/db";
// Explicit operator command (dry run unless --apply). Saved reports and anything an action, draft,
// investigation, scenario, feedback or schedule refers to are preserved, as is audit metadata.
const cfg = config(),
  db = new Database(cfg),
  apply = process.argv.includes("--apply");
try {
  await db.assertProductionRole();
  const workspaces = await db.query("SELECT id FROM workspaces");
  for (const w of workspaces.rows) {
    await db.tenant(w.id, async (tx) => {
      // AI conversation logs follow the same retention window as other derived content.
      const ai = await tx.query(
        "SELECT count(*)::int AS n FROM ai_runs WHERE workspace_id=$1 AND created_at<now()-$2*interval '1 day'",
        [w.id, cfg.retentionDays],
      );
      // Unsaved view snapshots that nothing refers to.
      const unsaved =
        "SELECT r.id FROM reports r WHERE r.workspace_id=$1 AND NOT r.saved AND r.created_at<now()-$2*interval '1 day' AND NOT EXISTS(SELECT 1 FROM actions a WHERE a.report_id=r.id OR a.baseline->>'reportId'=r.id) AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.report_id=r.id) AND NOT EXISTS(SELECT 1 FROM investigations i WHERE i.report_id=r.id) AND NOT EXISTS(SELECT 1 FROM scenarios s WHERE s.report_id=r.id) AND NOT EXISTS(SELECT 1 FROM feedback f WHERE f.report_id=r.id) AND NOT EXISTS(SELECT 1 FROM schedules sc WHERE sc.last_report_id=r.id) AND NOT EXISTS(SELECT 1 FROM ai_runs x WHERE x.report_id=r.id AND x.created_at>=now()-$2*interval '1 day')";
      const views = await tx.query(unsaved, [w.id, cfg.retentionDays]);
      console.log(
        `${w.id}: ${ai.rows[0].n} AI runs and ${views.rows.length} unsaved report views older than ${cfg.retentionDays} days.`,
      );
      if (apply) {
        await tx.query(
          "DELETE FROM ai_runs WHERE workspace_id=$1 AND created_at<now()-$2*interval '1 day'",
          [w.id, cfg.retentionDays],
        );
        await tx.query(
          "UPDATE notifications SET report_id=NULL WHERE workspace_id=$1 AND report_id=ANY($2::text[])",
          [w.id, views.rows.map((r) => r.id)],
        );
        await tx.query(
          "DELETE FROM reports WHERE workspace_id=$1 AND id=ANY($2::text[])",
          [w.id, views.rows.map((r) => r.id)],
        );
      }
      const candidates = await tx.query(
        "SELECT id FROM datasets d WHERE workspace_id=$1 AND NOT active AND created_at<now()-$2*interval '1 day' AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.dataset_id=d.id)",
        [w.id, cfg.retentionDays],
      );
      console.log(
        `${w.id}: ${candidates.rows.length} unreferenced inactive datasets older than ${cfg.retentionDays} days.`,
      );
      if (apply) {
        await tx.query(
          "DELETE FROM datasets WHERE workspace_id=$1 AND id=ANY($2::text[])",
          [w.id, candidates.rows.map((r) => r.id)],
        );
        await tx.query(
          "DELETE FROM stream_events WHERE workspace_id=$1 AND received_at<now()-interval '1 day'",
          [w.id],
        );
        await tx.query(
          "DELETE FROM jobs WHERE workspace_id=$1 AND state IN('succeeded','failed','cancelled') AND updated_at<now()-$2*interval '1 day'",
          [w.id, cfg.retentionDays],
        );
      }
    });
  }
  if (apply) {
    await db.query("DELETE FROM sessions WHERE expires_at<now()");
    await db.query("DELETE FROM oidc_states WHERE expires_at<now()");
  }
  console.log(
    apply
      ? "Retention cleanup completed."
      : "Dry run only. Add --apply to remove eligible records.",
  );
} finally {
  await db.close();
}
