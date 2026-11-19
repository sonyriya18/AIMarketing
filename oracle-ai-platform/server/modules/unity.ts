// Oracle Unity module: customer-data quality, identity-link coverage, consent states, audience
// readiness against configured destination requirements, exact overlap and job health.
// Nothing here merges people, infers consent, or changes Unity configuration.
import Decimal from "decimal.js";
import type { RecordData, Report, Source } from "../../shared/catalog";
import {
  Assessment,
  D,
  bool,
  fmt,
  list,
  lower,
  ms,
  present,
  rate,
  text,
  type AssessmentMeta,
  type RuleDef,
} from "./common";
import type {
  CompareResult,
  MetricDefinition,
  ModuleDefinition,
  ScenarioResult,
} from "./types";
import { UNITY_LAYOUT, unityCharts, type AudienceCounts } from "./unity-charts";

const VERSION = "unity-assessment-2026-10-30.1";
const DAY = 86_400_000;
const rule = (r: Omit<RuleDef, "version">): RuleDef => ({
  version: "v1",
  ...r,
});
export const UNITY_RULES: Record<string, RuleDef> = {
  missing_required_field: rule({
    title: "Complete a required field",
    description:
      "Source records are missing a field the customer marked as required for this purpose.",
    severity: "medium",
    ownerRole: "Data steward",
    effort: "M (source feed or mapping fix; basis: one field, one feed)",
    automation: "B",
    targetMetric: "completeness",
    nextChecks: [
      "Break the gap down by source system (Analyze Data).",
      "Check the ingest mapping for this field in the affected feed.",
    ],
    dataNeeded: ["sourceSystem on every profile record"],
    measurement: "Field completeness in the next profile snapshot.",
  }),
  stale_records: rule({
    title: "Refresh stale source records",
    description:
      "Source records were last updated longer ago than the approved staleness window.",
    severity: "medium",
    ownerRole: "Data engineer",
    effort: "S (feed schedule check)",
    automation: "B",
    targetMetric: "stale_records",
    nextChecks: [
      "Check the ingest job history for the affected source systems.",
    ],
    dataNeeded: ["updatedAt on every profile record", "Ingest job history"],
    measurement: "Stale record count in the next snapshot.",
  }),
  duplicate_candidates: rule({
    title: "Review duplicate candidates",
    description:
      "Records with the same normalized email are linked to different master IDs. These are candidates, not verified matches; nothing is merged automatically.",
    severity: "low",
    ownerRole: "Data steward",
    effort: "M (identity-rule review with the Unity administrator)",
    automation: "B",
    targetMetric: "duplicate_candidates",
    nextChecks: [
      "Review the identity-resolution rules that should link these records.",
      "Confirm whether shared emails (e.g. family or role addresses) are expected.",
    ],
    dataNeeded: ["Identity-resolution rule configuration"],
    measurement: "Candidate count after the next identity-resolution job.",
  }),
  consent_gap: rule({
    title: "Resolve unknown or expired consent",
    description:
      "Members of an audience lack a granted, unexpired permission for the destination's channel and purpose. Permission is never inferred from an email address or past engagement.",
    severity: "high",
    ownerRole: "Privacy / data steward",
    effort: "M (consent source reconciliation)",
    automation: "B",
    targetMetric: "ready_members",
    nextChecks: [
      "Confirm the authoritative consent source for this channel and purpose.",
      "Check whether consent records are loaded at the master-ID level.",
    ],
    dataNeeded: ["Consent records with channel, purpose, status and dates"],
    measurement:
      "Members with granted, unexpired consent in the next snapshot.",
  }),
  activation_blocked: rule({
    title: "Audience not ready for its destination",
    description:
      "Exported members are missing destination-required fields or permission. Readiness checks configured requirements only; it is not legal certification or proof the destination will accept the records.",
    severity: "high",
    ownerRole: "Audience manager",
    effort: "M (blocker remediation)",
    automation: "B",
    targetMetric: "ready_members",
    nextChecks: [
      "Review the blocker breakdown for this audience.",
      "Draft a remediation plan (Draft studio).",
    ],
    dataNeeded: ["Complete membership export", "Destination requirements"],
    measurement: "Ready members / exported members in the next snapshot.",
  }),
  job_failed: rule({
    title: "Investigate a failed Unity job",
    description: "The latest recorded run of a job failed.",
    severity: "high",
    ownerRole: "Data engineer",
    effort: "S–M (log review; basis: one job)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Read the job's error detail and the jobs configured to depend on it.",
      "Confirm which data or audiences were affected before re-running in Unity.",
    ],
    dataNeeded: ["Job history with status, timestamps and sanitized errors"],
    measurement: "Next run of the job succeeds.",
  }),
  incomplete_membership: rule({
    title: "Membership export is incomplete",
    description:
      "A segment is not marked as a complete membership export, so readiness and overlap are partial.",
    severity: "info",
    ownerRole: "Analyst",
    effort: "S (re-export)",
    automation: "A",
    targetMetric: null,
    nextChecks: [
      "Export the full membership through an authorized export and confirm all output parts were collected.",
    ],
    dataNeeded: ["Complete segment membership export"],
    measurement: "Segment marked complete in the next batch.",
  }),
};
const md = (
  id: string,
  label: string,
  grain: string,
  basis: MetricDefinition["basis"],
  numerator: string,
  denominator: string | null,
  exclusions = "None",
): MetricDefinition => ({
  id,
  label,
  grain,
  basis,
  numerator,
  denominator,
  timeBasis: "Snapshot as-of time",
  exclusions,
  source: "unity",
});
export const UNITY_METRICS: MetricDefinition[] = [
  md(
    "source_records",
    "Source records",
    "source record",
    "snapshot",
    "Count of profile records",
    null,
  ),
  md(
    "masters",
    "Master customers",
    "master ID",
    "unique",
    "Distinct masterId",
    null,
  ),
  md(
    "link_coverage",
    "Source-to-master link coverage",
    "source record",
    "derived",
    "Records with a masterId",
    "All source records",
    "An unlinked record is not proof of a duplicate",
  ),
  md(
    "duplicate_candidates",
    "Duplicate candidates",
    "email group",
    "unique",
    "Normalized emails linked to >1 master ID",
    null,
    "Candidates only, not verified matches",
  ),
  md(
    "completeness",
    "Required-field completeness",
    "source record × field",
    "derived",
    "Populated required fields",
    "Records × required fields",
  ),
  md(
    "stale_records",
    "Stale source records",
    "source record",
    "snapshot",
    "Records with updatedAt older than staleDays before as-of",
    null,
    "Records without updatedAt are counted separately",
  ),
  md(
    "ready_members",
    "Ready audience members",
    "master ID",
    "unique",
    "Exported members with all destination fields and granted, unexpired consent",
    null,
    "Partial when membership is incomplete",
  ),
  md(
    "overlap_jaccard",
    "Audience overlap (Jaccard)",
    "member ID",
    "derived",
    "|A ∩ B|",
    "|A ∪ B|",
    "Unavailable unless both memberships are complete, same identity level, compatible snapshots",
  ),
];

function segmentReadiness(
  a: { rows: (t: string) => RecordData[] },
  seg: RecordData,
  asOf: number,
) {
  const members = new Set(
    a
      .rows("membership")
      .filter((m) => text(m.segmentId) === seg.id)
      .map((m) => text(m.memberId)),
  );
  const dest = a
    .rows("destination")
    .find((d) => d.id === text(seg.destinationId));
  const masterLevel = lower(seg.identityLevel || "master") === "master";
  const profilesBy = new Map<string, RecordData[]>();
  for (const p of a.rows("profile")) {
    const k = masterLevel ? text(p.masterId) : p.id;
    if (k) profilesBy.set(k, [...(profilesBy.get(k) || []), p]);
  }
  const required = dest ? list(dest.requiredFields) : [];
  const ch = lower(dest?.consentChannel),
    pu = lower(dest?.consentPurpose);
  const consentBy = new Map<string, RecordData[]>();
  for (const c of a.rows("consent"))
    consentBy.set(text(c.masterId), [
      ...(consentBy.get(text(c.masterId)) || []),
      c,
    ]);
  let ready = 0,
    onlyField = 0,
    onlyConsent = 0,
    both = 0;
  const fieldMissing: Record<string, number> = Object.fromEntries(
    required.map((f) => [f, 0]),
  );
  const consentState = { granted: 0, denied: 0, expired: 0, unknown: 0 };
  for (const m of members) {
    const ps = profilesBy.get(m) || [];
    const missing = required.filter((f) => !ps.some((p) => present(p[f])));
    for (const f of missing) fieldMissing[f]++;
    let state: keyof typeof consentState = "unknown";
    if (ch && pu) {
      const recs = (consentBy.get(m) || [])
        .filter((c) => lower(c.channel) === ch && lower(c.purpose) === pu)
        .sort((x, y) =>
          text(y.effectiveDate).localeCompare(text(x.effectiveDate)),
        );
      const latest = recs[0];
      if (latest) {
        const s = lower(latest.status);
        state =
          s === "granted"
            ? present(latest.expiresAt) && ms(latest.expiresAt) < asOf
              ? "expired"
              : "granted"
            : s === "denied"
              ? "denied"
              : "unknown";
      }
    } else state = "granted"; // destination requires no permission check
    consentState[state]++;
    const consentOk = state === "granted";
    if (!missing.length && consentOk) ready++;
    else if (missing.length && consentOk) onlyField++;
    else if (!missing.length && !consentOk) onlyConsent++;
    else both++;
  }
  return {
    members,
    dest,
    required,
    fieldMissing,
    consentState,
    ready,
    onlyField,
    onlyConsent,
    both,
    masterLevel,
    complete: bool(seg.membershipComplete),
    needsConsent: !!(ch && pu),
  };
}

function overlap(
  a: { rows: (t: string) => RecordData[] },
  s1: RecordData,
  s2: RecordData,
  toleranceHours: number,
) {
  const reasons: string[] = [];
  if (!bool(s1.membershipComplete) || !bool(s2.membershipComplete))
    reasons.push("Both memberships must be complete exports");
  if (
    lower(s1.identityLevel || "master") !== lower(s2.identityLevel || "master")
  )
    reasons.push("Memberships use different identity levels");
  if (!present(s1.snapshotAt) || !present(s2.snapshotAt))
    reasons.push("Both segments need a snapshotAt time");
  else if (
    Math.abs(ms(s1.snapshotAt) - ms(s2.snapshotAt)) >
    toleranceHours * 3_600_000
  )
    reasons.push(`Snapshots are more than ${toleranceHours} hour(s) apart`);
  const A = new Set(
    a
      .rows("membership")
      .filter((m) => text(m.segmentId) === s1.id)
      .map((m) => text(m.memberId)),
  );
  const B = new Set(
    a
      .rows("membership")
      .filter((m) => text(m.segmentId) === s2.id)
      .map((m) => text(m.memberId)),
  );
  if (reasons.length)
    return { exact: false as const, reasons, A: A.size, B: B.size };
  const inter = [...A].filter((x) => B.has(x)).length,
    union = new Set([...A, ...B]).size;
  return {
    exact: true as const,
    reasons,
    A: A.size,
    B: B.size,
    inter,
    union,
    ofA: rate(inter, A.size),
    ofB: rate(inter, B.size),
    jaccard: rate(inter, union),
  };
}

function assess(
  source: Source,
  records: RecordData[],
  meta: AssessmentMeta,
): Report {
  const a = new Assessment(
    "unity",
    source,
    records,
    meta,
    UNITY_RULES,
    VERSION,
  );
  const asOf = Date.parse(meta.asOf);
  const staleDays = a.policy("staleDays", 30),
    tolerance = a.policy("snapshotToleranceHours", 1);
  const required = a.policy<string[]>("requiredFields", []);
  const profiles = a.rows("profile"),
    segments = a.rows("segment"),
    jobs = a.rows("job");
  const hasProfiles = profiles.length > 0;
  a.metric({
    id: "source_records",
    label: "Source records",
    value: hasProfiles ? profiles.length : null,
    unit: "count",
    formula: "Count of source profile records in this snapshot",
    rows: profiles,
    reason: "Upload profile records",
    grain: "source record",
    basis: "snapshot",
  });
  const masters = new Set(
    profiles.filter((p) => present(p.masterId)).map((p) => text(p.masterId)),
  );
  a.metric({
    id: "masters",
    label: "Master customers",
    value: hasProfiles ? masters.size : null,
    unit: "count",
    formula: "Distinct masterId across source records",
    rows: profiles,
    reason: "Upload profile records with masterId",
    grain: "master ID",
    basis: "unique",
  });
  const linked = profiles.filter((p) => present(p.masterId));
  a.metric({
    id: "link_coverage",
    label: "Source-to-master link coverage",
    value: hasProfiles ? rate(linked.length, profiles.length) : null,
    unit: "percent",
    formula:
      "Source records with a masterId / source records × 100 (an unlinked record is not proof of a duplicate)",
    rows: profiles,
    reason: "Upload profile records",
    grain: "source record",
    basis: "derived",
  });
  // Duplicate candidates: same normalized email, different master IDs.
  const byEmail = new Map<string, Set<string>>();
  for (const p of linked)
    if (present(p.email)) {
      const e = lower(p.email);
      byEmail.set(e, (byEmail.get(e) || new Set()).add(text(p.masterId)));
    }
  const dupGroups = [...byEmail.entries()].filter(([, s]) => s.size > 1);
  a.metric({
    id: "duplicate_candidates",
    label: "Duplicate candidates",
    value: hasProfiles ? dupGroups.length : null,
    unit: "count",
    formula:
      "Normalized email addresses linked to more than one master ID (candidates, not verified matches)",
    rows: profiles.filter((p) => dupGroups.some(([e]) => e === lower(p.email))),
    reason: "Upload profile records with email and masterId",
    grain: "email group",
    basis: "unique",
  });
  if (dupGroups.length)
    a.finding({
      rule: "duplicate_candidates",
      scope: "identity",
      detail: `${dupGroups.length} email address(es) are linked to more than one master ID. Nothing is merged automatically.`,
      evidence: ["duplicate_candidates"],
      affected: dupGroups.length,
    });
  // Completeness against approved required fields.
  if (required.length && hasProfiles) {
    const populated = profiles.reduce(
      (n, p) => n + required.filter((k) => present(p[k])).length,
      0,
    );
    a.metric({
      id: "completeness",
      label: "Required-field completeness",
      value: rate(populated, profiles.length * required.length),
      unit: "percent",
      formula: `Populated required fields (${required.join(", ")}) / (records × required fields) × 100`,
      rows: profiles,
      grain: "source record × field",
      basis: "derived",
    });
    const rowsOut: Record<string, unknown>[] = [];
    for (const field of required) {
      const missing = profiles.filter((p) => !present(p[field]));
      rowsOut.push({
        key: "field:" + field,
        field,
        populated: profiles.length - missing.length,
        missing: missing.length,
        completeness: fmt(
          rate(profiles.length - missing.length, profiles.length),
        ),
      });
      if (missing.length) {
        const bySource = new Map<string, number>();
        for (const p of missing)
          bySource.set(
            text(p.sourceSystem) || "unknown",
            (bySource.get(text(p.sourceSystem) || "unknown") || 0) + 1,
          );
        const top = [...bySource.entries()].sort((x, y) => y[1] - x[1])[0];
        a.finding({
          rule: "missing_required_field",
          scope: "field:" + field,
          title: "Complete required field " + field,
          detail: `${missing.length} of ${profiles.length} source records lack ${field}; most are from ${top[0]} (${top[1]}).`,
          rows: missing,
          evidence: ["completeness"],
          affected: missing.length,
          hypotheses: [
            `The ${top[0]} feed does not map ${field}.`,
            "The field is optional at the point of capture.",
          ],
        });
      }
    }
    a.section({
      id: "fields",
      kind: "table",
      title: "Required-field completeness",
      subtitle:
        "Completeness is measured against the fields your administrator marked as required for this purpose.",
      columns: [
        { key: "field", label: "Field" },
        { key: "populated", label: "Populated", unit: "count" },
        { key: "missing", label: "Missing", unit: "count" },
        { key: "completeness", label: "Complete %", unit: "percent" },
      ],
      rows: rowsOut,
    });
  } else
    a.metric({
      id: "completeness",
      label: "Required-field completeness",
      value: null,
      unit: "percent",
      formula: "Populated required fields / (records × required fields) × 100",
      reason: hasProfiles
        ? "An administrator must choose required fields in the source policy"
        : "Upload profile records",
    });
  // Freshness
  const noUpdate = profiles.filter((p) => !present(p.updatedAt)),
    stale = profiles.filter(
      (p) => present(p.updatedAt) && ms(p.updatedAt) < asOf - staleDays * DAY,
    );
  a.metric({
    id: "stale_records",
    label: `Records not updated in ${staleDays} days`,
    value:
      hasProfiles && noUpdate.length < profiles.length ? stale.length : null,
    unit: "count",
    formula: `Records with updatedAt more than ${staleDays} days before as-of`,
    rows: stale,
    reason: "Profile records need updatedAt",
    state: noUpdate.length ? "partial" : "observed",
    grain: "source record",
    basis: "snapshot",
  });
  if (noUpdate.length)
    a.warnings.push(
      `${noUpdate.length} source records have no updatedAt; their freshness is unknown.`,
    );
  if (stale.length)
    a.finding({
      rule: "stale_records",
      scope: "freshness",
      detail: `${stale.length} source records were last updated more than ${staleDays} days before the snapshot.`,
      rows: stale,
      evidence: ["stale_records"],
      affected: stale.length,
    });
  // Consent overview by channel/purpose at master level
  const consents = a.rows("consent");
  const pairs = [
    ...new Set(consents.map((c) => lower(c.channel) + "|" + lower(c.purpose))),
  ];
  const consentRows = pairs.map((pair) => {
    const [ch, pu] = pair.split("|");
    const latest = new Map<string, RecordData>();
    for (const c of consents.filter(
      (c) => lower(c.channel) === ch && lower(c.purpose) === pu,
    )) {
      const cur = latest.get(text(c.masterId));
      if (!cur || text(c.effectiveDate) > text(cur.effectiveDate))
        latest.set(text(c.masterId), c);
    }
    const st = { granted: 0, denied: 0, expired: 0, unknown: 0 };
    for (const m of masters) {
      const c = latest.get(m);
      const s = lower(c?.status);
      if (s === "granted")
        present(c!.expiresAt) && ms(c!.expiresAt) < asOf
          ? st.expired++
          : st.granted++;
      else if (s === "denied") st.denied++;
      else st.unknown++;
    }
    return { key: "consent:" + pair, channel: ch, purpose: pu, ...st };
  });
  if (consentRows.length)
    a.section({
      id: "consent",
      kind: "table",
      title: "Consent states by channel and purpose",
      subtitle:
        "Master customers without a recorded status are unknown. Permission is never inferred from an email address or past engagement.",
      columns: [
        { key: "channel", label: "Channel" },
        { key: "purpose", label: "Purpose" },
        { key: "granted", label: "Granted", unit: "count" },
        { key: "denied", label: "Denied", unit: "count" },
        { key: "expired", label: "Expired", unit: "count" },
        { key: "unknown", label: "Unknown", unit: "count" },
      ],
      rows: consentRows,
    });
  // Audience readiness
  const segRows: Record<string, unknown>[] = [];
  const audienceCounts: AudienceCounts[] = [];
  for (const seg of segments) {
    const r = segmentReadiness(a, seg, asOf);
    const exported = r.members.size;
    if (r.dest && exported)
      audienceCounts.push({
        name: text(seg.name) || seg.id,
        ready: r.ready,
        onlyField: r.onlyField,
        onlyConsent: r.onlyConsent,
        both: r.both,
      });
    segRows.push({
      key: "segment:" + seg.id,
      segment: text(seg.name) || seg.id,
      destination:
        text(r.dest?.name) ||
        (present(seg.destinationId)
          ? text(seg.destinationId) + " (requirements not supplied)"
          : "—"),
      reported: D(seg.reportedCount) ? text(seg.reportedCount) : null,
      exported,
      complete: r.complete ? "Complete" : "Partial",
      ready: r.dest ? r.ready : null,
      readiness: r.dest ? fmt(rate(r.ready, exported)) : null,
    });
    if (!r.complete)
      a.finding({
        rule: "incomplete_membership",
        entity: seg,
        detail: `${text(seg.name) || seg.id}: membership export is not marked complete; readiness and overlap are partial.`,
      });
    if (r.dest && exported) {
      const blocked = exported - r.ready;
      if (blocked) {
        const fieldText = Object.entries(r.fieldMissing)
          .filter(([, n]) => n)
          .map(([f, n]) => `${f} missing for ${n}`)
          .join("; ");
        const consentText = r.needsConsent
          ? `consent: ${r.consentState.unknown} unknown, ${r.consentState.expired} expired, ${r.consentState.denied} denied`
          : "";
        a.finding({
          rule: "activation_blocked",
          entity: seg,
          detail: `${text(seg.name) || seg.id} → ${text(r.dest.name) || r.dest.id}: ${r.ready} of ${exported} exported members are ready. Blockers: ${[fieldText, consentText].filter(Boolean).join("; ")}.`,
          affected: blocked,
          partial: !r.complete,
        });
        if (
          r.needsConsent &&
          r.consentState.unknown + r.consentState.expired > 0
        )
          a.finding({
            rule: "consent_gap",
            entity: seg,
            title:
              "Resolve unknown or expired consent for " +
              (text(seg.name) || seg.id),
            detail: `${r.consentState.unknown} members have no recorded ${text(r.dest.consentChannel)}/${text(r.dest.consentPurpose)} permission and ${r.consentState.expired} have expired permission.`,
            affected: r.consentState.unknown + r.consentState.expired,
            partial: !r.complete,
          });
      }
    }
  }
  if (segments.length === 1) {
    const r = segmentReadiness(a, segments[0], asOf);
    const st = r.complete ? "observed" : "partial";
    a.metric({
      id: "exported_members",
      label: "Exported members",
      value: r.members.size,
      unit: "count",
      formula: "Distinct member IDs in the membership export",
      grain: "member ID",
      basis: "unique",
      state: st,
      reason: "Membership export is not complete",
    });
    if (r.dest) {
      a.metric({
        id: "ready_members",
        label: "Ready members",
        value: r.ready,
        unit: "count",
        formula:
          "Members with every destination-required field and granted, unexpired consent",
        grain: "member ID",
        basis: "unique",
        state: st,
        reason: "Membership export is not complete",
      });
      a.metric({
        id: "blocked_field_only",
        label: "Blocked only by missing fields",
        value: r.onlyField,
        unit: "count",
        formula: "Members with consent but missing ≥1 required field",
        basis: "unique",
        state: st,
      });
      a.metric({
        id: "blocked_consent_only",
        label: "Blocked only by consent",
        value: r.onlyConsent,
        unit: "count",
        formula: "Members with all fields but no granted, unexpired consent",
        basis: "unique",
        state: st,
      });
      a.metric({
        id: "blocked_both",
        label: "Blocked by fields and consent",
        value: r.both,
        unit: "count",
        formula: "Members missing fields and lacking granted consent",
        basis: "unique",
        state: st,
      });
      a.section({
        id: "blockers",
        kind: "bars",
        title:
          "Activation blockers for " +
          (text(segments[0].name) || segments[0].id),
        unit: "count",
        bars: [
          ...Object.entries(r.fieldMissing).map(([f, n]) => ({
            label: "Missing " + f,
            value: n,
          })),
          ...(r.needsConsent
            ? [
                { label: "Consent unknown", value: r.consentState.unknown },
                { label: "Consent expired", value: r.consentState.expired },
                { label: "Consent denied", value: r.consentState.denied },
              ]
            : []),
        ],
        note: "A member can have several blockers; bars are not additive.",
      });
    } else
      a.warnings.push(
        "No destination requirements supplied for this segment; readiness cannot be assessed.",
      );
  }
  if (segments.length === 2) {
    const o = overlap(a, segments[0], segments[1], tolerance);
    if (o.exact) {
      a.metric({
        id: "overlap_intersection",
        label: "Members in both audiences",
        value: o.inter,
        unit: "count",
        formula: "|A ∩ B| at the shared identity level",
        grain: "member ID",
        basis: "unique",
      });
      a.metric({
        id: "overlap_of_a",
        label: `Share of ${text(segments[0].name) || "A"} also in ${text(segments[1].name) || "B"}`,
        value: o.ofA,
        unit: "percent",
        formula: "|A ∩ B| / |A| × 100",
      });
      a.metric({
        id: "overlap_of_b",
        label: `Share of ${text(segments[1].name) || "B"} also in ${text(segments[0].name) || "A"}`,
        value: o.ofB,
        unit: "percent",
        formula: "|A ∩ B| / |B| × 100",
      });
      a.metric({
        id: "overlap_jaccard",
        label: "Jaccard overlap",
        value: o.jaccard,
        unit: "percent",
        formula: "|A ∩ B| / |A ∪ B| × 100",
      });
    } else
      a.metric({
        id: "overlap_jaccard",
        label: "Exact audience overlap",
        value: null,
        unit: "percent",
        formula: "|A ∩ B| / |A ∪ B| × 100",
        reason:
          o.reasons.join("; ") + ". Counts alone cannot establish overlap.",
      });
  }
  if (segRows.length)
    a.section({
      id: "segments",
      kind: "table",
      title: "Audience readiness",
      subtitle:
        "Ready = all destination-required fields present on a linked record and granted, unexpired consent for the destination's channel and purpose.",
      columns: [
        { key: "segment", label: "Audience" },
        { key: "destination", label: "Destination" },
        { key: "reported", label: "Reported by Unity", unit: "count" },
        { key: "exported", label: "Exported members", unit: "count" },
        { key: "complete", label: "Membership" },
        { key: "ready", label: "Ready", unit: "count" },
        { key: "readiness", label: "Ready %", unit: "percent" },
      ],
      rows: segRows,
    });
  // Jobs
  const jobRows: Record<string, unknown>[] = [];
  const byName = new Map<string, RecordData[]>();
  for (const j of jobs)
    byName.set(text(j.name) || j.id, [
      ...(byName.get(text(j.name) || j.id) || []),
      j,
    ]);
  for (const [nm, runs] of byName) {
    runs.sort((x, y) =>
      text(y.startedAt || y.completedAt).localeCompare(
        text(x.startedAt || x.completedAt),
      ),
    );
    const latest = runs[0],
      lastOk = runs.find((r) =>
        ["succeeded", "success", "completed"].includes(lower(r.status)),
      );
    const dependents = jobs
      .filter((j) => list(j.dependsOn).includes(nm))
      .map((j) => text(j.name) || j.id);
    jobRows.push({
      key: "job:" + latest.id,
      job: nm,
      type: text(latest.jobType),
      latest: text(latest.status),
      lastRun: text(latest.startedAt || latest.completedAt) || null,
      lastSuccess: lastOk ? text(lastOk.completedAt || lastOk.startedAt) : null,
      failures: runs.filter((r) =>
        ["failed", "error", "aborted"].includes(lower(r.status)),
      ).length,
    });
    if (["failed", "error", "aborted"].includes(lower(latest.status)))
      a.finding({
        rule: "job_failed",
        entity: latest,
        title: "Investigate failed job " + nm,
        detail: `${nm} (${text(latest.jobType)}) latest run is ${text(latest.status)}${present(latest.error) ? ": " + text(latest.error) : ""}. Last success: ${lastOk ? text(lastOk.completedAt || lastOk.startedAt) : "none recorded"}.${dependents.length ? " Configured dependents: " + [...new Set(dependents)].join(", ") + "." : ""}`,
        caveats: [
          "Identity resolution and Customer 360 are different job types; check the one that failed.",
        ],
      });
  }
  if (jobRows.length)
    a.section({
      id: "jobs",
      kind: "table",
      title: "Job health",
      subtitle:
        "Dependencies are shown only when configured (dependsOn); they are never inferred from job names.",
      columns: [
        { key: "job", label: "Job" },
        { key: "type", label: "Type" },
        { key: "latest", label: "Latest status" },
        { key: "lastRun", label: "Last run" },
        { key: "lastSuccess", label: "Last success" },
        { key: "failures", label: "Failed runs", unit: "count" },
      ],
      rows: jobRows,
    });
  a.metric({
    id: "failed_jobs",
    label: "Jobs whose latest run failed",
    value: jobs.length
      ? jobRows.filter((r) =>
          ["failed", "error", "aborted"].includes(lower(r.latest)),
        ).length
      : null,
    unit: "count",
    formula: "Distinct job names whose most recent run failed",
    reason: "Upload job history",
    basis: "unique",
  });
  // Field analysis (Analyze Data)
  const field =
    typeof meta.options?.field === "string" ? meta.options.field : "";
  if (field && hasProfiles) {
    const bySrc = new Map<string, { total: number; filled: number }>();
    for (const p of profiles) {
      const k = text(p.sourceSystem) || "unknown",
        e = bySrc.get(k) || { total: 0, filled: 0 };
      e.total++;
      if (present(p[field])) e.filled++;
      bySrc.set(k, e);
    }
    a.section({
      id: "field-by-source",
      kind: "bars",
      title: `${field}: completeness by source system`,
      unit: "percent",
      bars: [...bySrc.entries()].map(([k, v]) => ({
        label: k,
        value: rate(v.filled, v.total)!.toNumber(),
        note: `${v.filled} of ${v.total}`,
      })),
      note: "Aggregate view. Record-level drill-down shows source IDs only.",
    });
  }
  unityCharts(a, asOf, audienceCounts, consentRows, required);
  a.capability(
    "profiles",
    "Profile data quality",
    hasProfiles,
    "Export source profile records with sourceSystem, masterId and updatedAt.",
  );
  a.capability(
    "required",
    "Required-field completeness",
    required.length > 0 && hasProfiles,
    "Administrator chooses required fields for the purpose (source policy).",
  );
  a.capability(
    "consent",
    "Consent coverage",
    consents.length > 0,
    "Consent records with channel, purpose, status and dates at master-ID level.",
  );
  a.capability(
    "readiness",
    "Audience readiness",
    segments.length > 0 && a.rows("destination").length > 0
      ? segments.every((s) => bool(s.membershipComplete))
        ? true
        : "partial"
      : false,
    "Segments with complete membership exports and destination requirements.",
  );
  a.capability(
    "overlap",
    "Exact audience overlap",
    segments.filter((s) => bool(s.membershipComplete)).length >= 2,
    "Two complete membership exports at the same identity level and compatible snapshots.",
  );
  a.capability(
    "jobs",
    "Job health",
    jobs.length > 0,
    "Job history from the Unity Jobs API or an export (type, status, times, errors).",
  );
  a.capability(
    "history",
    "Trends over time",
    false,
    "Stored snapshots over time. Current intelligent attributes are not used to manufacture history.",
  );
  return a.build();
}

function select(all: RecordData[], keys: string[]) {
  if (!keys.length) return all;
  const chosen = new Set(keys);
  const segs = all.filter(
    (r) => r.type === "segment" && chosen.has("segment:" + r.id),
  );
  const segIds = new Set(segs.map((s) => s.id));
  const members = all.filter(
    (r) => r.type === "membership" && segIds.has(text(r.segmentId)),
  );
  const memberIds = new Set(members.map((m) => text(m.memberId)));
  const destIds = new Set(segs.map((s) => text(s.destinationId)));
  return all.filter(
    (r) =>
      chosen.has(r.type + ":" + r.id) ||
      segIds.has(r.id) ||
      (r.type === "membership" && segIds.has(text(r.segmentId))) ||
      (r.type === "destination" && destIds.has(r.id)) ||
      (r.type === "profile" &&
        (memberIds.has(text(r.masterId)) || memberIds.has(r.id))) ||
      (r.type === "consent" && memberIds.has(text(r.masterId))) ||
      (!segs.length && r.type !== "segment" && r.type !== "membership"),
  );
}

function validateBatch(records: RecordData[]) {
  const errors: { row: number; message: string }[] = [],
    warnings: string[] = [];
  const segs = records.filter((r) => r.type === "segment"),
    segIds = new Set(segs.map((s) => s.id));
  const masters = new Set(
    records
      .filter((r) => r.type === "profile")
      .map((r) => text(r.masterId))
      .filter(Boolean),
  );
  const dests = new Set(
    records.filter((r) => r.type === "destination").map((r) => r.id),
  );
  records.forEach((r, i) => {
    if (
      r.type === "membership" &&
      segs.length &&
      !segIds.has(text(r.segmentId))
    )
      errors.push({
        row: i + 1,
        message: `Segment ${text(r.segmentId)} is not in this batch's segment export`,
      });
    if (
      r.type === "consent" &&
      !["granted", "denied", "unknown"].includes(lower(r.status))
    )
      errors.push({
        row: i + 1,
        message: "Consent status must be granted, denied or unknown",
      });
  });
  for (const s of segs) {
    if (
      bool(s.membershipComplete) &&
      !records.some(
        (m) => m.type === "membership" && text(m.segmentId) === s.id,
      )
    )
      errors.push({
        row: 0,
        message: `Segment ${s.id} is marked complete but has no membership rows`,
      });
    if (present(s.destinationId) && !dests.has(text(s.destinationId)))
      warnings.push(
        `Segment ${s.id} references destination ${text(s.destinationId)}, which is not in this batch; readiness will be unavailable.`,
      );
  }
  const orphanConsent = records.filter(
    (r) =>
      r.type === "consent" && masters.size && !masters.has(text(r.masterId)),
  ).length;
  if (orphanConsent)
    warnings.push(
      `${orphanConsent} consent records reference master IDs not present in the profile export.`,
    );
  return { errors, warnings };
}

function simulate(input: Record<string, unknown>): ScenarioResult {
  const n = (k: string, max?: number) => {
    const v = D(input[k]);
    if (
      v === null ||
      v.lt(0) ||
      (max !== undefined && v.gt(max)) ||
      (!v.isInteger() && max === undefined)
    )
      throw Error(
        `Enter a valid ${k}${max !== undefined ? " from 0 to " + max : " (whole number)"}`,
      );
    return v;
  };
  const ready = n("readyMembers"),
    oF = n("blockedFieldOnly"),
    oC = n("blockedConsentOnly"),
    both = n("blockedBoth");
  const f = n("fieldFixRate", 100).div(100),
    c = n("consentVerifiedRate", 100).div(100);
  const projected = ready
    .plus(oF.mul(f))
    .plus(oC.mul(c))
    .plus(both.mul(f).mul(c));
  return {
    kind: "assumption",
    formulaVersion: "unity-readiness-scenario-v1",
    formula:
      "Projected ready = ready + field-only × f + consent-only × c + both × f × c (each member counted once; f and c assumed independent)",
    measured: {
      readyMembers: fmt(ready),
      blockedFieldOnly: fmt(oF),
      blockedConsentOnly: fmt(oC),
      blockedBoth: fmt(both),
    },
    assumed: {
      fieldFixRate: fmt(f.mul(100))!,
      consentVerifiedRate: fmt(c.mul(100))!,
    },
    projected: {
      readyMembers: fmt(projected.toDecimalPlaces(0, Decimal.ROUND_DOWN)),
      additionalReady: fmt(
        projected.minus(ready).toDecimalPlaces(0, Decimal.ROUND_DOWN),
      ),
    },
    unit: "members",
    note: "Hypothetical. A simulated fix does not change Unity records, and assumed consent is not consent: permission must be verified from the authoritative source.",
  };
}

function compare(
  source: Source,
  all: RecordData[],
  keys: string[],
  meta: AssessmentMeta,
): CompareResult {
  const segs = keys.map((k) =>
    all.find((r) => r.type === "segment" && "segment:" + r.id === k),
  );
  if (segs.some((s) => !s)) throw Error("Choose audiences from this snapshot");
  const view = { rows: (t: string) => all.filter((r) => r.type === t) };
  const asOf = Date.parse(meta.asOf),
    tol = Number(source.policy.snapshotToleranceHours ?? 1);
  const rd = segs.map((s) => segmentReadiness(view, s!, asOf));
  const caveats: string[] = [];
  if (new Set(segs.map((s) => text(s!.destinationId))).size > 1)
    caveats.push(
      "Audiences target different destinations; readiness requirements differ.",
    );
  if (rd.some((r) => !r.complete))
    caveats.push(
      "At least one membership export is incomplete; counts are partial.",
    );
  const extra: CompareResult["extra"] = [];
  if (segs.length === 2) {
    const o = overlap(view, segs[0]!, segs[1]!, tol);
    extra.push({
      title: "Exact audience overlap",
      rows: o.exact
        ? [
            {
              label: "Members in both",
              value: String(o.inter),
              definition: "|A ∩ B|",
            },
            {
              label: `Share of ${text(segs[0]!.name) || "A"}`,
              value: fmt(o.ofA),
              definition: "|A ∩ B| / |A| × 100",
            },
            {
              label: `Share of ${text(segs[1]!.name) || "B"}`,
              value: fmt(o.ofB),
              definition: "|A ∩ B| / |B| × 100",
            },
            {
              label: "Jaccard overlap",
              value: fmt(o.jaccard),
              definition: "|A ∩ B| / |A ∪ B| × 100",
            },
          ]
        : [
            {
              label: "Exact overlap",
              value: null,
              definition:
                o.reasons.join("; ") +
                ". Counts alone cannot establish overlap.",
            },
          ],
    });
  }
  return {
    columns: segs.map((s) => ({
      key: "segment:" + s!.id,
      label: text(s!.name) || s!.id,
    })),
    rows: [
      {
        metric: "Destination",
        unit: "text",
        values: rd.map((r) => (r.dest ? text(r.dest.name) || r.dest.id : null)),
      },
      {
        metric: "Identity level",
        unit: "text",
        values: segs.map((s) => text(s!.identityLevel) || "master"),
      },
      {
        metric: "Snapshot",
        unit: "text",
        values: segs.map((s) => text(s!.snapshotAt) || null),
      },
      {
        metric: "Membership export",
        unit: "text",
        values: rd.map((r) => (r.complete ? "Complete" : "Partial")),
      },
      {
        metric: "Reported by Unity",
        unit: "count",
        values: segs.map((s) =>
          D(s!.reportedCount) ? text(s!.reportedCount) : null,
        ),
      },
      {
        metric: "Exported members",
        unit: "count",
        values: rd.map((r) => String(r.members.size)),
      },
      {
        metric: "Ready members",
        unit: "count",
        values: rd.map((r) => (r.dest ? String(r.ready) : null)),
      },
      {
        metric: "Ready %",
        unit: "percent",
        values: rd.map((r) =>
          r.dest ? fmt(rate(r.ready, r.members.size)) : null,
        ),
      },
      {
        metric: "Consent unknown",
        unit: "count",
        values: rd.map((r) =>
          r.needsConsent ? String(r.consentState.unknown) : null,
        ),
      },
    ],
    caveats,
    test: null,
    extra,
  };
}

const finding = (r: Report, id?: string) =>
  r.findings.find((f) => f.id === id) || r.findings[0];
export const unity: ModuleDefinition = {
  app: "unity",
  definitionVersion: VERSION,
  layout: UNITY_LAYOUT,
  rules: UNITY_RULES,
  metricDictionary: UNITY_METRICS,
  assess,
  select,
  validateBatch,
  scenarioFields: [
    {
      key: "readyMembers",
      label: "Ready members (measured)",
      unit: "count",
      prefill: "ready_members",
    },
    {
      key: "blockedFieldOnly",
      label: "Blocked only by fields (measured)",
      unit: "count",
      prefill: "blocked_field_only",
    },
    {
      key: "blockedConsentOnly",
      label: "Blocked only by consent (measured)",
      unit: "count",
      prefill: "blocked_consent_only",
    },
    {
      key: "blockedBoth",
      label: "Blocked by both (measured)",
      unit: "count",
      prefill: "blocked_both",
    },
    {
      key: "fieldFixRate",
      label: "Assumed share of missing fields completed (%)",
      unit: "percent",
    },
    {
      key: "consentVerifiedRate",
      label: "Assumed share of consent verified as granted (%)",
      unit: "percent",
    },
  ],
  simulate,
  compare,
  compareEntity: "segment",
  analyzeEntity: "segment",
  draftTypes: [
    {
      id: "segment_definition",
      label: "Audience definition draft",
      fields: [
        {
          key: "request",
          label: "What audience do you need?",
          multiline: true,
        },
        {
          key: "definition",
          label:
            "Typed definition (JSON, validated against this tenant's fields)",
          multiline: true,
        },
        { key: "destination", label: "Intended destination" },
        { key: "notes", label: "Notes and open questions", multiline: true },
      ],
      prefill: () => ({
        request: "",
        definition: '{"match":"all","conditions":[]}',
        destination: "",
        notes: "Saved as a platform draft. Nothing is published to Unity.",
      }),
    },
    {
      id: "remediation_plan",
      label: "Data remediation plan",
      fields: [
        { key: "issue", label: "Observed issue", multiline: true },
        { key: "rule", label: "Source rule and version" },
        { key: "before", label: "Before-state (measured)", multiline: true },
        { key: "steps", label: "Remediation steps", multiline: true },
        { key: "owner", label: "Owner" },
        { key: "recheck", label: "Re-assessment check" },
      ],
      prefill: (r, id) => {
        const f = finding(r, id);
        const m = f
          ? r.metrics
              .filter((x) => f.evidenceIds.includes(x.id))
              .map((x) => `${x.label}: ${x.value ?? "unavailable"}`)
              .join("\n")
          : "";
        return {
          issue: f ? f.title + ". " + f.detail : "",
          rule: f?.rule || "",
          before: m,
          steps: f
            ? (
                UNITY_RULES[f.rule.replace(/-v\d+$/, "")]?.nextChecks || []
              ).join("\n")
            : "",
          owner: f?.recommendation?.ownerRole || "",
          recheck: f?.recommendation?.measurement || "",
        };
      },
    },
    {
      id: "activation_checklist",
      label: "Activation-readiness checklist",
      fields: [
        { key: "audience", label: "Audience" },
        { key: "blockers", label: "Blockers with evidence", multiline: true },
        { key: "checks", label: "Checks before activation", multiline: true },
        { key: "approver", label: "Approver" },
      ],
      prefill: (r) => {
        const fs = r.findings.filter(
          (f) =>
            f.rule.startsWith("activation_blocked") ||
            f.rule.startsWith("consent_gap"),
        );
        return {
          audience: r.scope?.join(", ") || "",
          blockers: fs.map((f) => "• " + f.detail).join("\n"),
          checks:
            "Confirm complete membership export\nConfirm consent source for channel/purpose\nConfirm destination field mapping",
          approver: "",
        };
      },
    },
  ],
};

// ---------------- Typed audience definitions (natural-language drafting target) ----------------
export const OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "is_present",
  "is_missing",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "in",
] as const;
export type FieldKind = "text" | "number" | "date";
export function discoverFields(profiles: RecordData[]) {
  const out: Record<string, FieldKind> = {};
  const keys = new Set(
    profiles
      .flatMap((p) => Object.keys(p))
      .filter((k) => !["type", "id"].includes(k)),
  );
  for (const k of keys) {
    const vals = profiles
      .map((p) => p[k])
      .filter(present)
      .slice(0, 500);
    out[k] =
      vals.length &&
      vals.every(
        (v) =>
          /^\d{4}-\d{2}-\d{2}/.test(text(v)) &&
          !Number.isNaN(Date.parse(text(v))),
      )
        ? "date"
        : vals.length && vals.every((v) => D(v) !== null)
          ? "number"
          : "text";
  }
  return out;
}
export interface Condition {
  field: string;
  operator: (typeof OPERATORS)[number];
  value?: string | number | string[];
}
export interface Definition {
  match: "all" | "any";
  conditions: Condition[];
}
export function validateDefinition(
  raw: unknown,
  fields: Record<string, FieldKind>,
): Definition {
  const d = raw as Definition;
  if (
    !d ||
    typeof d !== "object" ||
    !["all", "any"].includes(d.match) ||
    !Array.isArray(d.conditions) ||
    d.conditions.length > 20
  )
    throw Error(
      'Definition must be {"match":"all"|"any","conditions":[…]} with at most 20 conditions',
    );
  for (const c of d.conditions) {
    if (!c || typeof c.field !== "string" || !(c.field in fields))
      throw Error(
        `Field ${String(c?.field)} does not exist in this tenant's profile data`,
      );
    if (!OPERATORS.includes(c.operator))
      throw Error(`Operator ${String(c.operator)} is not allowed`);
    const kind = fields[c.field];
    if (["gt", "gte", "lt", "lte"].includes(c.operator) && kind !== "number")
      throw Error(`${c.operator} needs a numeric field; ${c.field} is ${kind}`);
    if (["before", "after"].includes(c.operator) && kind !== "date")
      throw Error(`${c.operator} needs a date field; ${c.field} is ${kind}`);
    if (
      !["is_present", "is_missing"].includes(c.operator) &&
      (c.value === undefined || c.value === null || c.value === "")
    )
      throw Error(`${c.field} ${c.operator} needs a value`);
    if (c.operator === "in" && !Array.isArray(c.value))
      throw Error("in needs a list of values");
  }
  return d;
}
export function previewDefinition(d: Definition, profiles: RecordData[]) {
  const test = (p: RecordData, c: Condition) => {
    const v = p[c.field];
    switch (c.operator) {
      case "is_present":
        return present(v);
      case "is_missing":
        return !present(v);
      case "equals":
        return lower(v) === lower(c.value);
      case "not_equals":
        return present(v) && lower(v) !== lower(c.value);
      case "contains":
        return lower(v).includes(lower(c.value));
      case "starts_with":
        return lower(v).startsWith(lower(c.value));
      case "in":
        return (c.value as string[]).map(lower).includes(lower(v));
      case "gt":
        return D(v) !== null && D(v)!.gt(D(c.value)!);
      case "gte":
        return D(v) !== null && D(v)!.gte(D(c.value)!);
      case "lt":
        return D(v) !== null && D(v)!.lt(D(c.value)!);
      case "lte":
        return D(v) !== null && D(v)!.lte(D(c.value)!);
      case "before":
        return present(v) && ms(v) < ms(c.value);
      case "after":
        return present(v) && ms(v) > ms(c.value);
    }
  };
  const byMaster = new Map<string, RecordData[]>();
  for (const p of profiles) {
    const k = text(p.masterId) || "source:" + p.id;
    byMaster.set(k, [...(byMaster.get(k) || []), p]);
  }
  let n = 0;
  for (const recs of byMaster.values()) {
    const ok =
      d.match === "all"
        ? d.conditions.every((c) => recs.some((p) => test(p, c)))
        : d.conditions.some((c) => recs.some((p) => test(p, c)));
    if (ok) n++;
  }
  return {
    count: n,
    basis:
      "Distinct master IDs (unlinked source records counted individually) in the active local snapshot whose linked records satisfy the conditions. Not a native Unity segment count.",
  };
}
