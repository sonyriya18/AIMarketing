import WebSocket from "ws";
import type { Database } from "./db";
import type { Config } from "./config";
import type { RecordData, Source } from "../shared/catalog";
import {
  authorization,
  canonical,
  at,
  ProviderError,
  type ConnectorConfig,
  type Secrets,
} from "./connectors";
import { resolveEndpoint, seal, id, safeError } from "./security";
import { validateRecords, commitRecords } from "./imports";

const active = new Set<() => void>();
export function stopStreams() {
  for (const stop of active) stop();
}
export function decodeEvents(
  payload: unknown,
  c: ConnectorConfig,
): RecordData[] {
  const selected = at(payload, c.streamItemsPath),
    list = Array.isArray(selected) ? selected : [selected];
  // Receipt time is recorded separately from event time; it is never used as the event time.
  const receivedAt = new Date().toISOString();
  const result = validateRecords(
    "infinity",
    canonical(list, "event", c.streamMapping).map((r) => ({
      receivedAt,
      ...r,
    })),
  );
  if (
    result.errors.length ||
    result.records.some((r) => !r.timestamp || !r.sessionId || !r.event)
  )
    throw new ProviderError(
      "Stream payload did not match the verified event ID, session, timestamp and event mapping",
    );
  return result.records;
}

/** Continuous subscriber with a fenced database job lease.
 * Every reconnect records possible missing coverage. No historical replay is claimed. */
export async function consumeStream(
  db: Database,
  cfg: Config,
  workspace: string,
  job: any,
  data: any,
  c: ConnectorConfig,
  secrets: Secrets,
) {
  let socket: WebSocket | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    stopped = false,
    processing = false;
  let buffer: RecordData[] = [],
    failure: Error | undefined,
    lastSnapshot = 0,
    lastPersisted: string | null = null;
  const attempt = Number(job.attempts) + 1,
    startedAt = new Date().toISOString();
  const stop = () => {
    stopped = true;
    socket?.close(1000, "Subscriber stopping");
  };
  active.add(stop);
  try {
    if (
      data.app !== "infinity" ||
      !c.providerContractConfirmed ||
      !Object.keys(c.streamMapping).length
    )
      throw new ProviderError(
        "A verified Infinity stream field mapping is required",
      );
    const streamUrl = new URL(c.streamUrl);
    if (streamUrl.protocol !== "wss:")
      throw new ProviderError("Stream URL must use wss");
    const { addresses } = await resolveEndpoint(
      c.streamUrl.replace(/^wss:/, "https:"),
      cfg,
    );
    const headers = await authorization(c, secrets, cfg, (s) =>
      db
        .tenant(workspace, (tx) =>
          tx.query("UPDATE connections SET secrets=$2 WHERE id=$1", [
            data.id,
            seal(s, cfg.encryptionKey),
          ]),
        )
        .then(() => {}),
    );
    await db.tenant(workspace, async (tx) => {
      await tx.query(
        "UPDATE connections SET status='connecting',last_attempt_at=now(),last_error=NULL WHERE id=$1",
        [data.id],
      );
      await tx.query(
        "INSERT INTO notifications(id,workspace_id,source_id,message,kind,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id(),
          workspace,
          data.source_id,
          "Stream subscription started or reconnected. Events before subscription and during interruptions are not replayed; review coverage before comparing periods.",
          "coverage",
          job.id + ":coverage:" + attempt,
        ],
      );
    });
    socket = new WebSocket(c.streamUrl, {
      headers,
      followRedirects: false,
      handshakeTimeout: 30000,
      maxPayload: 1_000_000,
      lookup: ((_h: any, options: any, callback: any) =>
        options?.all
          ? callback(null, [addresses[0]])
          : callback(null, addresses[0].address, addresses[0].family)) as any,
    });
    socket.on("message", (raw) => {
      try {
        const events = decodeEvents(JSON.parse(raw.toString()), c);
        if (buffer.length + events.length > 5000)
          throw new ProviderError(
            "Stream ingest buffer is full. Narrow the stream or increase worker capacity.",
          );
        buffer.push(...events);
      } catch (e) {
        failure = e as Error;
        stop();
      }
    });
    socket.on("error", () => {
      failure = new ProviderError("Infinity stream connection failed", true);
      stop();
    });
    socket.on("close", () => {
      if (!stopped)
        failure = new ProviderError(
          "Infinity stream disconnected; coverage may have gaps",
          true,
        );
      stopped = true;
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", () => resolve());
      socket!.once("error", reject);
      socket!.once("close", () =>
        reject(new ProviderError("Stream closed during handshake", true)),
      );
    });
    if (c.streamSubscribe !== undefined)
      socket.send(JSON.stringify(c.streamSubscribe));
    await db.tenant(workspace, (tx) =>
      tx.query(
        "UPDATE connections SET status='streaming',last_checked_at=now(),capabilities=$2 WHERE id=$1",
        [
          data.id,
          JSON.stringify({
            websocket: { state: "available", checkedAt: startedAt },
            events: { state: "not_yet_observed" },
            replay: { state: "unavailable" },
          }),
        ],
      ),
    );
    const source: Source = {
      id: data.source_id,
      app: "infinity",
      name: data.name,
      timezone: data.timezone,
      currency: data.currency,
      visibility: data.visibility,
      policy: data.policy,
    };
    const tick = async () => {
      if (processing || stopped) return;
      processing = true;
      try {
        const authorized = await db.tenant(workspace, async (tx) => {
          const j = await tx.query(
            "SELECT j.state,j.attempts,m.role,m.permissions,e.enabled,e.starts_at,e.ends_at,c.status FROM jobs j JOIN memberships m ON m.workspace_id=j.workspace_id AND m.user_id=j.created_by JOIN entitlements e ON e.workspace_id=j.workspace_id AND e.app='infinity' JOIN connections c ON c.id=j.connection_id WHERE j.id=$1",
            [job.id],
          );
          const row = j.rows[0];
          if (
            !row ||
            row.state !== "running" ||
            row.attempts !== attempt ||
            !(
              row.role === "owner" ||
              (row.role === "analyst" &&
                (row.permissions || []).includes("connectors"))
            ) ||
            !row.enabled ||
            (row.starts_at && new Date(row.starts_at).getTime() > Date.now()) ||
            (row.ends_at && new Date(row.ends_at).getTime() <= Date.now()) ||
            row.status === "disconnected"
          )
            return false;
          await tx.query(
            "UPDATE jobs SET lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND attempts=$2",
            [job.id, attempt],
          );
          return true;
        });
        if (!authorized) {
          stop();
          return;
        }
        const pending = buffer.splice(0);
        if (pending.length && job.kind === "sync") {
          await db.tenant(workspace, async (tx) => {
            await tx.query(
              "INSERT INTO stream_events(workspace_id,source_id,external_id,data) SELECT $1,$2,x->>'id',x FROM jsonb_array_elements($3::jsonb) x ON CONFLICT(source_id,external_id) DO NOTHING",
              [workspace, source.id, JSON.stringify(pending)],
            );
            await tx.query(
              "DELETE FROM stream_events WHERE source_id=$1 AND received_at<now()-$2*interval '1 minute'",
              [source.id, c.streamWindowMinutes],
            );
          });
        }
        if (pending.length) lastPersisted = new Date().toISOString();
        if (
          job.kind === "sync" &&
          lastPersisted &&
          Date.now() - lastSnapshot >= c.streamSnapshotSeconds * 1000
        ) {
          const rows = await db.tenant(workspace, (tx) =>
            tx.query(
              "SELECT data FROM stream_events WHERE source_id=$1 AND received_at>=now()-$2*interval '1 minute' ORDER BY received_at,external_id LIMIT 25001",
              [source.id, c.streamWindowMinutes],
            ),
          );
          if (rows.rows.length > 25000)
            throw new ProviderError(
              "Stream window exceeds 25,000 events. Reduce the window or narrow the stream.",
            );
          const snapshot = await commitRecords(
            db,
            workspace,
            job.created_by,
            source,
            rows.rows.map((r) => r.data),
            {
              name: source.name + " · live events",
              mode: "stream",
              asOf: lastPersisted,
              jobId: job.id,
              jobAttempt: attempt,
              metadata: {
                subscriptionStartedAt: startedAt,
                windowMinutes: c.streamWindowMinutes,
                replaySupported: false,
                coverage:
                  "Observed receipt window; subscription gaps and incomplete sessions are possible",
              },
            },
          );
          await db.tenant(workspace, async (tx) => {
            await tx.query(
              "UPDATE connections SET last_success_at=now(),capabilities=$2 WHERE id=$1",
              [
                data.id,
                JSON.stringify({
                  websocket: { state: "available" },
                  events: {
                    state: "available",
                    rows: rows.rows.length,
                    lastEventAt: lastPersisted,
                  },
                  replay: { state: "unavailable" },
                }),
              ],
            );
            await tx.query(
              "UPDATE jobs SET result=$2 WHERE id=$1 AND attempts=$3 AND state='running'",
              [
                job.id,
                JSON.stringify({
                  rows: rows.rows.length,
                  datasetId: snapshot.id,
                  continuous: true,
                }),
                attempt,
              ],
            );
          });
          lastSnapshot = Date.now();
        }
        if (
          job.kind === "check" &&
          (lastPersisted || Date.now() - Date.parse(startedAt) > 30000)
        ) {
          stop();
          await db.tenant(workspace, (tx) =>
            tx.query(
              "UPDATE jobs SET state='succeeded',result=$2,lease_until=NULL WHERE id=$1 AND attempts=$3 AND state='running'",
              [
                job.id,
                JSON.stringify({
                  rows: pending.length,
                  websocket: "available",
                  eventMapping: lastPersisted ? "observed" : "not_yet_observed",
                }),
                attempt,
              ],
            ),
          );
        }
      } catch (e) {
        failure = e as Error;
        stop();
      } finally {
        processing = false;
      }
    };
    timer = setInterval(() => void tick(), 1000);
    while (!stopped) await new Promise((r) => setTimeout(r, 500));
    while (processing) await new Promise((r) => setTimeout(r, 50));
    if (failure) throw failure;
    await db.tenant(workspace, (tx) =>
      tx.query(
        "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE id=$1 AND attempts=$2 AND state='running'",
        [job.id, attempt],
      ),
    );
  } catch (e) {
    const message = safeError(e);
    await db.tenant(workspace, async (tx) => {
      const r = await tx.query(
        "UPDATE jobs SET state='failed',last_error=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND attempts=$3 AND state='running' RETURNING id",
        [job.id, message, attempt],
      );
      if (r.rows.length) {
        await tx.query(
          "UPDATE connections SET status='unavailable',last_error=$2,next_sync_at=now()+interval '30 seconds' WHERE id=$1 AND status<>'disconnected'",
          [data.id, message],
        );
        await tx.query(
          "INSERT INTO notifications(id,workspace_id,source_id,message,kind,dedupe_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
          [
            id(),
            workspace,
            data.source_id,
            message,
            "connection",
            job.id + ":failure:" + attempt,
          ],
        );
      }
    });
  } finally {
    if (timer) clearInterval(timer);
    socket?.terminate();
    active.delete(stop);
    await db.tenant(workspace, (tx) =>
      tx.query(
        "UPDATE connections SET status=$2,next_sync_at=now()+sync_minutes*interval '1 minute' WHERE id=$1 AND status IN('streaming','connecting') AND NOT EXISTS(SELECT 1 FROM jobs WHERE connection_id=$1 AND id<>$3 AND state IN('queued','running'))",
        [
          data.id,
          job.kind === "check" && !failure ? "available" : "paused",
          job.id,
        ],
      ),
    );
  }
}
