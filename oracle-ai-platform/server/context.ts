// Shared, authorization-checked data access used by the API routes and the worker.
import type express from "express";
import type { Database, SQL } from "./db";
import { requireWorkspace, sourceAccess } from "./auth";
import { HttpError } from "./security";
import type { RecordData, Report, Source } from "../shared/catalog";
import { assess, candidates } from "./modules";
import type { AssessmentMeta } from "./modules/common";

export async function datasetRecords(
  tx: SQL,
  workspace: string,
  source: Source,
  datasetId?: string,
) {
  const d = (
    await tx.query(
      "SELECT * FROM datasets WHERE source_id=$1 AND workspace_id=$2 AND redacted_at IS NULL AND " +
        (datasetId ? "id=$3" : "active=true"),
      datasetId ? [source.id, workspace, datasetId] : [source.id, workspace],
    )
  ).rows[0];
  if (!d)
    throw new HttpError(
      404,
      datasetId
        ? "Dataset not found or deleted"
        : "Import or synchronize data first",
    );
  const rr = await tx.query(
    `SELECT data FROM ${source.app}_records WHERE dataset_id=$1 AND workspace_id=$2`,
    [d.id, workspace],
  );
  return { dataset: d, records: rr.rows.map((r) => r.data as RecordData) };
}

/** Assess one dataset, attach provenance, and persist the immutable report snapshot. */
export async function buildReport(
  db: Database,
  workspace: string,
  userId: string,
  source: Source,
  input: {
    datasetId?: string;
    selectedIds?: string[];
    periodStart?: string;
    periodEnd?: string;
    options?: Record<string, unknown>;
    saved?: boolean;
    title?: string;
  },
) {
  return db.tenant(workspace, async (tx) => {
    const { dataset: d, records } = await datasetRecords(
      tx,
      workspace,
      source,
      input.datasetId,
    );
    const keys = input.selectedIds || [];
    const meta: AssessmentMeta = {
      datasetId: d.id,
      mode: d.mode,
      asOf: new Date(d.as_of).toISOString(),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      options: input.options,
    };
    if (keys.length) {
      const cand = candidates(source.app, records);
      const allowed = new Set(
        [...cand.analyze, ...cand.compare]
          .map((x) => x.key)
          .concat(records.map((r) => r.type + ":" + r.id)),
      );
      if (keys.some((k) => !allowed.has(k)))
        throw new HttpError(422, "A selected entity is not in this dataset");
    }
    const result = assess(source, records, meta, keys);
    result.sourceMetadata = {
      ...d.metadata,
      datasetName: d.name,
      rowCount: d.row_count,
      createdAt: d.created_at,
      environment: source.environment,
    };
    if (d.mode === "stream")
      result.warnings.push(
        String(
          d.metadata.coverage ||
            "Stream snapshots cover observed events only; subscription gaps and incomplete sessions are possible.",
        ),
      );
    if (d.metadata?.completeness === "partial")
      result.warnings.unshift(
        `This snapshot was imported as PARTIAL: ${(d.metadata.partialReason as string) || "some rows or files were excluded"}. Affected measures may be incomplete.`,
      );
    if (d.coverage_start || d.coverage_end)
      result.warnings.push(
        `Declared source coverage: ${d.coverage_start || "unspecified"} to ${d.coverage_end || "unspecified"}.`,
      );
    const staleDays = Number(source.policy.staleDays ?? 30);
    if (Date.now() - Date.parse(d.as_of) > staleDays * 86_400_000)
      result.warnings.unshift(
        `Stale data: this snapshot is older than ${staleDays} days. Refresh the source before acting.`,
      );
    await tx.query(
      "INSERT INTO reports(id,workspace_id,source_id,dataset_id,created_by,result,saved,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        result.id,
        workspace,
        source.id,
        d.id,
        userId,
        JSON.stringify(result),
        !!input.saved,
        input.title || null,
      ],
    );
    return result;
  });
}

export async function reportAccess(
  db: Database,
  req: express.Request,
  reportId: string,
  write = false,
) {
  const c = requireWorkspace(req, write);
  const r = (
    await db.tenant(c.workspaceId, (tx) =>
      tx.query("SELECT * FROM reports WHERE id=$1 AND workspace_id=$2", [
        reportId,
        c.workspaceId,
      ]),
    )
  ).rows[0];
  if (!r) throw new HttpError(404, "Report not found");
  const source = await sourceAccess(db, req, r.source_id, write);
  if (r.redacted_at)
    throw new HttpError(
      410,
      "This report's evidence was deleted under the data-retention policy",
    );
  return { c, source, report: r.result as Report, row: r };
}
