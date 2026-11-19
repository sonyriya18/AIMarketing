/**
 * Server-managed sessions. The browser holds an opaque random token in an HttpOnly cookie;
 * the database stores only its SHA-256 hash. Each session carries a CSRF token that must be
 * echoed in the `X-CSRF-Token` header on every state-changing request.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';
import { AppError } from '../http/errors';
import { isRole, permissionsFor, type Permission, type Role } from './permissions';

export const SESSION_COOKIE = 'rci_session';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  csrfToken: string;
  workspaceId: string | null;
  role: Role | null;
  permissions: Set<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export async function createSession(db: Db, cfg: AppConfig, userId: string, authMethod: 'dev' | 'oidc') {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3600_000);
  const { rows } = await db.withSystem((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, auth_method)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sha256(token), userId, csrf, expires, authMethod]
    )
  );
  return { token, sessionId: rows[0]!.id, expires };
}

export function setSessionCookie(res: Response, cfg: AppConfig, token: string, expires: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(res: Response, cfg: AppConfig) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/' });
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.withSystem((tx) => tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]));
}

/** Resolves the session cookie (if any) into `req.auth`. Never throws for a missing session. */
export function sessionMiddleware(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return next();
      req.auth = (await loadAuth(db, token)) ?? undefined;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function loadAuth(db: Db, token: string): Promise<AuthContext | null> {
  const s = await db.withSystem(async (tx) => {
    const { rows } = await tx.query<{
      id: string; user_id: string; email: string; display_name: string; csrf_token: string; current_workspace_id: string | null; last_seen_at: Date;
    }>(
      `SELECT s.id, s.user_id, u.email, u.display_name, s.csrf_token, s.current_workspace_id, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(token)]
    );
    const row = rows[0];
    if (row && Date.now() - row.last_seen_at.getTime() > 60_000) {
      await tx.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
    }
    return row;
  });
  if (!s) return null;

  let role: Role | null = null;
  let grants: string[] = [];
  let workspaceId = s.current_workspace_id;
  if (workspaceId) {
    // Membership is re-checked on every request, so a revoked membership stops access immediately.
    const m = await db.withUser(s.user_id, (tx) =>
      tx.query<{ role: string; grants: string[] }>('SELECT role, grants FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, s.user_id])
    );
    const row = m.rows[0];
    if (row && isRole(row.role)) {
      role = row.role;
      grants = row.grants;
    } else {
      workspaceId = null;
    }
  }
  return {
    sessionId: s.id,
    userId: s.user_id,
    email: s.email,
    displayName: s.display_name,
    csrfToken: s.csrf_token,
    workspaceId,
    role,
    permissions: role ? permissionsFor(role, grants) : new Set(),
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CSRF protection for cookie-authenticated writes. */
export function csrfProtection(exemptPaths: string[] = []) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || exemptPaths.includes(req.path) || !req.auth) return next();
    const sent = req.get('x-csrf-token') || '';
    const expected = req.auth.csrfToken;
    const ok = sent.length === expected.length && timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) return next(new AppError('forbidden', 'Missing or invalid CSRF token'));
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new AppError('unauthenticated', 'Sign in to continue'));
  next();
}

/** Requires a selected workspace (membership verified) and, optionally, a permission. */
export function requirePermission(permission?: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new AppError('unauthenticated', 'Sign in to continue'));
    if (!req.auth.workspaceId || !req.auth.role) return next(new AppError('forbidden', 'Select a workspace you belong to'));
    if (permission && !req.auth.permissions.has(permission)) {
      return next(new AppError('forbidden', `Your role (${req.auth.role}) does not allow this action`));
    }
    next();
  };
}

/** Returns the tenant context for an authorized request (after requirePermission). */
export function tenantOf(req: Request) {
  const a = req.auth;
  if (!a?.workspaceId) throw new AppError('forbidden', 'Select a workspace you belong to');
  return { workspaceId: a.workspaceId, userId: a.userId };
}
