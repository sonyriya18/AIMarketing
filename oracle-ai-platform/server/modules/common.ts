// Shared, deterministic assessment toolkit. Product modules own their own entities, metrics and
// rules; this file only provides the evidence contract builders and exact decimal helpers.
import Decimal from "decimal.js";
import type {
  AppId,
  Capability,
  ChartSpec,
  Finding,
  Metric,
  RecordData,
  Recommendation,
  Report,
  Section,
  Severity,
  Source,
} from "../../shared/catalog";
import { id as newId } from "../security";

export const D = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(String(v));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};
export const present = (v: unknown) =>
  v !== null && v !== undefined && String(v).trim() !== "";
export const text = (v: unknown) => String(v ?? "");
export const lower = (v: unknown) => text(v).trim().toLowerCase();
export const bool = (v: unknown) =>
  v === true || ["true", "yes", "1", "y"].includes(lower(v));
export const list = (v: unknown) =>
  Array.isArray(v)
    ? v.map(String)
    : text(v)
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
export const ms = (v: unknown) => (present(v) ? Date.parse(text(v)) : NaN);
/** Sum a field; null if any row is missing it (never treat missing as zero). */
export const sum = (rows: RecordData[], field: string) =>
  rows.length && rows.every((r) => D(r[field]) !== null)
    ? rows.reduce((s, r) => s.plus(D(r[field])!), new Decimal(0))
    : null;
/** numerator / denominator × 100, or null when either is unknown or the denominator is zero. */
export const rate = (
  n: Decimal | number | null,
  d: Decimal | number | null,
) => {
  if (n === null || d === null) return null;
  const dn = new Decimal(d);
  return dn.gt(0) ? new Decimal(n).div(dn).mul(100) : null;
};
export const fmt = (v: Decimal | null) =>
  v?.toDecimalPlaces(4).toString() ?? null;
export const num = (v: Decimal | null) => (v === null ? null : v.toNumber());

export interface RuleDef {
  version: string;
  title: string;
  description: string;
  severity: Severity;
  ownerRole: string;
  effort: string;
  automation: "A" | "B" | "C";
  targetMetric: string | null;
  nextChecks: string[];
  dataNeeded: string[];
  measurement: string;
  /** Dashboard topic the rule belongs to (e.g. "Leads"). */
  group?: string;
}
export interface AssessmentMeta {
  id?: string;
  datasetId: string;
  mode: string;
  asOf: string;
  periodStart?: string;
  periodEnd?: string;
  options?: Record<string, unknown>;
  scope?: string[];
}
const SEVERITY_WEIGHT: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
  attention: 2,
};
export const PRIORITY_BASIS =
  "Ordered by rule severity (high > medium > low), then affected volume, then evidence completeness. Not a probability or a business-value estimate.";

export class Assessment {
  metrics: Metric[] = [];
  findings: Finding[] = [];
  warnings: string[] = [];
  sections: Section[] = [];
  capabilities: Capability[] = [];
  thresholds: Record<string, unknown> = {};
  constructor(
    public app: AppId,
    public source: Source,
    public records: RecordData[],
    public meta: AssessmentMeta,
    public rules: Record<string, RuleDef>,
    public definitionVersion: string,
  ) {}
  rows(type: string) {
    return this.records.filter((r) => r.type === type);
  }
  policy<T>(key: string, fallback: T): T {
    const v = this.source.policy?.[key];
    const out = (v === undefined || v === null ? fallback : v) as T;
    this.thresholds[key] = out;
    return out;
  }
  /** Calendar day of a timestamp in the source timezone. */
  day(v: unknown) {
    const s = text(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.source.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(s));
  }
  inPeriod(r: RecordData, key: string) {
    const { periodStart, periodEnd } = this.meta;
    if (!periodStart && !periodEnd) return true;
    if (!present(r[key])) return false;
    const d = this.day(r[key]);
    return (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);
  }
  metric(m: {
    id: string;
    label: string;
    value: Decimal | number | null;
    unit: Metric["unit"];
    formula: string;
    rows?: RecordData[];
    reason?: string;
    state?: Metric["state"];
    grain?: string;
    basis?: Metric["basis"];
    currency?: string;
  }) {
    const value = m.value === null ? null : new Decimal(m.value);
    const state =
      value === null ? "unavailable" : (m.state ?? ("observed" as const));
    this.metrics.push({
      id: m.id,
      label: m.label,
      value: fmt(value),
      unit: m.unit,
      formula: m.formula,
      recordIds: (m.rows || []).slice(0, 5000).map((r) => r.type + ":" + r.id),
      reason:
        value === null
          ? m.reason || "Required inputs are missing"
          : state === "partial"
            ? m.reason
            : undefined,
      state,
      grain: m.grain,
      basis: m.basis,
      version: this.definitionVersion,
      currency: m.currency,
    });
    return value;
  }
  finding(fd: {
    rule: string;
    entity?: RecordData;
    scope?: string;
    title?: string;
    detail: string;
    severity?: Severity;
    rows?: RecordData[];
    evidence?: string[];
    action?: string;
    affected?: number;
    caveats?: string[];
    hypotheses?: string[];
    partial?: boolean;
  }) {
    const rule = this.rules[fd.rule];
    if (!rule) throw Error("Unknown rule " + fd.rule);
    const severity = fd.severity || rule.severity;
    const recordIds = [
      ...(fd.entity ? [fd.entity.type + ":" + fd.entity.id] : []),
      ...(fd.rows || []).slice(0, 500).map((r) => r.type + ":" + r.id),
    ];
    const recommendation: Recommendation = {
      action: fd.action || rule.nextChecks[0] || rule.description,
      rationale: rule.description,
      hypotheses: fd.hypotheses || [],
      dataNeeded: rule.dataNeeded,
      ownerRole: rule.ownerRole,
      effort: rule.effort,
      targetMetric: rule.targetMetric,
      automation: rule.automation,
      permission:
        rule.automation === "C"
          ? "Oracle write action: disabled unless a verified adapter and customer approval policy exist"
          : rule.automation === "B"
            ? "Reviewed internal work: analyst or administrator"
            : "Routine platform automation",
      measurement: rule.measurement,
      uncertainty: fd.partial
        ? "Observed on partial data; confirm with a complete export before acting."
        : "Observed in this snapshot. Explanations listed as hypotheses are not proven.",
    };
    this.findings.push({
      group: rule.group,
      id:
        fd.rule +
        ":" +
        (fd.entity ? fd.entity.type + ":" + fd.entity.id : fd.scope || "all"),
      app: this.app,
      title: fd.title || rule.title,
      severity,
      detail: fd.detail,
      evidenceIds: fd.evidence || [],
      recordIds,
      action: recommendation.action,
      rule: fd.rule + "-" + rule.version,
      entityScope: fd.entity
        ? fd.entity.type + ":" + fd.entity.id
        : fd.scope || "source",
      caveats: fd.caveats || [],
      priority: {
        rank: 0,
        basis: PRIORITY_BASIS,
        affected: fd.affected ?? Math.max(1, recordIds.length),
      },
      recommendation,
    });
  }
  capability(
    id: string,
    label: string,
    ok: boolean | "partial",
    needs: string,
  ) {
    this.capabilities.push({
      id,
      label,
      state: ok === "partial" ? "partial" : ok ? "available" : "unavailable",
      needs,
    });
  }
  section(s: Section) {
    this.sections.push(s);
  }
  /** A chart section; skipped when there is nothing to draw (no invented points). */
  chart(s: Omit<Section, "kind" | "chart"> & { chart: ChartSpec }) {
    const hasValue = s.chart.data.some((d) =>
      s.chart.series.some((x) => d[x.key] !== null && d[x.key] !== undefined),
    );
    if (s.chart.data.length && hasValue)
      this.sections.push({ ...s, kind: "chart" });
  }
  build(): Report {
    const ranked = [...this.findings].sort(
      (a, b) =>
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
        (b.priority?.affected || 0) - (a.priority?.affected || 0) ||
        (a.recommendation?.uncertainty.startsWith("Observed on partial")
          ? 1
          : 0) -
          (b.recommendation?.uncertainty.startsWith("Observed on partial")
            ? 1
            : 0),
    );
    ranked.forEach((f, i) => (f.priority!.rank = i + 1));
    return {
      id: this.meta.id || newId(),
      app: this.app,
      name: this.source.name,
      datasetId: this.meta.datasetId,
      sourceId: this.source.id,
      sourceMode: this.meta.mode,
      generatedAt: new Date().toISOString(),
      asOf: this.meta.asOf,
      timezone: this.source.timezone,
      currency: this.source.currency,
      metrics: this.metrics,
      findings: ranked,
      warnings: this.warnings,
      records: this.records,
      definitionVersion: this.definitionVersion,
      sections: this.sections,
      capabilities: this.capabilities,
      thresholds: this.thresholds,
      options: this.meta.options || {},
      period: {
        start: this.meta.periodStart || null,
        end: this.meta.periodEnd || null,
      },
      policy: { ...this.source.policy },
      scope: this.meta.scope || [],
    };
  }
}

/** Two-proportion z-test (pooled), used only for compatible, independent samples. */
export function twoProportion(x1: number, n1: number, x2: number, n2: number) {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = x1 / n1,
    p2 = x2 / n2,
    p = (x1 + x2) / (n1 + n2),
    se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { diffPp: (p1 - p2) * 100, z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  return {
    diffPp: (p1 - p2) * 100,
    z,
    pValue: 2 * (1 - normalCdf(Math.abs(z))),
  };
}
export function normalCdf(x: number) {
  // Abramowitz & Stegun 7.1.26 approximation of erf (|error| < 1.5e-7).
  const t = 1 / (1 + 0.3275911 * (x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return 0.5 * (1 + y);
}
/** Inverse standard normal (Acklam's rational approximation). */
export function normalInv(p: number) {
  if (p <= 0 || p >= 1) throw Error("Probability must be between 0 and 1");
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269,
    -30.6647980661472, 2.50662827745924,
  ];
  const b = [
    -54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197,
    -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878,
  ];
  const d = [
    0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742,
  ];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5,
    r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}
/** Per-arm sample size for detecting baseline → baseline+mde (two-sided, two proportions). */
export function sampleSizePerArm(
  baselinePct: number,
  mdePp: number,
  alpha = 0.05,
  power = 0.8,
) {
  const p1 = baselinePct / 100,
    p2 = (baselinePct + mdePp) / 100;
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1) || mdePp === 0)
    throw Error("Baseline and baseline + effect must be between 0% and 100%");
  const za = normalInv(1 - alpha / 2),
    zb = normalInv(power),
    pbar = (p1 + p2) / 2;
  const n =
    (za * Math.sqrt(2 * pbar * (1 - pbar)) +
      zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) **
      2 /
    (p2 - p1) ** 2;
  return Math.ceil(n);
}
