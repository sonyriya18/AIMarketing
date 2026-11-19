// Oracle Infinity website performance and time spent. Two separate evidence paths that are never
// added together: event-level sessions (time measured between hits) and saved page reports
// (sums of the report's own counters). Time on the last page of a session cannot be measured
// from hits, so it is reported as unmeasured rather than zero.
import Decimal from "decimal.js";
import type { RecordData } from "../../shared/catalog";
import {
  Assessment,
  D,
  fmt,
  ms,
  present,
  rate,
  text,
  twoProportion,
  type RuleDef,
} from "./common";
import { median } from "./eloqua-revenue";
import { dayLabel, dayRange } from "./layout";
import type { MetricDefinition } from "./types";

const rule = (r: Omit<RuleDef, "version">): RuleDef => ({
  version: "v1",
  ...r,
});
export const WEB_RULES: Record<string, RuleDef> = {
  web_high_bounce: rule({
    title: "Landing page loses most visitors on arrival",
    description:
      "Among sessions that started on this page (at least the minimum cohort), the single-page (bounce) share is at or above the approved threshold.",
    severity: "high",
    ownerRole: "Digital experience owner",
    effort: "M (page and traffic-source review; basis: one page)",
    automation: "B",
    targetMetric: "web_single_page_rate",
    nextChecks: [
      "Check that the page matches the promise of the email, ad or search result that sends visitors to it.",
      "Make the main call to action visible without scrolling, especially on mobile.",
      "Compare this page's bounce by device and channel (Compare Cohorts).",
    ],
    dataNeeded: ["Events with session IDs, page and timestamps"],
    measurement:
      "Single-page share of sessions starting on this page in the next snapshot.",
  }),
  web_low_time: rule({
    title: "Visitors leave this page within seconds",
    description:
      "Average measured time on page is below the approved number of seconds for a page with at least the minimum cohort of timed views.",
    severity: "medium",
    ownerRole: "Content owner",
    effort: "M (content review; basis: one page)",
    automation: "B",
    targetMetric: "web_avg_time_on_page_seconds",
    nextChecks: [
      "Check the page loads quickly and its first screen answers why the visitor came.",
      "Confirm the page is tracked correctly (a missing next hit makes time unmeasurable, not short).",
    ],
    dataNeeded: ["Events or page report with measured time on page"],
    measurement: "Average time on page for this page in the next snapshot.",
  }),
  web_high_exit: rule({
    title: "Many journeys end on this page",
    description:
      "Exits / page views is at or above the approved threshold on a page that is not where conversions happen.",
    severity: "medium",
    ownerRole: "Digital experience owner",
    effort: "S (next-step links and related content; basis: one page)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Add a clear next step: related products, a form, or a contact option.",
      "Check for broken links or errors on the page.",
    ],
    dataNeeded: ["Events with session IDs, or a page report with exits"],
    measurement: "Exit rate for this page in the next snapshot.",
  }),
  web_device_gap: rule({
    title: "One device type bounces much more than the others",
    description:
      "The single-page share of one device type differs from all other devices by at least 10 percentage points and a two-proportion test gives p < 0.05.",
    severity: "medium",
    ownerRole: "Digital experience owner",
    effort: "M (device-specific UX review)",
    automation: "B",
    targetMetric: "web_single_page_rate",
    nextChecks: [
      "Test the top landing pages on that device type for layout and speed.",
      "Check whether traffic sources differ by device (the gap may come from the audience, not the page).",
    ],
    dataNeeded: ["Events with device and session IDs"],
    measurement: "Single-page share by device in the next snapshot.",
  }),
  web_engaged_no_convert: rule({
    title: "Visitors spend time here but rarely convert",
    description:
      "Average time on page is at least twice the site average, while sessions that viewed the page convert below the site rate.",
    severity: "low",
    ownerRole: "Content / conversion owner",
    effort: "S (call-to-action review; basis: one page)",
    automation: "B",
    targetMetric: "event_conversion_rate",
    nextChecks: [
      "Add or move a call to action near the content visitors spend time on.",
      "Check whether the page answers pricing, availability or next-step questions.",
    ],
    dataNeeded: ["Events with session IDs and a configured conversion event"],
    measurement:
      "Conversion share of sessions viewing this page in the next snapshot.",
  }),
};
const md = (
  id: string,
  label: string,
  grain: string,
  basis: MetricDefinition["basis"],
  numerator: string,
  denominator: string | null,
  timeBasis: string,
  exclusions: string,
  source: string,
): MetricDefinition => ({
  id,
  label,
  grain,
  basis,
  numerator,
  denominator,
  timeBasis,
  exclusions,
  source,
});
export const WEB_METRICS: MetricDefinition[] = [
  md(
    "web_page_views",
    "Page views (events)",
    "page view",
    "total",
    "Page views (consecutive hits on the same page in a session count once)",
    null,
    "Event time in period",
    "Events without session, page or timestamp",
    "event",
  ),
  md(
    "web_pages_per_session",
    "Pages per session",
    "session",
    "derived",
    "Page views",
    "Sessions with a page view",
    "Event time in period",
    "As above",
    "event",
  ),
  md(
    "web_single_page_rate",
    "Single-page sessions (bounce)",
    "session",
    "derived",
    "Sessions with exactly one page view",
    "Sessions with a page view",
    "Event time in period",
    "As above; Infinity's own bounce definition may differ",
    "event",
  ),
  md(
    "web_median_session_seconds",
    "Median time spent per session",
    "session",
    "derived",
    "Median(last hit − first hit)",
    null,
    "Event time in period",
    "Single-hit sessions and sessions with a gap above sessionTimeoutMinutes (unmeasurable)",
    "event",
  ),
  md(
    "web_avg_time_on_page_seconds",
    "Average time on page",
    "page view",
    "derived",
    "Σ seconds to the next page view",
    "Page views followed by another page view",
    "Event time in period",
    "Last page of each session (unmeasurable)",
    "event",
  ),
  md(
    "web_time_measured_share",
    "Page views with measured time",
    "page view",
    "derived",
    "Page views followed by another page view",
    "Page views",
    "Event time in period",
    "None",
    "event",
  ),
  md(
    "web_report_page_views",
    "Page views (saved report)",
    "page view",
    "total",
    "Σ pageViews",
    null,
    "Rows whose period lies inside the selected period",
    "Overlapping rows for the same page and device are withheld",
    "page_metrics",
  ),
  md(
    "web_report_bounce_rate",
    "Bounce rate (saved report)",
    "session",
    "derived",
    "Σ bounces",
    "Σ entries",
    "As above",
    "As above",
    "page_metrics",
  ),
  md(
    "web_report_exit_rate",
    "Exit rate (saved report)",
    "page view",
    "derived",
    "Σ exits",
    "Σ pageViews",
    "As above",
    "As above",
    "page_metrics",
  ),
  md(
    "web_report_avg_time_seconds",
    "Average time on page (saved report)",
    "page view",
    "derived",
    "Σ timeOnPageSeconds",
    "Σ timedPageViews",
    "As above",
    "Rows without timedPageViews",
    "page_metrics",
  ),
];

interface PageStats {
  views: number;
  entries: number;
  exits: number;
  singleEntries: number;
  times: number[];
  sessions: Set<string>;
  converted: Set<string>;
}
const newPage = (): PageStats => ({
  views: 0,
  entries: 0,
  exits: 0,
  singleEntries: 0,
  times: [],
  sessions: new Set(),
  converted: new Set(),
});
const avg = (xs: number[]) =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const secs = (v: number | null) =>
  v === null ? null : new Decimal(v).toDecimalPlaces(1);
const BUCKETS: [string, number][] = [
  ["Under 10 s", 10],
  ["10–30 s", 30],
  ["30 s – 1 min", 60],
  ["1–3 min", 180],
  ["3–10 min", 600],
  ["10 min or more", Infinity],
];

export function assessWeb(a: Assessment) {
  const minCohort = a.policy("minCohort", 30),
    bounceT = a.policy("webBounceThreshold", 60),
    exitT = a.policy("exitRateThreshold", 60),
    lowT = a.policy("lowTimeOnPageSeconds", 10),
    timeout = a.policy("sessionTimeoutMinutes", 30),
    pvEvent = a.policy<string | null>("pageViewEvent", null),
    conv = a.policy<string | null>("conversionEvent", null);
  eventWeb(a, { minCohort, bounceT, exitT, lowT, timeout, pvEvent, conv });
  reportWeb(a, { minCohort, bounceT, exitT, lowT });
}

function eventWeb(
  a: Assessment,
  p: {
    minCohort: number;
    bounceT: number;
    exitT: number;
    lowT: number;
    timeout: number;
    pvEvent: string | null;
    conv: string | null;
  },
) {
  const all = a
    .rows("event")
    .filter(
      (e) =>
        a.inPeriod(e, "timestamp") &&
        present(e.sessionId) &&
        !Number.isNaN(ms(e.timestamp)),
    );
  if (!all.length || !all.some((e) => present(e.page))) return;
  // Duplicate candidates (same session, name, time and page) count once for timing.
  const seen = new Set<string>();
  const hits = all.filter((e) => {
    const k = [e.sessionId, e.event, e.timestamp, e.page].map(text).join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const bySession = new Map<string, RecordData[]>();
  for (const e of hits)
    bySession.set(text(e.sessionId), [
      ...(bySession.get(text(e.sessionId)) || []),
      e,
    ]);
  const pages = new Map<string, PageStats>();
  const page = (k: string) => {
    if (!pages.has(k)) pages.set(k, newPage());
    return pages.get(k)!;
  };
  const durations: number[] = [];
  let unmeasurable = 0,
    gapSessions = 0,
    pageViews = 0,
    timed = 0,
    sessionsWithPages = 0,
    single = 0,
    convertedSessions = 0;
  const allTimes: number[] = [];
  const cohort = new Map<
    string,
    {
      sessions: number;
      single: number;
      durations: number[];
      views: number;
      converted: number;
    }
  >();
  const addCohort = (
    k: string,
    s: {
      single: boolean;
      duration: number | null;
      views: number;
      converted: boolean;
    },
  ) => {
    const c = cohort.get(k) || {
      sessions: 0,
      single: 0,
      durations: [],
      views: 0,
      converted: 0,
    };
    c.sessions++;
    if (s.single) c.single++;
    if (s.duration !== null) c.durations.push(s.duration);
    c.views += s.views;
    if (s.converted) c.converted++;
    cohort.set(k, c);
  };
  for (const [sid, es] of bySession) {
    es.sort(
      (x, y) =>
        ms(x.timestamp) - ms(y.timestamp) ||
        text(x.id).localeCompare(text(y.id)),
    );
    const gap = es.some(
      (e, i) =>
        i > 0 && ms(e.timestamp) - ms(es[i - 1].timestamp) > p.timeout * 60_000,
    );
    if (gap) gapSessions++;
    const converted = !!p.conv && es.some((e) => text(e.event) === p.conv);
    if (converted) convertedSessions++;
    // Page views: page-view events (if configured), else every hit with a page;
    // consecutive hits on the same page form one view.
    const pv: { page: string; start: number }[] = [];
    for (const e of es) {
      if (!present(e.page)) continue;
      if (p.pvEvent && text(e.event) !== p.pvEvent) continue;
      if (!p.pvEvent && pv.length && pv.at(-1)!.page === text(e.page)) continue;
      pv.push({ page: text(e.page), start: ms(e.timestamp) });
    }
    const duration =
      es.length > 1 && !gap
        ? (ms(es.at(-1)!.timestamp) - ms(es[0].timestamp)) / 1000
        : null;
    if (duration === null) unmeasurable++;
    else durations.push(duration);
    const meta = {
      single: pv.length === 1,
      duration,
      views: pv.length,
      converted,
    };
    for (const dim of ["device", "channel"]) {
      const v = es.find((e) => present(e[dim]))?.[dim];
      if (present(v)) addCohort(dim + ":" + text(v), meta);
    }
    if (!pv.length) continue;
    sessionsWithPages++;
    pageViews += pv.length;
    if (pv.length === 1) single++;
    const entry = page(pv[0].page);
    entry.entries++;
    if (pv.length === 1) entry.singleEntries++;
    page(pv.at(-1)!.page).exits++;
    pv.forEach((v, i) => {
      const st = page(v.page);
      st.views++;
      st.sessions.add(sid);
      if (converted) st.converted.add(sid);
      if (i < pv.length - 1 && !gap) {
        const t = (pv[i + 1].start - v.start) / 1000;
        st.times.push(t);
        allTimes.push(t);
        timed++;
      }
    });
  }
  if (!sessionsWithPages) return;
  const sessionsTotal = bySession.size;
  a.metric({
    id: "web_page_views",
    label: "Page views (events)",
    value: pageViews,
    unit: "count",
    formula: p.pvEvent
      ? `Events named "${p.pvEvent}" with a page`
      : "Hits with a page; consecutive hits on the same page in a session count as one view",
    rows: hits,
    grain: "page view",
    basis: "total",
  });
  a.metric({
    id: "web_pages_per_session",
    label: "Pages per session",
    value: new Decimal(pageViews).div(sessionsWithPages),
    unit: "count",
    formula: `${pageViews} page views / ${sessionsWithPages} sessions with a page view`,
    grain: "session",
    basis: "derived",
  });
  const siteSingle = a.metric({
    id: "web_single_page_rate",
    label: "Single-page sessions (bounce)",
    value: rate(single, sessionsWithPages),
    unit: "percent",
    formula: `${single} single-page sessions / ${sessionsWithPages} sessions with a page view`,
    grain: "session",
    basis: "derived",
  });
  a.metric({
    id: "web_median_session_seconds",
    label: "Median time spent per session",
    value: secs(median(durations)),
    unit: "seconds",
    formula: `Median(last hit − first hit) of ${durations.length} measurable sessions; ${unmeasurable} not measurable`,
    reason: durations.length
      ? `${unmeasurable} sessions (single hit or long gap) are not measurable and are left out`
      : "Every session has a single hit, so time cannot be measured",
    state: durations.length && unmeasurable ? "partial" : undefined,
    grain: "session",
    basis: "derived",
  });
  const siteAvg = avg(allTimes);
  a.metric({
    id: "web_avg_time_on_page_seconds",
    label: "Average time on page",
    value: secs(siteAvg),
    unit: "seconds",
    formula: `Σ seconds to the next page view / ${timed} measured page views`,
    reason: timed
      ? `${pageViews - timed} page views were the last of their session and cannot be timed`
      : "No page view is followed by another page view in the same session",
    state: timed && timed < pageViews ? "partial" : undefined,
    grain: "page view",
    basis: "derived",
  });
  a.metric({
    id: "web_time_measured_share",
    label: "Page views with measured time",
    value: rate(timed, pageViews),
    unit: "percent",
    formula: `${timed} / ${pageViews} page views (the last page of a session cannot be timed)`,
    grain: "page view",
    basis: "derived",
  });
  if (gapSessions)
    a.warnings.push(
      `${gapSessions} sessions have a gap longer than ${p.timeout} minutes between hits; their time spent is not measured.`,
    );
  const convPages = new Set(
    hits
      .filter((e) => p.conv && text(e.event) === p.conv && present(e.page))
      .map((e) => text(e.page)),
  );
  const siteConv = p.conv ? rate(convertedSessions, sessionsTotal) : null;
  const rows = [...pages.entries()]
    .sort((x, y) => y[1].views - x[1].views)
    .map(([pg, s]) => {
      const single = rate(s.singleEntries, s.entries);
      const exit = rate(s.exits, s.views);
      const t = avg(s.times);
      const convRate = p.conv ? rate(s.converted.size, s.sessions.size) : null;
      if (s.entries >= p.minCohort && single && single.gte(p.bounceT))
        a.finding({
          rule: "web_high_bounce",
          scope: "page:" + pg,
          title: `Landing page ${pg} loses most visitors on arrival`,
          detail: `${s.singleEntries} of ${s.entries} sessions that started on ${pg} viewed no other page (${fmt(single.toDecimalPlaces(1))}%); the approved threshold is ${p.bounceT}%.`,
          affected: s.entries,
          hypotheses: [
            "The page may not match the message of the link or ad that sent the visitor.",
            "The call to action may be hidden below the fold on small screens.",
          ],
        });
      if (s.times.length >= p.minCohort && t !== null && t < p.lowT)
        a.finding({
          rule: "web_low_time",
          scope: "page:" + pg,
          title: `Visitors leave ${pg} within seconds`,
          detail: `Average measured time on ${pg} is ${t.toFixed(1)} seconds over ${s.times.length} timed views; the approved minimum is ${p.lowT} seconds.`,
          affected: s.views,
        });
      if (
        s.views >= p.minCohort &&
        exit &&
        exit.gte(p.exitT) &&
        !convPages.has(pg)
      )
        a.finding({
          rule: "web_high_exit",
          scope: "page:" + pg,
          title: `Many journeys end on ${pg}`,
          detail: `${s.exits} of ${s.views} views of ${pg} were the last page of the session (${fmt(exit.toDecimalPlaces(1))}%); the approved threshold is ${p.exitT}%.${p.conv ? "" : " No conversion event is configured, so confirm this is not a confirmation page."}`,
          affected: s.exits,
        });
      if (
        siteAvg !== null &&
        siteConv &&
        convRate &&
        s.times.length >= p.minCohort &&
        t !== null &&
        t >= 2 * siteAvg &&
        convRate.lt(siteConv) &&
        !convPages.has(pg)
      )
        a.finding({
          rule: "web_engaged_no_convert",
          scope: "page:" + pg,
          title: `Visitors spend time on ${pg} but rarely convert`,
          detail: `Average time on ${pg} is ${t.toFixed(1)} s (site ${siteAvg.toFixed(1)} s), while ${fmt(convRate.toDecimalPlaces(1))}% of sessions viewing it converted (site ${fmt(siteConv.toDecimalPlaces(1))}%).`,
          affected: s.sessions.size,
          hypotheses: [
            "Visitors may not find a clear next step on this page.",
            "The page may attract research visitors who are not ready to convert.",
          ],
        });
      return {
        key: "page:" + pg,
        page: pg,
        views: s.views,
        entries: s.entries,
        single: fmt(single),
        exit: fmt(exit),
        time: t === null ? null : fmt(secs(t)),
        measured: fmt(rate(s.times.length, s.views)),
        conv: fmt(convRate),
      };
    });
  a.section({
    id: "web-pages",
    kind: "table",
    title: "Website performance by page",
    subtitle:
      "From events. Single-page % uses sessions that started on the page; exit % uses page views; time on page is the time to the next page view (the last page of a session is not timed).",
    columns: [
      { key: "page", label: "Page" },
      { key: "views", label: "Page views", unit: "count" },
      { key: "entries", label: "Entries", unit: "count" },
      { key: "single", label: "Single-page %", unit: "percent" },
      { key: "exit", label: "Exit %", unit: "percent" },
      { key: "time", label: "Avg time on page", unit: "seconds" },
      { key: "measured", label: "Views timed %", unit: "percent" },
      ...(p.conv
        ? [
            {
              key: "conv",
              label: "Sessions converting %",
              unit: "percent" as const,
            },
          ]
        : []),
    ],
    rows,
  });
  a.chart({
    id: "web-time",
    title: "Time spent per session",
    subtitle: `Measurable sessions by duration (last hit − first hit). ${unmeasurable} sessions with a single hit or a long gap are not measurable and are not counted as zero.`,
    chart: {
      type: "bar",
      x: "band",
      unit: "count",
      series: [{ key: "sessions", label: "Sessions" }],
      data: BUCKETS.map(([label, max], i) => ({
        band: label,
        sessions: durations.filter(
          (d) => d < max && (i === 0 || d >= BUCKETS[i - 1][1]),
        ).length,
      })),
    },
  });
  for (const dim of ["device", "channel"]) {
    const entries = [...cohort.entries()].filter(([k]) =>
      k.startsWith(dim + ":"),
    );
    if (!entries.length) continue;
    a.section({
      id: "web-" + dim,
      kind: "table",
      title: `Engagement by ${dim}`,
      subtitle: `Session-level measures by the ${dim} recorded on the session's hits.`,
      columns: [
        { key: "value", label: dim[0].toUpperCase() + dim.slice(1) },
        { key: "sessions", label: "Sessions", unit: "count" },
        { key: "single", label: "Single-page %", unit: "percent" },
        { key: "median", label: "Median time spent", unit: "seconds" },
        { key: "pages", label: "Pages per session", unit: "count" },
        ...(p.conv
          ? [{ key: "conv", label: "Conversion %", unit: "percent" as const }]
          : []),
      ],
      rows: entries.map(([k, c]) => ({
        key: "cohort:" + dim + "=" + k.slice(dim.length + 1),
        value: k.slice(dim.length + 1),
        sessions: c.sessions,
        single: fmt(rate(c.single, c.sessions)),
        median: fmt(secs(median(c.durations))),
        pages: fmt(new Decimal(c.views).div(c.sessions)),
        conv: p.conv ? fmt(rate(c.converted, c.sessions)) : null,
      })),
    });
    if (dim === "device" && entries.length > 1 && siteSingle) {
      // Worst device versus all other devices combined.
      const [worstKey, worst] = entries.reduce((x, y) =>
        x[1].single / x[1].sessions >= y[1].single / y[1].sessions ? x : y,
      );
      const rest = entries.filter(([k]) => k !== worstKey);
      const rs = rest.reduce((s, [, c]) => s + c.sessions, 0),
        rsingle = rest.reduce((s, [, c]) => s + c.single, 0);
      const t = twoProportion(worst.single, worst.sessions, rsingle, rs);
      if (
        t &&
        worst.sessions >= p.minCohort &&
        rs >= p.minCohort &&
        t.diffPp >= 10 &&
        t.pValue < 0.05
      )
        a.finding({
          rule: "web_device_gap",
          scope: "device:" + worstKey.slice(7),
          title: `${worstKey.slice(7)} visitors bounce much more than others`,
          detail: `${fmt(rate(worst.single, worst.sessions)!.toDecimalPlaces(1))}% of ${worst.sessions} ${worstKey.slice(7)} sessions viewed one page, versus ${fmt(rate(rsingle, rs)!.toDecimalPlaces(1))}% on other devices (difference ${t.diffPp.toFixed(1)} pp, p = ${t.pValue.toPrecision(2)}). The test shows a difference, not its cause.`,
          affected: worst.sessions,
          caveats: [
            "Traffic sources can differ by device, so the gap may come from the audience rather than the page.",
          ],
        });
    }
  }
  webEventCharts(a, bySession, rows, cohort, p.conv);
}

function reportWeb(
  a: Assessment,
  p: { minCohort: number; bounceT: number; exitT: number; lowT: number },
) {
  const all = a.rows("page_metrics");
  if (!all.length) return;
  const { periodStart, periodEnd } = a.meta;
  const rows = all.filter(
    (r) =>
      (!periodStart || text(r.periodStart) >= periodStart) &&
      (!periodEnd || text(r.periodEnd) <= periodEnd),
  );
  if (rows.length < all.length)
    a.warnings.push(
      `${all.length - rows.length} page report rows extend beyond the selected period and were excluded; report rows cannot be split by day.`,
    );
  // Overlapping periods for the same page and device would double count.
  const groups = new Map<string, RecordData[]>();
  for (const r of rows) {
    const k = text(r.page) + "|" + text(r.device);
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  const bad = new Set<string>();
  for (const g of groups.values()) {
    const s = [...g].sort((x, y) =>
      text(x.periodStart).localeCompare(text(y.periodStart)),
    );
    for (let i = 1; i < s.length; i++)
      if (text(s[i].periodStart) <= text(s[i - 1].periodEnd))
        bad.add(text(s[i].page));
  }
  if (bad.size)
    a.warnings.push(
      `Overlapping report periods for ${bad.size} page(s); their totals are withheld to avoid double counting.`,
    );
  // Per page: use total rows (no device) when present, else add the device rows.
  const byPage = new Map<string, RecordData[]>();
  for (const r of rows)
    if (!bad.has(text(r.page)))
      byPage.set(text(r.page), [...(byPage.get(text(r.page)) || []), r]);
  const pageRows = new Map<string, RecordData[]>();
  for (const [pg, rs] of byPage) {
    const totals = rs.filter((r) => !present(r.device));
    pageRows.set(pg, totals.length ? totals : rs);
  }
  const used = [...pageRows.values()].flat();
  const S = (rs: RecordData[], k: string) =>
    rs.length && rs.every((r) => D(r[k]) !== null)
      ? rs.reduce((s, r) => s.plus(D(r[k])!), new Decimal(0))
      : null;
  const views = S(used, "pageViews"),
    entries = S(used, "entries"),
    bounces = S(used, "bounces"),
    exits = S(used, "exits"),
    time = S(used, "timeOnPageSeconds"),
    timedViews = S(used, "timedPageViews");
  a.metric({
    id: "web_report_page_views",
    label: "Page views (saved report)",
    value: views,
    unit: "count",
    formula: "Σ pageViews over page rows in the period",
    rows: used,
    reason: "Some page rows have no pageViews",
    grain: "page view",
    basis: "total",
  });
  a.metric({
    id: "web_report_bounce_rate",
    label: "Bounce rate (saved report)",
    value: rate(bounces, entries),
    unit: "percent",
    formula: "Σ bounces / Σ entries (never an average of row percentages)",
    reason: "Page rows need bounces and entries",
    grain: "session",
    basis: "derived",
  });
  a.metric({
    id: "web_report_exit_rate",
    label: "Exit rate (saved report)",
    value: rate(exits, views),
    unit: "percent",
    formula: "Σ exits / Σ pageViews",
    reason: "Page rows need exits and pageViews",
    grain: "page view",
    basis: "derived",
  });
  a.metric({
    id: "web_report_avg_time_seconds",
    label: "Average time on page (saved report)",
    value: time && timedViews && timedViews.gt(0) ? time.div(timedViews) : null,
    unit: "seconds",
    formula: "Σ timeOnPageSeconds / Σ timedPageViews",
    reason: "Page rows need timeOnPageSeconds and timedPageViews",
    grain: "page view",
    basis: "derived",
  });
  const table = [...pageRows.entries()]
    .map(([pg, rs]) => {
      const v = S(rs, "pageViews"),
        en = S(rs, "entries"),
        b = S(rs, "bounces"),
        ex = S(rs, "exits"),
        tm = S(rs, "timeOnPageSeconds"),
        tv = S(rs, "timedPageViews");
      const br = rate(b, en),
        er = rate(ex, v),
        at = tm && tv && tv.gt(0) ? tm.div(tv) : null;
      if (en && en.gte(p.minCohort) && br && br.gte(p.bounceT))
        a.finding({
          rule: "web_high_bounce",
          scope: "report-page:" + pg,
          title: `Landing page ${pg} loses most visitors on arrival`,
          detail: `Saved report: ${b} of ${en} entries to ${pg} bounced (${fmt(br.toDecimalPlaces(1))}%); the approved threshold is ${p.bounceT}%.`,
          rows: rs,
          affected: en.toNumber(),
        });
      if (tv && tv.gte(p.minCohort) && at && at.lt(p.lowT))
        a.finding({
          rule: "web_low_time",
          scope: "report-page:" + pg,
          title: `Visitors leave ${pg} within seconds`,
          detail: `Saved report: average time on ${pg} is ${at.toDecimalPlaces(1)} seconds over ${tv} timed views; the approved minimum is ${p.lowT} seconds.`,
          rows: rs,
          affected: v?.toNumber() || tv.toNumber(),
        });
      if (v && v.gte(p.minCohort) && er && er.gte(p.exitT))
        a.finding({
          rule: "web_high_exit",
          scope: "report-page:" + pg,
          title: `Many journeys end on ${pg}`,
          detail: `Saved report: ${ex} of ${v} views of ${pg} were exits (${fmt(er.toDecimalPlaces(1))}%); the approved threshold is ${p.exitT}%. Confirm it is not a confirmation page.`,
          rows: rs,
          affected: ex!.toNumber(),
        });
      return {
        key: "report-page:" + pg,
        page: pg,
        views: fmt(v),
        entries: fmt(en),
        bounce: fmt(br),
        exit: fmt(er),
        time: fmt(at ? at.toDecimalPlaces(1) : null),
        visitors: rs.length === 1 ? fmt(D(rs[0].visitors)) : null,
      };
    })
    .sort((x, y) => Number(y.views || 0) - Number(x.views || 0));
  a.section({
    id: "web-report-pages",
    kind: "table",
    title: "Website performance by page (saved report)",
    subtitle:
      "Sums of the report's own counters per page. Rates divide sums, never average row percentages. Visitors are shown only for a single row because distinct counts cannot be added.",
    columns: [
      { key: "page", label: "Page" },
      { key: "views", label: "Page views", unit: "count" },
      { key: "entries", label: "Entries", unit: "count" },
      { key: "bounce", label: "Bounce %", unit: "percent" },
      { key: "exit", label: "Exit %", unit: "percent" },
      { key: "time", label: "Avg time on page", unit: "seconds" },
      { key: "visitors", label: "Visitors", unit: "count" },
    ],
    rows: table,
  });
  const devices = new Map<string, RecordData[]>();
  for (const r of rows)
    if (present(r.device) && !bad.has(text(r.page)))
      devices.set(text(r.device), [...(devices.get(text(r.device)) || []), r]);
  if (devices.size)
    a.section({
      id: "web-report-device",
      kind: "table",
      title: "Website performance by device (saved report)",
      columns: [
        { key: "device", label: "Device" },
        { key: "views", label: "Page views", unit: "count" },
        { key: "bounce", label: "Bounce %", unit: "percent" },
        { key: "time", label: "Avg time on page", unit: "seconds" },
      ],
      rows: [...devices.entries()].map(([d, rs]) => {
        const tm = S(rs, "timeOnPageSeconds"),
          tv = S(rs, "timedPageViews");
        return {
          key: "cohort:device=" + d,
          device: d,
          views: fmt(S(rs, "pageViews")),
          bounce: fmt(rate(S(rs, "bounces"), S(rs, "entries"))),
          time: fmt(
            tm && tv && tv.gt(0) ? tm.div(tv).toDecimalPlaces(1) : null,
          ),
        };
      }),
    });
  webReportCharts(a, table, devices, S);
}

/** Charts from the event path: sessions per day, channel mix, page time and bounce, devices. */
function webEventCharts(
  a: Assessment,
  bySession: Map<string, RecordData[]>,
  pageRows: Record<string, unknown>[],
  cohort: Map<string, { sessions: number; single: number; converted: number }>,
  conv: string | null,
) {
  const perDay = new Map<string, { sessions: number; converted: number }>();
  for (const es of bySession.values()) {
    const d = a.day(es[0].timestamp);
    const v = perDay.get(d) || { sessions: 0, converted: 0 };
    v.sessions++;
    if (conv && es.some((e) => text(e.event) === conv)) v.converted++;
    perDay.set(d, v);
  }
  a.chart({
    id: "sessions-trend",
    title: "Sessions per day",
    chart: {
      type: "area",
      x: "day",
      unit: "count",
      series: [
        { key: "sessions", label: "Sessions" },
        ...(conv ? [{ key: "converted", label: "Converted sessions" }] : []),
      ],
      data: dayRange([...perDay.keys()]).map((d) => ({
        day: dayLabel(d),
        sessions: perDay.get(d)?.sessions ?? 0,
        ...(conv ? { converted: perDay.get(d)?.converted ?? 0 } : {}),
      })),
    },
  });
  const channels = [...cohort.entries()].filter(([k]) =>
    k.startsWith("channel:"),
  );
  if (channels.length)
    a.chart({
      id: "channel-donut",
      title: "Sessions by traffic channel",
      chart: {
        type: "donut",
        x: "channel",
        unit: "count",
        series: [{ key: "sessions", label: "Sessions" }],
        data: channels
          .sort((x, y) => y[1].sessions - x[1].sessions)
          .slice(0, 6)
          .map(([k, c]) => ({ channel: k.slice(8), sessions: c.sessions })),
      },
    });
  const busiest = [...pageRows]
    .sort((x, y) => Number(y.views) - Number(x.views))
    .slice(0, 10);
  a.chart({
    id: "page-time",
    title: "Average time on page (busiest pages)",
    chart: {
      type: "hbar",
      x: "page",
      unit: "seconds",
      series: [{ key: "time", label: "Avg time on page" }],
      data: busiest
        .filter((r) => r.time !== null)
        .map((r) => ({ page: String(r.page), time: Number(r.time) })),
    },
  });
  a.chart({
    id: "page-bounce",
    title: "Single-page (bounce) rate by landing page",
    chart: {
      type: "hbar",
      x: "page",
      unit: "percent",
      series: [{ key: "single", label: "Single-page sessions" }],
      data: [...pageRows]
        .filter((r) => Number(r.entries) > 0 && r.single !== null)
        .sort((x, y) => Number(y.entries) - Number(x.entries))
        .slice(0, 10)
        .map((r) => ({ page: String(r.page), single: Number(r.single) })),
    },
  });
  const devices = [...cohort.entries()].filter(([k]) =>
    k.startsWith("device:"),
  );
  if (devices.length > 1)
    a.chart({
      id: "device-chart",
      title: "Bounce and conversion by device",
      chart: {
        type: "grouped",
        x: "device",
        unit: "percent",
        series: [
          { key: "single", label: "Single-page sessions" },
          ...(conv ? [{ key: "conv", label: "Converted sessions" }] : []),
        ],
        data: devices.map(([k, c]) => ({
          device: k.slice(7),
          single: Number(fmt(rate(c.single, c.sessions)!.toDecimalPlaces(1))),
          ...(conv
            ? {
                conv: Number(
                  fmt(rate(c.converted, c.sessions)!.toDecimalPlaces(1)),
                ),
              }
            : {}),
        })),
      },
    });
}

/** Charts from saved page reports: time on page, bounce by page, devices. */
function webReportCharts(
  a: Assessment,
  table: Record<string, unknown>[],
  devices: Map<string, RecordData[]>,
  S: (rs: RecordData[], k: string) => Decimal | null,
) {
  a.chart({
    id: "report-page-time",
    title: "Average time on page (saved report)",
    chart: {
      type: "hbar",
      x: "page",
      unit: "seconds",
      series: [{ key: "time", label: "Avg time on page" }],
      data: table
        .filter((r) => r.time !== null)
        .slice(0, 10)
        .map((r) => ({ page: String(r.page), time: Number(r.time) })),
    },
  });
  a.chart({
    id: "report-page-bounce",
    title: "Bounce rate by page (saved report)",
    chart: {
      type: "hbar",
      x: "page",
      unit: "percent",
      series: [{ key: "bounce", label: "Bounce rate" }],
      data: table
        .filter((r) => r.bounce !== null)
        .slice(0, 10)
        .map((r) => ({
          page: String(r.page),
          bounce: Number(Number(r.bounce).toFixed(1)),
        })),
    },
  });
  if (devices.size > 1)
    a.chart({
      id: "report-device-chart",
      title: "Bounce rate by device (saved report)",
      chart: {
        type: "bar",
        x: "device",
        unit: "percent",
        series: [{ key: "bounce", label: "Bounce rate" }],
        data: [...devices.entries()].map(([d, rs]) => {
          const b = rate(S(rs, "bounces"), S(rs, "entries"));
          return {
            device: d,
            bounce: b === null ? null : Number(b.toDecimalPlaces(1)),
          };
        }),
      },
    });
}

export function webCapability(a: Assessment) {
  const events = a.rows("event"),
    report = a.rows("page_metrics");
  a.capability(
    "web",
    "Website performance and time spent",
    report.length || events.some((e) => present(e.page) && present(e.sessionId))
      ? report.some((r) => present(r.timeOnPageSeconds)) || events.length > 0
        ? true
        : "partial"
      : false,
    "Events with session ID, page and timestamp, or a saved page report with page views, entries, exits, bounces and time on page.",
  );
}
