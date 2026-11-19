// Company home page: live status across the user's authorized applications and sources, a work
// queue, a grounded AI briefing and question routing. Everything is filtered by entitlement,
// user application grant and source grant.
import express from "express";
import { z } from "zod";
import type { Database } from "./db";
import type { Config } from "./config";
import { asyncRoute, requireWorkspace } from "./auth";
import { HttpError, id } from "./security";
import { isApp, product } from "../shared/catalog";
import { briefingWithAI, routeWithAI, type BriefingItem } from "./ai";

export async function homeData(db: Database, req: express.Request) {
  const c = requireWorkspace(req);
  const apps = c.apps.filter(isApp);
  return db.tenant(c.workspaceId, async (tx) => {
    const sources = (
      await tx.query(
        "SELECT s.id,s.app,s.name,s.environment,s.policy FROM sources s WHERE s.workspace_id=$1 AND s.app=ANY($2) AND (s.visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=s.id AND g.user_id=$4)) ORDER BY s.app,s.name",
        [c.workspaceId, apps, c.role === "owner", c.userId],
      )
    ).rows;
    const out = [];
    for (const s of sources) {
      const d = (
        await tx.query(
          "SELECT id,name,as_of,row_count,metadata->>'completeness' AS completeness FROM datasets WHERE source_id=$1 AND active AND redacted_at IS NULL",
          [s.id],
        )
      ).rows[0];
      const rep = d
        ? (
            await tx.query(
              "SELECT id,created_at,result->'findings' AS findings,result->'capabilities' AS capabilities FROM reports WHERE dataset_id=$1 AND redacted_at IS NULL AND (result->'scope' IS NULL OR jsonb_array_length(result->'scope')=0) AND (result->'options' IS NULL OR result->'options'='{}'::jsonb) ORDER BY created_at DESC LIMIT 1",
              [d.id],
            )
          ).rows[0]
        : null;
      const conn =
        (
          await tx.query(
            "SELECT status,verification,last_success_at,last_error FROM connections WHERE source_id=$1 ORDER BY last_attempt_at DESC NULLS LAST LIMIT 1",
            [s.id],
          )
        ).rows[0] || null;
      const counts = (
        await tx.query(
          "SELECT (SELECT count(*)::int FROM notifications WHERE source_id=$1 AND read_at IS NULL AND (snoozed_until IS NULL OR snoozed_until<now())) AS unread, (SELECT count(*)::int FROM actions WHERE source_id=$1 AND state IN('open','accepted','in_progress')) AS open_actions, (SELECT count(*)::int FROM actions WHERE source_id=$1 AND state IN('open','accepted','in_progress') AND due_date IS NOT NULL AND due_date<to_char(now(),'YYYY-MM-DD')) AS overdue, (SELECT count(*)::int FROM drafts WHERE source_id=$1 AND status='in_review' AND created_by<>$2) AS reviews, (SELECT count(*)::int FROM investigations WHERE source_id=$1 AND status='open') AS investigations",
          [s.id, c.userId],
        )
      ).rows[0];
      const findings: any[] = rep?.findings || [];
      const sev = (x: string) =>
        findings.filter((f) => f.severity === x).length;
      const staleDays = Number(s.policy?.staleDays ?? 30);
      out.push({
        id: s.id,
        app: s.app,
        name: s.name,
        environment: s.environment,
        dataset: d
          ? {
              id: d.id,
              name: d.name,
              asOf: d.as_of,
              rows: d.row_count,
              partial: d.completeness === "partial",
              stale: Date.now() - Date.parse(d.as_of) > staleDays * 86_400_000,
            }
          : null,
        assessment: rep
          ? {
              reportId: rep.id,
              at: rep.created_at,
              high: sev("high"),
              medium: sev("medium"),
              low: sev("low") + sev("info"),
              top: findings.slice(0, 3).map((f) => ({
                id: f.id,
                title: f.title,
                severity: f.severity,
                detail: f.detail,
              })),
              gaps: (rep.capabilities || [])
                .filter((x: any) => x.state !== "available")
                .map((x: any) => x.label),
            }
          : null,
        connection: conn,
        ...counts,
      });
    }
    return { apps, permissions: c.permissions, sources: out };
  });
}

export function registerHome(api: express.Router, db: Database, cfg: Config) {
  api.get(
    "/home",
    asyncRoute(async (req, res) => res.json(await homeData(db, req))),
  );
  api.post(
    "/home/briefing",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      const home = await homeData(db, req);
      const items: BriefingItem[] = home.sources.flatMap((s: any) =>
        (s.assessment?.top || []).map((f: any) => ({
          id: f.id,
          app: product(s.app).short,
          source: s.name,
          title: f.title,
          severity: f.severity,
          detail: f.detail,
        })),
      );
      const gaps = home.sources.flatMap((s: any) => [
        ...(!s.dataset
          ? [
              `${product(s.app).short} · ${s.name}: no data yet. Upload an export or connect the source.`,
            ]
          : []),
        ...(s.dataset?.stale
          ? [
              `${product(s.app).short} · ${s.name}: data is stale; refresh it before acting.`,
            ]
          : []),
        ...(s.dataset && !s.assessment
          ? [
              `${product(s.app).short} · ${s.name}: data loaded but not assessed yet; open its Summary.`,
            ]
          : []),
      ]);
      if (!items.length && !gaps.length)
        return res.json({
          generator: "rule_based",
          status: "Nothing to brief yet",
          statements: [],
        });
      // Count toward the workspace AI budget only when a model is actually called.
      if (cfg.aiProvider !== "none") {
        const anchor = home.sources.find((s: any) => s.assessment);
        await db.tenant(c.workspaceId, async (tx) => {
          await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            c.workspaceId,
          ]);
          const n = (
            await tx.query(
              "SELECT count(*)::int AS n FROM ai_runs WHERE workspace_id=$1 AND created_at>=date_trunc('day',now())",
              [c.workspaceId],
            )
          ).rows[0].n;
          if (n >= cfg.aiLimit)
            throw new HttpError(429, "Workspace AI daily budget reached");
          if (anchor)
            await tx.query(
              "INSERT INTO ai_runs(id,workspace_id,source_id,report_id,user_id,purpose,question,provider,model,status) VALUES($1,$2,$3,$4,$5,'briefing','Home briefing',$6,$7,'completed')",
              [
                id(),
                c.workspaceId,
                anchor.id,
                anchor.assessment.reportId,
                c.userId,
                cfg.aiProvider,
                cfg.aiModel,
              ],
            );
        });
      }
      const ws = (
        await db.query("SELECT name FROM workspaces WHERE id=$1", [
          c.workspaceId,
        ])
      ).rows[0];
      const b = await briefingWithAI(cfg, ws.name, items, gaps);
      res.json({ ...b, findings: items });
    }),
  );
  api.post(
    "/home/route",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      const question = z
        .string()
        .trim()
        .min(2)
        .max(500)
        .parse(req.body.question);
      const apps = c.apps.filter(isApp);
      if (!apps.length)
        throw new HttpError(
          422,
          "No assessment applications are enabled for you",
        );
      res.json(await routeWithAI(cfg, question, apps));
    }),
  );
}
