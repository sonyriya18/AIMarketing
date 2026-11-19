// Dashboard layout shared by the modules: topic groups, plain-language explanations for every
// section, and chart helpers (month/day buckets, top-N + "Other"). Values are never invented:
// a bucket without data is null, and charts with nothing to draw are skipped.
import Decimal from "decimal.js";
import type { RecordData, Report } from "../../shared/catalog";
import { D, ms, present, text } from "./common";

export interface ModuleLayout {
  /** Topic tabs in order; "Overview" is always first in the interface. */
  groups: string[];
  sections: Record<string, { group: string; about: string }>;
  rules: Record<string, string>;
  capabilities: Record<string, string>;
}

export function applyLayout(report: Report, layout: ModuleLayout) {
  report.groups = layout.groups;
  for (const s of report.sections || []) {
    const l = layout.sections[s.id];
    if (l) {
      s.group ??= l.group;
      s.about ??= l.about;
    }
  }
  for (const f of report.findings) {
    const base = f.rule.replace(/-v\d+$/, "");
    f.group ??= layout.rules[base];
  }
  for (const c of report.capabilities || [])
    c.group ??= layout.capabilities[c.id];
  return report;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** "2026-07" → "Jul 2026". */
export const monthLabel = (ym: string) =>
  `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** "2026-10-03" → "3 Oct". */
export const dayLabel = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** Every month between the first and last key, so gaps show as empty months, not skipped. */
export function monthRange(keys: string[]) {
  const sorted = [...new Set(keys)].sort();
  if (!sorted.length) return [];
  const out: string[] = [];
  let [y, m] = sorted[0].split("-").map(Number);
  const [ey, em] = sorted.at(-1)!.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out.slice(-24);
}
export function dayRange(keys: string[]) {
  const sorted = [...new Set(keys)].sort();
  if (!sorted.length) return [];
  const out: string[] = [];
  for (
    let t = Date.parse(sorted[0] + "T00:00:00Z");
    t <= Date.parse(sorted.at(-1)! + "T00:00:00Z");
    t += 86_400_000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out.slice(-120);
}

/** The top N labels by weight; the rest fold into "Other" (never a generated 9th colour). */
export function topLabels(
  rows: RecordData[],
  label: (r: RecordData) => string,
  n = 5,
) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(label(r), (counts.get(label(r)) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const keep = new Set(top.map(([k]) => k));
  return {
    labels: [...top.map(([k]) => k), ...(counts.size > n ? ["Other"] : [])],
    of: (r: RecordData) => (keep.has(label(r)) ? label(r) : "Other"),
  };
}
/** Safe series key for a free-text label. */
export const key = (s: string) =>
  "s_" +
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);
export const num = (v: Decimal | null) =>
  v === null ? null : Number(v.toDecimalPlaces(2).toString());
export const sumField = (rows: RecordData[], f: string) =>
  rows.reduce((s, r) => (D(r[f]) ? s.plus(D(r[f])!) : s), new Decimal(0));
export const dayOf = (r: RecordData, f: string) =>
  present(r[f]) && !Number.isNaN(ms(r[f])) ? text(r[f]).slice(0, 10) : "";
