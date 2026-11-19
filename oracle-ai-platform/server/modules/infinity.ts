// Oracle Infinity module. Two data modes that are never mixed into one total:
//  - report mode: saved-report rows plus a manifest (aggregates; no paths can be built from them)
//  - event mode: timestamped events (ordered journeys, tracking quality, volume history)
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
  sum,
  text,
  twoProportion,
  type AssessmentMeta,
  type RuleDef,
} from "./common";
import type {
  CompareResult,
  MetricDefinition,
  ModuleDefinition,
  ScenarioResult,
} from "./types";
import {
  WEB_METRICS,
  WEB_RULES,
  assessWeb,
  webCapability,
} from "./infinity-web";
import type { ModuleLayout } from "./layout";

const VERSION = "infinity-assessment-2026-11-02.1";
const rule = (r: Omit<RuleDef, "version">): RuleDef => ({
  version: "v1",
  ...r,
});
export const INFINITY_LAYOUT: ModuleLayout = {
  groups: ["Website", "Traffic", "Journeys", "Tracking"],
  sections: {
    "sessions-trend": {
      group: "Traffic",
      about:
        "Sessions per day from your event data (and converted sessions when a conversion event is set). Dips can be real behaviour or a tracking gap: check Tracking before acting.",
    },
    "channel-donut": {
      group: "Traffic",
      about: "Share of sessions per traffic channel recorded on the hits.",
    },
    "report-trend": {
      group: "Traffic",
      about:
        "Daily sessions from your saved Infinity report, exactly as the report counted them.",
    },
    "report-cohorts": {
      group: "Traffic",
      about:
        "Sessions and conversion per report dimension (for example device). Rows can overlap, so they are not added up.",
    },
    "event-cohorts": {
      group: "Traffic",
      about:
        "Sessions and conversion by device and channel from event data. A session can appear in more than one row.",
    },
    "web-channel": {
      group: "Traffic",
      about:
        "Engagement per traffic channel: bounce, time spent, pages per session and conversion.",
    },
    "page-time": {
      group: "Website",
      about:
        "Average time visitors spend on your busiest pages, measured as the time to their next page view. Very short times usually mean the page is not what visitors expected.",
    },
    "page-bounce": {
      group: "Website",
      about:
        "Share of sessions that started on the page and viewed nothing else. High bars on landing pages are the first place to improve.",
    },
    "web-time": {
      group: "Website",
      about:
        "How long sessions last. Sessions with one hit cannot be timed and are left out instead of counted as zero.",
    },
    "device-chart": {
      group: "Website",
      about:
        "Bounce and conversion by device. A device that bounces much more usually needs a layout or speed fix.",
    },
    "web-pages": {
      group: "Website",
      about:
        "Every page with views, entries, bounce, exit rate, average time and conversion of sessions that saw it.",
    },
    "web-device": {
      group: "Website",
      about:
        "Engagement per device: bounce, time spent, pages per session and conversion.",
    },
    "report-page-time": {
      group: "Website",
      about:
        "Average time on page from your saved page report (total time divided by timed views).",
    },
    "report-page-bounce": {
      group: "Website",
      about:
        "Bounce rate per page from your saved page report (bounces divided by entries).",
    },
    "report-device-chart": {
      group: "Website",
      about: "Bounce rate per device from your saved page report.",
    },
    "web-report-pages": {
      group: "Website",
      about:
        "Your saved page report per page. Rates divide sums; visitor counts are never added across rows.",
    },
    "web-report-device": {
      group: "Website",
      about: "Your saved page report per device.",
    },
    funnel: {
      group: "Journeys",
      about:
        "How many sessions (or visitors) reached each step in order within the time window. The largest drop is where to look first.",
    },
    tracking: {
      group: "Tracking",
      about:
        "Each expected event and whether it carries the attributes your tracking specification requires.",
    },
    daily: {
      group: "Tracking",
      about:
        "Events per complete day. Sudden drops are checked for anomalies before being read as behaviour.",
    },
  },
  rules: {
    journey_drop: "Journeys",
    tracking_missing_attributes: "Tracking",
    tracking_unknown_event: "Tracking",
    tracking_duplicates: "Tracking",
    late_events: "Tracking",
    volume_anomaly: "Tracking",
    report_partial: "Traffic",
    web_high_bounce: "Website",
    web_low_time: "Website",
    web_high_exit: "Website",
    web_device_gap: "Website",
    web_engaged_no_convert: "Website",
  },
  capabilities: {
    report: "Traffic",
    events: "Traffic",
    journey: "Journeys",
    conversion: "Journeys",
    revenue: "Journeys",
    tracking: "Tracking",
    anomaly: "Tracking",
    web: "Website",
  },
};
const BASE_RULES: Record<string, RuleDef> = {
  journey_drop: rule({
    title: "Investigate the largest measured drop-off",
    description:
      "Among entities that reached the previous configured step, the share not reaching the next step within the window is at or above the approved threshold.",
    severity: "high",
    ownerRole: "Digital experience owner",
    effort: "M (step review and tracking check; basis: one step)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Confirm both steps are tracked on every relevant page (Tracking quality).",
      "Compare the drop-off by device and channel (Compare Cohorts).",
      "Review recent releases that touched this step.",
    ],
    dataNeeded: [
      "Events with session/visitor IDs and timestamps",
      "Tracking specification for both steps",
    ],
    measurement:
      "Step progression in the next event snapshot with the same steps and window.",
  }),
  tracking_missing_attributes: rule({
    title: "Repair events missing required attributes",
    description:
      "Events in the tracking specification lack attributes the specification requires.",
    severity: "medium",
    ownerRole: "Tag / analytics engineer",
    effort: "S–M (tag fix; basis: one event)",
    automation: "B",
    targetMetric: "tracking_issues",
    nextChecks: [
      "Check the tag for this event on the affected pages.",
      "Validate in a test session after the fix.",
    ],
    dataNeeded: ["Tracking specification with required attributes"],
    measurement: "Missing-attribute count for this event in the next snapshot.",
  }),
  tracking_unknown_event: rule({
    title: "Review events not in the tracking specification",
    description:
      "Event names appear that the tracking specification does not define.",
    severity: "low",
    ownerRole: "Tag / analytics engineer",
    effort: "S",
    automation: "B",
    targetMetric: "tracking_issues",
    nextChecks: ["Add the event to the specification or remove the tag."],
    dataNeeded: ["Tracking specification"],
    measurement: "Unknown event names in the next snapshot.",
  }),
  tracking_duplicates: rule({
    title: "Review duplicate-event candidates",
    description:
      "Events share session, name and timestamp but have different IDs. These are candidates, not confirmed duplicates.",
    severity: "low",
    ownerRole: "Tag / analytics engineer",
    effort: "S",
    automation: "B",
    targetMetric: "duplicate_event_candidates",
    nextChecks: ["Check for a tag firing twice on the page."],
    dataNeeded: [],
    measurement: "Candidate count in the next snapshot.",
  }),
  late_events: rule({
    title: "Late-arriving events",
    description:
      "Events were received later than the approved lateness threshold after they occurred; recent periods may still change.",
    severity: "info",
    ownerRole: "Analyst",
    effort: "None (account for maturity)",
    automation: "A",
    targetMetric: null,
    nextChecks: ["Treat the most recent period as incomplete when comparing."],
    dataNeeded: ["receivedAt on events"],
    measurement: "Late-event share in the next snapshot.",
  }),
  volume_anomaly: rule({
    title: "Unusual daily event volume",
    description:
      "The last complete day's event volume differs from the trailing history by at least the approved z-score. This can reflect real behavior or a tracking change.",
    severity: "medium",
    ownerRole: "Analyst",
    effort: "S (check releases and tracking first)",
    automation: "A",
    targetMetric: "daily_events",
    nextChecks: [
      "Check tracking quality and releases for that day before reading it as a behavior change.",
    ],
    dataNeeded: ["At least the approved minimum days of comparable history"],
    measurement:
      "Volume returns within the trailing range, or the cause is documented.",
  }),
  report_partial: rule({
    title: "Saved report is sampled or truncated",
    description:
      "The report manifest says the export was sampled or truncated; totals are partial.",
    severity: "medium",
    ownerRole: "Analyst",
    effort: "S (narrow the report scope)",
    automation: "A",
    targetMetric: null,
    nextChecks: ["Re-export with a narrower date range or fewer dimensions."],
    dataNeeded: ["Unsampled, untruncated report export"],
    measurement: "Manifest no longer reports sampling or truncation.",
  }),
};
export const INFINITY_RULES: Record<string, RuleDef> = {
  ...BASE_RULES,
  ...WEB_RULES,
};
const md = (
  id: string,
  label: string,
  grain: string,
  basis: MetricDefinition["basis"],
  numerator: string,
  denominator: string | null,
  exclusions: string,
  source: string,
): MetricDefinition => ({
  id,
  label,
  grain,
  basis,
  numerator,
  denominator,
  timeBasis:
    "Event time (event mode) or report date (report mode), source timezone",
  exclusions,
  source,
});
export const INFINITY_METRICS: MetricDefinition[] = [
  md(
    "report_sessions",
    "Sessions (saved report)",
    "session",
    "total",
    "Σ sessions over total rows, or over rows only when declared disjoint",
    null,
    "Total/subtotal rows are never added to their underlying rows",
    "report_row",
  ),
  md(
    "report_visitors",
    "Distinct visitors (saved report)",
    "visitor",
    "unique",
    "Visitors from one total row covering the whole period",
    null,
    "Never summed across rows or days",
    "report_row",
  ),
  md(
    "report_conversion_rate",
    "Session conversion rate (saved report)",
    "session",
    "derived",
    "Σ convertedSessions",
    "Σ sessions (same rows)",
    "Same as sessions",
    "report_row",
  ),
  md(
    "event_sessions",
    "Sessions (events)",
    "session",
    "unique",
    "Distinct sessionId",
    null,
    "Events without sessionId",
    "event",
  ),
  md(
    "converted_sessions",
    "Converted sessions (events)",
    "session",
    "unique",
    "Distinct sessions with ≥1 conversion event",
    null,
    "Multiple conversion events in one session count once",
    "event",
  ),
  md(
    "event_conversion_rate",
    "Session conversion rate (events)",
    "session",
    "derived",
    "Converted sessions",
    "Event sessions",
    "Same",
    "event",
  ),
  md(
    "tracking_issues",
    "Tracking issues",
    "event",
    "total",
    "Events missing required attributes + events not in the specification",
    null,
    "Requires a tracking specification",
    "event + tracking_spec",
  ),
  md(
    "daily_events",
    "Last complete day's events vs history",
    "day",
    "derived",
    "Events on the last complete day",
    "Trailing mean (z-score)",
    "Insufficient history ⇒ unavailable",
    "event",
  ),
  ...WEB_METRICS,
];

/** Ordered funnel: counts entities whose events contain the steps in order within the window. */
export function funnel(
  events: RecordData[],
  steps: string[],
  windowMinutes: number,
  identity: "session" | "visitor",
) {
  const key = identity === "visitor" ? "visitorId" : "sessionId";
  const groups = new Map<string, RecordData[]>();
  for (const e of events)
    if (present(e[key]) && present(e.timestamp))
      groups.set(text(e[key]), [...(groups.get(text(e[key])) || []), e]);
  const reached = steps.map(() => 0);
  for (const es of groups.values()) {
    es.sort(
      (a, b) =>
        ms(a.timestamp) - ms(b.timestamp) ||
        text(a.id).localeCompare(text(b.id)),
    );
    // Earliest start that reaches the most steps (repeated first-step events can restart the window).
    let best = 0;
    for (let s = 0; s < es.length; s++) {
      if (text(es[s].event) !== steps[0]) continue;
      const start = ms(es[s].timestamp);
      let next = 1;
      for (let i = s + 1; i < es.length && next < steps.length; i++) {
        if (ms(es[i].timestamp) - start > windowMinutes * 60_000) break;
        if (text(es[i].event) === steps[next]) next++;
      }
      best = Math.max(best, next);
      if (best === steps.length) break;
    }
    for (let i = 0; i < best; i++) reached[i]++;
  }
  return { reached, entities: groups.size };
}

function reportMode(a: Assessment) {
  const manifests = a.rows("report_manifest");
  const rows = a
    .rows("report_row")
    .filter((r) => !present(r.date) || a.inPeriod(r, "date"));
  if (!rows.length) {
    a.metric({
      id: "report_sessions",
      label: "Sessions (saved report)",
      value: null,
      unit: "count",
      formula: "Σ sessions from report rows",
      reason: "Upload saved-report rows with a report manifest",
    });
    return;
  }
  const totals = rows.filter((r) => bool(r.isTotal)),
    detail = rows.filter((r) => !bool(r.isTotal));
  const disjoint =
    manifests.length > 0 && manifests.every((m) => bool(m.rowsDisjoint));
  const partial = manifests.some((m) => bool(m.sampled) || bool(m.truncated));
  for (const m of manifests.filter((m) => bool(m.sampled) || bool(m.truncated)))
    a.finding({
      rule: "report_partial",
      entity: m,
      detail: `${text(m.name) || m.id} is ${[bool(m.sampled) && "sampled", bool(m.truncated) && "truncated"].filter(Boolean).join(" and ")}; totals are partial.`,
    });
  if (!manifests.length)
    a.warnings.push(
      "No report manifest supplied: dates, sampling and row semantics are unknown, so row totals are withheld unless a total row is present.",
    );
  // Total rows dated per day can be added across days (sessions are additive across disjoint days).
  const totalDays = totals.filter((r) => present(r.date));
  const basis = totalDays.length
    ? totalDays
    : totals.length === 1
      ? totals
      : disjoint
        ? detail
        : [];
  const sessions = basis.length ? sum(basis, "sessions") : null,
    converted = basis.length ? sum(basis, "convertedSessions") : null;
  const why = basis.length
    ? "Rows lack sessions"
    : "Rows may overlap: provide a total row or a manifest that declares rowsDisjoint";
  a.metric({
    id: "report_sessions",
    label: "Sessions (saved report)",
    value: sessions,
    unit: "count",
    formula: totalDays.length
      ? "Σ sessions over dated total rows"
      : totals.length === 1
        ? "Sessions on the single total row"
        : "Σ sessions over rows declared disjoint",
    rows: basis,
    reason: why,
    state: partial ? "partial" : "observed",
    grain: "session",
    basis: "total",
  });
  a.metric({
    id: "report_conversion_rate",
    label: "Session conversion rate (saved report)",
    value:
      sessions && converted && converted.lte(sessions)
        ? rate(converted, sessions)
        : null,
    unit: "percent",
    formula: "Σ convertedSessions / Σ sessions × 100 over the same rows",
    rows: basis,
    reason: "Needs comparable sessions and convertedSessions",
    state: partial ? "partial" : "observed",
    grain: "session",
    basis: "derived",
  });
  const periodTotal = totals.filter((r) => !present(r.date));
  a.metric({
    id: "report_visitors",
    label: "Distinct visitors (saved report)",
    value: periodTotal.length === 1 ? D(periodTotal[0].visitors) : null,
    unit: "count",
    formula: "Visitors on one undated total row covering the report period",
    rows: periodTotal,
    reason:
      "Distinct visitors are never summed across rows or days; supply an undated total row",
    grain: "visitor",
    basis: "unique",
  });
  // Cohort table (dimension rows)
  const cohorts = detail.filter((r) => present(r.dimensionValue));
  const groups = new Map<string, RecordData[]>();
  for (const r of cohorts)
    groups.set(text(r.dimension) + "=" + text(r.dimensionValue), [
      ...(groups.get(text(r.dimension) + "=" + text(r.dimensionValue)) || []),
      r,
    ]);
  if (groups.size)
    a.section({
      id: "report-cohorts",
      kind: "table",
      title: "Report cohorts",
      subtitle:
        "Each cohort's rate uses its own rows. Cohorts are not added together unless the manifest declares rows disjoint.",
      columns: [
        { key: "cohort", label: "Cohort" },
        { key: "sessions", label: "Sessions", unit: "count" },
        { key: "converted", label: "Converted sessions", unit: "count" },
        { key: "rate", label: "Conversion %", unit: "percent" },
      ],
      rows: [...groups.entries()].map(([k, rr]) => ({
        key: "cohort:" + k,
        cohort: k.replace("=", ": "),
        sessions: fmt(sum(rr, "sessions")),
        converted: fmt(sum(rr, "convertedSessions")),
        rate: fmt(rate(sum(rr, "convertedSessions"), sum(rr, "sessions"))),
      })),
    });
  const byDay = new Map<string, RecordData[]>();
  for (const r of totalDays.length ? totalDays : disjoint ? detail : [])
    if (present(r.date))
      byDay.set(text(r.date), [...(byDay.get(text(r.date)) || []), r]);
  if (byDay.size > 1)
    a.section({
      id: "report-trend",
      kind: "bars",
      title: "Sessions by day (saved report)",
      unit: "count",
      bars: [...byDay.entries()].sort().map(([d, rr]) => ({
        label: d,
        value: sum(rr, "sessions")?.toNumber() ?? null,
      })),
      note: "The latest day can be incomplete when the report includes the current day.",
    });
}

function eventMode(a: Assessment) {
  const policyConv = a.policy<string | null>("conversionEvent", null);
  const lateMin = a.policy("lateMinutes", 60),
    minHist = a.policy("minHistoryDays", 14),
    zT = a.policy("anomalyZ", 3),
    dropT = a.policy("dropThreshold", 30),
    minCohort = a.policy("minCohort", 30);
  const all = a.rows("event"),
    events = all.filter((e) => a.inPeriod(e, "timestamp"));
  const spec = a.rows("tracking_spec");
  if (!events.length) {
    a.metric({
      id: "event_sessions",
      label: "Sessions (events)",
      value: null,
      unit: "count",
      formula: "Distinct sessionId",
      reason: "Upload event records",
    });
    return;
  }
  const sessions = new Set(
    events.filter((e) => present(e.sessionId)).map((e) => text(e.sessionId)),
  );
  a.metric({
    id: "event_sessions",
    label: "Sessions (events)",
    value: sessions.size,
    unit: "count",
    formula: "Distinct sessionId among events in period",
    rows: events,
    grain: "session",
    basis: "unique",
  });
  const visitors = new Set(
    events.filter((e) => present(e.visitorId)).map((e) => text(e.visitorId)),
  );
  a.metric({
    id: "event_visitors",
    label: "Visitors (events)",
    value: visitors.size ? visitors.size : null,
    unit: "count",
    formula: "Distinct visitorId among events in period",
    reason: "Events do not carry visitorId",
    grain: "visitor",
    basis: "unique",
  });
  if (policyConv) {
    const conv = events.filter((e) => text(e.event) === policyConv);
    const converted = new Set(
      conv.filter((e) => present(e.sessionId)).map((e) => text(e.sessionId)),
    );
    a.metric({
      id: "conversion_events",
      label: `Conversion events (${policyConv})`,
      value: conv.length,
      unit: "count",
      formula: `Count of ${policyConv} events`,
      rows: conv,
      grain: "event",
      basis: "total",
    });
    a.metric({
      id: "converted_sessions",
      label: "Converted sessions (events)",
      value: converted.size,
      unit: "count",
      formula: `Distinct sessions with ≥1 ${policyConv} event (several events in one session count once)`,
      rows: conv,
      grain: "session",
      basis: "unique",
    });
    a.metric({
      id: "event_conversion_rate",
      label: "Session conversion rate (events)",
      value: rate(converted.size, sessions.size),
      unit: "percent",
      formula: "Converted sessions / event sessions × 100",
      grain: "session",
      basis: "derived",
    });
  } else
    a.metric({
      id: "event_conversion_rate",
      label: "Session conversion rate (events)",
      value: null,
      unit: "percent",
      formula: "Converted sessions / sessions × 100",
      reason:
        "An administrator must name the conversion event (conversionEvent) in the source policy",
    });
  // Journey
  const opt = a.meta.options || {};
  const steps =
    (Array.isArray(opt.steps)
      ? opt.steps.map(String)
      : (a.source.policy.funnelSteps as string[] | undefined)) || [];
  const windowMin = Number(
    opt.windowMinutes ?? a.source.policy.funnelWindowMinutes ?? 30,
  );
  const identity = (opt.identity ??
    a.source.policy.funnelIdentity ??
    "session") as "session" | "visitor";
  a.thresholds.funnelWindowMinutes = windowMin;
  a.thresholds.funnelIdentity = identity;
  if (steps.length >= 2) {
    if (identity === "visitor" && events.some((e) => !present(e.visitorId)))
      a.warnings.push(
        "Some events lack visitorId; they are excluded from the cross-session journey.",
      );
    const { reached, entities } = funnel(events, steps, windowMin, identity);
    steps.forEach((s, i) =>
      a.metric({
        id: "step_" + i,
        label: `Step ${i + 1}: ${s}`,
        value: reached[i],
        unit: "count",
        formula: `${identity === "visitor" ? "Visitors" : "Sessions"} reaching this step in order within ${windowMin} minutes of step 1`,
        grain: identity,
        basis: "unique",
      }),
    );
    let worst: { i: number; drop: Decimal } | null = null;
    for (let i = 1; i < steps.length; i++) {
      const drop = reached[i - 1]
        ? new Decimal(reached[i - 1] - reached[i]).div(reached[i - 1]).mul(100)
        : null;
      a.metric({
        id: "drop_" + i,
        label: `Drop-off before ${steps[i]}`,
        value: drop,
        unit: "percent",
        formula:
          "(previous-step entities − this-step entities) / previous-step entities × 100",
        reason: "No entity reached the previous step",
      });
      if (
        drop &&
        reached[i - 1] >= minCohort &&
        (!worst || drop.gt(worst.drop))
      )
        worst = { i, drop };
    }
    if (worst && worst.drop.gte(dropT))
      a.finding({
        rule: "journey_drop",
        scope: "journey:" + steps.join(">"),
        detail: `${worst.drop.toDecimalPlaces(2)}% of ${identity}s reaching “${steps[worst.i - 1]}” did not reach “${steps[worst.i]}” within ${windowMin} minutes (${reached[worst.i - 1] - reached[worst.i]} of ${reached[worst.i - 1]}).`,
        evidence: ["drop_" + worst.i],
        affected: reached[worst.i - 1] - reached[worst.i],
        hypotheses: [
          "The step's page has a usability or performance problem.",
          "The second step is not tracked on every path (tracking gap).",
          "Users complete the step in another session or channel.",
        ],
      });
    a.section({
      id: "funnel",
      kind: "funnel",
      title: "Ordered journey",
      subtitle: `${identity === "visitor" ? "Cross-session (visitor)" : "Same-session"} progression, ${windowMin}-minute window from step 1, ${entities} ${identity}s observed. Built from timestamped events only.`,
      bars: steps.map((s, i) => ({
        label: s,
        value: reached[i],
        note: i
          ? `${fmt(reached[i - 1] ? new Decimal(reached[i]).div(reached[i - 1]).mul(100) : null) ?? "—"}% of previous`
          : undefined,
      })),
    });
  } else
    a.warnings.push(
      "Journey analysis needs at least two configured steps (Analyze Journey or the source policy).",
    );
  // Tracking quality
  const missingCore = events.filter((e) => !present(e.sessionId));
  if (missingCore.length)
    a.warnings.push(
      `${missingCore.length} events have no sessionId and are excluded from session measures.`,
    );
  const dupKey = new Map<string, RecordData[]>();
  for (const e of events)
    if (present(e.sessionId)) {
      const k =
        text(e.sessionId) + "|" + text(e.event) + "|" + text(e.timestamp);
      dupKey.set(k, [...(dupKey.get(k) || []), e]);
    }
  const dups = [...dupKey.values()].filter((g) => g.length > 1);
  a.metric({
    id: "duplicate_event_candidates",
    label: "Duplicate-event candidates",
    value: dups.length,
    unit: "count",
    formula:
      "Groups of events with the same session, name and timestamp but different IDs",
    rows: dups.flat(),
    grain: "event group",
    basis: "unique",
  });
  if (dups.length)
    a.finding({
      rule: "tracking_duplicates",
      scope: "duplicates",
      detail: `${dups.length} groups of events share session, name and timestamp.`,
      rows: dups.flat(),
      affected: dups.length,
    });
  const late = events.filter(
    (e) =>
      present(e.receivedAt) &&
      ms(e.receivedAt) - ms(e.timestamp) > lateMin * 60_000,
  );
  if (events.some((e) => present(e.receivedAt))) {
    a.metric({
      id: "late_events",
      label: `Events received over ${lateMin} min late`,
      value: late.length,
      unit: "count",
      formula:
        "receivedAt − timestamp > lateMinutes (event time is used for all measures)",
      rows: late,
      grain: "event",
      basis: "total",
    });
    if (late.length)
      a.finding({
        rule: "late_events",
        scope: "late",
        detail: `${late.length} events arrived more than ${lateMin} minutes after they occurred.`,
        affected: late.length,
      });
  } else
    a.warnings.push(
      "Events have no receivedAt, so late arrival cannot be measured.",
    );
  if (spec.length) {
    const specBy = new Map(spec.map((s) => [s.id, list(s.requiredAttributes)]));
    const unknown = events.filter((e) => !specBy.has(text(e.event)));
    const missingAttr = new Map<string, RecordData[]>();
    for (const e of events)
      for (const attr of specBy.get(text(e.event)) || [])
        if (!present(e[attr]))
          missingAttr.set(text(e.event) + "." + attr, [
            ...(missingAttr.get(text(e.event) + "." + attr) || []),
            e,
          ]);
    const issues =
      unknown.length +
      [...missingAttr.values()].reduce((n, g) => n + g.length, 0);
    a.metric({
      id: "tracking_issues",
      label: "Tracking issues",
      value: issues,
      unit: "count",
      formula:
        "Events missing specification-required attributes + events not in the specification",
      grain: "event",
      basis: "total",
    });
    for (const [k, g] of missingAttr)
      a.finding({
        rule: "tracking_missing_attributes",
        scope: "attr:" + k,
        title: `Repair ${k.split(".")[0]}: missing ${k.split(".")[1]}`,
        detail: `${g.length} ${k.split(".")[0]} events lack required attribute ${k.split(".")[1]}.`,
        rows: g,
        evidence: ["tracking_issues"],
        affected: g.length,
      });
    const unknownNames = [...new Set(unknown.map((e) => text(e.event)))];
    if (unknownNames.length)
      a.finding({
        rule: "tracking_unknown_event",
        scope: "unknown-events",
        detail: `Events not in the specification: ${unknownNames.slice(0, 8).join(", ")}${unknownNames.length > 8 ? " …" : ""} (${unknown.length} events).`,
        rows: unknown,
        evidence: ["tracking_issues"],
        affected: unknown.length,
      });
    const expected = [...specBy.keys()].filter(
      (n) => !events.some((e) => text(e.event) === n),
    );
    if (expected.length)
      a.warnings.push(
        `Specified events with no observations in this period: ${expected.join(", ")}. Absence in a sample is not proof the event is broken.`,
      );
    a.section({
      id: "tracking",
      kind: "checklist",
      title: "Tracking quality",
      items: [...specBy.keys()].map((n) => {
        const g = [...missingAttr.entries()].filter(([k]) =>
          k.startsWith(n + "."),
        );
        const seen = events.filter((e) => text(e.event) === n).length;
        return {
          label: n,
          state: g.length ? "issue" : seen ? "ok" : "unavailable",
          detail: g.length
            ? g
                .map(([k, v]) => `${v.length} missing ${k.split(".")[1]}`)
                .join("; ")
            : seen
              ? `${seen} events, all required attributes present`
              : "Not observed in this period",
        };
      }),
    });
  } else
    a.metric({
      id: "tracking_issues",
      label: "Tracking issues",
      value: null,
      unit: "count",
      formula: "Requires a tracking specification",
      reason:
        "Upload a tracking_spec export (expected events and required attributes)",
    });
  // Daily volume and anomaly
  const asOf = Date.parse(a.meta.asOf);
  const counts = new Map<string, number>();
  for (const e of all)
    counts.set(a.day(e.timestamp), (counts.get(a.day(e.timestamp)) || 0) + 1);
  const asOfDay = a.day(new Date(asOf).toISOString());
  const complete = [...counts.keys()].filter((d) => d < asOfDay).sort();
  // Fill missing days with zero only between first and last observed complete days (observed zero).
  const days: string[] = [];
  if (complete.length)
    for (
      let t = Date.parse(complete[0] + "T12:00:00Z");
      t <= Date.parse(complete.at(-1)! + "T12:00:00Z");
      t += 86_400_000
    )
      days.push(new Date(t).toISOString().slice(0, 10));
  const series = days.map((d) => counts.get(d) || 0);
  if (days.length)
    a.section({
      id: "daily",
      kind: "bars",
      title: "Events per complete day",
      unit: "count",
      bars: days.slice(-30).map((d, i, arr) => ({
        label: d,
        value: series[series.length - arr.length + i],
      })),
      note: "The current, incomplete day is excluded. Days inside the observed range with no events show as zero.",
    });
  if (series.length - 1 >= minHist) {
    const hist = series.slice(-1 - minHist, -1),
      last = series.at(-1)!;
    const mean = hist.reduce((s, x) => s + x, 0) / hist.length,
      sd = Math.sqrt(
        hist.reduce((s, x) => s + (x - mean) ** 2, 0) / (hist.length - 1),
      );
    const z = sd ? (last - mean) / sd : 0;
    a.metric({
      id: "daily_events",
      label: `Events on ${days.at(-1)} (z vs prior ${minHist} days)`,
      value: last,
      unit: "count",
      formula: `Last complete day's events; z = (value − trailing mean) / trailing sd = ${z.toFixed(2)}`,
      grain: "day",
      basis: "derived",
    });
    if (Math.abs(z) >= zT)
      a.finding({
        rule: "volume_anomaly",
        scope: "volume:" + days.at(-1),
        detail: `${days.at(-1)}: ${last} events vs a trailing mean of ${mean.toFixed(1)} (z = ${z.toFixed(2)}, threshold ${zT}). Check tracking before reading this as behavior.`,
        caveats: [
          "Day-of-week seasonality is not modeled; compare with the same weekday.",
          "Correlation with a release does not prove cause.",
        ],
      });
  } else
    a.metric({
      id: "daily_events",
      label: "Daily volume anomaly check",
      value: null,
      unit: "count",
      formula: "z-score of last complete day vs trailing history",
      reason: `Insufficient history: ${Math.max(0, series.length - 1)} complete prior day(s), ${minHist} required`,
    });
  // Event cohorts (device / channel)
  const cohortRows: Record<string, unknown>[] = [];
  for (const dim of ["device", "channel"]) {
    const vals = [
      ...new Set(
        events.filter((e) => present(e[dim])).map((e) => text(e[dim])),
      ),
    ];
    for (const v of vals) {
      const ss = new Set(
        events
          .filter((e) => text(e[dim]) === v && present(e.sessionId))
          .map((e) => text(e.sessionId)),
      );
      const cs = policyConv
        ? new Set(
            events
              .filter(
                (e) =>
                  text(e[dim]) === v &&
                  text(e.event) === policyConv &&
                  present(e.sessionId),
              )
              .map((e) => text(e.sessionId)),
          )
        : null;
      cohortRows.push({
        key: `cohort:${dim}=${v}`,
        cohort: `${dim}: ${v}`,
        sessions: ss.size,
        converted: cs ? cs.size : null,
        rate: cs ? fmt(rate(cs.size, ss.size)) : null,
      });
    }
  }
  if (cohortRows.length)
    a.section({
      id: "event-cohorts",
      kind: "table",
      title: "Event cohorts",
      subtitle:
        "A session can appear in more than one cohort (e.g. channel changes mid-session); cohorts are not additive.",
      columns: [
        { key: "cohort", label: "Cohort" },
        { key: "sessions", label: "Sessions", unit: "count" },
        { key: "converted", label: "Converted sessions", unit: "count" },
        { key: "rate", label: "Conversion %", unit: "percent" },
      ],
      rows: cohortRows,
    });
}

function assess(
  source: Source,
  records: RecordData[],
  meta: AssessmentMeta,
): Report {
  const a = new Assessment(
    "infinity",
    source,
    records,
    meta,
    INFINITY_RULES,
    VERSION,
  );
  reportMode(a);
  eventMode(a);
  assessWeb(a);
  webCapability(a);
  const hasReport = a.rows("report_row").length > 0,
    hasEvents = a.rows("event").length > 0;
  if (hasReport && hasEvents)
    a.warnings.push(
      "Saved-report and event data are shown separately and never added together.",
    );
  a.capability(
    "report",
    "Saved-report aggregates",
    hasReport ? (a.rows("report_manifest").length ? true : "partial") : false,
    "Saved-report export rows plus a manifest (dates, timezone, sampling, row semantics).",
  );
  a.capability(
    "events",
    "Event-level analysis",
    hasEvents,
    "Timestamped events with event ID, name, session ID (and visitor ID for cross-session journeys).",
  );
  a.capability(
    "journey",
    "Ordered journeys",
    hasEvents && a.rows("event").some((e) => present(e.sessionId)),
    "Events with session IDs and a configured step sequence and window. Report totals cannot establish a funnel.",
  );
  a.capability(
    "conversion",
    "Event conversion rate",
    hasEvents && !!source.policy.conversionEvent,
    "Name the conversion event in the source policy.",
  );
  a.capability(
    "tracking",
    "Tracking quality",
    a.rows("tracking_spec").length > 0 && hasEvents,
    "Tracking specification (expected events and required attributes).",
  );
  a.capability(
    "anomaly",
    "Volume anomaly detection",
    a.metrics.some((m) => m.id === "daily_events" && m.value !== null),
    "Enough complete days of comparable event history (minHistoryDays).",
  );
  a.capability(
    "revenue",
    "Revenue and checkout analysis",
    false,
    "Transaction events with a verified value definition and currency. Not part of this module's default rules.",
  );
  a.warnings.push(
    "Correlation or before/after movement does not prove why conversion changed.",
  );
  return a.build();
}

function select(all: RecordData[], keys: string[]) {
  if (!keys.length) return all;
  const out: RecordData[] = [];
  for (const k of keys) {
    const m = /^cohort:([^=]+)=(.*)$/.exec(k);
    if (!m) continue;
    const [, dim, val] = m;
    out.push(
      ...all.filter(
        (r) =>
          (r.type === "event" && text(r[dim]) === val) ||
          (r.type === "report_row" &&
            text(r.dimension) === dim &&
            text(r.dimensionValue) === val) ||
          (r.type === "page_metrics" &&
            dim === "device" &&
            text(r.device) === val),
      ),
    );
  }
  const reportIds = new Set(
    out.filter((r) => r.type === "report_row").map((r) => text(r.reportId)),
  );
  return [
    ...new Map(
      [
        ...out,
        ...all.filter(
          (r) =>
            r.type === "tracking_spec" ||
            (r.type === "report_manifest" && reportIds.has(r.id)),
        ),
      ].map((r) => [r.type + ":" + r.id, r]),
    ).values(),
  ];
}

function validateBatch(records: RecordData[]) {
  const errors: { row: number; message: string }[] = [],
    warnings: string[] = [];
  const manifests = new Set(
    records.filter((r) => r.type === "report_manifest").map((r) => r.id),
  );
  records.forEach((r, i) => {
    if (
      r.type === "report_row" &&
      manifests.size &&
      !manifests.has(text(r.reportId))
    )
      errors.push({
        row: i + 1,
        message: `Report ${text(r.reportId)} has no manifest in this batch`,
      });
    if (
      r.type === "report_row" &&
      D(r.convertedSessions) &&
      D(r.sessions) &&
      D(r.convertedSessions)!.gt(D(r.sessions)!)
    )
      errors.push({
        row: i + 1,
        message: "convertedSessions exceeds sessions",
      });
    if (r.type === "page_metrics") {
      if (text(r.periodStart) > text(r.periodEnd))
        errors.push({ row: i + 1, message: "periodStart is after periodEnd" });
      for (const [x, y] of [
        ["exits", "pageViews"],
        ["timedPageViews", "pageViews"],
        ["bounces", "entries"],
        ["entries", "pageViews"],
      ])
        if (D(r[x]) && D(r[y]) && D(r[x])!.gt(D(r[y])!))
          errors.push({ row: i + 1, message: `${x} exceeds ${y}` });
      if (D(r.timeOnPageSeconds)?.lt(0))
        errors.push({ row: i + 1, message: "timeOnPageSeconds is negative" });
    }
    if (r.type === "report_manifest" && text(r.startDate) > text(r.endDate))
      errors.push({ row: i + 1, message: "startDate is after endDate" });
  });
  if (records.some((r) => r.type === "report_row") && !manifests.size)
    warnings.push(
      "Report rows without a manifest: totals will be withheld unless the rows include a total row.",
    );
  return { errors, warnings };
}

function simulate(input: Record<string, unknown>): ScenarioResult {
  const n = (k: string, max?: number, optional = false) => {
    const v = D(input[k]);
    if (v === null && optional) return null;
    if (v === null || v.lt(0) || (max !== undefined && v.gt(max)))
      throw Error(
        `Enter a valid ${k}${max !== undefined ? " from 0 to " + max : ""}`,
      );
    return v;
  };
  const sessions = n("sessions")!,
    base = n("baselineRate", 100)!,
    proposed = n("proposedRate", 100)!,
    value = n("valuePerConversion", undefined, true);
  const currency = String(input.currency || "").toUpperCase();
  if (value && !/^[A-Z]{3}$/.test(currency))
    throw Error("A value basis needs a three-letter currency code");
  const add = sessions.mul(proposed.minus(base)).div(100);
  return {
    kind: "assumption",
    formulaVersion: "infinity-conversion-scenario-v1",
    formula:
      "Projected additional converted sessions = sessions × (assumed rate − baseline rate) / 100; value = that × your entered value per conversion",
    measured: { sessions: fmt(sessions), baselineRate: fmt(base) },
    assumed: {
      proposedRate: fmt(proposed)!,
      ...(value ? { valuePerConversion: fmt(value)!, currency } : {}),
    },
    projected: {
      additionalConvertedSessions: fmt(add),
      hypotheticalValue: value ? fmt(add.mul(value)) : null,
    },
    unit: "sessions",
    currency: value ? currency : undefined,
    note: "Hypothetical. Not an observed result or a forecast; it does not show that any change causes improvement.",
  };
}

function compare(
  source: Source,
  all: RecordData[],
  keys: string[],
  meta: AssessmentMeta,
): CompareResult {
  if (keys.length < 2) throw Error("Choose at least two cohorts");
  const conv = source.policy.conversionEvent as string | undefined;
  const cohorts = keys.map((k) => {
    const m = /^cohort:([^=]+)=(.*)$/.exec(k);
    if (!m) throw Error("Choose cohorts from this snapshot");
    const ev = all.filter(
      (r) =>
        r.type === "event" &&
        text(r[m[1]]) === m[2] &&
        (!meta.periodStart ||
          (r.timestamp &&
            text(r.timestamp).slice(0, 10) >= meta.periodStart)) &&
        (!meta.periodEnd || text(r.timestamp).slice(0, 10) <= meta.periodEnd),
    );
    const rows = all.filter(
      (r) =>
        r.type === "report_row" &&
        !bool(r.isTotal) &&
        text(r.dimension) === m[1] &&
        text(r.dimensionValue) === m[2],
    );
    const sess = new Set(
      ev.filter((e) => present(e.sessionId)).map((e) => text(e.sessionId)),
    );
    const convS = conv
      ? new Set(
          ev
            .filter((e) => text(e.event) === conv && present(e.sessionId))
            .map((e) => text(e.sessionId)),
        )
      : null;
    return {
      key: k,
      label: m[1] + ": " + m[2],
      ev,
      rows,
      sess,
      convS,
      rSessions: sum(rows, "sessions"),
      rConv: sum(rows, "convertedSessions"),
    };
  });
  const caveats: string[] = [];
  const evMode = cohorts.every((c) => c.ev.length),
    rpMode = cohorts.every((c) => c.rows.length);
  if (!evMode && !rpMode)
    throw Error("These cohorts are not all present in the same data mode");
  if (evMode) {
    const seen = new Map<string, number>();
    for (const c of cohorts)
      for (const s of c.sess) seen.set(s, (seen.get(s) || 0) + 1);
    const shared = [...seen.values()].filter((n) => n > 1).length;
    if (shared)
      caveats.push(
        `${shared} sessions appear in more than one cohort; the cohorts overlap.`,
      );
    if (!conv)
      caveats.push(
        "No conversion event configured; conversion is unavailable.",
      );
  }
  if (
    rpMode &&
    new Set(cohorts.flatMap((c) => c.rows.map((r) => text(r.reportId)))).size >
      1
  )
    caveats.push(
      "Rows come from different saved reports; definitions may differ.",
    );
  caveats.push(
    "The current, incomplete period can differ from complete periods.",
  );
  let test: CompareResult["test"] = null;
  const pick = (c: (typeof cohorts)[number]) =>
    evMode
      ? c.convS
        ? [c.convS.size, c.sess.size]
        : null
      : c.rConv && c.rSessions
        ? [c.rConv.toNumber(), c.rSessions.toNumber()]
        : null;
  if (
    cohorts.length === 2 &&
    !caveats.some((x) => x.includes("overlap")) &&
    pick(cohorts[0]) &&
    pick(cohorts[1])
  ) {
    const [x1, n1] = pick(cohorts[0])!,
      [x2, n2] = pick(cohorts[1])!;
    const t = twoProportion(x1, n1, x2, n2)!;
    test = {
      metric: "Session conversion rate",
      method:
        "Two-sided pooled two-proportion z-test on disjoint session cohorts",
      diffPp: Number(t.diffPp.toFixed(3)),
      pValue: Number(t.pValue.toPrecision(3)),
      conclusion:
        t.pValue < 0.05
          ? "The difference is unlikely to be chance alone at the 5% level; it does not explain why."
          : "No difference established: within what chance can produce.",
    };
  }
  return {
    columns: cohorts.map((c) => ({ key: c.key, label: c.label })),
    rows: evMode
      ? [
          {
            metric: "Sessions (events)",
            unit: "count",
            values: cohorts.map((c) => String(c.sess.size)),
          },
          {
            metric: "Converted sessions",
            unit: "count",
            values: cohorts.map((c) => (c.convS ? String(c.convS.size) : null)),
          },
          {
            metric: "Session conversion rate",
            unit: "percent",
            values: cohorts.map((c) =>
              c.convS ? fmt(rate(c.convS.size, c.sess.size)) : null,
            ),
          },
          {
            metric: "Events",
            unit: "count",
            values: cohorts.map((c) => String(c.ev.length)),
          },
        ]
      : [
          {
            metric: "Sessions (saved report)",
            unit: "count",
            values: cohorts.map((c) => fmt(c.rSessions)),
          },
          {
            metric: "Converted sessions",
            unit: "count",
            values: cohorts.map((c) => fmt(c.rConv)),
          },
          {
            metric: "Session conversion rate",
            unit: "percent",
            values: cohorts.map((c) => fmt(rate(c.rConv, c.rSessions))),
          },
        ],
    caveats,
    test,
  };
}

const finding = (r: Report, id?: string) =>
  r.findings.find((f) => f.id === id) || r.findings[0];
export const infinity: ModuleDefinition = {
  app: "infinity",
  definitionVersion: VERSION,
  layout: INFINITY_LAYOUT,
  rules: INFINITY_RULES,
  metricDictionary: INFINITY_METRICS,
  assess,
  select,
  validateBatch,
  scenarioFields: [
    {
      key: "sessions",
      label: "Eligible sessions (measured)",
      unit: "count",
      prefill: "event_sessions",
    },
    {
      key: "baselineRate",
      label: "Baseline session conversion rate (%)",
      unit: "percent",
      prefill: "event_conversion_rate",
    },
    {
      key: "proposedRate",
      label: "Assumed conversion rate after change (%)",
      unit: "percent",
    },
    {
      key: "valuePerConversion",
      label: "Your value per conversion (optional)",
      unit: "money",
      optional: true,
    },
    {
      key: "currency",
      label: "Currency of that value (e.g. USD)",
      unit: "text",
      optional: true,
    },
  ],
  simulate,
  compare,
  compareEntity: "cohort",
  analyzeEntity: "journey",
  draftTypes: [
    {
      id: "journey_investigation",
      label: "Journey investigation brief",
      fields: [
        { key: "dropoff", label: "Measured drop-off", multiline: true },
        {
          key: "evidence",
          label: "Evidence needed to investigate",
          multiline: true,
        },
        {
          key: "hypotheses",
          label: "Hypotheses (not proven)",
          multiline: true,
        },
        { key: "checks", label: "Next checks", multiline: true },
      ],
      prefill: (r, id) => {
        const f = finding(r, id);
        return {
          dropoff: f ? f.detail : "",
          evidence: (INFINITY_RULES.journey_drop.dataNeeded || []).join("\n"),
          hypotheses: (f?.recommendation?.hypotheses || []).join("\n"),
          checks: INFINITY_RULES.journey_drop.nextChecks.join("\n"),
        };
      },
    },
    {
      id: "tracking_repair",
      label: "Tracking repair checklist",
      fields: [
        {
          key: "issues",
          label: "Issues against the event contract",
          multiline: true,
        },
        { key: "fix", label: "Fix steps", multiline: true },
        { key: "verify", label: "Verification" },
      ],
      prefill: (r) => ({
        issues: r.findings
          .filter((f) => f.rule.startsWith("tracking"))
          .map((f) => "• " + f.detail)
          .join("\n"),
        fix: "Update the tag for each event; deploy to a test environment first.",
        verify:
          "Re-run the tracking-quality check on a test-session event export.",
      }),
    },
    {
      id: "experiment_brief",
      label: "Experiment brief",
      fields: [
        { key: "change", label: "Proposed change", multiline: true },
        { key: "hypothesis", label: "Hypothesis" },
        { key: "metric", label: "Primary metric" },
        { key: "guardrails", label: "Guardrails" },
        { key: "audience", label: "Audience" },
        { key: "owner", label: "Implementation owner" },
        { key: "window", label: "Measurement window" },
      ],
      prefill: (r, id) => {
        const f = finding(r, id);
        return {
          change: "",
          hypothesis: f
            ? `Changing the step in “${f.title}” changes progression.`
            : "",
          metric: "Ordered step progression (same steps and window)",
          guardrails: "Overall session conversion rate, tracking-issue count",
          audience: "",
          owner: "",
          window: "At least two full weeks, complete days only",
        };
      },
    },
  ],
};
