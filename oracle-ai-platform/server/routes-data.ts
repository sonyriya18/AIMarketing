// Data, report, scenario, comparison, playbook and Ask AI routes. Every route re-checks the
// signed-in user's workspace, application entitlement and source grant.
import express from "express";
import { clientDocuments } from "./brand";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Database } from "./db";
import type { Config } from "./config";
import {
  asyncRoute,
  requireWorkspace,
  requirePermission,
  sourceAccess,
} from "./auth";
import { HttpError, id, audit, hash } from "./security";
import { ENTITY_TYPES, type Report } from "../shared/catalog";
import { DICTIONARY } from "../shared/fields";
import { parseBatch, commitRecords, MAX_FILES } from "./imports";
import { moduleFor } from "./modules";
import { sampleSizePerArm } from "./modules/common";
import { askAI, passages, TOOLS, type Document } from "./ai";
import { buildReport, datasetRecords, reportAccess } from "./context";
import { evaluateActions } from "./outcomes";
import { buildStudio, profile360 } from "./studio";

const string = z.string().trim().min(1).max(160);
const fileSchema = z.object({
  content: z.string().max(4_000_000),
  format: z.enum(["csv", "json"]),
  type: z.string().max(60),
  mapping: z.record(z.string(), z.string()).optional(),
  name: z.string().max(200).optional(),
});
const batchSchema = z.object({
  files: z.array(fileSchema).min(1).max(MAX_FILES),
  name: string,
  asOf: z.iso.datetime(),
  coverageStart: z.iso.date().optional(),
  coverageEnd: z.iso.date().optional(),
  acceptPartial: z.boolean().default(false),
  partialReason: z.string().max(500).optional(),
});
const toBatch = (body: any) =>
  Array.isArray(body?.files)
    ? body
    : {
        ...body,
        files: [
          {
            content: body?.content,
            format: body?.format,
            type: body?.type,
            mapping: body?.mapping,
            name: body?.name,
          },
        ],
      };
export const optionsSchema = z
  .object({
    field: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .max(60)
      .optional(),
    steps: z.array(z.string().min(1).max(100)).min(2).max(10).optional(),
    windowMinutes: z.number().min(1).max(43200).optional(),
    identity: z.enum(["session", "visitor"]).optional(),
  })
  .strict()
  .default({});
const reportInput = z.object({
  datasetId: z.string().optional(),
  selectedIds: z.array(z.string().max(300)).max(100).default([]),
  periodStart: z.iso.date().optional(),
  periodEnd: z.iso.date().optional(),
  options: optionsSchema,
});
const htmlEscape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// Neutralize spreadsheet formula injection in every exported cell.
export const csvCell = (v: unknown) =>
  '"' +
  String(v ?? "")
    .replace(/^[=+\-@\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';

export async function approvedDocuments(
  db: Database,
  workspace: string,
  sourceId: string,
): Promise<Document[]> {
  return db.tenant(workspace, async (tx) => {
    const k = await tx.query(
      "SELECT id,title,content FROM knowledge WHERE source_id=$1 AND status='approved' ORDER BY created_at DESC LIMIT 20",
      [sourceId],
    );
    // The client's business profile and marketing rules (Branding & links) travel with the
    // approved playbooks, so AI answers and drafts can cite them and must follow the rules.
    const w = await tx.query("SELECT name,brand FROM workspaces WHERE id=$1", [workspace]);
    return [...k.rows, ...clientDocuments(w.rows[0]?.name, w.rows[0]?.brand)];
  });
}

export function registerData(api: express.Router, db: Database, cfg: Config) {
  // ---------------- Imports (single file or explicit multi-file batch) ----------------
  api.post(
    "/sources/:id/import/preview",
    asyncRoute(async (req, res) => {
      const source = await sourceAccess(db, req, req.params.id, true),
        input = batchSchema.parse(toBatch(req.body));
      const r = parseBatch(source.app, input.files);
      res.json({
        ...r,
        records: r.records.slice(0, 8),
        committable: !r.errors.length || input.acceptPartial,
      });
    }),
  );
  api.post(
    "/sources/:id/import/commit",
    asyncRoute(async (req, res) => {
      const source = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true),
        input = batchSchema.parse(toBatch(req.body));
      const r = parseBatch(source.app, input.files);
      if (r.errors.length && !input.acceptPartial)
        throw new HttpError(
          422,
          `Resolve ${r.errors.length} validation error(s) or explicitly import as a partial snapshot`,
        );
      if (input.acceptPartial && r.errors.length && !input.partialReason)
        throw new HttpError(
          422,
          "Explain why this partial snapshot is acceptable",
        );
      if (!r.records.length)
        throw new HttpError(422, "No valid records to import");
      const partial = r.errors.length > 0 || input.acceptPartial;
      const committed = await commitRecords(
        db,
        c.workspaceId,
        c.userId,
        source,
        r.records,
        {
          name: input.name,
          mode: "upload",
          asOf: input.asOf,
          coverageStart: input.coverageStart,
          coverageEnd: input.coverageEnd,
          metadata: {
            files: r.files,
            warnings: r.warnings,
            completeness: partial ? "partial" : "complete",
            partialReason: partial
              ? input.partialReason || "declared partial"
              : undefined,
            quarantinedRows: r.errors.length,
            quarantine: r.errors.slice(0, 50),
            mappingVersion: hash(
              JSON.stringify(input.files.map((f) => f.mapping || {})),
            ).slice(0, 12),
            importedBy: c.userId,
          },
        },
      );
      // Re-evaluate tracked actions against the new active snapshot (observation only, no causal claim).
      if (!committed.duplicate)
        await evaluateActions(db, c.workspaceId, c.userId, source).catch(
          () => undefined,
        );
      res.status(201).json({
        ...committed,
        partial,
        quarantinedRows: r.errors.length,
        warnings: r.warnings,
      });
    }),
  );
  api.post(
    "/datasets/:id/activate",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, true);
      const d = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT * FROM datasets WHERE id=$1 AND workspace_id=$2 AND redacted_at IS NULL",
            [req.params.id, c.workspaceId],
          ),
        )
      ).rows[0];
      if (!d) throw new HttpError(404, "Dataset not found");
      await sourceAccess(db, req, d.source_id, true);
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("UPDATE datasets SET active=false WHERE source_id=$1", [
          d.source_id,
        ]);
        await tx.query("UPDATE datasets SET active=true WHERE id=$1", [
          req.params.id,
        ]);
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "dataset.reactivated",
          req.params.id,
        );
      });
      res.json({ ok: true });
    }),
  );
  // Authorized deletion: removes imported records, redacts derived reports and AI runs, keeps audit metadata.
  api.delete(
    "/datasets/:id",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      const confirm = z.string().parse(req.body?.confirm);
      const d = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query("SELECT * FROM datasets WHERE id=$1 AND workspace_id=$2", [
            req.params.id,
            c.workspaceId,
          ]),
        )
      ).rows[0];
      if (!d) throw new HttpError(404, "Dataset not found");
      const source = await sourceAccess(db, req, d.source_id, true);
      if (confirm !== d.name)
        throw new HttpError(
          422,
          "Type the dataset name exactly to confirm deletion",
        );
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          `DELETE FROM ${source.app}_records WHERE dataset_id=$1`,
          [d.id],
        );
        const reports = await tx.query(
          "UPDATE reports SET result=$2,redacted_at=now() WHERE dataset_id=$1 RETURNING id",
          [
            d.id,
            JSON.stringify({
              redacted: true,
              reason: "Dataset deleted under the retention policy",
              at: new Date().toISOString(),
            }),
          ],
        );
        const ids = reports.rows.map((r) => r.id);
        if (ids.length)
          await tx.query(
            "UPDATE ai_runs SET result=NULL,question='[deleted]',tool_calls='[]' WHERE report_id=ANY($1)",
            [ids],
          );
        await tx.query(
          "UPDATE datasets SET active=false,redacted_at=now(),row_count=0,metadata=$2 WHERE id=$1",
          [d.id, JSON.stringify({ redacted: true })],
        );
        await audit(tx, c.workspaceId, c.userId, "dataset.deleted", d.id, {
          reports: ids.length,
        });
      });
      res.json({
        ok: true,
        note: "Records deleted and derived reports redacted. Backups expire on the backup retention schedule documented in docs/OPERATIONS.md (Retention and deletion).",
      });
    }),
  );
  // ---------------- Dictionaries, templates, examples ----------------
  api.get(
    "/dictionary/:app",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      if (
        !["eloqua", "unity", "infinity"].includes(req.params.app) ||
        !c.apps.includes(req.params.app as never)
      )
        throw new HttpError(
          403,
          "This application is not enabled for your account",
        );
      const m = moduleFor(req.params.app as "eloqua");
      res.json({
        entities: Object.fromEntries(
          ENTITY_TYPES[m.app].map((t) => [t, DICTIONARY[t]]),
        ),
        metrics: m.metricDictionary,
        rules: m.rules,
        definitionVersion: m.definitionVersion,
        scenario: m.scenarioFields,
        drafts: m.draftTypes.map((d) => ({
          id: d.id,
          label: d.label,
          fields: d.fields,
        })),
      });
    }),
  );
  api.get(
    "/examples/:app",
    asyncRoute(async (req, res) => {
      requireWorkspace(req);
      if (cfg.production)
        throw new HttpError(
          404,
          "Synthetic examples are not available in production",
        );
      if (!["eloqua", "unity", "infinity"].includes(req.params.app))
        throw new HttpError(404, "Unknown example");
      const p = resolve("examples", req.params.app + ".json");
      if (!existsSync(p)) throw new HttpError(404, "Example not found");
      res
        .attachment(req.params.app + "-SYNTHETIC-example.json")
        .type("json")
        .send(readFileSync(p, "utf8"));
    }),
  );
  // One click: import the clearly SYNTHETIC example into this source (development only), and set
  // the sample's settings (conversion event, funnel steps, required fields) where none are set.
  api.post(
    "/sources/:id/examples/load",
    asyncRoute(async (req, res) => {
      if (cfg.production)
        throw new HttpError(
          404,
          "Synthetic examples are not available in production",
        );
      const source = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true);
      const p = resolve("examples", source.app + ".json");
      if (!existsSync(p)) throw new HttpError(404, "Example not found");
      const r = parseBatch(source.app, [
        {
          content: readFileSync(p, "utf8"),
          format: "json",
          type: "mixed",
          name: source.app + "-SYNTHETIC-example.json",
        },
      ]);
      if (r.errors.length)
        throw new HttpError(422, "The example did not validate");
      const committed = await commitRecords(
        db,
        c.workspaceId,
        c.userId,
        source,
        r.records,
        {
          name: "Sample data (synthetic)",
          mode: "upload",
          asOf: "2026-10-28T12:00:00Z",
          metadata: {
            files: r.files,
            warnings: r.warnings,
            completeness: "complete",
            synthetic: true,
            importedBy: c.userId,
          },
        },
      );
      const defaults: Record<string, Record<string, unknown>> = {
        infinity: {
          conversionEvent: "purchase",
          funnelSteps: [
            "view_product",
            "add_to_cart",
            "checkout_start",
            "purchase",
          ],
        },
        unity: { requiredFields: ["email", "country"] },
        eloqua: {},
      };
      const applied = Object.fromEntries(
        Object.entries(defaults[source.app]).filter(
          ([k]) => source.policy?.[k] === undefined,
        ),
      );
      await db.tenant(c.workspaceId, async (tx) => {
        if (committed.duplicate) {
          await tx.query(
            "UPDATE datasets SET active=false WHERE source_id=$1",
            [source.id],
          );
          await tx.query("UPDATE datasets SET active=true WHERE id=$1", [
            committed.id,
          ]);
        }
        if (Object.keys(applied).length)
          await tx.query("UPDATE sources SET policy=policy||$2 WHERE id=$1", [
            source.id,
            JSON.stringify(applied),
          ]);
        await audit(tx, c.workspaceId, c.userId, "example.loaded", source.id, {
          records: r.records.length,
        });
      });
      res.status(201).json({
        id: committed.id,
        records: r.records.length,
        settings: applied,
      });
    }),
  );
  // ---------------- Reports ----------------
  api.post(
    "/sources/:id/reports",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id),
        c = requireWorkspace(req),
        input = reportInput.parse(req.body);
      if (
        input.periodStart &&
        input.periodEnd &&
        input.periodStart > input.periodEnd
      )
        throw new HttpError(422, "Start date must be before end date");
      res.json(await buildReport(db, c.workspaceId, c.userId, s, input));
    }),
  );
  // Studio: deep dives, head-to-head comparisons and flows for the active (or chosen) snapshot.
  api.post(
    "/sources/:id/studio",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      const v = z
        .object({
          datasetId: z.string().optional(),
          periodStart: z.iso.date().optional(),
          periodEnd: z.iso.date().optional(),
        })
        .parse(req.body || {});
      const { dataset, records } = await db.tenant(s.workspaceId, (tx) =>
        datasetRecords(tx, s.workspaceId, s, v.datasetId),
      );
      res.json(
        buildStudio(s, records, {
          periodStart: v.periodStart,
          periodEnd: v.periodEnd,
          asOf: new Date(dataset.as_of).toISOString(),
          datasetId: dataset.id,
        }),
      );
    }),
  );
  // Unity customer profile (360): one person's linked records, consent and audiences.
  api.post(
    "/sources/:id/profile",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id),
        c = requireWorkspace(req);
      if (s.app !== "unity")
        throw new HttpError(422, "Customer profiles belong to Unity sources");
      const query = z.string().trim().min(2).max(200).parse(req.body?.query);
      const { dataset, records } = await db.tenant(s.workspaceId, (tx) =>
        datasetRecords(tx, s.workspaceId, s),
      );
      const found = profile360(
        records,
        query,
        new Date(dataset.as_of).toISOString(),
      );
      await db.tenant(c.workspaceId, (tx) =>
        audit(tx, c.workspaceId, c.userId, "profile.viewed", s.id, {
          found: !!found,
        }),
      );
      res.json({ found: !!found, profile: found });
    }),
  );
  api.get(
    "/reports/:id",
    asyncRoute(async (req, res) =>
      res.json((await reportAccess(db, req, req.params.id)).report),
    ),
  );
  api.post(
    "/reports/:id/save",
    asyncRoute(async (req, res) => {
      const { c, row } = await reportAccess(db, req, req.params.id, true);
      const title = z.string().trim().min(1).max(160).parse(req.body.title);
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("UPDATE reports SET saved=true,title=$2 WHERE id=$1", [
          row.id,
          title,
        ]);
        await audit(tx, c.workspaceId, c.userId, "report.saved", row.id);
      });
      res.json({ ok: true });
    }),
  );
  api.get(
    "/sources/:id/reports",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT r.id,r.title,r.saved,r.created_at,r.dataset_id,r.redacted_at,d.name AS dataset_name,u.email AS created_by FROM reports r JOIN datasets d ON d.id=r.dataset_id LEFT JOIN users u ON u.id=r.created_by WHERE r.source_id=$1 AND (r.saved OR $2) ORDER BY r.created_at DESC LIMIT 100",
              [s.id, req.query.all === "1"],
            ),
          )
        ).rows,
      );
    }),
  );
  api.get(
    "/reports/:id/export",
    asyncRoute(async (req, res) => {
      const { report, row } = await reportAccess(db, req, req.params.id);
      const format = String(req.query.format || "json");
      const name = "assessment-" + report.app + "-" + report.id;
      await db.tenant(row.workspace_id, (tx) =>
        audit(
          tx,
          row.workspace_id,
          req.ctx!.userId,
          "report.exported",
          report.id,
          { format },
        ),
      );
      if (format === "json") {
        const { records, ...evidence } = report;
        res
          .attachment(name + ".json")
          .json({ ...evidence, recordCount: records.length });
      } else if (format === "csv")
        res
          .type("text/csv")
          .attachment(name + ".csv")
          .send(
            [
              "kind,id,label_or_title,value,unit,state,definition_or_detail,reason_or_action",
              ...report.metrics.map((m) =>
                [
                  "metric",
                  m.id,
                  m.label,
                  m.value,
                  m.currency || m.unit,
                  m.state,
                  m.formula,
                  m.reason,
                ]
                  .map(csvCell)
                  .join(","),
              ),
              ...report.findings.map((f) =>
                [
                  "finding",
                  f.id,
                  f.title,
                  f.priority?.rank,
                  f.severity,
                  f.rule,
                  f.detail,
                  f.action,
                ]
                  .map(csvCell)
                  .join(","),
              ),
            ].join("\r\n"),
          );
      else if (format === "print") {
        const ws = (
          await db.query("SELECT name,logo FROM workspaces WHERE id=$1", [
            row.workspace_id,
          ])
        ).rows[0];
        res
          .type("html")
          .send(
            `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(ws.name)} · ${htmlEscape(report.app)} assessment</title><style>body{font:14px/1.5 Arial,sans-serif;max-width:920px;margin:32px auto;color:#1d2433;padding:0 16px}h1{margin:0}header{display:flex;gap:16px;align-items:center;border-bottom:3px solid #b42318;padding-bottom:12px}header img{max-height:48px}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{text-align:left;border-bottom:1px solid #ddd;padding:8px;vertical-align:top}small,.muted{color:#5a6475}.tag{font-size:11px;border:1px solid #ccc;border-radius:10px;padding:1px 6px}@media print{.noprint{display:none}}</style></head><body>` +
              `<header>${ws.logo ? `<img src="${htmlEscape(ws.logo)}" alt="">` : ""}<div><h1>${htmlEscape(ws.name)}</h1><div>${htmlEscape(report.name)} · Oracle ${htmlEscape(report.app)} assessment</div></div></header>` +
              `<p class="muted">Data as of ${htmlEscape(report.asOf)} · period ${htmlEscape(report.period?.start || "all")} – ${htmlEscape(report.period?.end || "all")} · timezone ${htmlEscape(report.timezone)} · generated ${htmlEscape(report.generatedAt)} · ${htmlEscape(report.definitionVersion)}</p>` +
              `<h2>Measures</h2><table><thead><tr><th>Measure</th><th>Value</th><th>Definition</th></tr></thead><tbody>${report.metrics.map((m) => `<tr><td>${htmlEscape(m.label)} <span class="tag">${htmlEscape(m.state || "")}</span></td><td>${htmlEscape(m.value ?? "Unavailable")} ${htmlEscape(m.value === null ? "" : m.currency || (m.unit === "percent" ? "%" : m.unit))}</td><td>${htmlEscape(m.formula)}${m.reason ? `<br><small>${htmlEscape(m.reason)}</small>` : ""}</td></tr>`).join("")}</tbody></table>` +
              `<h2>Findings and recommendations</h2>${report.findings.map((f) => `<h3>${f.priority?.rank}. ${htmlEscape(f.title)} <span class="tag">${htmlEscape(String(f.severity))}</span></h3><p>${htmlEscape(f.detail)}</p><p><b>Proposed action:</b> ${htmlEscape(f.action)}</p>${f.recommendation?.hypotheses.length ? `<p><b>Hypotheses (not proven):</b> ${htmlEscape(f.recommendation.hypotheses.join(" · "))}</p>` : ""}<small>Rule ${htmlEscape(f.rule)} · evidence ${htmlEscape(f.evidenceIds.join(", ") || f.entityScope || "")}</small>`).join("") || "<p>No rules triggered.</p>"}` +
              `<h2>Data limitations</h2>${report.warnings.map((w) => `<p>${htmlEscape(w)}</p>`).join("")}<small>Snapshot ${htmlEscape(report.id)} · dataset ${htmlEscape(report.datasetId)}. This is a browser print view: use your browser's Print command to save a PDF. No server-side PDF renderer is used.</small></body></html>`,
          );
      } else throw new HttpError(422, "Unsupported export format");
    }),
  );
  // ---------------- Comparison ----------------
  api.post(
    "/sources/:id/compare",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id),
        c = requireWorkspace(req),
        input = z
          .object({
            datasetId: z.string().optional(),
            keys: z.array(z.string().max(300)).min(2).max(4),
            periodStart: z.iso.date().optional(),
            periodEnd: z.iso.date().optional(),
          })
          .parse(req.body);
      const out = await db.tenant(c.workspaceId, async (tx) => {
        const { dataset, records } = await datasetRecords(
          tx,
          c.workspaceId,
          s,
          input.datasetId,
        );
        try {
          return moduleFor(s.app).compare(s, records, input.keys, {
            datasetId: dataset.id,
            mode: dataset.mode,
            asOf: new Date(dataset.as_of).toISOString(),
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          });
        } catch (e) {
          throw new HttpError(422, (e as Error).message);
        }
      });
      res.json(out);
    }),
  );
  // ---------------- Scenarios (assumption-based, persisted with baseline and formula version) ----------------
  api.post(
    "/reports/:id/scenarios",
    asyncRoute(async (req, res) => {
      const { c, report } = await reportAccess(db, req, req.params.id, true);
      const input = z
        .record(z.string(), z.union([z.string().max(40), z.number()]))
        .parse(req.body);
      let result;
      try {
        result = moduleFor(report.app).simulate({
          currency: report.currency,
          ...input,
        });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      const sid = id();
      const baseline = {
        reportId: report.id,
        datasetId: report.datasetId,
        asOf: report.asOf,
        scope: report.scope || [],
        definitionVersion: report.definitionVersion,
      };
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "INSERT INTO scenarios(id,workspace_id,source_id,report_id,input,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            sid,
            c.workspaceId,
            report.sourceId,
            report.id,
            JSON.stringify(input),
            JSON.stringify({ ...result, baseline }),
            c.userId,
          ],
        ),
      );
      res.json({ id: sid, ...result, baseline });
    }),
  );
  api.get(
    "/sources/:id/scenarios",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT id,input,result,created_at FROM scenarios WHERE source_id=$1 ORDER BY created_at DESC LIMIT 30",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/tools/sample-size",
    asyncRoute(async (req, res) => {
      requireWorkspace(req);
      const v = z
        .object({
          baselinePct: z.number().gt(0).lt(100),
          mdePp: z.number().refine((x) => x !== 0, "Effect cannot be zero"),
          alpha: z.number().gt(0).lt(0.5).default(0.05),
          power: z.number().gt(0.5).lt(1).default(0.8),
        })
        .parse(req.body);
      try {
        res.json({
          perArm: sampleSizePerArm(v.baselinePct, v.mdePp, v.alpha, v.power),
          method:
            "Two-sided test of two proportions (normal approximation), equal allocation",
          inputs: v,
        });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    }),
  );
  // ---------------- Playbooks (approved grounding documents) ----------------
  api.get(
    "/sources/:id/knowledge",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT k.id,k.title,k.format,k.status,k.version,k.sha256,k.created_at,length(k.content) AS chars,u.email AS created_by FROM knowledge k LEFT JOIN users u ON u.id=k.created_by WHERE source_id=$1 ORDER BY created_at DESC",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources/:id/knowledge",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, true),
        s = await sourceAccess(db, req, req.params.id, true),
        v = z
          .object({
            title: string,
            content: z.string().min(1).max(200000),
            format: z.enum(["text", "markdown"]).default("text"),
          })
          .parse(req.body);
      if (/\u0000/.test(v.content))
        throw new HttpError(
          422,
          "Binary content is not supported; upload plain text or Markdown",
        );
      const prior = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT max(version) AS v FROM knowledge WHERE source_id=$1 AND title=$2",
            [s.id, v.title],
          ),
        )
      ).rows[0]?.v;
      const kid = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO knowledge(id,workspace_id,source_id,title,content,format,status,version,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)",
          [
            kid,
            c.workspaceId,
            s.id,
            v.title,
            v.content,
            v.format,
            (prior || 0) + 1,
            hash(v.content),
            c.userId,
          ],
        );
        await audit(tx, c.workspaceId, c.userId, "playbook.uploaded", kid);
      });
      res.status(201).json({
        id: kid,
        status: "pending",
        note: "A user with approval permission must approve it before AI can cite it.",
      });
    }),
  );
  api.post(
    "/knowledge/:id/:decision(approve|retire)",
    asyncRoute(async (req, res) => {
      const c = requirePermission(req, "approvals");
      const k = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query("SELECT * FROM knowledge WHERE id=$1 AND workspace_id=$2", [
            req.params.id,
            c.workspaceId,
          ]),
        )
      ).rows[0];
      if (!k) throw new HttpError(404, "Playbook not found");
      await sourceAccess(db, req, k.source_id, true);
      await db.tenant(c.workspaceId, async (tx) => {
        if (req.params.decision === "approve")
          await tx.query(
            "UPDATE knowledge SET status='retired' WHERE source_id=$1 AND title=$2 AND status='approved' AND id<>$3",
            [k.source_id, k.title, k.id],
          );
        await tx.query("UPDATE knowledge SET status=$2 WHERE id=$1", [
          k.id,
          req.params.decision === "approve" ? "approved" : "retired",
        ]);
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "playbook." + req.params.decision,
          k.id,
        );
      });
      res.json({ ok: true });
    }),
  );
  api.get(
    "/sources/:id/knowledge/search",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      const q = z.string().min(2).max(200).parse(req.query.q);
      res.json(
        passages(await approvedDocuments(db, s.workspaceId, s.id), q, 5),
      );
    }),
  );
  // ---------------- Ask AI (grounded, with bounded server-side tools) ----------------
  api.post(
    "/reports/:id/chat",
    asyncRoute(async (req, res) => {
      const { c, report, source } = await reportAccess(
        db,
        req,
        req.params.id,
        true,
      );
      const question = z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .parse(req.body.question),
        runId = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          c.workspaceId,
        ]);
        const count = await tx.query(
          "SELECT count(*)::int AS n FROM ai_runs WHERE workspace_id=$1 AND created_at>=date_trunc('day',now())",
          [c.workspaceId],
        );
        if (count.rows[0].n >= cfg.aiLimit)
          throw new HttpError(429, "Workspace AI daily budget reached");
        await tx.query(
          "INSERT INTO ai_runs(id,workspace_id,source_id,report_id,user_id,question,provider,model,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')",
          [
            runId,
            c.workspaceId,
            report.sourceId,
            report.id,
            c.userId,
            question,
            cfg.aiProvider,
            cfg.aiModel || null,
          ],
        );
      });
      const documents = await approvedDocuments(
        db,
        c.workspaceId,
        report.sourceId,
      );
      const host = toolHost(db, req, report, source, documents);
      const answer = await askAI(cfg, report, question, documents, host);
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "UPDATE ai_runs SET result=$2,status=$3,usage=$4,tool_calls=$5 WHERE id=$1",
          [
            runId,
            JSON.stringify(answer),
            answer.status,
            JSON.stringify(answer.usage || {}),
            JSON.stringify(
              answer.tools.map((t) => ({
                tool: t.tool,
                args: t.args,
                ok: t.ok,
              })),
            ),
          ],
        ),
      );
      res.json({ ...answer, id: runId });
    }),
  );
  // AI insights for the Summary page: one validated AI answer per dataset, definitions, period
  // and scope (cached), so opening the page again does not spend the AI budget again.
  api.post(
    "/reports/:id/insights",
    asyncRoute(async (req, res) => {
      const { c, report, source } = await reportAccess(db, req, req.params.id);
      const question =
        "Give a short executive summary of this assessment: the two or three most important observations, then the three most valuable next actions. Cite the evidence for each.";
      const key =
        "insights:" +
        hash(
          JSON.stringify([
            report.datasetId,
            report.definitionVersion,
            report.period,
            report.scope,
            report.options,
            cfg.aiProvider,
            cfg.aiModel,
          ]),
        );
      if (cfg.aiProvider === "none")
        return res.json(await askAI(cfg, report, question, []));
      const cached = await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "SELECT result FROM ai_runs WHERE source_id=$1 AND purpose='insights' AND question=$2 AND result->>'generator'='ai' ORDER BY created_at DESC LIMIT 1",
          [report.sourceId, key],
        ),
      );
      if (cached.rows[0]) return res.json(cached.rows[0].result);
      const runId = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          c.workspaceId,
        ]);
        const count = await tx.query(
          "SELECT count(*)::int AS n FROM ai_runs WHERE workspace_id=$1 AND created_at>=date_trunc('day',now())",
          [c.workspaceId],
        );
        if (count.rows[0].n >= cfg.aiLimit)
          throw new HttpError(429, "Workspace AI daily budget reached");
        await tx.query(
          "INSERT INTO ai_runs(id,workspace_id,source_id,report_id,user_id,purpose,question,provider,model,status) VALUES($1,$2,$3,$4,$5,'insights',$6,$7,$8,'running')",
          [
            runId,
            c.workspaceId,
            report.sourceId,
            report.id,
            c.userId,
            key,
            cfg.aiProvider,
            cfg.aiModel || null,
          ],
        );
      });
      const documents = await approvedDocuments(
        db,
        c.workspaceId,
        report.sourceId,
      );
      const answer = await askAI(
        cfg,
        report,
        question,
        documents,
        toolHost(db, req, report, source, documents),
      );
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "UPDATE ai_runs SET result=$2,status=$3,usage=$4 WHERE id=$1",
          [
            runId,
            JSON.stringify(answer),
            answer.status,
            JSON.stringify(answer.usage || {}),
          ],
        ),
      );
      res.json(answer);
    }),
  );
  api.get(
    "/sources/:id/chat",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req),
        s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(c.workspaceId, (tx) =>
            tx.query(
              "SELECT id,report_id,question,result,created_at FROM ai_runs WHERE source_id=$1 AND user_id=$2 AND purpose='chat' AND result IS NOT NULL ORDER BY created_at DESC LIMIT 20",
              [s.id, c.userId],
            ),
          )
        ).rows,
      );
    }),
  );
  api.get(
    "/ai/usage",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      res.json(
        (
          await db.tenant(c.workspaceId, (tx) =>
            tx.query(
              "SELECT date_trunc('day',created_at) AS day,provider,model,purpose,count(*)::int AS runs,sum((usage->>'input')::int) AS input_tokens,sum((usage->>'output')::int) AS output_tokens,count(*) FILTER (WHERE result->>'generator'='rule_based')::int AS fallbacks FROM ai_runs WHERE workspace_id=$1 GROUP BY 1,2,3,4 ORDER BY 1 DESC LIMIT 60",
              [c.workspaceId],
            ),
          )
        ).rows,
      );
    }),
  );
}

/** Tools the model may request. Every call is re-authorized and constrained to this report's source. */
export function toolHost(
  db: Database,
  req: express.Request,
  report: Report,
  source: { id: string; app: string; workspaceId: string } & Record<
    string,
    any
  >,
  documents: Document[],
) {
  return {
    run: async (tool: string, args: Record<string, unknown>) => {
      if (!(tool in TOOLS)) throw Error("Tool not allowed");
      // Permission is re-checked on every call (revocation takes effect immediately).
      const s = await sourceAccess(db, req, report.sourceId);
      switch (tool) {
        case "list_datasets": {
          const rows = (
            await db.tenant(s.workspaceId, (tx) =>
              tx.query(
                "SELECT id,name,mode,as_of,row_count,active FROM datasets WHERE source_id=$1 AND redacted_at IS NULL ORDER BY created_at DESC LIMIT 10",
                [s.id],
              ),
            )
          ).rows;
          return { summary: `${rows.length} dataset versions`, result: rows };
        }
        case "get_metric": {
          const metricId = z.string().max(120).parse(args.metricId);
          let r = report;
          if (args.reportId !== undefined) {
            const rid = z.string().max(80).parse(args.reportId);
            const row = (
              await db.tenant(s.workspaceId, (tx) =>
                tx.query(
                  "SELECT result FROM reports WHERE id=$1 AND source_id=$2 AND redacted_at IS NULL",
                  [rid, s.id],
                ),
              )
            ).rows[0];
            if (!row) throw Error("Report not found for this source");
            r = row.result;
          }
          const m = r.metrics.find((x) => x.id === metricId);
          if (!m) throw Error("Metric not found");
          return {
            summary: `${m.label}: ${m.value ?? "unavailable"}`,
            result: {
              reportId: r.id,
              asOf: r.asOf,
              ...m,
              recordIds: undefined,
            },
          };
        }
        case "compare_records": {
          const keys = z
            .array(z.string().max(300))
            .min(2)
            .max(4)
            .parse(args.keys);
          const out = await db.tenant(s.workspaceId, async (tx) => {
            const { dataset, records } = await datasetRecords(
              tx,
              s.workspaceId,
              s,
              report.datasetId,
            );
            return moduleFor(s.app).compare(s, records, keys, {
              datasetId: dataset.id,
              mode: dataset.mode,
              asOf: new Date(dataset.as_of).toISOString(),
            });
          });
          return {
            summary: `Compared ${keys.length} entities; ${out.caveats.length} comparability caveats`,
            result: out,
          };
        }
        case "inspect_coverage":
          return {
            summary: `${(report.capabilities || []).filter((x) => x.state !== "available").length} capabilities limited`,
            result: {
              capabilities: report.capabilities,
              limitations: report.warnings,
              source: report.sourceMetadata?.completeness || "complete",
            },
          };
        case "check_rule": {
          const ruleId = z
            .string()
            .max(80)
            .parse(args.ruleId)
            .replace(/-v\d+$/, "");
          const rule = moduleFor(s.app).rules[ruleId];
          if (!rule) throw Error("Unknown rule");
          const triggered = report.findings
            .filter((f) => f.rule.startsWith(ruleId + "-"))
            .map((f) => f.id);
          return {
            summary: `${rule.title}: ${triggered.length} triggered`,
            result: { rule, triggered, thresholds: report.thresholds },
          };
        }
        case "get_playbook_excerpt": {
          const q = z.string().min(2).max(200).parse(args.query);
          const p = passages(documents, q, 3);
          return {
            summary: `${p.length} approved passages`,
            result: p.map((x) => ({
              documentId: x.docId,
              title: x.title,
              text: x.text,
            })),
          };
        }
        case "propose_action": {
          const fid = z.string().max(300).parse(args.findingId);
          const f = report.findings.find((x) => x.id === fid);
          if (!f) throw Error("Finding not found");
          return {
            summary: "Draft action (not saved)",
            result: {
              title: f.title,
              action: f.action,
              owner: f.recommendation?.ownerRole,
              measurement: f.recommendation?.measurement,
              saved: false,
            },
          };
        }
      }
      throw Error("Tool not allowed");
    },
  };
}
