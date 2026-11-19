import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { Config } from "./config";
import type { Database } from "./db";
import { HttpError, hash, id, safeEqual } from "./security";
import {
  PRODUCT_IDS,
  type Permission,
  type Session,
  type ProductId,
  type Source,
} from "../shared/catalog";
export interface Context {
  userId: string;
  email: string;
  workspaceId: string | null;
  csrf: string;
  role: "owner" | "analyst" | "viewer" | null;
  apps: ProductId[];
  permissions: Permission[];
  tokenHash: string;
  /** Platform provider administrator: manages client companies and subscriptions. */
  provider: boolean;
  workspaceStatus: "active" | "suspended" | null;
}
declare global {
  namespace Express {
    interface Request {
      ctx?: Context;
    }
  }
}
const cookieName = "enterprise_session";
export const asyncRoute =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
export function auth(db: Database, cfg: Config) {
  return asyncRoute(async (req, res, next) => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .filter((x) => x.includes("="))
        .map((x) => {
          const i = x.indexOf("=");
          return [x.slice(0, i).trim(), x.slice(i + 1)];
        }),
    );
    const token = cookies[cookieName];
    if (token) {
      const tokenHash = hash(cfg.sessionSecret + token);
      const { rows } = await db.query(
        "SELECT s.*,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
        [tokenHash],
      );
      const s = rows[0];
      if (s) {
        let role: Context["role"] = null,
          apps: ProductId[] = [],
          permissions: Permission[] = [],
          workspaceStatus: Context["workspaceStatus"] = null;
        if (s.workspace_id) {
          const m = await db.query(
            "SELECT role,apps,permissions FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [s.workspace_id, s.user_id],
          );
          role = m.rows[0]?.role || null;
          if (role) {
            permissions =
              role === "owner"
                ? ["connectors", "approvals"]
                : role === "analyst"
                  ? (m.rows[0].permissions || []).filter((p: string) =>
                      ["connectors", "approvals"].includes(p),
                    )
                  : [];
            // Subscription: only active companies, and only tools inside their dates.
            const e = await db.query(
              "SELECT e.app,w.status FROM workspaces w LEFT JOIN entitlements e ON e.workspace_id=w.id AND e.enabled AND (e.starts_at IS NULL OR e.starts_at<=now()) AND (e.ends_at IS NULL OR e.ends_at>now()) WHERE w.id=$1",
              [s.workspace_id],
            );
            workspaceStatus = e.rows[0]?.status || null;
            apps =
              workspaceStatus === "active"
                ? e.rows
                    .map((x) => x.app)
                    .filter(Boolean)
                    .filter(
                      (a) => role === "owner" || m.rows[0].apps.includes(a),
                    )
                : [];
          }
        }
        const provider =
          cfg.providerAdmins.includes(String(s.email).toLowerCase()) ||
          (!cfg.production &&
            (
              await db.query("SELECT 1 FROM platform_admins WHERE user_id=$1", [
                s.user_id,
              ])
            ).rows.length > 0);
        req.ctx = {
          userId: s.user_id,
          email: s.email,
          workspaceId: role ? s.workspace_id : null,
          csrf: s.csrf,
          role,
          apps,
          permissions,
          tokenHash,
          provider,
          workspaceStatus: role ? workspaceStatus : null,
        };
      }
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.path !== "/auth/dev-login"
    ) {
      if (req.get("origin") && req.get("origin") !== cfg.origin)
        throw new HttpError(403, "Request origin is not allowed");
      if (req.ctx && !safeEqual(req.get("x-csrf-token") || "", req.ctx.csrf))
        throw new HttpError(
          403,
          "Your form expired. Refresh and try again.",
          "csrf",
        );
    }
    next();
  });
}
export function requireUser(req: Request) {
  if (!req.ctx)
    throw new HttpError(401, "Sign in to continue", "not_authenticated");
  return req.ctx;
}
export function requireWorkspace(req: Request, write = false, owner = false) {
  const c = requireUser(req);
  if (!c.workspaceId || !c.role)
    throw new HttpError(403, "Choose an authorized workspace");
  if ((owner && c.role !== "owner") || (write && c.role === "viewer"))
    throw new HttpError(403, "Your role does not allow this action");
  return c as Context & { workspaceId: string };
}
/** Explicit permission (administrators hold all; analysts only when granted). */
/** Platform provider administrator (not a company role). */
export function requireProvider(req: Request) {
  const c = requireUser(req);
  if (!c.provider)
    throw new HttpError(
      403,
      "Only the platform provider can manage companies and subscriptions",
    );
  return c;
}
export function requirePermission(req: Request, permission: Permission) {
  const c = requireWorkspace(req, true);
  if (!c.permissions.includes(permission))
    throw new HttpError(
      403,
      permission === "connectors"
        ? "Connector administration permission is required"
        : "Approval permission is required",
    );
  return c;
}
export function requireProduct(req: Request, app: string) {
  const c = requireWorkspace(req);
  if (!c.apps.includes(app as ProductId))
    throw new HttpError(
      403,
      "This application is not enabled for your account",
    );
  return c;
}
export async function sourceAccess(
  db: Database,
  req: Request,
  sourceId: string,
  write = false,
): Promise<Source & { workspaceId: string }> {
  const c = requireWorkspace(req, write);
  const result = await db.tenant(c.workspaceId, (tx) =>
    tx.query(
      "SELECT s.* FROM sources s WHERE s.workspace_id=$1 AND s.id=$2 AND (s.visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=s.id AND g.user_id=$4))",
      [c.workspaceId, sourceId, c.role === "owner", c.userId],
    ),
  );
  const s = result.rows[0];
  if (!s) throw new HttpError(404, "Source not found or not authorized");
  requireProduct(req, s.app);
  return {
    id: s.id,
    app: s.app,
    name: s.name,
    timezone: s.timezone,
    currency: s.currency,
    policy: s.policy,
    visibility: s.visibility,
    environment: s.environment,
    workspaceId: c.workspaceId,
  };
}
export async function issueSession(
  db: Database,
  cfg: Config,
  res: Response,
  userId: string,
) {
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(24).toString("hex");
  const m = await db.query(
    "SELECT workspace_id FROM memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1",
    [userId],
  );
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,workspace_id,csrf,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",
    [
      hash(cfg.sessionSecret + token),
      userId,
      m.rows[0]?.workspace_id || null,
      csrf,
    ],
  );
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: cfg.production,
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 3600000,
  });
}
export async function sessionView(
  db: Database,
  cfg: Config,
  c: Context,
): Promise<Session> {
  const m = await db.query(
    "SELECT w.id,w.name,w.slug,w.logo,w.brand,w.status,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.name",
    [c.userId],
  );
  return {
    user: { id: c.userId, email: c.email },
    provider: c.provider,
    workspace: (() => {
      const w = m.rows.find((x) => x.id === c.workspaceId);
      return w ? { ...w, permissions: c.permissions } : null;
    })(),
    workspaces: m.rows,
    products: c.apps,
    csrf: c.csrf,
    mode: cfg.authMode,
    responsysSso: !!cfg.ssoSecret,
    responsysEmbedded: !!cfg.responsysDir,
  };
}
let identityConfig: Promise<oidc.Configuration> | null = null;
export function identity(cfg: Config) {
  return (identityConfig ??= oidc
    .discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret)
    .catch((e) => {
      identityConfig = null;
      throw e;
    }));
}
export async function beginOIDC(db: Database, cfg: Config) {
  const client = await identity(cfg),
    verifier = oidc.randomPKCECodeVerifier(),
    challenge = await oidc.calculatePKCECodeChallenge(verifier),
    state = oidc.randomState(),
    nonce = oidc.randomNonce();
  await db.query(
    "INSERT INTO oidc_states(state,value,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
    [state, JSON.stringify({ verifier, nonce })],
  );
  return oidc.buildAuthorizationUrl(client, {
    redirect_uri: cfg.origin + "/api/auth/callback",
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
}
export async function finishOIDC(db: Database, cfg: Config, url: URL) {
  const state = url.searchParams.get("state");
  if (!state) throw new HttpError(400, "Invalid sign-in state");
  const r = await db.query(
    "DELETE FROM oidc_states WHERE state=$1 AND expires_at>now() RETURNING value",
    [state],
  );
  if (!r.rows[0]) throw new HttpError(400, "Sign-in expired");
  const { verifier, nonce } = r.rows[0].value;
  const client = await identity(cfg);
  const tokens = await oidc.authorizationCodeGrant(client, url, {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
  });
  const claims = tokens.claims();
  if (
    !claims?.sub ||
    typeof claims.email !== "string" ||
    claims.email_verified !== true
  )
    throw new HttpError(403, "A verified email identity is required");
  const email = claims.email.toLowerCase();
  const existing = await db.query(
    "SELECT * FROM users WHERE issuer=$1 AND subject=$2",
    [cfg.issuer, claims.sub],
  );
  if (existing.rows[0]) return existing.rows[0].id as string;
  const emailUser = await db.query("SELECT * FROM users WHERE email=$1", [
    email,
  ]);
  if (emailUser.rows[0]?.issuer)
    throw new HttpError(403, "Email is already linked to another identity");
  const userId = emailUser.rows[0]?.id || id();
  const linked = await db.query(
    "INSERT INTO users(id,email,issuer,subject) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET issuer=EXCLUDED.issuer,subject=EXCLUDED.subject WHERE users.issuer IS NULL OR (users.issuer=EXCLUDED.issuer AND users.subject=EXCLUDED.subject) RETURNING id",
    [userId, email, cfg.issuer, claims.sub],
  );
  if (!linked.rows.length)
    throw new HttpError(403, "Identity is already linked");
  return linked.rows[0].id as string;
}
export const allProductIds = PRODUCT_IDS;
