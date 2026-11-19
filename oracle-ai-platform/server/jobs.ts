import type { Database } from "./db";
import type { Config } from "./config";
import { id, audit, safeError, unseal, seal } from "./security";
import {
  readSource,
  PendingExport,
  ProviderError,
  ConnectionSchema,
  type Secrets,
} from "./connectors";
import { commitRecords } from "./imports";
import { assess } from "./modules";
import { runDueSchedules } from "./routes-workflows";
import type { Source } from "../shared/catalog";
import { consumeStream, stopStreams } from "./streams";
export async function enqueue(
  db: Database,
  workspace: string,
  user: string,
  connectionId: string,
  kind: "check" | "sync",
) {
  return db.tenant(workspace, async (tx) => {
    const c = await tx.query(
      "SELECT * FROM connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [workspace, connectionId],
    );
    if (!c.rows[0]) throw Error("Connection not found");
    const active = await tx.query(
      "SELECT id FROM jobs WHERE connection_id=$1 AND state IN('queued','running')",
      [connectionId],
    );
    if (active.rows[0]) return active.rows[0].id;
    const jobId = id();
    await tx.query(
      "INSERT INTO jobs(id,workspace_id,source_id,connection_id,kind,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [jobId, workspace, c.rows[0].source_id, connectionId, kind, user],
    );
    return jobId;
  });
}
export async function runNext(db: Database, cfg: Config): Promise<boolean> {
  const workspaces = await db.query("SELECT id FROM workspaces ORDER BY id");
  for (const w of workspaces.rows) {
    const job = await db.tenant(w.id, async (tx) => {
      const { rows } = await tx.query(
        "SELECT * FROM jobs WHERE workspace_id=$1 AND ((state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [w.id],
      );
      if (!rows[0]) return null;
      await tx.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1",
        [rows[0].id],
      );
      return rows[0];
    });
    if (!job) continue;
    const heartbeat = setInterval(() => {
      void db
        .tenant(w.id, (tx) =>
          tx.query(
            "UPDATE jobs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND state='running' AND attempts=$2",
            [job.id, Number(job.attempts) + 1],
          ),
        )
        .catch(() => {});
    }, 60000);
    try {
      const data = await db.tenant(w.id, async (tx) => {
        const r = await tx.query(
          "SELECT c.*,s.app,s.name,s.timezone,s.currency,s.policy,s.visibility FROM connections c JOIN sources s ON s.id=c.source_id WHERE c.id=$1 AND c.workspace_id=$2",
          [job.connection_id, w.id],
        );
        return r.rows[0];
      });
      if (!data) throw new ProviderError("Connection removed");
      const member = await db.query(
        "SELECT role,permissions FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [w.id, job.created_by],
      );
      const entitlement = await db.query(
        "SELECT app FROM entitlements WHERE workspace_id=$1 AND app=$2 AND enabled AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())",
        [w.id, data.app],
      );
      const m0 = member.rows[0];
      const mayConnect =
        m0?.role === "owner" ||
        (m0?.role === "analyst" &&
          (m0.permissions || []).includes("connectors"));
      if (!mayConnect || !entitlement.rows.length)
        throw new ProviderError(
          "Job owner or application entitlement was revoked",
        );
      const connector = ConnectionSchema.parse(data.config),
        secrets = unseal<Secrets>(data.secrets, cfg.encryptionKey);
      if (connector.transport === "infinity-stream") {
        clearInterval(heartbeat);
        void consumeStream(db, cfg, w.id, job, data, connector, secrets).catch(
          (e) => console.error("Stream worker:", safeError(e)),
        );
        return true;
      }
      await db.tenant(w.id, (tx) =>
        tx.query(
          "UPDATE connections SET last_attempt_at=now(),status='syncing',last_error=NULL WHERE id=$1",
          [data.id],
        ),
      );
      const output = await readSource(data.app, connector, secrets, cfg, {
        checkpoint: job.checkpoint,
        checkOnly: job.kind === "check",
        saveCheckpoint: (cp) =>
          db
            .tenant(w.id, (tx) =>
              tx.query(
                "UPDATE jobs SET checkpoint=$2,progress=$3,updated_at=now() WHERE id=$1 AND state='running' AND attempts=$4",
                [
                  job.id,
                  JSON.stringify(cp),
                  JSON.stringify({
                    stage: "extracting",
                    at: new Date().toISOString(),
                  }),
                  Number(job.attempts) + 1,
                ],
              ),
            )
            .then(() => {}),
        saveSecrets: (s) =>
          db
            .tenant(w.id, (tx) =>
              tx.query("UPDATE connections SET secrets=$2 WHERE id=$1", [
                data.id,
                seal(s, cfg.encryptionKey),
              ]),
            )
            .then(() => {}),
      });
      let datasetId: string | null = null;
      if (job.kind === "sync") {
        const source: Source = {
          id: data.source_id,
          app: data.app,
          name: data.name,
          timezone: data.timezone,
          currency: data.currency,
          policy: data.policy,
          visibility: data.visibility,
        };
        const committed = await commitRecords(
          db,
          w.id,
          job.created_by,
          source,
          output.records,
          {
            name: data.name + " · connected",
            mode: "connected",
            asOf: output.asOf,
            metadata: output.metadata,
            jobId: job.id,
            jobAttempt: Number(job.attempts) + 1,
          },
        );
        datasetId = committed.id;
        const report = assess(source, output.records, {
          datasetId: datasetId!,
          mode: "connected",
          asOf: output.asOf,
        });
        await db.tenant(w.id, async (tx) => {
          for (const f of report.findings) {
            await tx.query(
              "INSERT INTO notifications(id,workspace_id,source_id,message,kind,severity,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
              [
                id(),
                w.id,
                source.id,
                f.title + ": " + f.detail,
                "finding",
                f.severity === "high" ? "high" : "info",
                source.id + ":" + f.id,
              ],
            );
          }
        });
      }
      await db.tenant(w.id, async (tx) => {
        const current = await tx.query(
          "SELECT id FROM jobs WHERE id=$1 AND state='running' AND attempts=$2 FOR UPDATE",
          [job.id, Number(job.attempts) + 1],
        );
        if (!current.rows.length) return;
        await tx.query(
          "UPDATE jobs SET state='succeeded',result=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='running'",
          [
            job.id,
            JSON.stringify({
              rows: output.records.length,
              datasetId,
              capabilities: output.capabilities,
            }),
          ],
        );
        await tx.query(
          "UPDATE connections SET status='available',capabilities=$2,last_checked_at=now(),last_success_at=CASE WHEN $3 THEN now() ELSE last_success_at END,last_error=NULL,next_sync_at=now()+sync_minutes*interval '1 minute',verification=CASE WHEN verification='configured' THEN 'connectivity_tested' ELSE verification END,owned_resources=$4 WHERE id=$1",
          [
            data.id,
            JSON.stringify(output.capabilities),
            job.kind === "sync",
            JSON.stringify(
              (output.metadata as any)?.ownedResources?.filter(
                (u: string) =>
                  !((output.metadata as any)?.cleanedResources || []).includes(
                    u,
                  ),
              ) || [],
            ),
          ],
        );
        await audit(
          tx,
          w.id,
          job.created_by,
          "connection." + job.kind,
          data.id,
          { rows: output.records.length, datasetId },
        );
      });
    } catch (e) {
      if (e instanceof PendingExport) {
        await db.tenant(w.id, (tx) =>
          tx.query(
            "UPDATE jobs SET state='queued',checkpoint=$2,available_at=now()+interval '15 seconds',lease_until=NULL,updated_at=now() WHERE id=$1 AND state='running' AND attempts=$3",
            [job.id, JSON.stringify(e.checkpoint), Number(job.attempts) + 1],
          ),
        );
      } else {
        const retry =
            e instanceof ProviderError && e.retryable && job.attempts < 4,
          message = safeError(e);
        await db.tenant(w.id, async (tx) => {
          const current = await tx.query(
            "SELECT id FROM jobs WHERE id=$1 AND state='running' AND attempts=$2 FOR UPDATE",
            [job.id, Number(job.attempts) + 1],
          );
          if (!current.rows.length) return;
          await tx.query(
            "UPDATE jobs SET state=$2,last_error=$3,lease_until=NULL,available_at=now()+$4*interval '1 second',updated_at=now(),failed_stage=$5 WHERE id=$1 AND state='running'",
            [
              job.id,
              retry ? "queued" : "failed",
              message,
              (e instanceof ProviderError && e.retryAfter) ||
                Math.min(300, 15 * 2 ** job.attempts) +
                  Math.floor(Math.random() * 10),
              job.checkpoint?.eloqua
                ? "eloqua-bulk"
                : job.kind === "check"
                  ? "connection-check"
                  : "extraction",
            ],
          );
          await tx.query(
            "UPDATE connections SET status='unavailable',last_error=$2,next_sync_at=now()+sync_minutes*interval '1 minute' WHERE id=$1",
            [job.connection_id, message],
          );
          await tx.query(
            "INSERT INTO notifications(id,workspace_id,source_id,message,kind,severity,dedupe_key) VALUES($1,$2,$3,$4,$5,'high',$6) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
            [
              id(),
              w.id,
              job.source_id,
              (retry ? "Sync retry scheduled: " : "Sync failed: ") + message,
              "connection",
              job.connection_id + ":" + message,
            ],
          );
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
  return false;
}
export async function schedule(db: Database) {
  const workspaces = await db.query("SELECT id FROM workspaces");
  for (const w of workspaces.rows) {
    const due = await db.tenant(w.id, (tx) =>
      tx.query(
        "SELECT c.id,(SELECT user_id FROM memberships WHERE workspace_id=c.workspace_id AND role='owner' ORDER BY user_id LIMIT 1) AS owner FROM connections c WHERE c.workspace_id=$1 AND c.enabled AND (c.next_sync_at IS NULL OR c.next_sync_at<=now())",
        [w.id],
      ),
    );
    for (const c of due.rows)
      if (c.owner) await enqueue(db, w.id, c.owner, c.id, "sync");
  }
}
export function startWorker(db: Database, cfg: Config) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        await schedule(db);
        await runDueSchedules(db);
        if (await runNext(db, cfg)) continue;
      } catch (e) {
        console.error("Worker error:", safeError(e));
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void loop();
  return () => {
    stopped = true;
    stopStreams();
  };
}
