// Recommendation-to-outcome tracking: after a newer dataset becomes active, re-run the relevant
// rule and compare the target metric. Reports "issue no longer observed" or "metric changed";
// never claims causal uplift.
import type { Database } from "./db";
import type { Report, Source } from "../shared/catalog";
import { buildReport } from "./context";

export interface Outcome {
  evaluatedAt: string;
  reportId: string;
  datasetId: string;
  status:
    | "no_newer_data"
    | "issue_still_observed"
    | "issue_no_longer_observed"
    | "not_evaluable";
  metric: null | {
    id: string;
    before: string | null;
    after: string | null;
    changePp?: string | null;
    change?: string | null;
    unit: string;
  };
  flags: string[];
  statement: string;
}
export function compareOutcome(baseline: any, after: Report): Outcome {
  const flags: string[] = [];
  if (
    baseline.definitionVersion &&
    baseline.definitionVersion !== after.definitionVersion
  )
    flags.push("Metric/rule definitions changed between snapshots.");
  const capsBefore = JSON.stringify(
    (baseline.capabilities || []).map((c: any) => [c.id, c.state]),
  );
  const capsAfter = JSON.stringify(
    (after.capabilities || []).map((c) => [c.id, c.state]),
  );
  if (baseline.capabilities && capsBefore !== capsAfter)
    flags.push(
      "Data coverage changed between snapshots (different capabilities available).",
    );
  if (
    after.warnings.some((w) =>
      w.startsWith("This snapshot was imported as PARTIAL"),
    )
  )
    flags.push("The newer snapshot is partial.");
  const present = baseline.findingId
    ? after.findings.some((f) => f.id === baseline.findingId)
    : null;
  let metric: Outcome["metric"] = null;
  if (baseline.metric) {
    const m = after.metrics.find((x) => x.id === baseline.metric.id);
    const b =
        baseline.metric.value === null ? null : Number(baseline.metric.value),
      a = m?.value === null || m?.value === undefined ? null : Number(m.value);
    metric = {
      id: baseline.metric.id,
      before: baseline.metric.value,
      after: m?.value ?? null,
      unit: baseline.metric.unit,
      ...(baseline.metric.unit === "percent"
        ? { changePp: b !== null && a !== null ? (a - b).toFixed(4) : null }
        : { change: b !== null && a !== null ? (a - b).toFixed(4) : null }),
    };
  }
  const status: Outcome["status"] =
    present === null
      ? "not_evaluable"
      : present
        ? "issue_still_observed"
        : "issue_no_longer_observed";
  return {
    evaluatedAt: new Date().toISOString(),
    reportId: after.id,
    datasetId: after.datasetId,
    status,
    metric,
    flags,
    statement:
      (status === "issue_no_longer_observed"
        ? "The rule no longer triggers in the newer snapshot."
        : status === "issue_still_observed"
          ? "The rule still triggers in the newer snapshot."
          : "No finding was linked, so only the metric is compared.") +
      " This is an observation, not proof that the action caused the change.",
  };
}
export async function evaluateActions(
  db: Database,
  workspace: string,
  userId: string,
  source: Source & { workspaceId?: string },
  actionId?: string,
) {
  const actions = (
    await db.tenant(workspace, (tx) =>
      tx.query(
        "SELECT * FROM actions WHERE source_id=$1 AND baseline IS NOT NULL AND state<>'dismissed'" +
          (actionId ? " AND id=$2" : ""),
        actionId ? [source.id, actionId] : [source.id],
      ),
    )
  ).rows;
  if (!actions.length) return [];
  const active = (
    await db.tenant(workspace, (tx) =>
      tx.query(
        "SELECT id FROM datasets WHERE source_id=$1 AND active AND redacted_at IS NULL",
        [source.id],
      ),
    )
  ).rows[0];
  const results: { id: string; outcome: Outcome }[] = [];
  const latest = new Map<string, Report>();
  for (const a of actions) {
    let outcome: Outcome;
    if (!active || active.id === a.baseline.datasetId)
      outcome = {
        evaluatedAt: new Date().toISOString(),
        reportId: a.baseline.reportId,
        datasetId: a.baseline.datasetId,
        status: "no_newer_data",
        metric: null,
        flags: [],
        statement:
          "No newer active snapshot yet; import or sync new data to evaluate.",
      };
    else {
      const scope: string[] = a.baseline.scope || [];
      const key = JSON.stringify(scope);
      if (!latest.has(key))
        latest.set(
          key,
          await buildReport(db, workspace, userId, source, {
            datasetId: active.id,
            selectedIds: scope,
            title: "Outcome evaluation",
          }),
        );
      outcome = compareOutcome(a.baseline, latest.get(key)!);
    }
    await db.tenant(workspace, (tx) =>
      tx.query("UPDATE actions SET outcome=$2,updated_at=now() WHERE id=$1", [
        a.id,
        JSON.stringify(outcome),
      ]),
    );
    results.push({ id: a.id, outcome });
  }
  return results;
}
