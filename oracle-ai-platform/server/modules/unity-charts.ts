// Unity dashboard: topic groups, explanations and charts for customer data quality, identity,
// consent, audiences and jobs. Every chart counts records exactly as supplied.
import type { RecordData } from "../../shared/catalog";
import { Assessment, lower, ms, present, rate, text } from "./common";
import {
  dayLabel,
  dayRange,
  num,
  topLabels,
  type ModuleLayout,
} from "./layout";

export const UNITY_LAYOUT: ModuleLayout = {
  groups: ["Customers", "Data quality", "Consent", "Audiences", "Jobs"],
  sections: {
    "profiles-by-source": {
      group: "Customers",
      about:
        "Source records per source system (CRM, web, store…). Shows where your customer data comes from.",
    },
    "link-donut": {
      group: "Customers",
      about:
        "Source records linked to a unified (master) customer versus not linked. Unlinked records cannot be used in master-level audiences.",
    },
    "records-per-master": {
      group: "Customers",
      about:
        "How many source records each unified customer has. Many customers with a single record can mean identity matching is too strict; very large groups can mean over-matching.",
    },
    "customer-attributes": {
      group: "Customers",
      about:
        "The most common values of a customer attribute (for example country) across unified customers. Useful for planning audiences and personalization.",
    },
    "field-completeness": {
      group: "Data quality",
      about:
        "Share of source records where each field is filled. Fields required by your destinations should be close to 100%.",
    },
    fields: {
      group: "Data quality",
      about: "Completeness of every field, overall and per source system.",
    },
    freshness: {
      group: "Data quality",
      about:
        "How long ago source records were last updated. Old records are more likely to be out of date.",
    },
    "field-by-source": {
      group: "Data quality",
      about: "Completeness of the chosen field per source system.",
    },
    "consent-chart": {
      group: "Consent",
      about:
        "Latest consent state per unified customer for each channel and purpose. Only granted, unexpired consent can be used for marketing.",
    },
    consent: {
      group: "Consent",
      about:
        "Consent states per channel and purpose. Unknown means no status was recorded; it is never assumed.",
    },
    "audience-chart": {
      group: "Audiences",
      about:
        "For each audience: members ready to activate and members blocked by missing fields, missing consent, or both.",
    },
    segments: {
      group: "Audiences",
      about:
        "Each audience with its destination, exported members and how many are ready.",
    },
    blockers: {
      group: "Audiences",
      about:
        "Why members of an audience cannot be activated, so you can fix the biggest blocker first.",
    },
    "jobs-chart": {
      group: "Jobs",
      about:
        "Job runs per day by outcome. A run of failures usually points to one broken source or schedule.",
    },
    jobs: {
      group: "Jobs",
      about:
        "Every Unity job with its latest status, last success and failed runs.",
    },
  },
  rules: {
    missing_required_field: "Data quality",
    stale_records: "Data quality",
    duplicate_candidates: "Customers",
    consent_gap: "Consent",
    activation_blocked: "Audiences",
    incomplete_membership: "Audiences",
    job_failed: "Jobs",
  },
  capabilities: {
    profiles: "Customers",
    required: "Data quality",
    consent: "Consent",
    readiness: "Audiences",
    overlap: "Audiences",
    jobs: "Jobs",
    history: "Data quality",
  },
};

export interface AudienceCounts {
  name: string;
  ready: number;
  onlyField: number;
  onlyConsent: number;
  both: number;
}

const ATTRIBUTE_SKIP = new Set([
  "id",
  "type",
  "sourceSystem",
  "masterId",
  "email",
  "phone",
  "firstName",
  "lastName",
  "updatedAt",
]);

export function unityCharts(
  a: Assessment,
  asOf: number,
  audiences: AudienceCounts[],
  consentRows: Record<string, unknown>[],
  required: string[],
) {
  const profiles = a.rows("profile");
  if (profiles.length) {
    const src = topLabels(
      profiles,
      (p) => text(p.sourceSystem) || "Not recorded",
      6,
    );
    a.chart({
      id: "profiles-by-source",
      title: "Source records by system",
      chart: {
        type: "donut",
        x: "system",
        unit: "count",
        series: [{ key: "records", label: "Source records" }],
        data: src.labels.map((l) => ({
          system: l,
          records: profiles.filter((p) => src.of(p) === l).length,
        })),
      },
    });
    const linked = profiles.filter((p) => present(p.masterId)).length;
    a.chart({
      id: "link-donut",
      title: "Identity links",
      chart: {
        type: "donut",
        x: "state",
        unit: "count",
        series: [{ key: "records", label: "Source records" }],
        data: [
          { state: "Linked to a unified customer", records: linked },
          { state: "Not linked", records: profiles.length - linked },
        ],
      },
    });
    const perMaster = new Map<string, number>();
    for (const p of profiles)
      if (present(p.masterId))
        perMaster.set(
          text(p.masterId),
          (perMaster.get(text(p.masterId)) || 0) + 1,
        );
    if (perMaster.size) {
      const bands: [string, (n: number) => boolean][] = [
        ["1 record", (n) => n === 1],
        ["2 records", (n) => n === 2],
        ["3 records", (n) => n === 3],
        ["4–5 records", (n) => n >= 4 && n <= 5],
        ["6 or more", (n) => n >= 6],
      ];
      a.chart({
        id: "records-per-master",
        title: "Source records per unified customer",
        chart: {
          type: "bar",
          x: "band",
          unit: "count",
          series: [{ key: "customers", label: "Unified customers" }],
          data: bands.map(([band, f]) => ({
            band,
            customers: [...perMaster.values()].filter(f).length,
          })),
        },
      });
    }
    // Completeness of required fields, else of the common contact fields present in the data.
    const fields = (
      required.length
        ? required
        : ["email", "phone", "firstName", "lastName", "country"]
    ).filter((f) => profiles.some((p) => f in p));
    a.chart({
      id: "field-completeness",
      title: required.length
        ? "Completeness of required fields"
        : "Completeness of key fields",
      chart: {
        type: "hbar",
        x: "field",
        unit: "percent",
        series: [{ key: "filled", label: "Records with a value" }],
        data: fields.map((f) => ({
          field: f,
          filled: num(
            rate(profiles.filter((p) => present(p[f])).length, profiles.length),
          ),
        })),
      },
    });
    if (profiles.some((p) => present(p.updatedAt))) {
      const bands: [string, number][] = [
        ["Last 30 days", 30],
        ["31–90 days", 90],
        ["91–180 days", 180],
        ["181–365 days", 365],
        ["Over a year", Infinity],
      ];
      const ages = profiles.map((p) =>
        present(p.updatedAt) ? (asOf - ms(p.updatedAt)) / 86_400_000 : null,
      );
      a.chart({
        id: "freshness",
        title: "Time since last update",
        chart: {
          type: "bar",
          x: "age",
          unit: "count",
          series: [{ key: "records", label: "Source records" }],
          data: [
            ...bands.map(([age, max], i) => ({
              age,
              records: ages.filter(
                (d) =>
                  d !== null && d < max && (i === 0 || d >= bands[i - 1][1]),
              ).length,
            })),
            {
              age: "Not recorded",
              records: ages.filter((d) => d === null).length,
            },
          ],
        },
      });
    }
    // One customer attribute with few distinct values (e.g. country), per unified customer.
    const candidate = Object.keys(profiles[0])
      .filter((k) => !ATTRIBUTE_SKIP.has(k))
      .map((k) => ({
        k,
        values: new Set(
          profiles.filter((p) => present(p[k])).map((p) => lower(p[k])),
        ),
      }))
      .filter((c) => c.values.size >= 2 && c.values.size <= 25)
      .sort((x, y) => (x.k === "country" ? -1 : y.k === "country" ? 1 : 0))[0];
    if (candidate) {
      const byCustomer = new Map<string, RecordData>();
      for (const p of profiles)
        if (present(p[candidate.k]))
          byCustomer.set(text(p.masterId) || p.id, p);
      const rows = [...byCustomer.values()];
      const top = topLabels(rows, (p) => text(p[candidate.k]), 7);
      a.chart({
        id: "customer-attributes",
        title: `Customers by ${candidate.k}`,
        chart: {
          type: "hbar",
          x: "value",
          unit: "count",
          series: [{ key: "customers", label: "Customers" }],
          data: top.labels.map((l) => ({
            value: l,
            customers: rows.filter((p) => top.of(p) === l).length,
          })),
        },
      });
    }
  }
  if (consentRows.length)
    a.chart({
      id: "consent-chart",
      title: "Consent by channel and purpose",
      chart: {
        type: "stacked",
        x: "pair",
        unit: "count",
        series: [
          { key: "granted", label: "Granted" },
          { key: "denied", label: "Denied" },
          { key: "expired", label: "Expired" },
          { key: "unknown", label: "Unknown" },
        ],
        data: consentRows.map((r) => ({
          pair: `${text(r.channel)} · ${text(r.purpose)}`,
          granted: Number(r.granted) || 0,
          denied: Number(r.denied) || 0,
          expired: Number(r.expired) || 0,
          unknown: Number(r.unknown) || 0,
        })),
      },
    });
  if (audiences.length)
    a.chart({
      id: "audience-chart",
      title: "Audience readiness",
      chart: {
        type: "stacked",
        x: "audience",
        unit: "count",
        series: [
          { key: "ready", label: "Ready" },
          { key: "field", label: "Missing fields" },
          { key: "consent", label: "Missing consent" },
          { key: "both", label: "Both" },
        ],
        data: audiences.map((s) => ({
          audience: s.name,
          ready: s.ready,
          field: s.onlyField,
          consent: s.onlyConsent,
          both: s.both,
        })),
      },
    });
  const jobs = a
    .rows("job")
    .filter((j) => present(j.startedAt || j.completedAt));
  if (jobs.length) {
    const day = (j: RecordData) => a.day(j.startedAt || j.completedAt);
    const ok = (j: RecordData) =>
      ["succeeded", "success", "completed"].includes(lower(j.status));
    const bad = (j: RecordData) =>
      ["failed", "error", "aborted"].includes(lower(j.status));
    a.chart({
      id: "jobs-chart",
      title: "Job runs per day",
      chart: {
        type: "stacked",
        x: "day",
        unit: "count",
        series: [
          { key: "ok", label: "Succeeded" },
          { key: "failed", label: "Failed" },
          { key: "other", label: "Other status" },
        ],
        data: dayRange(jobs.map(day)).map((d) => {
          const js = jobs.filter((j) => day(j) === d);
          return {
            day: dayLabel(d),
            ok: js.filter(ok).length,
            failed: js.filter(bad).length,
            other: js.filter((j) => !ok(j) && !bad(j)).length,
          };
        }),
      },
    });
  }
}
