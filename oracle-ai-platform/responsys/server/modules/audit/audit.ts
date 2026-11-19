/**
 * Append-only audit and event records. Both are written in the same transaction as the change
 * they describe, so an event is only visible to SSE readers after the change commits.
 */
import type { Tx } from '../../db/pool';
import { redact } from '../../observability/logger';

export interface Actor {
  workspaceId: string;
  userId: string | null;
  requestId?: string;
}

export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  target: { type?: string; id?: string } = {},
  outcome: 'success' | 'denied' | 'failure' = 'success',
  details: Record<string, unknown> = {}
) {
  await tx.query(
    `INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, request_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.workspaceId, actor.userId, action, target.type ?? null, target.id ?? null, actor.requestId ?? null, outcome, JSON.stringify(redact(details))]
  );
}

export type EventType =
  | 'import.progress'
  | 'dataset.activated'
  | 'report.ready'
  | 'sync.status'
  | 'connection.health'
  | 'draft.updated'
  | 'approval.updated'
  | 'operation.updated';

export async function publishEvent(
  tx: Tx,
  e: { workspaceId: string; accountId?: string | null; type: EventType; resourceId?: string; revision?: string | number | null; payload?: Record<string, unknown> }
) {
  await tx.query(
    `INSERT INTO events (workspace_id, account_id, type, resource_id, revision, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.workspaceId, e.accountId ?? null, e.type, e.resourceId ?? null, e.revision ?? null, JSON.stringify(e.payload ?? {})]
  );
}
