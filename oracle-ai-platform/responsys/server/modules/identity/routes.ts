/**
 * Identity, session, workspace, membership, and account routes.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isSigninAllowed, type AppConfig } from '../../config';
import type { Db, Tx } from '../../db/pool';
import { AppError, notFound } from '../../http/errors';
import { ah, isValidCurrency, isValidTimeZone, parse, uuidParam } from '../../http/util';
import { OidcService, safeReturnTo, type OidcIdentity } from '../../auth/oidc';
import {
  clearSessionCookie,
  createSession,
  requireAuth,
  requirePermission,
  revokeSession,
  setSessionCookie,
  tenantOf,
} from '../../auth/sessions';
import { GRANTABLE, ROLES, isRole, type Role } from '../../auth/permissions';
import { audit } from '../audit/audit';
import { logger } from '../../observability/logger';
import { websiteUrl } from '../insights/business';

const EmailSchema = z.string().trim().toLowerCase().email().max(254);

async function upsertDevUser(tx: Tx, email: string, displayName: string) {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET display_name = CASE WHEN users.display_name = '' THEN EXCLUDED.display_name ELSE users.display_name END
     RETURNING id`,
    [email, displayName]
  );
  return rows[0]!.id;
}

async function upsertOidcUser(tx: Tx, id: OidcIdentity) {
  const bySub = await tx.query<{ id: string }>('SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2', [id.issuer, id.subject]);
  if (bySub.rows[0]) {
    await tx.query('UPDATE users SET email = $2, display_name = COALESCE(NULLIF($3, \'\'), display_name) WHERE id = $1', [bySub.rows[0].id, id.email, id.name]);
    return bySub.rows[0].id;
  }
  // Link a pre-provisioned (invited) user only when the provider vouches for the email.
  const byEmail = await tx.query<{ id: string; oidc_subject: string | null }>('SELECT id, oidc_subject FROM users WHERE email = $1', [id.email]);
  const existing = byEmail.rows[0];
  if (existing) {
    if (existing.oidc_subject || !id.emailVerified) {
      throw new AppError('forbidden', 'This email is already linked to a different sign-in identity');
    }
    await tx.query('UPDATE users SET oidc_issuer = $2, oidc_subject = $3, display_name = COALESCE(NULLIF($4, \'\'), display_name) WHERE id = $1', [
      existing.id,
      id.issuer,
      id.subject,
      id.name,
    ]);
    return existing.id;
  }
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO users (email, display_name, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, $4) RETURNING id',
    [id.email, id.name, id.issuer, id.subject]
  );
  return rows[0]!.id;
}

/** Selects the user's only workspace automatically; otherwise leaves the choice to the user. */
async function autoSelectWorkspace(db: Db, userId: string, sessionId: string) {
  const ms = await db.withUser(userId, (tx) => tx.query<{ workspace_id: string }>('SELECT workspace_id FROM memberships WHERE user_id = $1', [userId]));
  if (ms.rows.length === 1) {
    await db.withSystem((tx) => tx.query('UPDATE sessions SET current_workspace_id = $2 WHERE id = $1', [sessionId, ms.rows[0]!.workspace_id]));
  }
}

export function identityRoutes(cfg: AppConfig, db: Db): Router {
  const r = Router();
  const oidc = cfg.AUTH_MODE === 'oidc' ? new OidcService(cfg, db) : null;
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  r.get('/auth/config', (_req, res) => {
    const issuerHost = cfg.OIDC_ISSUER_URL ? new URL(cfg.OIDC_ISSUER_URL).host : '';
    const providerName = issuerHost === 'accounts.google.com' ? 'Google' : issuerHost === 'login.microsoftonline.com' ? 'Microsoft' : null;
    res.json({ data: { mode: cfg.AUTH_MODE, providerName } });
  });

  if (cfg.AUTH_MODE === 'dev') {
    // Development/test identity harness. Config validation refuses this mode in production.
    r.post(
      '/auth/dev-login',
      loginLimiter,
      ah(async (req, res) => {
        const body = parse(z.object({ email: EmailSchema, displayName: z.string().trim().max(120).optional() }), req.body);
        if (!isSigninAllowed(cfg, body.email)) throw new AppError('forbidden', 'This email is not allowed to sign in to this app');
        const userId = await db.withSystem((tx) => upsertDevUser(tx, body.email, body.displayName || body.email.split('@')[0]!));
        const s = await createSession(db, cfg, userId, 'dev');
        await autoSelectWorkspace(db, userId, s.sessionId);
        setSessionCookie(res, cfg, s.token, s.expires);
        res.status(201).json({ data: { ok: true } });
      })
    );
  }

  if (oidc) {
    r.get(
      '/auth/oidc/login',
      loginLimiter,
      ah(async (req, res) => {
        res.redirect(302, await oidc.beginLogin(safeReturnTo(String(req.query.returnTo || '/'))));
      })
    );
    r.get(
      '/auth/oidc/callback',
      loginLimiter,
      ah(async (req, res) => {
        const url = new URL(req.originalUrl, cfg.APP_BASE_URL);
        let signedIn: Awaited<ReturnType<typeof oidc.completeLogin>>;
        try {
          signedIn = await oidc.completeLogin(url);
        } catch (err) {
          logger.warn('oidc sign-in failed', { error: (err as Error).message });
          return res.redirect(302, '/?signinError=failed');
        }
        const { identity, returnTo } = signedIn;
        if (!isSigninAllowed(cfg, identity.email) || (cfg.signinAllowList.length > 0 && !identity.emailVerified)) {
          logger.warn('oidc sign-in refused by allow-list', { domain: identity.email.slice(identity.email.lastIndexOf('@')) });
          return res.redirect(302, '/?signinError=not_allowed');
        }
        const userId = await db.withSystem((tx) => upsertOidcUser(tx, identity));
        const s = await createSession(db, cfg, userId, 'oidc');
        await autoSelectWorkspace(db, userId, s.sessionId);
        setSessionCookie(res, cfg, s.token, s.expires);
        res.redirect(302, returnTo);
      })
    );
  }

  r.post(
    '/auth/logout',
    ah(async (req, res) => {
      if (req.auth) await revokeSession(db, req.auth.sessionId);
      clearSessionCookie(res, cfg);
      res.json({ data: { ok: true } });
    })
  );

  r.get(
    '/session',
    requireAuth,
    ah(async (req, res) => {
      const a = req.auth!;
      const memberships = await db.withUser(a.userId, (tx) =>
        tx.query<{ workspace_id: string; name: string; role: string }>(
          `SELECT m.workspace_id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = $1 ORDER BY w.name`,
          [a.userId]
        )
      );
      const current = memberships.rows.find((m) => m.workspace_id === a.workspaceId);
      res.json({
        data: {
          user: { id: a.userId, email: a.email, displayName: a.displayName },
          csrfToken: a.csrfToken,
          authMode: cfg.AUTH_MODE,
          workspace: current ? { id: current.workspace_id, name: current.name, role: a.role, permissions: [...a.permissions] } : null,
          memberships: memberships.rows.map((m) => ({ workspaceId: m.workspace_id, name: m.name, role: m.role })),
          features: {
            aiProvider: cfg.AI_PROVIDER,
            allowWorkspaceCreation: cfg.ALLOW_WORKSPACE_CREATION,
            dataMode: cfg.APP_DATA_MODE,
            uploadMaxBytes: cfg.UPLOAD_MAX_BYTES,
            liveUpdates: cfg.LIVE_UPDATES,
            killSwitches: {
              providerDraftWrites: cfg.ENABLE_PROVIDER_DRAFT_WRITES,
              proofSends: cfg.ENABLE_PROOF_SENDS,
              liveCampaignSends: cfg.ENABLE_LIVE_CAMPAIGN_SENDS,
            },
          },
        },
      });
    })
  );

  r.post(
    '/session/workspace',
    requireAuth,
    ah(async (req, res) => {
      const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), req.body);
      const a = req.auth!;
      const m = await db.withUser(a.userId, (tx) => tx.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, a.userId]));
      if (!m.rowCount) throw notFound('Workspace');
      await db.withSystem((tx) => tx.query('UPDATE sessions SET current_workspace_id = $2 WHERE id = $1', [a.sessionId, workspaceId]));
      res.json({ data: { ok: true } });
    })
  );

  r.post(
    '/workspaces',
    requireAuth,
    ah(async (req, res) => {
      if (!cfg.ALLOW_WORKSPACE_CREATION) {
        throw new AppError('forbidden', 'Workspace creation is managed by your administrator in this deployment');
      }
      const { name } = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
      const a = req.auth!;
      const id = randomUUID();
      await db.withTenant({ workspaceId: id, userId: a.userId }, async (tx) => {
        await tx.query('INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3)', [id, name, a.userId]);
        await tx.query(`INSERT INTO memberships (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'owner', $2)`, [id, a.userId]);
        await audit(tx, { workspaceId: id, userId: a.userId, requestId: req.requestId }, 'workspace.create', { type: 'workspace', id });
      });
      await db.withSystem((tx) => tx.query('UPDATE sessions SET current_workspace_id = $2 WHERE id = $1', [a.sessionId, id]));
      res.status(201).json({ data: { id, name } });
    })
  );

  // ---------------------------------------------------------------- members
  r.get(
    '/workspace/members',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const { rows } = await db.withTenant(t, (tx) =>
        tx.query(
          `SELECT u.id AS "userId", u.email, u.display_name AS "displayName", m.role, m.grants, m.created_at AS "createdAt"
             FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.email`,
          [t.workspaceId]
        )
      );
      res.json({ data: rows });
    })
  );

  const MemberBody = z.object({
    email: EmailSchema,
    role: z.enum(ROLES),
    grants: z.array(z.string()).max(10).default([]),
  });

  const checkGrants = (role: Role, grants: string[]) => {
    const bad = grants.filter((g) => !(GRANTABLE[role] as string[]).includes(g));
    if (bad.length) throw new AppError('unprocessable', `Grants not allowed for role ${role}: ${bad.join(', ')}`);
  };

  r.post(
    '/workspace/members',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const body = parse(MemberBody, req.body);
      checkGrants(body.role, body.grants);
      const userId = await db.withSystem(async (tx) => {
        const ex = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [body.email]);
        if (ex.rows[0]) return ex.rows[0].id;
        const ins = await tx.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [body.email]);
        return ins.rows[0]!.id;
      });
      await db.withTenant(t, async (tx) => {
        // Changing someone's role must not leave the workspace without an owner (same rule as removal).
        if (body.role !== 'owner') {
          const owners = await tx.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [t.workspaceId]);
          if (owners.rows.length === 1 && owners.rows[0]!.user_id === userId) {
            throw new AppError('conflict', 'A workspace must keep at least one owner. Make someone else an owner first.');
          }
        }
        await tx.query(
          `INSERT INTO memberships (workspace_id, user_id, role, grants, created_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, grants = EXCLUDED.grants`,
          [t.workspaceId, userId, body.role, body.grants, t.userId]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'membership.upsert', { type: 'user', id: userId }, 'success', { role: body.role, grants: body.grants });
      });
      res.status(201).json({ data: { userId, role: body.role, grants: body.grants } });
    })
  );

  r.delete(
    '/workspace/members/:userId',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const userId = uuidParam(req, 'userId', 'Member');
      await db.withTenant(t, async (tx) => {
        const owners = await tx.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner'`, [t.workspaceId]);
        if (owners.rows.length === 1 && owners.rows[0]!.user_id === userId) {
          throw new AppError('conflict', 'A workspace must keep at least one owner');
        }
        const del = await tx.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [t.workspaceId, userId]);
        if (!del.rowCount) throw notFound('Member');
        await audit(tx, { ...t, requestId: req.requestId }, 'membership.remove', { type: 'user', id: userId });
      });
      res.json({ data: { ok: true } });
    })
  );

  // ---------------------------------------------------------------- accounts
  const AccountBody = z.object({
    name: z.string().trim().min(1).max(120),
    timezone: z.string().refine(isValidTimeZone, 'Unknown IANA timezone'),
    currency: z.string().trim().toUpperCase().refine(isValidCurrency, 'Unknown ISO 4217 currency code'),
    externalAccountId: z.string().trim().max(120).optional().nullable(),
    locale: z.string().trim().max(20).optional(),
    brand: z
      .object({
        officialWebsite: z.string().trim().max(500).refine((value) => { try { return !value || Boolean(websiteUrl(value)); } catch { return false; } }, 'Use a public HTTPS website URL').optional(),
        name: z.string().trim().max(80).optional(),
        senderName: z.string().trim().max(80).optional(),
        domain: z.string().trim().max(120).regex(/^[a-z0-9.-]*$/i, 'Domain may contain letters, digits, dots and hyphens').optional(),
        allowedLinkDomains: z.array(z.string().trim().toLowerCase().max(120)).max(20).optional(),
      })
      .optional(),
    contentPack: z.enum(['starter', 'amil_example']).optional(),
  });

  const ACCOUNT_COLUMNS = `id, name, external_account_id AS "externalAccountId", timezone, currency, locale, brand,
    content_pack AS "contentPack", data_revision AS "dataRevision", created_at AS "createdAt"`;

  r.get(
    '/accounts',
    requirePermission('report.view'),
    ah(async (req, res) => {
      const { rows } = await db.withTenant(tenantOf(req), (tx) => tx.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY name`));
      res.json({ data: rows });
    })
  );

  r.post(
    '/accounts',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const b = parse(AccountBody, req.body);
      const row = await db.withTenant(t, async (tx) => {
        const dup = await tx.query('SELECT 1 FROM accounts WHERE name = $1', [b.name]);
        if (dup.rowCount) throw new AppError('conflict', 'An account with this name already exists');
        const { rows } = await tx.query(
          `INSERT INTO accounts (workspace_id, name, external_account_id, timezone, currency, locale, brand, content_pack, created_by)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'en-US'), $7, COALESCE($8, 'starter'), $9) RETURNING ${ACCOUNT_COLUMNS}`,
          [t.workspaceId, b.name, b.externalAccountId ?? null, b.timezone, b.currency, b.locale ?? null, JSON.stringify(b.brand ?? {}), b.contentPack ?? null, t.userId]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'account.create', { type: 'account', id: rows[0].id }, 'success', { timezone: b.timezone, currency: b.currency });
        return rows[0];
      });
      res.status(201).json({ data: row });
    })
  );

  r.patch(
    '/accounts/:accountId',
    requirePermission('workspace.manage'),
    ah(async (req, res) => {
      const t = tenantOf(req);
      const accountId = uuidParam(req, 'accountId', 'Account');
      const b = parse(AccountBody.partial(), req.body);
      const row = await db.withTenant(t, async (tx) => {
        const cur = await tx.query('SELECT id FROM accounts WHERE id = $1', [accountId]);
        if (!cur.rowCount) throw notFound('Account');
        const { rows } = await tx.query(
          `UPDATE accounts SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), currency = COALESCE($4, currency),
                  locale = COALESCE($5, locale), brand = COALESCE($6, brand), content_pack = COALESCE($7, content_pack),
                  external_account_id = COALESCE($8, external_account_id),
                  data_revision = CASE WHEN $3::text IS NOT NULL OR $4::text IS NOT NULL THEN data_revision + 1 ELSE data_revision END
            WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
          [accountId, b.name ?? null, b.timezone ?? null, b.currency ?? null, b.locale ?? null, b.brand ? JSON.stringify(b.brand) : null, b.contentPack ?? null, b.externalAccountId ?? null]
        );
        await audit(tx, { ...t, requestId: req.requestId }, 'account.update', { type: 'account', id: accountId }, 'success', { fields: Object.keys(b) });
        return rows[0];
      });
      res.json({ data: row });
    })
  );

  return r;
}

export { isRole };
