// Follow-through workflows: action plans with outcome tracking, guided drafts with review and
// approval, investigations, feedback/value tracking, scheduled assessments, notifications,
// Unity audience drafting and capability-gated cross-application evidence.
import express from "express";
import { z } from "zod";
import type { Database } from "./db";
import type { Config } from "./config";
import {
  asyncRoute,
  requireWorkspace,
  requirePermission,
  sourceAccess,
} from "./auth";
import { HttpError, id, audit } from "./security";
import { isApp, ENTITY_TYPES, type Report } from "../shared/catalog";
import { moduleFor } from "./modules";
import { lower, text } from "./modules/common";
import {
  discoverFields,
  validateDefinition,
  previewDefinition,
  OPERATORS,
} from "./modules/unity";
import { draftWithAI, hypothesesWithAI, audienceWithAI } from "./ai";
import { reportAccess, datasetRecords, buildReport } from "./context";
import { approvedDocuments } from "./routes-data";
import { evaluateActions } from "./outcomes";

const string = z.string().trim().min(1).max(160);
const nextRun = (cadence: string, from = new Date()) =>
  new Date(from.getTime() + (cadence === "daily" ? 1 : 7) * 86_400_000);

export function registerWorkflows(
  api: express.Router,
  db: Database,
  cfg: Config,
) {
  // ---------------- Action plans ----------------
  api.get(
    "/sources/:id/actions",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT * FROM actions WHERE source_id=$1 ORDER BY updated_at DESC",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources/:id/actions",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true),
        v = z
          .object({
            title: string,
            detail: z.string().max(5000),
            reportId: z.string().nullable().default(null),
            findingId: z.string().max(300).optional(),
            assignee: z.string().max(160).default(""),
            dueDate: z.iso.date().optional(),
            priority: z.enum(["high", "medium", "low"]).default("medium"),
            intervention: z.string().max(5000).default(""),
          })
          .parse(req.body);
      let baseline: any = null,
        rule: string | null = null,
        target: string | null = null;
      if (v.reportId) {
        const { report } = await reportAccess(db, req, v.reportId);
        if (report.sourceId !== s.id)
          throw new HttpError(422, "Report belongs to a different source");
        const f = v.findingId
          ? report.findings.find((x) => x.id === v.findingId)
          : undefined;
        if (v.findingId && !f)
          throw new HttpError(422, "Finding is not in that report");
        rule = f?.rule || null;
        target = f?.recommendation?.targetMetric || null;
        const m = target
          ? report.metrics.find((x) => x.id === target)
          : undefined;
        baseline = {
          reportId: report.id,
          datasetId: report.datasetId,
          asOf: report.asOf,
          scope: report.scope || [],
          definitionVersion: report.definitionVersion,
          findingId: f?.id || null,
          capabilities: report.capabilities,
          metric: m
            ? { id: m.id, value: m.value, unit: m.unit, state: m.state }
            : null,
        };
      }
      const aid = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO actions(id,workspace_id,source_id,report_id,finding_id,rule,target_metric,baseline,priority,title,detail,intervention,assignee,due_date,state,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15)",
          [
            aid,
            c.workspaceId,
            s.id,
            v.reportId,
            v.findingId || null,
            rule,
            target,
            baseline ? JSON.stringify(baseline) : null,
            v.priority,
            v.title,
            v.detail,
            v.intervention,
            v.assignee,
            v.dueDate || null,
            c.userId,
          ],
        );
        await audit(tx, c.workspaceId, c.userId, "action.created", aid, {
          findingId: v.findingId,
        });
      });
      res.status(201).json({ id: aid });
    }),
  );
  api.patch(
    "/actions/:id",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, true),
        v = z
          .object({
            state: z.enum([
              "open",
              "accepted",
              "in_progress",
              "dismissed",
              "resolved",
            ]),
            version: z.number().int(),
            assignee: z.string().max(160).optional(),
            dueDate: z.iso.date().nullable().optional(),
            priority: z.enum(["high", "medium", "low"]).optional(),
            intervention: z.string().max(5000).optional(),
            completionNotes: z.string().max(5000).optional(),
          })
          .parse(req.body);
      const a = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query("SELECT * FROM actions WHERE id=$1 AND workspace_id=$2", [
            req.params.id,
            c.workspaceId,
          ]),
        )
      ).rows[0];
      if (!a) throw new HttpError(404, "Action not found");
      await sourceAccess(db, req, a.source_id, true);
      const r = await db.tenant(c.workspaceId, async (tx) => {
        const updated = await tx.query(
          "UPDATE actions SET state=$2,version=version+1,assignee=$4,due_date=$5,priority=$6,intervention=$7,completion_notes=$8,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *",
          [
            a.id,
            v.state,
            v.version,
            v.assignee ?? a.assignee,
            v.dueDate === undefined ? a.due_date : v.dueDate,
            v.priority ?? a.priority,
            v.intervention ?? a.intervention,
            v.completionNotes ?? a.completion_notes,
          ],
        );
        if (!updated.rows.length)
          throw new HttpError(
            409,
            "This action changed. Reload it before editing.",
          );
        await audit(tx, c.workspaceId, c.userId, "action.updated", a.id, {
          state: v.state,
        });
        return updated.rows[0];
      });
      res.json(r);
    }),
  );
  api.post(
    "/actions/:id/evaluate",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, true);
      const a = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query("SELECT * FROM actions WHERE id=$1 AND workspace_id=$2", [
            req.params.id,
            c.workspaceId,
          ]),
        )
      ).rows[0];
      if (!a) throw new HttpError(404, "Action not found");
      const s = await sourceAccess(db, req, a.source_id, true);
      if (!a.baseline)
        throw new HttpError(
          422,
          "This action has no evidence baseline; create it from a finding to track outcomes",
        );
      const [r] = await evaluateActions(db, c.workspaceId, c.userId, s, a.id);
      res.json(r?.outcome || null);
    }),
  );
  // ---------------- Feedback and measurable value ----------------
  api.post(
    "/reports/:id/feedback",
    asyncRoute(async (req, res) => {
      const { c, report } = await reportAccess(db, req, req.params.id, true);
      const v = z
        .object({
          findingId: z.string().max(300),
          verdict: z.enum(["useful", "dismissed", "completed"]),
          reason: z.string().max(1000).default(""),
          minutes: z.number().int().min(0).max(10000).optional(),
        })
        .parse(req.body);
      const f = report.findings.find((x) => x.id === v.findingId);
      if (!f) throw new HttpError(422, "Finding is not in this report");
      if (v.verdict === "dismissed" && !v.reason.trim())
        throw new HttpError(
          422,
          "Give a reason when dismissing a recommendation",
        );
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "INSERT INTO feedback(id,workspace_id,source_id,report_id,finding_id,rule,verdict,reason,minutes_spent,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id(),
            c.workspaceId,
            report.sourceId,
            report.id,
            f.id,
            f.rule,
            v.verdict,
            v.reason,
            v.minutes ?? null,
            c.userId,
          ],
        ),
      );
      res.status(201).json({ ok: true });
    }),
  );
  api.get(
    "/sources/:id/value",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      const out = await db.tenant(s.workspaceId, async (tx) => {
        const fb = (
          await tx.query(
            "SELECT verdict,count(*)::int AS n,sum(minutes_spent)::int AS minutes,count(minutes_spent)::int AS timed FROM feedback WHERE source_id=$1 GROUP BY verdict",
            [s.id],
          )
        ).rows;
        const byRule = (
          await tx.query(
            "SELECT rule,verdict,count(*)::int AS n FROM feedback WHERE source_id=$1 GROUP BY rule,verdict ORDER BY rule",
            [s.id],
          )
        ).rows;
        const actions = (
          await tx.query(
            "SELECT state,count(*)::int AS n FROM actions WHERE source_id=$1 GROUP BY state",
            [s.id],
          )
        ).rows;
        const resolvedObserved = (
          await tx.query(
            "SELECT count(*)::int AS n FROM actions WHERE source_id=$1 AND outcome->>'status'='issue_no_longer_observed'",
            [s.id],
          )
        ).rows[0].n;
        const reports = (
          await tx.query(
            "SELECT count(*)::int AS n,count(*) FILTER (WHERE saved)::int AS saved FROM reports WHERE source_id=$1",
            [s.id],
          )
        ).rows[0];
        const ai = (
          await tx.query(
            "SELECT count(*)::int AS n,count(*) FILTER (WHERE result->>'generator'='rule_based')::int AS fallback FROM ai_runs WHERE source_id=$1",
            [s.id],
          )
        ).rows[0];
        return {
          feedback: fb,
          feedbackByRule: byRule,
          actions,
          issuesNoLongerObserved: resolvedObserved,
          reports,
          ai,
        };
      });
      res.json({
        ...out,
        timeSaved: null,
        timeSavedNote:
          "Time saved is not calculated: it needs a documented manual-process baseline. Recorded review minutes are user-entered.",
      });
    }),
  );
  // ---------------- Guided draft studio ----------------
  api.get(
    "/sources/:id/drafts",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT d.*,u.email AS author,r.email AS reviewer FROM drafts d LEFT JOIN users u ON u.id=d.created_by LEFT JOIN users r ON r.id=d.reviewed_by WHERE d.source_id=$1 ORDER BY d.updated_at DESC",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources/:id/drafts",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true),
        v = z
          .object({
            draftType: z.string().max(60),
            reportId: z.string(),
            findingId: z.string().max(300).optional(),
            title: string,
            useAI: z.boolean().default(false),
          })
          .parse(req.body);
      const { report } = await reportAccess(db, req, v.reportId);
      if (report.sourceId !== s.id)
        throw new HttpError(422, "Report belongs to a different source");
      const type = moduleFor(s.app).draftTypes.find(
        (d) => d.id === v.draftType,
      );
      if (!type)
        throw new HttpError(422, "Unknown draft type for this application");
      const prefill = type.prefill(report, v.findingId);
      let content: Record<string, string> = prefill,
        generator = "rule_based",
        note = "Prefilled from the assessment";
      if (v.useAI) {
        const docs = await approvedDocuments(db, c.workspaceId, s.id);
        const ai = await draftWithAI(
          cfg,
          report,
          type,
          prefill,
          v.findingId,
          docs,
        );
        if (ai) {
          content = ai.fields;
          generator = "ai";
          note = `AI draft (${ai.model}); cites ${ai.cited.length} finding(s), ${ai.citedDocs.length} playbook(s)`;
        } else
          note =
            cfg.aiProvider === "none"
              ? "AI not configured: rule-based prefill"
              : "AI draft rejected or unavailable: rule-based prefill";
      }
      const did = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO drafts(id,workspace_id,source_id,report_id,finding_id,draft_type,title,content,generator,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            did,
            c.workspaceId,
            s.id,
            report.id,
            v.findingId || null,
            v.draftType,
            v.title,
            JSON.stringify(content),
            generator,
            c.userId,
          ],
        );
        await tx.query(
          "INSERT INTO draft_revisions(id,workspace_id,draft_id,version,content,status,note,created_by) VALUES($1,$2,$3,1,$4,'draft',$5,$6)",
          [id(), c.workspaceId, did, JSON.stringify(content), note, c.userId],
        );
        await audit(tx, c.workspaceId, c.userId, "draft.created", did, {
          generator,
        });
      });
      res.status(201).json({ id: did, generator, note });
    }),
  );
  const draftOf = async (req: express.Request, write: boolean) => {
    const c = requireWorkspace(req, write);
    const d = (
      await db.tenant(c.workspaceId, (tx) =>
        tx.query("SELECT * FROM drafts WHERE id=$1 AND workspace_id=$2", [
          req.params.id,
          c.workspaceId,
        ]),
      )
    ).rows[0];
    if (!d) throw new HttpError(404, "Draft not found");
    const s = await sourceAccess(db, req, d.source_id, write);
    return { c, d, s };
  };
  api.get(
    "/drafts/:id/revisions",
    asyncRoute(async (req, res) => {
      const { c, d } = await draftOf(req, false);
      res.json(
        (
          await db.tenant(c.workspaceId, (tx) =>
            tx.query(
              "SELECT r.version,r.content,r.status,r.note,r.created_at,u.email AS author FROM draft_revisions r LEFT JOIN users u ON u.id=r.created_by WHERE draft_id=$1 ORDER BY version DESC",
              [d.id],
            ),
          )
        ).rows,
      );
    }),
  );
  api.patch(
    "/drafts/:id",
    asyncRoute(async (req, res) => {
      const { c, d, s } = await draftOf(req, true);
      const v = z
        .object({
          content: z.record(z.string(), z.string().max(20000)),
          version: z.number().int(),
          note: z.string().max(500).default("Edited"),
        })
        .parse(req.body);
      const type = moduleFor(s.app).draftTypes.find(
        (t) => t.id === d.draft_type,
      )!;
      const allowed = new Set(type.fields.map((f) => f.key));
      if (Object.keys(v.content).some((k) => !allowed.has(k)))
        throw new HttpError(422, "Unknown draft field");
      if (d.draft_type === "segment_definition" && v.content.definition) {
        const { records } = await db.tenant(c.workspaceId, (tx) =>
          datasetRecords(tx, c.workspaceId, s),
        );
        try {
          validateDefinition(
            JSON.parse(v.content.definition),
            discoverFields(records.filter((r) => r.type === "profile")),
          );
        } catch (e) {
          throw new HttpError(
            422,
            "Audience definition: " + (e as Error).message,
          );
        }
      }
      const r = await db.tenant(c.workspaceId, async (tx) => {
        const u = await tx.query(
          "UPDATE drafts SET content=$2,version=version+1,status='draft',reviewed_by=NULL,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *",
          [d.id, JSON.stringify(v.content), v.version],
        );
        if (!u.rows.length)
          throw new HttpError(
            409,
            "This draft changed. Reload it before editing.",
          );
        await tx.query(
          "INSERT INTO draft_revisions(id,workspace_id,draft_id,version,content,status,note,created_by) VALUES($1,$2,$3,$4,$5,'draft',$6,$7)",
          [
            id(),
            c.workspaceId,
            d.id,
            u.rows[0].version,
            JSON.stringify(v.content),
            v.note,
            c.userId,
          ],
        );
        return u.rows[0];
      });
      res.json(r);
    }),
  );
  api.post(
    "/drafts/:id/status",
    asyncRoute(async (req, res) => {
      const v = z
        .object({
          status: z.enum(["in_review", "approved", "rejected", "draft"]),
          version: z.number().int(),
          note: z.string().max(500).default(""),
        })
        .parse(req.body);
      const { c, d } = await draftOf(req, true);
      if (["approved", "rejected"].includes(v.status)) {
        requirePermission(req, "approvals");
        if (d.created_by === c.userId)
          throw new HttpError(
            403,
            "Another user with approval permission must review this draft (separation of duties)",
          );
        if (d.status !== "in_review")
          throw new HttpError(422, "Submit the draft for review first");
      }
      const r = await db.tenant(c.workspaceId, async (tx) => {
        const u = await tx.query(
          "UPDATE drafts SET status=$2,version=version+1,reviewed_by=CASE WHEN $2 IN('approved','rejected') THEN $4 ELSE reviewed_by END,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *",
          [d.id, v.status, v.version, c.userId],
        );
        if (!u.rows.length)
          throw new HttpError(
            409,
            "This draft changed. Reload it before reviewing.",
          );
        await tx.query(
          "INSERT INTO draft_revisions(id,workspace_id,draft_id,version,content,status,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id(),
            c.workspaceId,
            d.id,
            u.rows[0].version,
            JSON.stringify(u.rows[0].content),
            v.status,
            v.note || v.status,
            c.userId,
          ],
        );
        await audit(tx, c.workspaceId, c.userId, "draft." + v.status, d.id);
        return u.rows[0];
      });
      res.json({
        ...r,
        note: "Approval is recorded in this platform only. Nothing was published to Oracle.",
      });
    }),
  );
  // ---------------- Unity audience drafting (typed, allowlisted) ----------------
  api.post(
    "/sources/:id/audience/validate",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      if (s.app !== "unity")
        throw new HttpError(422, "Audience drafting belongs to Unity sources");
      const v = z
        .object({
          definition: z.unknown().optional(),
          request: z.string().max(2000).optional(),
        })
        .parse(req.body);
      const { records, dataset } = await db.tenant(s.workspaceId, (tx) =>
        datasetRecords(tx, s.workspaceId, s),
      );
      const profiles = records.filter((r) => r.type === "profile");
      const fields = discoverFields(profiles);
      let definition = v.definition,
        ai: any = null;
      if (!definition && v.request) {
        requireWorkspace(req, true);
        ai = await audienceWithAI(cfg, v.request, fields, OPERATORS);
        if (!ai)
          return res.json({
            ok: false,
            generator: "rule_based",
            fields,
            operators: OPERATORS,
            error:
              cfg.aiProvider === "none"
                ? "AI is not configured. Build the definition with the field and operator lists."
                : "AI could not produce a valid definition. Build it with the field and operator lists.",
          });
        definition = ai.definition;
      }
      try {
        const d = validateDefinition(definition, fields);
        const complete = dataset.metadata?.completeness !== "partial";
        res.json({
          ok: true,
          generator: ai ? "ai" : "manual",
          definition: d,
          unsupported: ai?.unsupported || [],
          assumptions: ai?.assumptions || [],
          preview: complete ? previewDefinition(d, profiles) : null,
          previewNote: complete
            ? undefined
            : "Preview withheld: the active profile snapshot is partial.",
          fields,
          operators: OPERATORS,
        });
      } catch (e) {
        res.json({
          ok: false,
          generator: ai ? "ai" : "manual",
          error: (e as Error).message,
          fields,
          operators: OPERATORS,
          unsupported: ai?.unsupported || [],
        });
      }
    }),
  );
  // ---------------- Investigations ----------------
  api.post(
    "/sources/:id/investigations",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true),
        v = z
          .object({ reportId: z.string(), findingId: z.string().max(300) })
          .parse(req.body);
      const { report } = await reportAccess(db, req, v.reportId);
      const f = report.findings.find((x) => x.id === v.findingId);
      if (report.sourceId !== s.id || !f)
        throw new HttpError(422, "Finding is not in this source's report");
      const rule = moduleFor(s.app).rules[f.rule.replace(/-v\d+$/, "")];
      const iid = id();
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "INSERT INTO investigations(id,workspace_id,source_id,report_id,finding_id,title,hypotheses,checks,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            iid,
            c.workspaceId,
            s.id,
            report.id,
            f.id,
            "Investigate: " + f.title,
            JSON.stringify(
              (f.recommendation?.hypotheses || []).map((h) => ({
                text: h,
                status: "open",
                source: "rule",
              })),
            ),
            JSON.stringify(
              (rule?.nextChecks || []).map((t) => ({ text: t, done: false })),
            ),
            c.userId,
          ],
        ),
      );
      res.status(201).json({ id: iid });
    }),
  );
  api.get(
    "/sources/:id/investigations",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT i.id,i.title,i.status,i.finding_id,i.updated_at,u.email AS created_by FROM investigations i LEFT JOIN users u ON u.id=i.created_by WHERE source_id=$1 ORDER BY updated_at DESC",
              [s.id],
            ),
          )
        ).rows,
      );
    }),
  );
  const investigationOf = async (req: express.Request, write: boolean) => {
    const c = requireWorkspace(req, write);
    const i = (
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "SELECT * FROM investigations WHERE id=$1 AND workspace_id=$2",
          [req.params.id, c.workspaceId],
        ),
      )
    ).rows[0];
    if (!i) throw new HttpError(404, "Investigation not found");
    const s = await sourceAccess(db, req, i.source_id, write);
    return { c, i, s };
  };
  api.get(
    "/investigations/:id",
    asyncRoute(async (req, res) => {
      const { c, i, s } = await investigationOf(req, false);
      const { report } = await reportAccess(db, req, i.report_id);
      const f = report.findings.find((x) => x.id === i.finding_id)!;
      const rule = moduleFor(s.app).rules[f.rule.replace(/-v\d+$/, "")];
      const timeline = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT DISTINCT ON (r.dataset_id) r.id,r.dataset_id,d.name AS dataset,d.as_of,(r.result->'findings') @> $2::jsonb AS present FROM reports r JOIN datasets d ON d.id=r.dataset_id WHERE r.source_id=$1 AND r.redacted_at IS NULL ORDER BY r.dataset_id,r.created_at DESC",
            [s.id, JSON.stringify([{ id: f.id }])],
          ),
        )
      ).rows.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
      const related = report.findings
        .filter(
          (x) =>
            x.id !== f.id &&
            (x.rule === f.rule ||
              x.recordIds.some((r) => f.recordIds.includes(r))),
        )
        .slice(0, 10);
      res.json({
        ...i,
        finding: f,
        rule,
        metrics: report.metrics.filter((m) => f.evidenceIds.includes(m.id)),
        lineage: {
          reportId: report.id,
          datasetId: report.datasetId,
          asOf: report.asOf,
          definitionVersion: report.definitionVersion,
          source: report.sourceMetadata,
          thresholds: report.thresholds,
        },
        timeline,
        related,
        missingEvidence: [
          ...(report.capabilities || [])
            .filter((x) => x.state !== "available")
            .map((x) => `${x.label}: ${x.needs}`),
          ...(rule?.dataNeeded || []),
        ],
      });
    }),
  );
  api.patch(
    "/investigations/:id",
    asyncRoute(async (req, res) => {
      const { c, i } = await investigationOf(req, true);
      const v = z
        .object({
          version: z.number().int(),
          hypotheses: z
            .array(
              z.object({
                text: z.string().min(1).max(1000),
                status: z.enum(["open", "supported", "rejected"]),
                source: z.enum(["rule", "ai", "user"]),
                test: z.string().max(1000).optional(),
              }),
            )
            .max(20)
            .optional(),
          checks: z
            .array(
              z.object({
                text: z.string().min(1).max(1000),
                done: z.boolean(),
              }),
            )
            .max(30)
            .optional(),
          notes: z.string().max(20000).optional(),
          status: z.enum(["open", "closed"]).optional(),
        })
        .parse(req.body);
      const r = await db.tenant(c.workspaceId, async (tx) => {
        const u = await tx.query(
          "UPDATE investigations SET hypotheses=$3,checks=$4,notes=$5,status=$6,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *",
          [
            i.id,
            v.version,
            JSON.stringify(v.hypotheses ?? i.hypotheses),
            JSON.stringify(v.checks ?? i.checks),
            v.notes ?? i.notes,
            v.status ?? i.status,
          ],
        );
        if (!u.rows.length)
          throw new HttpError(
            409,
            "Someone else updated this investigation. Reload it before editing.",
          );
        await audit(tx, c.workspaceId, c.userId, "investigation.updated", i.id);
        return u.rows[0];
      });
      res.json(r);
    }),
  );
  api.post(
    "/investigations/:id/hypotheses",
    asyncRoute(async (req, res) => {
      const { c, i } = await investigationOf(req, true);
      const { report } = await reportAccess(db, req, i.report_id);
      const docs = await approvedDocuments(db, c.workspaceId, i.source_id);
      const ai = await hypothesesWithAI(cfg, report, i.finding_id, docs);
      if (!ai)
        return res.json({
          added: 0,
          generator: "rule_based",
          note:
            cfg.aiProvider === "none"
              ? "AI is not configured; the rule's hypotheses remain."
              : "AI output was rejected or unavailable; no hypotheses added.",
        });
      const merged = [
        ...i.hypotheses,
        ...ai.hypotheses.map((h: { text: string; test: string }) => ({
          text: h.text,
          test: h.test,
          status: "open",
          source: "ai",
        })),
      ].slice(0, 20);
      await db.tenant(c.workspaceId, (tx) =>
        tx.query(
          "UPDATE investigations SET hypotheses=$2,version=version+1,updated_at=now() WHERE id=$1",
          [i.id, JSON.stringify(merged)],
        ),
      );
      res.json({
        added: ai.hypotheses.length,
        generator: "ai",
        model: ai.model,
      });
    }),
  );
  // ---------------- Scheduled assessments and notifications ----------------
  api.get(
    "/sources/:id/schedule",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT cadence,enabled,next_run_at,last_run_at,last_report_id FROM schedules WHERE source_id=$1",
              [s.id],
            ),
          )
        ).rows[0] || null,
      );
    }),
  );
  api.put(
    "/sources/:id/schedule",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true),
        v = z
          .object({
            cadence: z.enum(["daily", "weekly"]),
            enabled: z.boolean(),
          })
          .parse(req.body);
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO schedules(id,workspace_id,source_id,cadence,enabled,next_run_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id) DO UPDATE SET cadence=EXCLUDED.cadence,enabled=EXCLUDED.enabled,next_run_at=EXCLUDED.next_run_at,created_by=EXCLUDED.created_by",
          [
            id(),
            c.workspaceId,
            s.id,
            v.cadence,
            v.enabled,
            nextRun(v.cadence),
            c.userId,
          ],
        );
        await audit(tx, c.workspaceId, c.userId, "schedule.updated", s.id, v);
      });
      res.json({
        ok: true,
        note: "Scheduled assessments create internal digests and notifications only. No email or Slack messages are sent.",
      });
    }),
  );
  api.post(
    "/sources/:id/schedule/run",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id, true),
        c = requireWorkspace(req, true);
      res.json(await runDigest(db, c.workspaceId, s.id, c.userId));
    }),
  );
  api.get(
    "/sources/:id/notifications",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      res.json(
        (
          await db.tenant(s.workspaceId, (tx) =>
            tx.query(
              "SELECT * FROM notifications WHERE source_id=$1 AND ($2 OR snoozed_until IS NULL OR snoozed_until<now()) ORDER BY created_at DESC LIMIT 100",
              [s.id, req.query.all === "1"],
            ),
          )
        ).rows,
      );
    }),
  );
  api.post(
    "/sources/:id/notifications/read",
    asyncRoute(async (req, res) => {
      const s = await sourceAccess(db, req, req.params.id);
      await db.tenant(s.workspaceId, (tx) =>
        tx.query(
          "UPDATE notifications SET read_at=now() WHERE source_id=$1 AND read_at IS NULL",
          [s.id],
        ),
      );
      res.json({ ok: true });
    }),
  );
  api.post(
    "/notifications/:id/:op(ack|snooze)",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, true);
      const n = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT * FROM notifications WHERE id=$1 AND workspace_id=$2",
            [req.params.id, c.workspaceId],
          ),
        )
      ).rows[0];
      if (!n) throw new HttpError(404, "Notification not found");
      await sourceAccess(db, req, n.source_id);
      const hours =
        req.params.op === "snooze"
          ? z.number().int().min(1).max(720).parse(req.body.hours)
          : 0;
      await db.tenant(c.workspaceId, (tx) =>
        req.params.op === "ack"
          ? tx.query(
              "UPDATE notifications SET acknowledged_at=now(),read_at=coalesce(read_at,now()) WHERE id=$1",
              [n.id],
            )
          : tx.query(
              "UPDATE notifications SET snoozed_until=now()+$2*interval '1 hour' WHERE id=$1",
              [n.id, hours],
            ),
      );
      res.json({ ok: true });
    }),
  );
  // ---------------- Connection verification level (administrator evidence) ----------------
  api.post(
    "/connections/:id/verification",
    asyncRoute(async (req, res) => {
      const c = requirePermission(req, "connectors");
      if (c.role !== "owner")
        throw new HttpError(
          403,
          "Only an administrator can record reconciliation evidence",
        );
      const v = z
        .object({
          level: z.enum(["sample_reconciled", "production_validated"]),
          evidence: z.string().min(20).max(5000),
        })
        .parse(req.body);
      const row = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT * FROM connections WHERE id=$1 AND workspace_id=$2",
            [req.params.id, c.workspaceId],
          ),
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Connection not found");
      await sourceAccess(db, req, row.source_id);
      if (!row.last_success_at)
        throw new HttpError(
          422,
          "A successful sync is required before recording reconciliation",
        );
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query("UPDATE connections SET verification=$2 WHERE id=$1", [
          row.id,
          v.level,
        ]);
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "connection.verification",
          row.id,
          v,
        );
      });
      res.json({ ok: true });
    }),
  );
  // ---------------- Cross-application evidence (capability-gated) ----------------
  api.get(
    "/cross/sources",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      const apps = c.apps.filter(isApp);
      const rows = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT s.id,s.app,s.name,s.environment FROM sources s WHERE workspace_id=$1 AND app=ANY($2) AND (visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=s.id AND g.user_id=$4)) ORDER BY app,name",
            [c.workspaceId, apps, c.role === "owner", c.userId],
          ),
        )
      ).rows;
      res.json(rows);
    }),
  );
  api.get(
    "/cross/mappings",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      const rows = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT * FROM cross_mappings WHERE workspace_id=$1 ORDER BY created_at DESC",
            [c.workspaceId],
          ),
        )
      ).rows;
      const visible = [];
      for (const m of rows)
        try {
          await sourceAccess(db, req, m.left_source);
          await sourceAccess(db, req, m.right_source);
          visible.push(m);
        } catch {
          /* hidden when the user cannot access both sources */
        }
      res.json(visible);
    }),
  );
  api.post(
    "/cross/mappings",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req, false, true);
      const v = z
        .object({
          name: string,
          leftSource: z.string(),
          leftEntity: z.string(),
          leftField: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          rightSource: z.string(),
          rightEntity: z.string(),
          rightField: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          normalization: z.enum(["exact", "lowercase-trim"]),
        })
        .parse(req.body);
      const l = await sourceAccess(db, req, v.leftSource),
        r = await sourceAccess(db, req, v.rightSource);
      if (l.id === r.id)
        throw new HttpError(422, "Choose two different sources");
      if (
        !ENTITY_TYPES[l.app].includes(v.leftEntity) ||
        !ENTITY_TYPES[r.app].includes(v.rightEntity)
      )
        throw new HttpError(422, "Entity does not belong to that application");
      const mid = id();
      await db.tenant(c.workspaceId, async (tx) => {
        await tx.query(
          "INSERT INTO cross_mappings(id,workspace_id,name,left_source,left_entity,left_field,right_source,right_entity,right_field,normalization,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            mid,
            c.workspaceId,
            v.name,
            l.id,
            v.leftEntity,
            v.leftField,
            r.id,
            v.rightEntity,
            v.rightField,
            v.normalization,
            c.userId,
          ],
        );
        await audit(
          tx,
          c.workspaceId,
          c.userId,
          "cross_mapping.approved",
          mid,
          v,
        );
      });
      res.status(201).json({ id: mid });
    }),
  );
  api.post(
    "/cross/mappings/:id/assess",
    asyncRoute(async (req, res) => {
      const c = requireWorkspace(req);
      const m = (
        await db.tenant(c.workspaceId, (tx) =>
          tx.query(
            "SELECT * FROM cross_mappings WHERE id=$1 AND workspace_id=$2",
            [req.params.id, c.workspaceId],
          ),
        )
      ).rows[0];
      if (!m) throw new HttpError(404, "Mapping not found");
      const l = await sourceAccess(db, req, m.left_source),
        r = await sourceAccess(db, req, m.right_source);
      const norm = (v: unknown) =>
        m.normalization === "lowercase-trim" ? lower(v) : text(v);
      const side = async (s: typeof l, entity: string, field: string) => {
        const rep = await buildReport(db, c.workspaceId, c.userId, s, {});
        const keys = new Set(
          rep.records
            .filter((x) => x.type === entity && text(x[field]))
            .map((x) => norm(x[field])),
        );
        return { rep, keys };
      };
      const [L, R] = [
        await side(l, m.left_entity, m.left_field),
        await side(r, m.right_entity, m.right_field),
      ];
      const matched = [...L.keys].filter((k) => R.keys.has(k)).length;
      const pct = (n: number, d: number) =>
        d ? ((n / d) * 100).toFixed(2) : null;
      const brief = (rep: Report) => ({
        sourceId: rep.sourceId,
        app: rep.app,
        name: rep.name,
        asOf: rep.asOf,
        reportId: rep.id,
        findings: rep.findings.slice(0, 5).map((f) => ({
          id: f.id,
          title: f.title,
          severity: f.severity,
          detail: f.detail,
        })),
      });
      res.json({
        mapping: {
          name: m.name,
          left: `${l.name} ${m.left_entity}.${m.left_field}`,
          right: `${r.name} ${m.right_entity}.${m.right_field}`,
          normalization: m.normalization,
        },
        joinCoverage: {
          leftKeys: L.keys.size,
          rightKeys: R.keys.size,
          matched,
          leftMatchedPct: pct(matched, L.keys.size),
          rightMatchedPct: pct(matched, R.keys.size),
        },
        periods: { left: L.rep.asOf, right: R.rep.asOf },
        left: brief(L.rep),
        right: brief(R.rep),
        caveats: [
          "Join coverage counts identifiers that match under the approved mapping; it does not prove person-level linkage quality.",
          "Findings stay attributed to their own source. No unified funnel or causal attribution is calculated.",
          ...(Math.abs(Date.parse(L.rep.asOf) - Date.parse(R.rep.asOf)) >
          7 * 86_400_000
            ? [
                "The two snapshots are more than seven days apart; periods may not be comparable.",
              ]
            : []),
        ],
      });
    }),
  );
}

/** Scheduled/manual digest: assess the active snapshot, compare with the previous digest, notify. */
export async function runDigest(
  db: Database,
  workspace: string,
  sourceId: string,
  userId: string,
) {
  const src = (
    await db.tenant(workspace, (tx) =>
      tx.query("SELECT * FROM sources WHERE id=$1", [sourceId]),
    )
  ).rows[0];
  if (!src) throw new HttpError(404, "Source not found");
  const sched = (
    await db.tenant(workspace, (tx) =>
      tx.query("SELECT * FROM schedules WHERE source_id=$1", [sourceId]),
    )
  ).rows[0];
  const report = await buildReport(db, workspace, userId, src, {
    saved: true,
    title: "Assessment digest " + new Date().toISOString().slice(0, 10),
  });
  const previous: string[] = sched?.last_findings || [];
  const now = report.findings.map((f) => f.id);
  const added = report.findings.filter((f) => !previous.includes(f.id)),
    resolved = previous.filter((x) => !now.includes(x));
  await db.tenant(workspace, async (tx) => {
    await tx.query(
      "INSERT INTO notifications(id,workspace_id,source_id,message,kind,severity,dedupe_key,report_id) VALUES($1,$2,$3,$4,'digest','info',$5,$6) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
      [
        id(),
        workspace,
        sourceId,
        `Digest: ${now.length} open signals (${added.length} new, ${resolved.length} no longer observed).`,
        `digest:${sourceId}:${report.datasetId}:${new Date().toISOString().slice(0, 10)}`,
        report.id,
      ],
    );
    for (const f of added.filter((x) => x.severity === "high"))
      await tx.query(
        "INSERT INTO notifications(id,workspace_id,source_id,message,kind,severity,dedupe_key,report_id) VALUES($1,$2,$3,$4,'finding','high',$5,$6) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
        [
          id(),
          workspace,
          sourceId,
          f.title + ": " + f.detail,
          `finding:${sourceId}:${f.id}`,
          report.id,
        ],
      );
    if (sched)
      await tx.query(
        "UPDATE schedules SET last_run_at=now(),last_report_id=$2,last_findings=$3,next_run_at=$4 WHERE id=$1",
        [sched.id, report.id, JSON.stringify(now), nextRun(sched.cadence)],
      );
  });
  return {
    reportId: report.id,
    open: now.length,
    added: added.length,
    resolved: resolved.length,
  };
}
export async function runDueSchedules(db: Database) {
  const ws = await db.query("SELECT id FROM workspaces");
  for (const w of ws.rows) {
    const due = (
      await db.tenant(w.id, (tx) =>
        tx.query(
          "SELECT s.* FROM schedules s WHERE s.enabled AND s.next_run_at<=now() AND EXISTS(SELECT 1 FROM datasets d WHERE d.source_id=s.source_id AND d.active)",
          [],
        ),
      )
    ).rows;
    for (const s of due) {
      // The schedule's creator must still be a member with access; otherwise skip and disable.
      const m = await db.query(
        "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
        [w.id, s.created_by],
      );
      const src = (
        await db.tenant(w.id, (tx) =>
          tx.query("SELECT app,visibility FROM sources WHERE id=$1", [
            s.source_id,
          ]),
        )
      ).rows[0];
      const ent = await db.query(
        "SELECT 1 FROM entitlements WHERE workspace_id=$1 AND app=$2 AND enabled AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())",
        [w.id, src?.app],
      );
      const granted =
        src?.visibility === "workspace" ||
        m.rows[0]?.role === "owner" ||
        (
          await db.tenant(w.id, (tx) =>
            tx.query(
              "SELECT 1 FROM source_grants WHERE source_id=$1 AND user_id=$2",
              [s.source_id, s.created_by],
            ),
          )
        ).rows.length > 0;
      if (
        !m.rows[0] ||
        m.rows[0].role === "viewer" ||
        !ent.rows.length ||
        !granted
      ) {
        await db.tenant(w.id, (tx) =>
          tx.query("UPDATE schedules SET enabled=false WHERE id=$1", [s.id]),
        );
        continue;
      }
      try {
        await runDigest(db, w.id, s.source_id, s.created_by);
      } catch {
        await db.tenant(w.id, (tx) =>
          tx.query(
            "UPDATE schedules SET next_run_at=now()+interval '1 hour' WHERE id=$1",
            [s.id],
          ),
        );
      }
    }
  }
}
