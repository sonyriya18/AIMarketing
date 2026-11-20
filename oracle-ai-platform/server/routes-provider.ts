// Provider console: the platform provider creates client companies and decides which tools each
// company subscribes to. A company sees only its subscribed tools (inside their dates, while the
// company is active); company administrators cannot change their own subscription.
import { responsysRuntime } from "./responsys-gateway";
import express from "express";
import { z } from "zod";
import type { Database, SQL } from "./db";
import type { Config } from "./config";
import { asyncRoute, requireProvider } from "./auth";
import { HttpError, id, audit } from "./security";
import { PRODUCT_IDS } from "../shared/catalog";
import { responsysFor } from "./sso";
import { parseBrand, templateBrand } from "./brand";

const day = z
  .union([z.iso.date(), z.iso.datetime()])
  .transform((v) => (v.length === 10 ? v + "T00:00:00Z" : v));
const tool = z.object({
  app: z.enum(["responsys", "eloqua", "unity", "infinity"]),
  enabled: z.boolean().default(true),
  startsAt: day.nullable().optional(),
  endsAt: day.nullable().optional(),
});
export function responsysOrigin(cfg: Config, v: string | null | undefined) {
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new HttpError(422, "Enter the Responsys address as a full URL");
  }
  if (!["http:", "https:"].includes(u.protocol))
    throw new HttpError(422, "The Responsys address must use http or https");
  if (cfg.production && u.protocol !== "https:")
    throw new HttpError(422, "The Responsys address must use HTTPS");
  return u.origin;
}
const checkDates = (tools: z.infer<typeof tool>[]) => {
  for (const t of tools)
    if (t.startsAt && t.endsAt && t.endsAt <= t.startsAt)
      throw new HttpError(422, `The ${t.app} end date must be after its start`);
};

// Audit rows are tenant data under row-level security: scope the transaction to the company.
const tenantScope = (tx: SQL, wid: string) =>
  tx.query("SELECT set_config('app.workspace_id',$1,true)", [wid]);

export function registerProvider(
  api: express.Router,
  db: Database,
  cfg: Config,
) {
  api.get(
    "/provider/companies",
    asyncRoute(async (req, res) => {
      const c = requireProvider(req);
      const { rows } = await db.query(
        `SELECT w.id,w.name,w.slug,w.status,w.responsys_url AS "responsysUrl",w.brand,w.created_at AS "createdAt",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('app',e.app,'enabled',e.enabled,'startsAt',e.starts_at,'endsAt',e.ends_at)) FROM entitlements e WHERE e.workspace_id=w.id),'[]'::jsonb) AS tools,
          (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id) AS members,
          COALESCE((SELECT jsonb_agg(u.email ORDER BY u.email) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=w.id AND m.role='owner'),'[]'::jsonb) AS admins,
          EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=w.id AND m.user_id=$1) AS member
         FROM workspaces w ORDER BY w.name`,
        [c.userId],
      );
      res.json({
        companies: rows,
        responsysDefaultUrl: cfg.responsysUrl || null,
        ssoConfigured: !!cfg.ssoSecret,
      });
    }),
  );
  api.post(
    "/provider/companies",
    asyncRoute(async (req, res) => {
      const c = requireProvider(req);
      const input = z
        .object({
          name: z.string().trim().min(1).max(160),
          slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
          adminEmail: z.email(),
          tools: z.array(tool).max(4).default([]),
          responsysUrl: z.string().max(300).nullable().optional(),
          template: z.string().max(60).optional(),
          brand: z.unknown().optional(),
        })
        .parse(req.body);
      checkDates(input.tools);
      // A client template (e.g. Endeavour Group – Dan Murphy's) pre-fills the branding.
      const brand = parseBrand({
        ...(templateBrand(input.template) || {}),
        ...((input.brand as object) || {}),
      });
      const url = responsysOrigin(cfg, input.responsysUrl);
      const wid = id(),
        email = input.adminEmail.toLowerCase();
      await db.transaction(async (tx) => {
        const taken = await tx.query("SELECT 1 FROM workspaces WHERE slug=$1", [
          input.slug,
        ]);
        if (taken.rows.length)
          throw new HttpError(409, "That company address is already in use");
        await tx.query(
          "INSERT INTO workspaces(id,name,slug,responsys_url,brand) VALUES($1,$2,$3,$4,$5)",
          [wid, input.name, input.slug, url, JSON.stringify(brand)],
        );
        const u = await tx.query(
          "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
          [id(), email],
        );
        await tx.query(
          "INSERT INTO memberships(workspace_id,user_id,role,apps) VALUES($1,$2,'owner',$3)",
          [wid, u.rows[0].id, JSON.stringify(PRODUCT_IDS)],
        );
        for (const t of new Map(input.tools.map((t) => [t.app, t])).values())
          await tx.query(
            "INSERT INTO entitlements(workspace_id,app,enabled,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)",
            [wid, t.app, t.enabled, t.startsAt || null, t.endsAt || null],
          );
        await tenantScope(tx, wid);
        await audit(tx, wid, c.userId, "company.created", wid, {
          tools: input.tools.map((t) => t.app),
          admin: email,
        });
        // The provider who is also the company's administrator lands in it straight away.
        if (u.rows[0].id === c.userId)
          await tx.query(
            "UPDATE sessions SET workspace_id=$2 WHERE token_hash=$1",
            [c.tokenHash, wid],
          );
      });
      res.status(201).json({ id: wid });
    }),
  );
  api.patch(
    "/provider/companies/:id",
    asyncRoute(async (req, res) => {
      const c = requireProvider(req);
      const input = z
        .object({
          status: z.enum(["active", "suspended"]).optional(),
          responsysUrl: z.string().max(300).nullable().optional(),
          tools: z.array(tool).max(4).optional(),
          brand: z.unknown().optional(),
        })
        .parse(req.body);
      const brand =
        input.brand === undefined ? undefined : parseBrand(input.brand);
      if (input.tools) checkDates(input.tools);
      const wid = String(req.params.id);
      await db.transaction(async (tx) => {
        const w = await tx.query(
          "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
          [wid],
        );
        if (!w.rows.length) throw new HttpError(404, "Company not found");
        if (input.status)
          await tx.query("UPDATE workspaces SET status=$2 WHERE id=$1", [
            wid,
            input.status,
          ]);
        if (brand !== undefined)
          await tx.query("UPDATE workspaces SET brand=$2 WHERE id=$1", [
            wid,
            JSON.stringify(brand),
          ]);
        if (input.responsysUrl !== undefined)
          await tx.query("UPDATE workspaces SET responsys_url=$2 WHERE id=$1", [
            wid,
            responsysOrigin(cfg, input.responsysUrl),
          ]);
        if (input.tools) {
          const chosen = new Map(input.tools.map((t) => [t.app, t]));
          for (const app of PRODUCT_IDS) {
            const t = chosen.get(app);
            await tx.query(
              "INSERT INTO entitlements(workspace_id,app,enabled,starts_at,ends_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,app) DO UPDATE SET enabled=EXCLUDED.enabled,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at",
              [wid, app, !!t?.enabled, t?.startsAt || null, t?.endsAt || null],
            );
          }
        }
        await tenantScope(tx, wid);
        await audit(tx, wid, c.userId, "subscription.updated", wid, {
          branding: brand !== undefined,
          status: input.status,
          tools: input.tools?.filter((t) => t.enabled).map((t) => t.app),
          responsysUrl: input.responsysUrl !== undefined,
        });
      });
      res.json({ ok: true });
    }),
  );
  // Real check of a company's Responsys address: is it running, and which sign-in does it use?
  api.post(
    "/provider/companies/:id/responsys-check",
    asyncRoute(async (req, res) => {
      requireProvider(req);
      const origin = await responsysFor(db, cfg, String(req.params.id));
      if (!origin)
        return res.json({
          state: "not_configured",
          message:
            "No Responsys address is set for this company or as the platform default.",
        });
      try {
        // The Responsys started by this platform is checked directly on its internal port.
        const target =
          cfg.responsysDir && origin === new URL(cfg.responsysUrl).origin
            ? `http://127.0.0.1:${cfg.responsysInternalPort}`
            : origin;
        const r = await fetch(target + "/api/v1/auth/config", {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        const body: any = await r.json().catch(() => null);
        const mode = body?.data?.mode;
        if (!r.ok || !mode)
          return res.json({
            state: "unexpected",
            origin,
            message: `The address answered (HTTP ${r.status}) but not like Responsys.`,
          });
        res.json({
          state: mode === "oidc" ? "single_sign_on" : "own_sign_in",
          origin,
          message:
            mode === "oidc"
              ? cfg.ssoSecret
                ? "Responsys is running and uses single sign-on. Users open it from this platform."
                : "Responsys uses single sign-on, but RESPONSYS_SSO_SECRET is not set on this platform."
              : "Responsys is running with its own local sign-in. Run the link step in docs/RESPONSYS_SSO.md to switch it to platform sign-in.",
        });
      } catch (e) {
        const runtime = responsysRuntime.current;
        const local =
          cfg.responsysDir && origin === new URL(cfg.responsysUrl).origin;
        res.json({
          state: "unreachable",
          origin,
          message:
            local && runtime && runtime.state !== "running"
              ? runtime.message
              : `Responsys did not answer at ${origin}: ${(e as Error).message}`,
        });
      }
    }),
  );
  api.post(
    "/provider/companies/:id/admins",
    asyncRoute(async (req, res) => {
      const c = requireProvider(req);
      const email = z.email().parse(req.body.email).toLowerCase(),
        wid = String(req.params.id);
      await db.transaction(async (tx) => {
        const w = await tx.query("SELECT id FROM workspaces WHERE id=$1", [
          wid,
        ]);
        if (!w.rows.length) throw new HttpError(404, "Company not found");
        const u = await tx.query(
          "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
          [id(), email],
        );
        await tx.query(
          "INSERT INTO memberships(workspace_id,user_id,role,apps) VALUES($1,$2,'owner',$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner',apps=EXCLUDED.apps",
          [wid, u.rows[0].id, JSON.stringify(PRODUCT_IDS)],
        );
        await tenantScope(tx, wid);
        await audit(tx, wid, c.userId, "company.admin_added", wid, { email });
      });
      res.json({ ok: true });
    }),
  );
}
