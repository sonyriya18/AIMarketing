// Single sign-on for the unmodified Responsys application. The platform is a minimal OpenID
// Connect provider (authorization code + PKCE S256, RS256 ID tokens) with exactly one client:
// Responsys, configured through its own OIDC settings (no Responsys code changes). A code is issued
// only when the signed-in user's current company subscribes to Responsys (active company, tool
// inside its dates, user granted the tool), and only to that company's registered Responsys address.
import express from "express";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { Database } from "./db";
import type { Config } from "./config";
import { asyncRoute, auth } from "./auth";
import { hash, id, safeEqual, seal, unseal } from "./security";

export const SSO_CLIENT_ID = "responsys-v17";
export const RESPONSYS_CALLBACK = "/api/v1/auth/oidc/callback";
export const RESPONSYS_LOGIN = "/api/v1/auth/oidc/login?returnTo=%2F";
export const issuerOf = (cfg: Config) => cfg.origin + "/sso";
/** Prefix of local-development subjects (see subjectOf). */
export const LOCAL_SUBJECT_PREFIX = "local-";
/**
 * The subject Responsys links to its user. Production uses the platform user id. Local
 * development derives it from the email, so reinstalling the platform (a new local database)
 * still signs in to the same Responsys user instead of being refused as a different identity.
 */
export const subjectOf = (cfg: Config, userId: string, email: string) =>
  cfg.production
    ? userId
    : LOCAL_SUBJECT_PREFIX +
      createHash("sha256")
        .update("responsys-local:" + String(email).trim().toLowerCase())
        .digest("hex")
        .slice(0, 40);
const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** The company's Responsys address (its own, else the platform default), origin only. */
export async function responsysFor(
  db: Database,
  cfg: Config,
  workspaceId: string,
) {
  const { rows } = await db.query(
    "SELECT responsys_url FROM workspaces WHERE id=$1",
    [workspaceId],
  );
  const raw = rows[0]?.responsys_url || cfg.responsysUrl;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

let keyCache: { kid: string; privatePem: string; jwk: object } | null = null;
async function signingKey(db: Database, cfg: Config) {
  if (keyCache) return keyCache;
  const { rows } = await db.query(
    "SELECT kid,private_key,public_jwk FROM sso_keys ORDER BY created_at DESC LIMIT 1",
  );
  if (rows[0]) {
    keyCache = {
      kid: rows[0].kid,
      privatePem: unseal<{ pem: string }>(
        rows[0].private_key,
        cfg.encryptionKey,
      ).pem,
      jwk: rows[0].public_jwk,
    };
    return keyCache;
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = id();
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await db.query(
    "INSERT INTO sso_keys(kid,private_key,public_jwk) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [kid, seal({ pem }, cfg.encryptionKey), JSON.stringify(jwk)],
  );
  keyCache = null;
  return signingKey(db, cfg);
}
async function idToken(db: Database, cfg: Config, claims: object) {
  const k = await signingKey(db, cfg);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: k.kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = sign("sha256", Buffer.from(head + "." + body), k.privatePem);
  return head + "." + body + "." + b64u(sig);
}

/** Whether the user's company may use Responsys right now (subscription + user grant). */
async function responsysAllowed(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  const { rows } = await db.query(
    `SELECT 1 FROM workspaces w
       JOIN memberships m ON m.workspace_id=w.id AND m.user_id=$2
       JOIN entitlements e ON e.workspace_id=w.id AND e.app='responsys' AND e.enabled
            AND (e.starts_at IS NULL OR e.starts_at<=now()) AND (e.ends_at IS NULL OR e.ends_at>now())
      WHERE w.id=$1 AND w.status='active' AND (m.role='owner' OR m.apps ? 'responsys')`,
    [workspaceId, userId],
  );
  return rows.length > 0;
}

const page = (
  res: express.Response,
  status: number,
  title: string,
  text: string,
) =>
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 16px;line-height:1.5"><h1>${title}</h1><p>${text}</p><p><a href="/">Back to the Oracle AI Platform</a></p></body>`,
    );

export function registerSso(app: express.Express, db: Database, cfg: Config) {
  const r = express.Router();
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  r.use((req, res, next) => {
    if (!cfg.ssoSecret)
      return page(
        res,
        404,
        "Responsys single sign-on is not set up",
        "The platform administrator needs to set RESPONSYS_SSO_SECRET (see docs/RESPONSYS_SSO.md).",
      );
    next();
  });
  r.get("/.well-known/openid-configuration", (_req, res) => {
    const iss = issuerOf(cfg);
    res.json({
      issuer: iss,
      authorization_endpoint: iss + "/authorize",
      token_endpoint: iss + "/token",
      jwks_uri: iss + "/jwks",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile"],
      claims_supported: ["sub", "email", "email_verified", "name"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      authorization_response_iss_parameter_supported: true,
    });
  });
  r.get(
    "/jwks",
    asyncRoute(async (_req, res) => {
      res.json({ keys: [(await signingKey(db, cfg)).jwk] });
    }),
  );
  r.get(
    "/authorize",
    auth(db, cfg),
    asyncRoute(async (req, res) => {
      const q = req.query as Record<string, string>;
      if (q.client_id !== SSO_CLIENT_ID)
        return page(
          res,
          400,
          "Unknown application",
          "This sign-in request does not come from the registered Responsys application.",
        );
      const c = req.ctx;
      if (!c) {
        // Sign in to the platform first, then come back to this request.
        return res.redirect(
          "/?next=" + encodeURIComponent(req.originalUrl.slice(0, 2000)),
        );
      }
      if (!c.workspaceId)
        return page(
          res,
          403,
          "Choose your company first",
          "Open the Oracle AI Platform, choose your company, then open Responsys from its home page.",
        );
      if (!(await responsysAllowed(db, c.userId, c.workspaceId)))
        return page(
          res,
          403,
          "Responsys is not part of your subscription",
          "Your company does not currently subscribe to Oracle Responsys, or your administrator has not given you access to it.",
        );
      const origin = await responsysFor(db, cfg, c.workspaceId);
      const expected = origin ? origin + RESPONSYS_CALLBACK : null;
      // Never redirect to an address that is not this company's registered Responsys app.
      if (!expected || q.redirect_uri !== expected)
        return page(
          res,
          400,
          "Responsys address does not match",
          "The Responsys application asking for sign-in is not the one registered for your company. Ask your platform provider to check the company's Responsys address.",
        );
      if (
        q.response_type !== "code" ||
        !String(q.scope || "")
          .split(" ")
          .includes("openid") ||
        q.code_challenge_method !== "S256" ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || "") ||
        !q.state ||
        !q.nonce
      ) {
        const back = new URL(expected);
        back.searchParams.set("error", "invalid_request");
        if (q.state) back.searchParams.set("state", q.state);
        return res.redirect(back.toString());
      }
      const code = randomBytes(32).toString("base64url");
      await db.query("DELETE FROM sso_codes WHERE expires_at<now()");
      await db.query(
        "INSERT INTO sso_codes(code_hash,value,expires_at) VALUES($1,$2,now()+interval '60 seconds')",
        [
          hash(code),
          JSON.stringify({
            userId: c.userId,
            email: c.email,
            workspaceId: c.workspaceId,
            redirectUri: expected,
            challenge: q.code_challenge,
            nonce: q.nonce,
          }),
        ],
      );
      const back = new URL(expected);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.state);
      back.searchParams.set("iss", issuerOf(cfg));
      res.redirect(back.toString());
    }),
  );
  r.post(
    "/token",
    express.urlencoded({ extended: false, limit: "10kb" }),
    asyncRoute(async (req, res) => {
      const fail = (status: number, error: string) =>
        res.status(status).json({ error });
      // Client authentication: client_secret_basic or client_secret_post.
      let clientId = String(req.body.client_id || ""),
        secret = String(req.body.client_secret || "");
      const basic = /^Basic (.+)$/i.exec(req.get("authorization") || "");
      if (basic) {
        const [u, p] = Buffer.from(basic[1], "base64").toString().split(":");
        clientId = decodeURIComponent(u || "");
        secret = decodeURIComponent(p || "");
      }
      if (clientId !== SSO_CLIENT_ID || !safeEqual(secret, cfg.ssoSecret))
        return fail(401, "invalid_client");
      if (req.body.grant_type !== "authorization_code")
        return fail(400, "unsupported_grant_type");
      const r0 = await db.query(
        "DELETE FROM sso_codes WHERE code_hash=$1 AND expires_at>now() RETURNING value",
        [hash(String(req.body.code || ""))],
      );
      const v = r0.rows[0]?.value;
      if (!v) return fail(400, "invalid_grant");
      const verifier = String(req.body.code_verifier || "");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (
        req.body.redirect_uri !== v.redirectUri ||
        !verifier ||
        !safeEqual(challenge, v.challenge)
      )
        return fail(400, "invalid_grant");
      // The subscription is checked again when the token is issued.
      if (!(await responsysAllowed(db, v.userId, v.workspaceId)))
        return fail(400, "invalid_grant");
      const now = Math.floor(Date.now() / 1000);
      const token = await idToken(db, cfg, {
        iss: issuerOf(cfg),
        sub: subjectOf(cfg, v.userId, v.email),
        aud: SSO_CLIENT_ID,
        iat: now,
        exp: now + 300,
        nonce: v.nonce,
        email: v.email,
        // Production identities come from the organization's identity provider, which must
        // assert a verified email at platform sign-in. Local email sign-in is development-only.
        email_verified: true,
        name: String(v.email).split("@")[0],
      });
      res.json({
        access_token: randomBytes(32).toString("base64url"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: token,
        scope: "openid email profile",
      });
    }),
  );
  app.use("/sso", r);
}
