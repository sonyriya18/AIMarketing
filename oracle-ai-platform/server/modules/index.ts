import type { AppId, RecordData, Report, Source } from "../../shared/catalog";
import { eloqua } from "./eloqua";
import { unity } from "./unity";
import { infinity } from "./infinity";
import { text, present, type AssessmentMeta } from "./common";
import type { ModuleDefinition } from "./types";
import { applyLayout } from "./layout";

export const MODULES: Record<AppId, ModuleDefinition> = {
  eloqua,
  unity,
  infinity,
};
export const moduleFor = (app: AppId) => MODULES[app];

/** Choices offered by Analyze and Compare, derived from the full snapshot. */
export function candidates(
  app: AppId,
  all: RecordData[],
): NonNullable<Report["candidates"]> {
  const uniq = (xs: { key: string; label: string }[]) => [
    ...new Map(xs.map((x) => [x.key, x])).values(),
  ];
  if (app === "eloqua") {
    const named = new Map(
      all
        .filter((r) => r.type === "campaign")
        .map((r) => [r.id, text(r.name) || r.id]),
    );
    const ids = new Set([
      ...named.keys(),
      ...all
        .filter(
          (r) =>
            [
              "campaign_metrics",
              "activity",
              "step",
              "lead",
              "opportunity",
            ].includes(r.type) && present(r.campaignId),
        )
        .map((r) => text(r.campaignId)),
    ]);
    const list = [...ids].map((id) => ({
      key: "campaign:" + id,
      label: named.get(id) || id,
    }));
    const events = all
      .filter((r) => r.type === "marketing_event")
      .map((r) => ({
        key: "event:" + r.id,
        label: "Event: " + (text(r.name) || r.id),
      }));
    return { analyze: [...list, ...events], compare: list };
  }
  if (app === "unity") {
    const segs = all
      .filter((r) => r.type === "segment")
      .map((r) => ({ key: "segment:" + r.id, label: text(r.name) || r.id }));
    const fields = [
      ...new Set(
        all.filter((r) => r.type === "profile").flatMap((r) => Object.keys(r)),
      ),
    ]
      .filter((k) => !["id", "type"].includes(k))
      .sort();
    return { analyze: segs, compare: segs, fields };
  }
  const cohorts: { key: string; label: string }[] = [];
  for (const r of all) {
    if (
      r.type === "report_row" &&
      present(r.dimension) &&
      present(r.dimensionValue)
    )
      cohorts.push({
        key: `cohort:${text(r.dimension)}=${text(r.dimensionValue)}`,
        label: `${text(r.dimension)}: ${text(r.dimensionValue)}`,
      });
    if (r.type === "page_metrics" && present(r.device))
      cohorts.push({
        key: `cohort:device=${text(r.device)}`,
        label: `device: ${text(r.device)}`,
      });
    if (r.type === "event")
      for (const dim of ["device", "channel"])
        if (present(r[dim]))
          cohorts.push({
            key: `cohort:${dim}=${text(r[dim])}`,
            label: `${dim}: ${text(r[dim])}`,
          });
  }
  const eventNames = [
    ...new Set(all.filter((r) => r.type === "event").map((r) => text(r.event))),
  ].sort();
  return {
    analyze: eventNames.map((n) => ({ key: "event:" + n, label: n })),
    compare: uniq(cohorts),
    eventNames,
  };
}

export function assess(
  source: Source,
  all: RecordData[],
  meta: AssessmentMeta,
  selected: string[] = [],
): Report {
  const m = moduleFor(source.app);
  const report = m.assess(source, m.select(all, selected), {
    ...meta,
    scope: selected,
  });
  report.candidates = candidates(source.app, all);
  return applyLayout(report, m.layout);
}
export const selectRecords = (app: AppId, all: RecordData[], keys: string[]) =>
  moduleFor(app).select(all, keys);
export const simulate = (app: AppId, input: Record<string, unknown>) =>
  moduleFor(app).simulate(input);
