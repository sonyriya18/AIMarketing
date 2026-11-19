/**
 * Authenticated Server-Sent Events for status and revision changes, with replay through
 * Last-Event-ID and a polling fallback (`GET /events?after=`). Events are read from the durable
 * events table, so a reconnecting client never misses a committed revision. Authorization is
 * re-checked on every poll: a revoked session or membership ends the stream.
 */
import { Router, type Request } from 'express';
import type { Db } from '../../db/pool';
import { loadAuth, parseCookies, requirePermission, SESSION_COOKIE, tenantOf } from '../../auth/sessions';
import { ah } from '../../http/util';

const MAX_REPLAY = 200;

async function eventsAfter(db: Db, workspaceId: string, after: string, accountId?: string) {
  const params: unknown[] = [after];
  let filter = '';
  if (accountId) {
    params.push(accountId);
    filter = 'AND (account_id = $2 OR account_id IS NULL)';
  }
  const { rows } = await db.withTenant({ workspaceId }, (tx) =>
    tx.query<{ id: string; type: string; account_id: string | null; resource_id: string | null; revision: string | null; payload: unknown; created_at: Date }>(
      `SELECT id, type, account_id, resource_id, revision, payload, created_at FROM events WHERE id > $1 ${filter} ORDER BY id LIMIT ${MAX_REPLAY}`,
      params
    )
  );
  return rows.map((r) => ({ id: r.id, type: r.type, accountId: r.account_id, resourceId: r.resource_id, revision: r.revision, payload: r.payload, at: r.created_at.toISOString() }));
}

async function latestId(db: Db, workspaceId: string) {
  const { rows } = await db.withTenant({ workspaceId }, (tx) => tx.query<{ id: string | null }>('SELECT MAX(id)::text AS id FROM events'));
  return rows[0]?.id ?? '0';
}

const cursorOf = (v: unknown) => (typeof v === 'string' && /^\d{1,18}$/.test(v) ? v : null);

export function eventRoutes(deps: { db: Db; pollMs?: number; heartbeatMs?: number }): Router {
  const { db } = deps;
  const pollMs = deps.pollMs ?? 1000;
  const heartbeatMs = deps.heartbeatMs ?? 15000;
  const r = Router();

  // Polling fallback: reads the same durable events.
  r.get(
    '/events',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const after = cursorOf(req.query.after) ?? (await latestId(db, t.workspaceId));
      const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
      const events = req.query.after ? await eventsAfter(db, t.workspaceId, after, accountId) : [];
      res.json({ data: { events, cursor: events.at(-1)?.id ?? after } });
    })
  );

  r.get(
    '/events/stream',
    requirePermission('report.view'),
    ah(async (req: Request, res) => {
      const t = tenantOf(req);
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]!;
      const accountId = typeof req.query.accountId === 'string' && /^[0-9a-f-]{36}$/.test(req.query.accountId) ? req.query.accountId : undefined;
      let cursor = cursorOf(req.get('last-event-id')) ?? cursorOf(req.query.after) ?? (await latestId(db, t.workspaceId));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n: connected\n\n`);
      let closed = false;
      let busy = false;
      const close = () => {
        closed = true;
        clearInterval(poll);
        clearInterval(beat);
        res.end();
      };
      const poll = setInterval(async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const auth = await loadAuth(db, token);
          if (!auth || auth.workspaceId !== t.workspaceId || !auth.permissions.has('report.view')) {
            res.write(`event: session.ended\ndata: {}\n\n`);
            return close();
          }
          const events = await eventsAfter(db, t.workspaceId, cursor, accountId);
          for (const e of events) {
            res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            cursor = e.id;
          }
        } catch {
          // Transient database errors are retried on the next tick.
        } finally {
          busy = false;
        }
      }, pollMs);
      const beat = setInterval(() => !closed && res.write(`: heartbeat ${Date.now()}\n\n`), heartbeatMs);
      req.on('close', close);
    })
  );

  return r;
}
