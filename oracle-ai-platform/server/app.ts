import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Database } from "./db";
import type { Config } from "./config";
import {
  auth,
  asyncRoute,
  requireUser,
  requireWorkspace,
  requireProduct,
  sourceAccess,
  issueSession,
  sessionView,
  beginOIDC,
  finishOIDC,
  allProductIds,
  requirePermission,
  requireProvider,
} from "./auth";
import { HttpError, id, audit, safeError, seal, unseal } from "./security";
import {
  isApp,
  PRODUCTS,
  ENTITY_TYPES,
  type AppId,
  type Report,
  type RecordData,
} from "../shared/catalog";
import { FIELDS, template } from "../shared/fields";
import { registerData } from "./routes-data";
import { registerWorkflows } from "./routes-workflows";
import { registerHome } from "./routes-home";
import { registerProvider } from "./routes-provider";
import { registerSso, responsysFor, RESPONSYS_LOGIN } from "./sso";
import { responsysGateway, responsysRuntime } from "./responsys-gateway";
import {
  ConnectionSchema,
  defaultResources,
  oauthStart,
  oauthFinish,
} from "./connectors";
import { enqueue } from "./jobs";
import { PolicySchema } from "../shared/policy";
import { safeEqual } from "./security";
const string = z.string().trim().min(1).max(160);
const sourceSchema = z.object({
  app: z.enum(["eloqua", "unity", "infinity"]),
  name: string,
  environment: z.enum(["production", "test", "sandbox"]).default("production"),
  timezone: z.string().default("UTC"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  visibility: z.enum(["workspace", "restricted"]),
  userIds: z.array(z.string()).default([]),
  policy: PolicySchema.default({}),
});
const importSchema = z.object({
  content: z.string().max(4_000_000),
  format: z.enum(["csv", "json"]),
  type: z.string(),
  mapping: z.record(z.string(), z.string()).optional(),
  name: string,
  asOf: z.iso.datetime(),
  coverageStart: z.iso.date().optional(),
  coverageEnd: z.iso.date().optional(),
});
const htmlEscape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const csv = (v: unknown) =>
  '"' +
  String(v ?? "")
    .replace(/^[=+\-@\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';
export function createApp(db: Database, cfg: Config) {
  const app = express();
  app.disable("x-powered-by");
  // responsys.<host>:<port> is the unmodified Responsys app (same port, platform sign-in).
  if (cfg.responsysDir)
    app.use(responsysGateway(cfg, () => responsysRuntime.current, db));
  if (cfg.trustProxyHops) app.set("trust proxy", cfg.trustProxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: cfg.production
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
    }),
  );
  app.use(express.json({ limit: "6mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Request-Id", id());
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get(
    "/health/ready",
    asyncRoute(async (_req, res) => {
      await db.query("SELECT 1");
      res.json({ status: "ready" });
    }),
  );
  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60000,
      // Locally every request comes from one address (the user's own PC), so the limit is higher.
      limit: cfg.production ? 300 : 1500,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests. Wait a minute and try again." },
    }),
  );
  api.use(auth(db, cfg));
  api.get("/auth/config", (_req, res) =>
    res.json({ mode: cfg.authMode, provider: cfg.providerName }),
  );
  api.post(
    "/auth/dev-login",
    asyncRoute(async (req, res) => {
      if (cfg.production || cfg.authMode !== "dev")
        throw new HttpError(404, "Not found");
      const email = z.email().parse(req.body.email).toLowerCase();
      const u = await db.query(
        "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
        [id(), email],
      );
      // Local development: with no PLATFORM_ADMIN_EMAILS configured, the first person to sign in
      // becomes the platform provider administrator.
      if (!cfg.providerAdmins.length)
        await db.query(
          "INSERT INTO platform_admins(user_id) SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM platform_admins) ON CONFLICT DO NOTHING",
          [u.rows[0].id],
        );
      await issueSession(db, cfg, res, u.rows[0].id);
      res.json({ ok: true });
    }),
  );
  api.get(
    "/auth/login",
    asyncRoute(async (_req, res) => {
      if (cfg.authMode !== "oidc")
        throw new HttpError(404, "OIDC is not configured");
      const loginUrl = await beginOIDC(db, cfg);
      res.cookie("enterprise_login_state", loginUrl.searchParams.get("state"), {
        httpOnly: true,
        secure: cfg.production,
        sameSite: "lax",
        path: "/api/auth/callback",
        maxAge: 600000,
      });
      res.redirect(loginUrl.toString());
    }),
  );
  api.get(
    "/auth/callback",
    asyncRoute(async (req, res) => {
      const stateCookie =
        (req.headers.cookie || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("enterprise_login_state="))
          ?.slice("enterprise_login_state=".length) || "";
      if (
        !stateCookie ||
        !safeEqual(stateCookie, String(req.query.state || ""))
      )
        throw new HttpError(403, "Sign-in browser state did not match");
      res.clearCookie("enterprise_login_state", { path: "/api/auth/callback" });
      const user = await finishOIDC(
        db,
        cfg,
        new URL(req.originalUrl, cfg.origin),
      );
      await issueSession(db, cfg, res, user);
      res.redirect("/");
    }),
  );
  api.get(
    "/session",
    asyncRoute(async (req, res) =>
      res.json(req.ctx ? await sessionView(db, cfg, req.ctx) : null),
    ),
  );
  api.post(
    "/auth/logout",
    asyncRoute(async (req, res) => {
      if (req.ctx)
        await db.query("DELETE FROM sessions WHERE token_hash=$1", [
          req.ctx.tokenHash,
        ]);
      res.clearCookie("enterprise_session", { path: "/" });
      res.json({ ok: true });
    }),
  );
  api.get(
    "/brand/:slug",
    asyncRoute(async (req, res) => {
      const { rows } = await db.query(
        "SELECT name,slug,logo,brand->'logos'->>'primary' AS \"brandLogo\",brand->>'displayName' AS \"displayName\",brand->>'color' AS color FROM workspaces WHERE slug=$1",
        [req.params.slug],
      );
      res.json(rows[0] || null);
    }),
  );
  api.post(
    "/workspaces",
    asyncRoute(async (req, res) => {
      const c = requireProvider(req);
      const input = z
        .object({
          name: string,
          slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
          products: z
            .array(z.enum(["responsys", "eloqua", "unity", "infinity"]))
            .default([]),
        })
        .parse(req.body);
      const wid = id();
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)",
          [wid, input.name, input.slug],
        );
        await tx.query(
          "INSERT INTO memberships(workspace_id,user_id,role,apps) VALUES($1,$2,'owner',$3)",
          [wid, c.userId, JSON.stringify(allProductIds)],
        );
        for (const p of new Set(input.products))
          await tx.query(
            "INSERT INTO entitlements(workspace_id,app) VALUES($1,$2)",
            [wid, p],
          );
        await tx.query(
          "UPDATE sessions SET workspace_id=$2 WHERE token_hash=$1",
          [c.tokenHash, wid],
        );
      });
      res.status(201).json({ id: wid });
    }),
  );
  api.post(
    "/session/workspace",
    asyncRoute(async (req, res) => {
      const c = requireUser(req),
        wid = z.string().parse(req.body.id);
      const r = await db.query(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [wid, c.userId],
      );
      if (!r.rows.length) throw new HttpError(403, "Workspace access denied");
      await db.query(
        "UPDATE sessions SET workspace_id=$2 WHERE token_hash=$1",
        [c.tokenHash, wid],
      );
      res.json({ ok: true });
    }),
  );
  api.get(
    "/settings",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      const [members, entitlements] = await Promise.all([
        db.query(
          "SELECT m.user_id AS id,u.email,m.role,m.apps,m.permissions FROM memberships m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1",
          [c.workspaceId],
        ),
        db.query("SELECT * FROM entitlements WHERE workspace_id=$1", [
          c.workspaceId,
        ]),
      ]);
      res.json({
        members: members.rows,
        entitlements: entitlements.rows,
        products: PRODUCTS,
        responsysUrlConfigured: !!(await responsysFor(db, cfg, c.workspaceId)),
        singleSignOn: !!cfg.ssoSecret,
      });
    }),
  );
  api.patch(
    "/settings",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true),
        input = z
          .object({
            name: string,
            logo: z.string().max(300000).nullable().default(null),
          })
          .parse(req.body);
      if (
        input.logo &&
        !/^https:\/\/|^data:image\/(png|jpeg|webp);base64,/.test(input.logo)
      )
        throw new HttpError(
          422,
          "Use an HTTPS logo or PNG/JPEG/WebP data image",
        );
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("UPDATE workspaces SET name=$2,logo=$3 WHERE id=$1", [
          c.workspaceId,
          input.name,
          input.logo,
        ]);
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "workspace.updated",
          c.workspaceId,
        );
      });
      res.json({ ok: true });
    }),
  );
  api.put(
    "/members",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true),
        input = z
          .object({
            email: z.email(),
            role: z.enum(["owner", "analyst", "viewer"]),
            apps: z.array(z.enum(["responsys", "eloqua", "unity", "infinity"])),
            permissions: z
              .array(z.enum(["connectors", "approvals"]))
              .default([]),
          })
          .parse(req.body);
      await db.transaction(async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          c.workspaceId,
        ]);
        const email = input.email.toLowerCase(),
          r = await tx.query(
            "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
            [id(), email],
          );
        if (r.rows[0].id === c.userId && input.role !== "owner")
          throw new HttpError(
            422,
            "Keep your owner role; another owner can change it",
          );
        await tx.query(
          "INSERT INTO memberships(workspace_id,user_id,role,apps,permissions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role,apps=EXCLUDED.apps,permissions=EXCLUDED.permissions",
          [
            c.workspaceId,
            r.rows[0].id,
            input.role,
            JSON.stringify(input.apps),
            JSON.stringify(input.role === "analyst" ? input.permissions : []),
          ],
        );
      });
      res.json({ ok: true });
    }),
  );
  api.delete(
    "/members/:id",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      if (req.params.id === c.userId)
        throw new HttpError(422, "Ask another owner to remove your membership");
      await db.query(
        "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [c.workspaceId, req.params.id],
      );
      res.json({ ok: true });
    }),
  );
  // What the Responsys card shows: is Responsys running, how users sign in, which AI it uses.
  api.get(
    "/responsys/status",
    asyncRoute(async (req, res) => {
      const c = requireProduct(req, "responsys");
      const origin = await responsysFor(db, cfg, c.workspaceId);
      const runtime = responsysRuntime.current;
      const local =
        !!runtime &&
        !!cfg.responsysUrl &&
        origin === new URL(cfg.responsysUrl).origin;
      res.json({
        state: !origin ? "not_configured" : local ? runtime!.state : "external",
        message: !origin
          ? "Not set up"
          : local
            ? runtime!.message
            : "Runs at the company's Responsys address",
        signIn: cfg.ssoSecret ? "Platform single sign-on" : "Its own sign-in",
        ai:
          cfg.shareAiWithResponsys && cfg.aiProvider !== "none"
            ? `${cfg.aiProvider === "gemini" ? "Gemini" : "ChatGPT"} · ${cfg.aiModel}`
            : "Rule-based (no AI key)",
        opens: cfg.responsysDir ? "Inside the platform" : "In this window",
      });
    }),
  );
  api.get(
    "/responsys",
    asyncRoute(async (req, res) => {
      const c = requireProduct(req, "responsys");
      const origin = await responsysFor(db, cfg, c.workspaceId);
      if (!origin)
        throw new HttpError(
          422,
          cfg.production
            ? "Your platform provider has not set the Responsys address for this company yet"
            : 'Responsys was not found in the platform\'s "responsys" folder, so it has no address yet. Extract the complete package again, then double-click 1-SETUP.cmd and 2-START.cmd.',
        );
      // The platform runs Responsys itself (local): wait for it to answer, or say exactly what is wrong.
      const runtime = responsysRuntime.current;
      if (
        runtime &&
        cfg.responsysUrl &&
        origin === new URL(cfg.responsysUrl).origin
      ) {
        for (let i = 0; i < 40 && runtime.state === "starting"; i++)
          await new Promise((r) => setTimeout(r, 500));
        if (runtime.state === "starting")
          throw new HttpError(
            503,
            "Responsys is still starting (the first start can take a minute). Click Oracle Responsys again in a moment.",
          );
        if (runtime.state !== "running")
          throw new HttpError(503, runtime.message);
      }
      if (cfg.production && !origin.startsWith("https://"))
        throw new HttpError(422, "Responsys launch URL must use HTTPS");
      // With single sign-on, Responsys starts its own OIDC sign-in, which this platform
      // answers only for subscribed companies. Without it, Responsys keeps its own sign-in.
      res.json({
        url: cfg.ssoSecret ? origin + RESPONSYS_LOGIN : origin + "/",
        singleSignOn: !!cfg.ssoSecret,
      });
    }),
  );
  api.get(
    "/sources",
    asyncRoute(async (req, res) => {
      const c = requireProduct(req, String(req.query.app));
      res.json(
        (
          await db.tenant(c.workspaceId, (tx) =>
            tx.query(
              "SELECT s.* FROM sources s WHERE workspace_id=$1 AND app=$2 AND (visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=s.id AND g.user_id=$4)) ORDER BY created_at",
              [c.workspaceId, req.query.app, c.role === "owner", c.userId],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true),
        v = sourceSchema.parse(req.body);
      requireProduct(req, v.app);
      try {
        new Intl.DateTimeFormat("en", { timeZone: v.timezone });
      } catch {
        throw new HttpError(422, "Use a valid IANA timezone");
      }
      const sid = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO sources(id,workspace_id,app,name,environment,timezone,currency,visibility,policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            sid,
            c.workspaceId,
            v.app,
            v.name,
            v.environment,
            v.timezone,
            v.currency,
            v.visibility,
            JSON.stringify(v.policy),
          ],
        );
        for (const uid of v.userIds) {
          const m = await tx.query(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [c.workspaceId, uid],
          );
          if (!m.rows.length)
            throw new HttpError(
              422,
              "Source grants must name workspace members",
            );
          await tx.query(
            "INSERT INTO source_grants(workspace_id,source_id,user_id) VALUES($1,$2,$3)",
            [c.workspaceId, sid, uid],
          );
        }
        await audit(tx, c.workspaceId, c.userId, "source.created", sid, {
          visibility: v.visibility,
        });
      });
      res.status(201).json({ id: sid });
    }),
  );
  api.patch(
    "/sources/:id",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true),
        source = await sourceAccess(db, req, req.params.id),
        policy = PolicySchema.parse(req.body.policy);
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("UPDATE sources SET policy=$2 WHERE id=$1", [
          source.id,
          JSON.stringify(policy),
        ]);
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "source.policy_updated",
          source.id,
        );
      });
      res.json({ ok: true });
    }),
  );
  api.get(
    "/templates/:app/:type",
    asyncRoute(async (req, res) => {
      requireProduct(req, req.params.app);
      if (
        !isApp(req.params.app) ||
        !ENTITY_TYPES[req.params.app].includes(req.params.type)
      )
        throw new HttpError(404, "Unknown template");
      res
        .type("text/csv")
        .attachment(req.params.app + "-" + req.params.type + "-template.csv")
        .send(template(req.params.type));
    }),
  );
  api.get("/fields/:type", (req, res) => {
    requireWorkspace(req);
    res.json(FIELDS[req.params.type] || []);
  });
  api.get(
    "/sources/:id/datasets",
    asyncRoute(async (req, res) => {
      const source = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(source.workspaceId, (tx) =>
            tx.query(
              "SELECT * FROM datasets WHERE source_id=$1 ORDER BY created_at DESC",
              [source.id],
            ),
          )
        ).rows,
      );
    }),
  );
  registerData(api, db, cfg);
  api.get("/connections/templates/:app", (req, res) => {
    requireProduct(req, req.params.app);
    res.json(isApp(req.params.app) ? defaultResources[req.params.app] : []);
  });
  api.get(
    "/sources/:id/connections",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT id,source_id,config,status,verification,capabilities,last_error,last_checked_at,last_success_at,last_attempt_at,next_sync_at,sync_minutes,enabled,owned_resources FROM connections WHERE source_id=$1",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources/:id/connections",
    asyncRoute(async (req, res) => {
      const c = requirePermission(req, "connectors"),
        s = await sourceAccess(db, req, req.params.id),
        v = ConnectionSchema.parse(req.body.config),
        secrets = z
          .record(z.string(), z.string())
          .parse(req.body.secrets || {}),
        connectionId = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO connections(id,workspace_id,source_id,config,secrets) VALUES($1,$2,$3,$4,$5)",
          [
            connectionId,
            c.workspaceId,
            s.id,
            JSON.stringify(v),
            seal(secrets, cfg.encryptionKey),
          ],
        );
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "connection.created",
          connectionId,
        );
      });
      res.status(201).json({ id: connectionId });
    }),
  );
  const connection = async (req: express.Request) => {
    const c = requirePermission(req, "connectors");
    const r = await db.tenant(c.workspaceId, (tx) =>
      tx.query("SELECT * FROM connections WHERE id=$1 AND workspace_id=$2", [
        req.params.id,
        c.workspaceId,
      ]),
    );
    if (!r.rows[0]) throw new HttpError(404, "Connection not found");
    await sourceAccess(db, req, r.rows[0].source_id);
    return { c, row: r.rows[0] };
  };
  api.patch(
    "/connections/:id",
    asyncRoute(async (req, res) => {
      const { c, row } = await connection(req);
      const enabled =
          typeof req.body.enabled === "boolean"
            ? req.body.enabled
            : row.enabled,
        minutes = z
          .number()
          .int()
          .min(1)
          .max(10080)
          .parse(req.body.syncMinutes ?? row.sync_minutes),
        configValue = req.body.config
          ? ConnectionSchema.parse(req.body.config)
          : row.config,
        secretsValue = req.body.secrets
          ? seal(
              {
                ...(row.secrets
                  ? unseal<Record<string, string>>(
                      row.secrets,
                      cfg.encryptionKey,
                    )
                  : {}),
                accessToken: "",
                refreshToken: "",
                expiresAt: "0",
                ...z.record(z.string(), z.string()).parse(req.body.secrets),
              },
              cfg.encryptionKey,
            )
          : row.secrets;
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "UPDATE connections SET enabled=$2,sync_minutes=$3,config=$4,secrets=$5,status=CASE WHEN status='disconnected' AND $5<>'' THEN 'not_checked' ELSE status END WHERE id=$1",
          [row.id, enabled, minutes, JSON.stringify(configValue), secretsValue],
        );
        if (req.body.enabled === false || req.body.secrets || req.body.config) {
          await tx.query(
            "UPDATE jobs SET state='cancelled' WHERE connection_id=$1 AND state IN('queued','running')",
            [row.id],
          );
          await tx.query("UPDATE connections SET status=$2 WHERE id=$1", [
            row.id,
            req.body.enabled === false ? "paused" : "not_checked",
          ]);
        }
        await audit(tx, c.workspaceId, c.userId, "connection.updated", row.id);
      });
      res.json({ ok: true });
    }),
  );
  api.delete(
    "/connections/:id",
    asyncRoute(async (req, res) => {
      const { c, row } = await connection(req);
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "UPDATE jobs SET state='cancelled' WHERE connection_id=$1 AND state IN('queued','running')",
          [row.id],
        );
        await tx.query(
          "UPDATE connections SET enabled=false,secrets='',status='disconnected' WHERE id=$1",
          [row.id],
        );
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "connection.disconnected",
          row.id,
        );
      });
      res.json({ ok: true });
    }),
  );
  api.post(
    "/connections/:id/:operation(check|sync)",
    asyncRoute(async (req, res) => {
      const { c, row } = await connection(req);
      if (row.status === "disconnected")
        throw new HttpError(
          422,
          "Configure new credentials before reconnecting",
        );
      res.status(202).json({
        id: await enqueue(
          db,
          c.workspaceId,
          c.userId,
          row.id,
          req.params.operation as "check" | "sync",
        ),
      });
    }),
  );
  api.get(
    "/connections/:id/authorize",
    asyncRoute(async (req, res) => {
      const { c, row } = await connection(req),
        v = ConnectionSchema.parse(row.config);
      const started = await oauthStart(
        v,
        unseal(row.secrets, cfg.encryptionKey),
        cfg,
        cfg.origin + "/api/connections/callback",
      );
      await db.query(
        "INSERT INTO oidc_states(state,value,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
        [
          started.state,
          JSON.stringify({
            connectionId: row.id,
            workspaceId: c.workspaceId,
            userId: c.userId,
            verifier: started.verifier,
          }),
        ],
      );
      res.redirect(started.url);
    }),
  );
  api.get(
    "/connections/callback",
    asyncRoute(async (req, res) => {
      const c = requirePermission(req, "connectors"),
        state = z.string().parse(req.query.state);
      const r = await db.query(
        "DELETE FROM oidc_states WHERE state=$1 AND expires_at>now() RETURNING value",
        [state],
      );
      const v = r.rows[0]?.value;
      if (!v || v.workspaceId !== c.workspaceId || v.userId !== c.userId)
        throw new HttpError(
          403,
          "Source authorization state expired or changed",
        );
      const row = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query("SELECT * FROM connections WHERE id=$1", [v.connectionId]),
        )
      ).rows[0];
      await sourceAccess(db, req, row.source_id);
      const secrets = await oauthFinish(
        ConnectionSchema.parse(row.config),
        unseal(row.secrets, cfg.encryptionKey),
        cfg,
        z.string().parse(req.query.code),
        v.verifier,
        cfg.origin + "/api/connections/callback",
      );
      await db.tenant(c.workspaceId, (tx) =>
        tx.query("UPDATE connections SET secrets=$2 WHERE id=$1", [
          row.id,
          seal(secrets, cfg.encryptionKey),
        ]),
      );
      res.redirect("/");
    }),
  );
  api.get(
    "/sources/:id/jobs",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT id,kind,state,attempts,result,progress,last_error,failed_stage,created_at,updated_at FROM jobs WHERE source_id=$1 ORDER BY created_at DESC LIMIT 30",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/jobs/:id/cancel",
    asyncRoute(async (req, res) => {
      const c = requirePermission(req, "connectors");
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "UPDATE jobs SET state='cancelled',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state IN('running','queued')",
          [req.params.id, c.workspaceId],
        ),
      );
      res.json({ ok: true });
    }),
  );
  registerWorkflows(api, db, cfg);
  registerHome(api, db, cfg);
  registerProvider(api, db, cfg);
  api.get(
    "/audit",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      res.json(
        (
          await db.tenant(c.workspaceId, (tx) =>
            tx.query(
              "SELECT * FROM audit WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
              [c.workspaceId],
            ),
          )
        ).rows,
      );
    }),
  );
  registerSso(app, db, cfg);
  app.use("/api", api);
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "API endpoint not found")),
  );
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError)
        return res.status(422).json({
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      const status =
        error instanceof HttpError
          ? error.status
          : error.type === "entity.too.large"
            ? 413
            : error.type === "entity.parse.failed"
              ? 400
              : error.code === "23505"
                ? 409
                : 500;
      if (status === 500)
        console.error(
          "Request failed:",
          res.getHeader("X-Request-Id"),
          safeError(error),
        );
      res.status(status).json({
        error:
          status === 500
            ? "The operation could not complete. Check the server log using the request ID."
            : status === 413
              ? "Request exceeds the upload size limit"
              : status === 400
                ? "Invalid JSON request"
                : error instanceof HttpError
                  ? error.message
                  : "That record already exists.",
        code: error.code || "request_failed",
        requestId: res.getHeader("X-Request-Id"),
      });
    },
  );
  return app;
}
