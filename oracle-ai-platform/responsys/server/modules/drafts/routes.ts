/**
 * Drafts (authored content) with immutable versions, version-bound approvals, and guarded
 * external operations. A draft is never a campaign, a launch, or performance: it has no metrics.
 *
 * Approval rules (blueprint 15.5): bound to version + content hash + action parameters; any new
 * version invalidates earlier approvals; the approver must differ from the requester; execution
 * re-checks kill switches, permission, approval state, expiry, and version at execution time.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import type { Db, Tx } from '../../db/pool';
import { requirePermission, tenantOf } from '../../auth/sessions';
import { AppError, forbidden, notFound } from '../../http/errors';
import { ah, parse, uuidParam } from '../../http/util';
import { audit, publishEvent } from '../audit/audit';
import { stableStringify } from '../reports/snapshots';
import { DraftContentSchema, validateDraft, type DraftContent } from '../../../shared/contracts/drafts';
import { KNOWN_RPL_TOKENS } from '../../../shared/creative/tokens';
import { JourneyRecordSchema } from '../../../shared/scenario/journeys';

const hash = (v: unknown) => createHash('sha256').update(stableStringify(v)).digest('hex');
const ACTIONS = ['provider_draft_create', 'proof_send', 'live_schedule'] as const;
type Action = (typeof ACTIONS)[number];

async function loadAccountPolicy(tx: Tx, accountId: string) {
  const { rows } = await tx.query<{ brand: { allowedLinkDomains?: string[] } }>('SELECT brand FROM accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw notFound('Account');
  return { allowedLinkDomains: rows[0].brand?.allowedLinkDomains ?? [] };
}

const DRAFT_COLUMNS = `d.id, d.account_id AS "accountId", d.name, d.primary_channel AS "primaryChannel", d.current_version AS "currentVersion",
  d.status, d.source, d.created_at AS "createdAt", d.updated_at AS "updatedAt", u.email AS "createdByEmail"`;

function killSwitch(cfg: AppConfig, action: Action): boolean {
  return action === 'provider_draft_create' ? cfg.ENABLE_PROVIDER_DRAFT_WRITES : action === 'proof_send' ? cfg.ENABLE_PROOF_SENDS : cfg.ENABLE_LIVE_CAMPAIGN_SENDS;
}

export function draftRoutes(deps: { cfg: AppConfig; db: Db }): Router {
  const { cfg, db } = deps;
  const r = Router();
  const actor = (req: Parameters<typeof tenantOf>[0]) => ({ ...tenantOf(req), requestId: req.requestId });

  async function insertVersion(tx: Tx, ws: string, draftId: string, accountId: string, version: number, content: DraftContent, userId: string, note: string | null, origin: string) {
    const policy = await loadAccountPolicy(tx, accountId);
    const validation = validateDraft(content, { knownTokens: KNOWN_RPL_TOKENS, allowedLinkDomains: policy.allowedLinkDomains });
    const contentHash = hash(content);
    await tx.query(
      `INSERT INTO draft_versions (workspace_id, draft_id, version, content, content_hash, validation, change_note, origin, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ws, draftId, version, JSON.stringify(content), contentHash, JSON.stringify(validation), note, origin, userId]
    );
    return { validation, contentHash };
  }

  r.get(
    '/accounts/:accountId/drafts',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const accountId = uuidParam(req, 'accountId', 'Account');
      const { rows } = await db.withTenant(tenantOf(req), (tx) =>
        tx.query(`SELECT ${DRAFT_COLUMNS} FROM drafts d LEFT JOIN users u ON u.id = d.created_by WHERE d.account_id = $1 AND d.status = 'active' ORDER BY d.updated_at DESC LIMIT 200`, [accountId])
      );
      res.json({ data: rows });
    })
  );

  r.post(
    '/drafts',
    requirePermission('draft.edit'),
    ah(async (req, res) => {
      const t = actor(req);
      const b = parse(
        z.object({
          accountId: z.string().uuid(),
          name: z.string().trim().min(1).max(160),
          primaryChannel: z.enum(['Email', 'SMS', 'WebPush']),
          content: DraftContentSchema,
          source: z
            .object({
              scenarioId: z.string().uuid().optional(),
              reportId: z.string().uuid().optional(),
              note: z.string().max(300).optional(),
              // The AI Simulator plan the draft was created from: a record for reviewers, not applied to any send.
              plan: z
                .object({
                  reportId: z.string().uuid(),
                  strategy: z.string().max(120),
                  period: z.string().max(160),
                  baseline: z.string().max(200),
                  audience: z.string().max(200),
                  program: z.string().max(300),
                  assumptions: z.string().max(400),
                  journey: JourneyRecordSchema.optional(),
                })
                .strict()
                .optional(),
            })
            .strict()
            .default({}),
        }),
        req.body
      );
      const out = await db.withTenant(t, async (tx) => {
        await loadAccountPolicy(tx, b.accountId);
        const d = await tx.query<{ id: string }>(
          `INSERT INTO drafts (workspace_id, account_id, name, primary_channel, current_version, source, created_by) VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id`,
          [t.workspaceId, b.accountId, b.name, b.primaryChannel, JSON.stringify(b.source), t.userId]
        );
        const id = d.rows[0]!.id;
        const v = await insertVersion(tx, t.workspaceId, id, b.accountId, 1, b.content, t.userId, 'Created', 'manual');
        await audit(tx, t, 'draft.create', { type: 'draft', id }, 'success', { contentHash: v.contentHash });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: b.accountId, type: 'draft.updated', resourceId: id, revision: 1 });
        return { id, version: 1, validation: v.validation };
      });
      res.status(201).json({ data: out });
    })
  );

  r.get(
    '/drafts/:draftId',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const id = uuidParam(req, 'draftId', 'Draft');
      const out = await db.withTenant(tenantOf(req), async (tx) => {
        const d = await tx.query(`SELECT ${DRAFT_COLUMNS} FROM drafts d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [id]);
        if (!d.rows[0]) throw notFound('Draft');
        const cur = await tx.query(
          `SELECT id, version, content, content_hash AS "contentHash", validation, change_note AS "changeNote", origin, created_at AS "createdAt" FROM draft_versions WHERE draft_id = $1 AND version = $2`,
          [id, d.rows[0].currentVersion]
        );
        const versions = await tx.query(
          `SELECT v.id, v.version, v.content_hash AS "contentHash", v.change_note AS "changeNote", v.origin, v.created_at AS "createdAt", u.email AS "createdByEmail",
                  (v.validation->>'passed')::boolean AS "validationPassed"
             FROM draft_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.draft_id = $1 ORDER BY v.version DESC`,
          [id]
        );
        const approvals = await tx.query(
          `SELECT a.id, a.action_type AS "actionType", a.action_params AS "actionParams", a.status, a.requested_at AS "requestedAt", a.decided_at AS "decidedAt",
                  a.decision_note AS "decisionNote", a.expires_at AS "expiresAt", v.version, ru.email AS "requestedByEmail", du.email AS "decidedByEmail"
             FROM approvals a JOIN draft_versions v ON v.id = a.draft_version_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
            WHERE a.draft_id = $1 ORDER BY a.requested_at DESC`,
          [id]
        );
        const ops = await tx.query(
          `SELECT o.id, o.operation_type AS "operationType", o.status, o.error, o.created_at AS "createdAt", o.approval_id AS "approvalId" FROM external_operations o
             JOIN draft_versions v ON v.id = o.draft_version_id WHERE v.draft_id = $1 ORDER BY o.created_at DESC`,
          [id]
        );
        return { ...d.rows[0], current: cur.rows[0], versions: versions.rows, approvals: approvals.rows, operations: ops.rows };
      });
      res.json({ data: out });
    })
  );

  r.get(
    '/drafts/:draftId/versions/:version',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const id = uuidParam(req, 'draftId', 'Draft');
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) throw notFound('Draft version');
      const { rows } = await db.withTenant(tenantOf(req), (tx) =>
        tx.query(`SELECT id, version, content, content_hash AS "contentHash", validation, change_note AS "changeNote", origin, created_at AS "createdAt" FROM draft_versions WHERE draft_id = $1 AND version = $2`, [id, version])
      );
      if (!rows[0]) throw notFound('Draft version');
      res.json({ data: rows[0] });
    })
  );

  /** Saves a new immutable version. Optimistic concurrency: expectedVersion must be current (T37). */
  r.put(
    '/drafts/:draftId',
    requirePermission('draft.edit'),
    ah(async (req, res) => {
      const t = actor(req);
      const id = uuidParam(req, 'draftId', 'Draft');
      const b = parse(
        z.object({
          expectedVersion: z.number().int().min(1),
          content: DraftContentSchema,
          name: z.string().trim().min(1).max(160).optional(),
          changeNote: z.string().max(300).optional(),
          origin: z.enum(['manual', 'ai_accepted', 'template']).default('manual'),
        }),
        req.body
      );
      const out = await db.withTenant(t, async (tx) => {
        const d = await tx.query<{ current_version: number; account_id: string }>('SELECT current_version, account_id FROM drafts WHERE id = $1 FOR UPDATE', [id]);
        if (!d.rows[0]) throw notFound('Draft');
        if (d.rows[0].current_version !== b.expectedVersion) {
          throw new AppError('conflict', `This draft was changed by someone else (now version ${d.rows[0].current_version}). Reload to see their changes; your edits were not saved.`, { currentVersion: d.rows[0].current_version });
        }
        const prev = await tx.query<{ content_hash: string }>('SELECT content_hash FROM draft_versions WHERE draft_id = $1 AND version = $2', [id, b.expectedVersion]);
        if (prev.rows[0]?.content_hash === hash(b.content) && !b.name) return { id, version: b.expectedVersion, unchanged: true };
        const version = b.expectedVersion + 1;
        const v = await insertVersion(tx, t.workspaceId, id, d.rows[0].account_id, version, b.content, t.userId, b.changeNote ?? null, b.origin);
        await tx.query('UPDATE drafts SET current_version = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1', [id, version, b.name ?? null]);
        // A material change invalidates every approval for earlier versions (T48).
        const inv = await tx.query(`UPDATE approvals SET status = 'invalidated' WHERE draft_id = $1 AND status IN ('pending', 'approved') RETURNING id`, [id]);
        await audit(tx, t, 'draft.version', { type: 'draft', id }, 'success', { version, contentHash: v.contentHash, origin: b.origin, invalidatedApprovals: inv.rowCount });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: d.rows[0].account_id, type: 'draft.updated', resourceId: id, revision: version });
        return { id, version, validation: v.validation, invalidatedApprovals: inv.rowCount };
      });
      res.json({ data: out });
    })
  );

  r.post(
    '/drafts/:draftId/archive',
    requirePermission('draft.edit'),
    ah(async (req, res) => {
      const t = actor(req);
      const id = uuidParam(req, 'draftId', 'Draft');
      await db.withTenant(t, async (tx) => {
        const u = await tx.query(`UPDATE drafts SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
        if (!u.rowCount) throw notFound('Draft');
        await tx.query(`UPDATE approvals SET status = 'invalidated' WHERE draft_id = $1 AND status IN ('pending', 'approved')`, [id]);
        await audit(tx, t, 'draft.archive', { type: 'draft', id });
      });
      res.json({ data: { ok: true } });
    })
  );

  // ---------------------------------------------------------------- approvals
  const ActionParams = z
    .object({
      proofRecipients: z.array(z.string().email()).max(10).optional(),
      scheduleAt: z.string().datetime({ offset: true }).optional(),
      scheduleTimezone: z.string().max(64).optional(),
      audienceDescription: z.string().max(300).optional(),
    })
    .strict()
    .default({});

  r.post(
    '/drafts/:draftId/approvals',
    requirePermission('draft.edit'),
    ah(async (req, res) => {
      const t = actor(req);
      const id = uuidParam(req, 'draftId', 'Draft');
      const b = parse(z.object({ actionType: z.enum(ACTIONS), params: ActionParams }), req.body);
      const out = await db.withTenant(t, async (tx) => {
        const d = await tx.query<{ account_id: string; current_version: number; status: string }>('SELECT account_id, current_version, status FROM drafts WHERE id = $1 FOR UPDATE', [id]);
        if (!d.rows[0] || d.rows[0].status !== 'active') throw notFound('Draft');
        const v = await tx.query<{ id: string; content_hash: string; validation: { passed: boolean } }>('SELECT id, content_hash, validation FROM draft_versions WHERE draft_id = $1 AND version = $2', [id, d.rows[0].current_version]);
        if (!v.rows[0]!.validation?.passed) throw new AppError('unprocessable', 'Fix the local validation errors before requesting approval');
        const a = await tx.query<{ id: string }>(
          `INSERT INTO approvals (workspace_id, account_id, draft_id, draft_version_id, content_hash, action_type, action_params, params_hash, requested_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '7 days') RETURNING id`,
          [t.workspaceId, d.rows[0].account_id, id, v.rows[0]!.id, v.rows[0]!.content_hash, b.actionType, JSON.stringify(b.params), hash(b.params), t.userId]
        );
        await audit(tx, t, 'approval.request', { type: 'approval', id: a.rows[0]!.id }, 'success', { draftId: id, version: d.rows[0].current_version, actionType: b.actionType });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: d.rows[0].account_id, type: 'approval.updated', resourceId: a.rows[0]!.id });
        return { id: a.rows[0]!.id, status: 'pending' };
      });
      res.status(201).json({ data: out });
    })
  );

  r.get(
    '/accounts/:accountId/approvals',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const accountId = uuidParam(req, 'accountId', 'Account');
      const { rows } = await db.withTenant(tenantOf(req), (tx) =>
        tx.query(
          `SELECT a.id, a.draft_id AS "draftId", d.name AS "draftName", a.action_type AS "actionType", a.action_params AS "actionParams", a.status, v.version,
                  a.requested_at AS "requestedAt", a.expires_at AS "expiresAt", ru.email AS "requestedByEmail", a.requested_by AS "requestedBy"
             FROM approvals a JOIN drafts d ON d.id = a.draft_id JOIN draft_versions v ON v.id = a.draft_version_id LEFT JOIN users ru ON ru.id = a.requested_by
            WHERE a.account_id = $1 ORDER BY a.requested_at DESC LIMIT 200`,
          [accountId]
        )
      );
      res.json({ data: rows });
    })
  );

  r.post(
    '/approvals/:approvalId/decision',
    requirePermission('approval.decide'),
    ah(async (req, res) => {
      const t = actor(req);
      const id = uuidParam(req, 'approvalId', 'Approval');
      const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }), req.body);
      const out = await db.withTenant(t, async (tx) => {
        const a = await tx.query<{ status: string; requested_by: string; draft_id: string; draft_version_id: string; content_hash: string; account_id: string; expires_at: Date }>(
          'SELECT status, requested_by, draft_id, draft_version_id, content_hash, account_id, expires_at FROM approvals WHERE id = $1 FOR UPDATE',
          [id]
        );
        const ap = a.rows[0];
        if (!ap) throw notFound('Approval');
        if (ap.requested_by === t.userId) {
          await audit(tx, t, 'approval.decide', { type: 'approval', id }, 'denied', { reason: 'separation_of_duties' });
          throw forbidden('The person who requested an approval cannot approve it');
        }
        if (ap.status !== 'pending') throw new AppError('conflict', `This approval is ${ap.status}`);
        if (ap.expires_at < new Date()) throw new AppError('conflict', 'This approval request has expired');
        const cur = await tx.query<{ id: string; content_hash: string }>(
          `SELECT v.id, v.content_hash FROM drafts d JOIN draft_versions v ON v.draft_id = d.id AND v.version = d.current_version WHERE d.id = $1`,
          [ap.draft_id]
        );
        if (cur.rows[0]?.id !== ap.draft_version_id || cur.rows[0]?.content_hash !== ap.content_hash) {
          await tx.query(`UPDATE approvals SET status = 'invalidated' WHERE id = $1`, [id]);
          throw new AppError('conflict', 'The draft changed after this approval was requested; it is no longer valid');
        }
        const status = b.decision === 'approve' ? 'approved' : 'rejected';
        await tx.query(`UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, status, t.userId, b.note ?? null]);
        await audit(tx, t, 'approval.decide', { type: 'approval', id }, 'success', { decision: status });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: ap.account_id, type: 'approval.updated', resourceId: id });
        return { id, status };
      });
      res.json({ data: out });
    })
  );

  /**
   * Executes an approved external action. Every check runs at execution time. In this release
   * no provider write capability is verified, so a fully approved request is recorded as
   * "blocked" with the exact missing prerequisite — never reported as sent.
   */
  r.post(
    '/approvals/:approvalId/execute',
    requirePermission('action.execute'),
    ah(async (req, res) => {
      const t = actor(req);
      const id = uuidParam(req, 'approvalId', 'Approval');
      const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().min(8).max(200) }), req.body);
      const out = await db.withTenant(t, async (tx) => {
        const existing = await tx.query('SELECT id, status, error FROM external_operations WHERE idempotency_key = $1', [idempotencyKey]);
        if (existing.rows[0]) return { ...existing.rows[0], replayed: true };
        const a = await tx.query<{ status: string; action_type: Action; draft_id: string; draft_version_id: string; content_hash: string; account_id: string; expires_at: Date; action_params: unknown }>(
          'SELECT status, action_type, draft_id, draft_version_id, content_hash, account_id, expires_at, action_params FROM approvals WHERE id = $1 FOR UPDATE',
          [id]
        );
        const ap = a.rows[0];
        if (!ap) throw notFound('Approval');
        const live = await tx.query(`SELECT id, status FROM external_operations WHERE approval_id = $1 AND status NOT IN ('failed', 'cancelled', 'blocked')`, [id]);
        if (live.rows[0]) return { ...live.rows[0], replayed: true };
        const cur = await tx.query<{ id: string; content_hash: string }>(
          `SELECT v.id, v.content_hash FROM drafts d JOIN draft_versions v ON v.draft_id = d.id AND v.version = d.current_version WHERE d.id = $1`,
          [ap.draft_id]
        );
        let block: string | null = null;
        if (ap.status !== 'approved') block = `The approval is ${ap.status}, not approved`;
        else if (ap.expires_at < new Date()) block = 'The approval has expired';
        else if (cur.rows[0]?.id !== ap.draft_version_id || cur.rows[0]?.content_hash !== ap.content_hash) block = 'The draft changed after approval';
        else if (!killSwitch(cfg, ap.action_type)) block = `This deployment has ${ap.action_type === 'provider_draft_create' ? 'ENABLE_PROVIDER_DRAFT_WRITES' : ap.action_type === 'proof_send' ? 'ENABLE_PROOF_SENDS' : 'ENABLE_LIVE_CAMPAIGN_SENDS'}=false`;
        else block = 'No verified Responsys write capability is configured for this account (read-only integration)';
        const op = await tx.query<{ id: string }>(
          `INSERT INTO external_operations (workspace_id, account_id, operation_type, status, draft_version_id, approval_id, idempotency_key, request, error, created_by)
           VALUES ($1, $2, $3, 'blocked', $4, $5, $6, $7, $8, $9) RETURNING id`,
          [t.workspaceId, ap.account_id, ap.action_type, ap.draft_version_id, id, idempotencyKey, JSON.stringify({ params: ap.action_params }), block, t.userId]
        );
        await audit(tx, t, 'operation.execute', { type: 'external_operation', id: op.rows[0]!.id }, 'denied', { actionType: ap.action_type, reason: block });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: ap.account_id, type: 'operation.updated', resourceId: op.rows[0]!.id });
        return { id: op.rows[0]!.id, status: 'blocked', error: block };
      });
      res.status(out.status === 'blocked' ? 409 : 200).json({ data: out });
    })
  );

  return r;
}
