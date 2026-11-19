// Eloqua leads, sales pipeline, events and website visits. Each measure keeps its own grain
// (lead, opportunity, registrant, visit). Lead stages come only from the customer's own
// milestone dates; attribution is exactly what the export records on each lead/opportunity.
// Nothing here claims that a campaign, event or page caused revenue.
import Decimal from "decimal.js";
import type { RecordData } from "../../shared/catalog";
import {
  Assessment,
  D,
  bool,
  fmt,
  lower,
  ms,
  present,
  rate,
  text,
  type RuleDef,
} from "./common";
import type { MetricDefinition } from "./types";

const DAY = 86_400_000;
const rule = (r: Omit<RuleDef, "version">): RuleDef => ({
  version: "v1",
  ...r,
});
export const REVENUE_RULES: Record<string, RuleDef> = {
  stalled_mqls: rule({
    title: "Follow up on marketing-qualified leads waiting for sales",
    description:
      "Leads reached MQL but have no sales-accepted, SQL, opportunity or disqualified date after the approved number of days.",
    severity: "high",
    ownerRole: "Sales development lead",
    effort: "S (lead review and routing; basis: one queue)",
    automation: "B",
    targetMetric: "stalled_mqls",
    nextChecks: [
      "Assign each waiting MQL to an owner, or return it to a nurture program with a reason.",
      "Confirm the lead routing rule and sales follow-up SLA for these sources.",
      "Check whether the CRM sync is writing acceptance dates back to Eloqua.",
    ],
    dataNeeded: ["Lead export with mqlAt, salAt, disqualifiedAt and owner"],
    measurement:
      "Count of MQLs waiting longer than the threshold in the next lead export.",
  }),
  low_mql_acceptance: rule({
    title: "Sales accepts few marketing-qualified leads",
    description:
      "Among mature MQLs (older than the lead maturity window), the share that reached sales-accepted is below the approved threshold.",
    severity: "medium",
    ownerRole: "Marketing operations with sales leadership",
    effort: "M (scoring model review; basis: one lead scoring model)",
    automation: "B",
    targetMetric: "mql_to_sal",
    nextChecks: [
      "Compare lead score and rating of accepted versus rejected MQLs by source.",
      "Review the lead scoring model criteria with sales and agree an MQL definition.",
    ],
    dataNeeded: ["Lead export with rating, score, mqlAt and salAt"],
    measurement:
      "MQL-to-SAL share for the next mature cohort of the same sources.",
  }),
  aging_pipeline: rule({
    title: "Review open opportunities older than the approved age",
    description:
      "Open opportunities were created more than the approved number of days before the as-of time.",
    severity: "medium",
    ownerRole: "Sales operations",
    effort: "S (pipeline review)",
    automation: "B",
    targetMetric: "open_pipeline",
    nextChecks: [
      "Ask owners to update stage, close date or close the opportunity.",
      "Check whether these contacts are still receiving relevant nurture content.",
    ],
    dataNeeded: [
      "Opportunity export with createdAt, outcome, stage and amount",
    ],
    measurement:
      "Value and count of aged open opportunities in the next export.",
  }),
  campaign_no_pipeline: rule({
    title: "Campaign leads are not reaching pipeline",
    description:
      "A campaign recorded at least the minimum cohort of mature leads, and none of them has an opportunity date or a linked opportunity.",
    severity: "medium",
    ownerRole: "Campaign manager",
    effort: "M (audience and offer review; basis: one campaign)",
    automation: "B",
    targetMetric: "lead_to_opportunity",
    nextChecks: [
      "Compare the campaign audience with the profile of leads that did convert.",
      "Check that opportunities from this campaign carry its campaign ID in the CRM.",
    ],
    dataNeeded: ["Lead and opportunity exports with campaignId and leadId"],
    measurement: "Opportunities from the campaign's next mature lead cohort.",
  }),
  event_low_attendance: rule({
    title: "Event attendance below the approved rate",
    description:
      "A past event with at least the minimum registrations had an attendance rate (attended / non-cancelled registrations) below the threshold.",
    severity: "medium",
    ownerRole: "Event marketing",
    effort: "S (reminder and follow-up plan; basis: one event)",
    automation: "B",
    targetMetric: "event_attendance_rate",
    nextChecks: [
      "Send the recording and a follow-up to registered non-attendees.",
      "Review reminder timing (for example 1 day and 1 hour before) and calendar invites for the next event.",
    ],
    dataNeeded: ["Event registrant export with attended and cancelled flags"],
    measurement: "Attendance rate of the next comparable event.",
  }),
  website_low_known: rule({
    title: "Most website visitors are anonymous",
    description:
      "The share of website visits linked to a known Eloqua contact is below the approved threshold.",
    severity: "low",
    ownerRole: "Web / marketing operations",
    effort: "M (tracking and form review)",
    automation: "B",
    targetMetric: "web_known_visitor_share",
    nextChecks: [
      "Confirm the Eloqua tracking script and cookie consent run on every page.",
      "Add progressive-profiling forms or gated content on high-traffic pages.",
      "Check that email links carry Eloqua tracking so clickers become known visitors.",
    ],
    dataNeeded: ["Site visit export with visitor and contact IDs"],
    measurement: "Known-visitor share in the next visit export.",
  }),
  landing_short_visits: rule({
    title: "Visits that start on this page end within seconds",
    description:
      "A landing page with at least the minimum timed visits has a median visit duration below the approved number of seconds.",
    severity: "low",
    ownerRole: "Content / web owner",
    effort: "M (page and offer review; basis: one page)",
    automation: "B",
    targetMetric: "web_median_visit_seconds",
    nextChecks: [
      "Check that the page matches the email or ad that sends people to it.",
      "Check page load time and that the main call to action is visible on mobile.",
    ],
    dataNeeded: ["Site visit export with first page URL and duration"],
    measurement:
      "Median visit duration for this landing page in the next export.",
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
const MATURE = "Leads created at least leadMaturityDays before as-of";
export const REVENUE_METRICS: MetricDefinition[] = [
  md(
    "leads_created",
    "Leads created",
    "lead",
    "unique",
    "Count of leads",
    null,
    "createdAt in period",
    "None",
    "lead",
  ),
  md(
    "lead_to_mql",
    "Lead → MQL",
    "lead",
    "derived",
    "Mature leads with mqlAt",
    "Mature leads",
    MATURE,
    "Leads younger than the maturity window",
    "lead",
  ),
  md(
    "mql_to_sal",
    "MQL → sales accepted",
    "lead",
    "derived",
    "Mature MQLs with salAt",
    "Mature leads with mqlAt",
    MATURE,
    "Leads younger than the maturity window",
    "lead",
  ),
  md(
    "sal_to_sql",
    "Sales accepted → SQL",
    "lead",
    "derived",
    "Mature SALs with sqlAt",
    "Mature leads with salAt",
    MATURE,
    "Leads younger than the maturity window",
    "lead",
  ),
  md(
    "lead_to_opportunity",
    "Lead → opportunity",
    "lead",
    "derived",
    "Mature leads with convertedAt",
    "Mature leads",
    MATURE,
    "Leads younger than the maturity window",
    "lead",
  ),
  md(
    "mql_to_sal_days",
    "Median days MQL → sales accepted",
    "lead",
    "derived",
    "Median(salAt − mqlAt)",
    null,
    "Leads with both dates",
    "Leads missing either date",
    "lead",
  ),
  md(
    "stalled_mqls",
    "MQLs waiting for sales",
    "lead",
    "snapshot",
    "Leads with mqlAt older than staleLeadDays and no later stage or disqualification",
    null,
    "As-of snapshot",
    "Disqualified or converted leads",
    "lead",
  ),
  md(
    "opportunities_created",
    "Opportunities created",
    "opportunity",
    "unique",
    "Count of opportunities",
    null,
    "createdAt in period",
    "None",
    "opportunity",
  ),
  md(
    "open_pipeline",
    "Open pipeline",
    "opportunity",
    "snapshot",
    "Σ amount of open opportunities",
    null,
    "As-of snapshot",
    "Amounts in another currency (never converted)",
    "opportunity",
  ),
  md(
    "won_revenue",
    "Won revenue",
    "opportunity",
    "total",
    "Σ amount of won opportunities",
    null,
    "closedAt in period",
    "Amounts in another currency",
    "opportunity",
  ),
  md(
    "win_rate",
    "Win rate",
    "opportunity",
    "derived",
    "Won opportunities",
    "Won + lost opportunities",
    "closedAt in period",
    "Open opportunities",
    "opportunity",
  ),
  md(
    "avg_won_deal",
    "Average won deal",
    "opportunity",
    "derived",
    "Σ won amount",
    "Won opportunities with an amount",
    "closedAt in period",
    "Amounts in another currency",
    "opportunity",
  ),
  md(
    "sales_cycle_days",
    "Median sales cycle",
    "opportunity",
    "derived",
    "Median(closedAt − createdAt) of won opportunities",
    null,
    "closedAt in period",
    "Opportunities without dates",
    "opportunity",
  ),
  md(
    "event_registrations",
    "Event registrations",
    "registrant",
    "unique",
    "Non-cancelled registrations",
    null,
    "Event startsAt in period",
    "Cancelled registrations",
    "event_registrant",
  ),
  md(
    "event_attendance_rate",
    "Event attendance rate",
    "registrant",
    "derived",
    "Attended registrations",
    "Non-cancelled registrations of past events",
    "Event startsAt in period and before as-of",
    "Upcoming events; registrations without an attended value",
    "event_registrant",
  ),
  md(
    "event_attendee_opportunities",
    "Opportunities from attendees after events",
    "opportunity",
    "unique",
    "Opportunities whose contact attended and that were created within eventPipelineDays after the event",
    null,
    "Event startsAt in period",
    "Opportunities without contactId",
    "opportunity + event_registrant",
  ),
  md(
    "web_visits",
    "Website visits",
    "visit",
    "unique",
    "Count of visits",
    null,
    "visitedAt in period",
    "None",
    "site_visit",
  ),
  md(
    "web_known_visitor_share",
    "Known-visitor share",
    "visit",
    "derived",
    "Visits with contactId",
    "Visits",
    "visitedAt in period",
    "None",
    "site_visit",
  ),
  md(
    "web_pages_per_visit",
    "Pages per visit",
    "visit",
    "derived",
    "Σ pages",
    "Visits with a page count",
    "visitedAt in period",
    "Visits without a page count",
    "site_visit",
  ),
  md(
    "web_median_visit_seconds",
    "Median visit duration",
    "visit",
    "derived",
    "Median durationSeconds",
    null,
    "visitedAt in period",
    "Visits without a duration",
    "site_visit",
  ),
  md(
    "web_visit_to_lead",
    "Known visitors who became leads",
    "contact",
    "derived",
    "Known visitors with a lead created within attributionWindowDays after a visit",
    "Known visitors in period",
    "visitedAt in period",
    "Contacts who were already leads before the visit",
    "site_visit + lead",
  ),
];

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v: number | null, dp = 1) =>
  v === null ? null : new Decimal(v).toDecimalPlaces(dp);
const dayKey = (v: unknown) => text(v).slice(0, 10);

/** Adds lead, opportunity, event and website measures to an Eloqua assessment. */
export function assessRevenue(
  a: Assessment,
  campaignName: (id: string) => string,
  deliveredByCampaign: Map<string, Decimal | null>,
) {
  const asOf = Date.parse(a.meta.asOf);
  const minCohort = a.policy("minCohort", 30);
  const cur = a.source.currency;
  const leadsAll = a.rows("lead"),
    oppsAll = a.rows("opportunity"),
    events = a.rows("marketing_event"),
    regs = a.rows("event_registrant"),
    visitsAll = a.rows("site_visit");

  // Opportunity money: never convert currencies; rows in another currency are excluded.
  const foreign = new Set(
    oppsAll
      .filter(
        (o) => present(o.currency) && text(o.currency).toUpperCase() !== cur,
      )
      .map((o) => o.id),
  );
  if (foreign.size)
    a.warnings.push(
      `${foreign.size} opportunities are in a currency other than ${cur}; their amounts are excluded from money totals (no conversion is applied).`,
    );
  const amount = (o: RecordData) => (foreign.has(o.id) ? null : D(o.amount));
  const money = (rows: RecordData[]) => {
    let total = new Decimal(0),
      missing = 0;
    for (const o of rows) {
      const v = amount(o);
      if (v === null) missing++;
      else total = total.plus(v);
    }
    return { total, missing, counted: rows.length - missing };
  };
  const won = (o: RecordData) => lower(o.outcome) === "won";
  const lost = (o: RecordData) => lower(o.outcome) === "lost";
  const open = (o: RecordData) => lower(o.outcome) === "open";
  const oppsByLead = new Map<string, RecordData[]>();
  for (const o of oppsAll)
    if (present(o.leadId))
      oppsByLead.set(text(o.leadId), [
        ...(oppsByLead.get(text(o.leadId)) || []),
        o,
      ]);

  // ---------------- Leads ----------------
  const maturity = a.policy("leadMaturityDays", 30),
    staleLead = a.policy("staleLeadDays", 14),
    acceptT = a.policy("mqlAcceptanceThreshold", 50);
  const leads = leadsAll.filter((l) => a.inPeriod(l, "createdAt"));
  const reached = (l: RecordData, k: string) =>
    present(l[k]) && ms(l[k]) <= asOf;
  const converted = (l: RecordData) =>
    reached(l, "convertedAt") || (oppsByLead.get(l.id) || []).length > 0;
  const hasField = (k: string) => leadsAll.some((l) => present(l[k]));
  const mature = leads.filter((l) => asOf - ms(l.createdAt) >= maturity * DAY);
  if (leadsAll.length) {
    a.metric({
      id: "leads_created",
      label: "Leads created",
      value: leads.length,
      unit: "count",
      formula: "Count of leads with createdAt in the period",
      rows: leads,
      grain: "lead",
      basis: "unique",
    });
    if (leads.length > mature.length)
      a.warnings.push(
        `${leads.length - mature.length} leads were created within ${maturity} days of the as-of time; they are excluded from stage conversion rates because they have not had time to progress.`,
      );
    const stage = (
      id: string,
      label: string,
      from: (l: RecordData) => boolean,
      to: (l: RecordData) => boolean,
      fields: string[],
    ) => {
      const base = mature.filter(from),
        hit = base.filter(to);
      const known = fields.every(hasField) || fields.length === 0;
      a.metric({
        id,
        label,
        value: known ? rate(hit.length, base.length) : null,
        unit: "percent",
        formula: `${hit.length} / ${base.length} mature leads (created ≥ ${maturity} days before as-of)`,
        rows: base,
        reason: !known
          ? `The lead export has no ${fields.filter((f) => !hasField(f)).join(", ")} values`
          : base.length
            ? `Only ${base.length} mature leads (minimum cohort ${minCohort}); treat as indicative`
            : `No mature leads in this stage yet (minimum age ${maturity} days)`,
        grain: "lead",
        basis: "derived",
        state:
          known && base.length < minCohort && base.length > 0
            ? "partial"
            : undefined,
      });
      return { base: base.length, hit: hit.length, known };
    };
    const s1 = stage(
      "lead_to_mql",
      "Lead → MQL",
      () => true,
      (l) => reached(l, "mqlAt"),
      ["mqlAt"],
    );
    const s2 = stage(
      "mql_to_sal",
      "MQL → sales accepted",
      (l) => reached(l, "mqlAt"),
      (l) => reached(l, "salAt"),
      ["mqlAt", "salAt"],
    );
    stage(
      "sal_to_sql",
      "Sales accepted → SQL",
      (l) => reached(l, "salAt"),
      (l) => reached(l, "sqlAt"),
      ["salAt", "sqlAt"],
    );
    stage(
      "lead_to_opportunity",
      "Lead → opportunity",
      () => true,
      converted,
      [],
    );
    const velocity = leadsAll
      .filter((l) => reached(l, "mqlAt") && reached(l, "salAt"))
      .map((l) => (ms(l.salAt) - ms(l.mqlAt)) / DAY)
      .filter((d) => d >= 0);
    a.metric({
      id: "mql_to_sal_days",
      label: "Median days MQL → sales accepted",
      value: round(median(velocity)),
      unit: "days",
      formula: `Median(salAt − mqlAt) over ${velocity.length} leads with both dates`,
      reason: "No lead has both mqlAt and salAt",
      grain: "lead",
      basis: "derived",
    });
    a.section({
      id: "lead-funnel",
      kind: "funnel",
      title: "Lead funnel (mature leads)",
      subtitle: `Leads created in the period and at least ${maturity} days before as-of. Stages come from your milestone dates; a stage with no dates in the export is unavailable, not zero.`,
      bars: [
        { label: "Leads", value: mature.length },
        {
          label: "MQL",
          value: hasField("mqlAt")
            ? mature.filter((l) => reached(l, "mqlAt")).length
            : null,
        },
        {
          label: "Sales accepted",
          value: hasField("salAt")
            ? mature.filter((l) => reached(l, "salAt")).length
            : null,
        },
        {
          label: "Sales qualified",
          value: hasField("sqlAt")
            ? mature.filter((l) => reached(l, "sqlAt")).length
            : null,
        },
        { label: "Opportunity", value: mature.filter(converted).length },
      ],
    });
    // Waiting MQLs: snapshot over all leads, not just the period.
    const stalled = leadsAll.filter(
      (l) =>
        reached(l, "mqlAt") &&
        !reached(l, "salAt") &&
        !reached(l, "sqlAt") &&
        !converted(l) &&
        !reached(l, "disqualifiedAt") &&
        asOf - ms(l.mqlAt) > staleLead * DAY,
    );
    if (hasField("mqlAt")) {
      a.metric({
        id: "stalled_mqls",
        label: `MQLs waiting over ${staleLead} days`,
        value: stalled.length,
        unit: "count",
        formula: `Leads with mqlAt more than ${staleLead} days before as-of and no sales-accepted, SQL, opportunity or disqualified date`,
        rows: stalled,
        grain: "lead",
        basis: "snapshot",
      });
      if (stalled.length)
        a.finding({
          rule: "stalled_mqls",
          scope: "stalled_mqls",
          detail: `${stalled.length} MQLs have waited more than ${staleLead} days without a sales decision (oldest: ${Math.floor(Math.max(...stalled.map((l) => (asOf - ms(l.mqlAt)) / DAY)))} days).`,
          rows: stalled,
          affected: stalled.length,
          hypotheses: [
            "Routing rules may not assign these lead sources to an owner.",
            "The CRM may not be writing acceptance dates back to Eloqua.",
          ],
        });
    }
    if (s2.known && s2.base >= minCohort && s1.known) {
      const r = rate(s2.hit, s2.base)!;
      if (r.lt(acceptT))
        a.finding({
          rule: "low_mql_acceptance",
          scope: "mql_acceptance",
          detail: `${s2.hit} of ${s2.base} mature MQLs (${fmt(r.toDecimalPlaces(1))}%) reached sales-accepted; the approved threshold is ${acceptT}%.`,
          evidence: ["mql_to_sal"],
          rows: mature.filter((l) => reached(l, "mqlAt")),
          affected: s2.base - s2.hit,
          hypotheses: [
            "The scoring model may weight engagement that sales does not value.",
            "Some sources may produce MQLs outside the target profile.",
          ],
        });
    }
    // Leads by source.
    const bySource = new Map<string, RecordData[]>();
    for (const l of leads)
      bySource.set(text(l.leadSource) || "Not recorded", [
        ...(bySource.get(text(l.leadSource) || "Not recorded") || []),
        l,
      ]);
    a.section({
      id: "lead-sources",
      kind: "table",
      title: "Leads by source",
      subtitle:
        "Source exactly as recorded on the lead. Conversion uses mature leads only; revenue counts won opportunities linked by leadId.",
      columns: [
        { key: "source", label: "Lead source" },
        { key: "leads", label: "Leads", unit: "count" },
        { key: "mature", label: "Mature leads", unit: "count" },
        { key: "mql", label: "MQL %", unit: "percent" },
        { key: "opp", label: "Opportunity %", unit: "percent" },
        { key: "won", label: "Won revenue", unit: "money" },
      ],
      rows: [...bySource.entries()]
        .sort((x, y) => y[1].length - x[1].length)
        .map(([src, ls]) => {
          const m = ls.filter((l) => mature.includes(l));
          const w = money(
            ls.flatMap((l) => oppsByLead.get(l.id) || []).filter(won),
          );
          return {
            key: "source:" + src,
            source: src,
            leads: ls.length,
            mature: m.length,
            mql: hasField("mqlAt")
              ? fmt(rate(m.filter((l) => reached(l, "mqlAt")).length, m.length))
              : null,
            opp: fmt(rate(m.filter(converted).length, m.length)),
            won: oppsAll.length ? fmt(w.total) : null,
          };
        }),
    });
    if (hasField("rating"))
      a.section({
        id: "lead-ratings",
        kind: "bars",
        title: "Leads by rating",
        subtitle: "Lead rating as recorded by your Eloqua lead scoring model.",
        bars: [
          ...leads.reduce(
            (m, l) =>
              m.set(
                text(l.rating) || "Not rated",
                (m.get(text(l.rating) || "Not rated") || 0) + 1,
              ),
            new Map<string, number>(),
          ),
        ]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([label, value]) => ({ label, value })),
      });
  }

  // ---------------- Opportunities / sales ----------------
  if (oppsAll.length) {
    const staleOpp = a.policy("staleOpportunityDays", 90);
    const created = oppsAll.filter((o) => a.inPeriod(o, "createdAt"));
    const openOpps = oppsAll.filter(open);
    const closed = oppsAll.filter(
      (o) =>
        (won(o) || lost(o)) && present(o.closedAt) && a.inPeriod(o, "closedAt"),
    );
    const wonRows = closed.filter(won);
    a.metric({
      id: "opportunities_created",
      label: "Opportunities created",
      value: created.length,
      unit: "count",
      formula: "Count of opportunities with createdAt in the period",
      rows: created,
      grain: "opportunity",
      basis: "unique",
    });
    const pipe = money(openOpps),
      wonMoney = money(wonRows);
    a.metric({
      id: "open_pipeline",
      label: "Open pipeline",
      value: pipe.total,
      unit: "money",
      currency: cur,
      formula: `Σ amount of ${pipe.counted} open opportunities (snapshot at as-of)`,
      rows: openOpps,
      state: pipe.missing ? "partial" : undefined,
      reason: pipe.missing
        ? `${pipe.missing} open opportunities have no amount in ${cur} and are not included`
        : undefined,
      grain: "opportunity",
      basis: "snapshot",
    });
    a.metric({
      id: "won_revenue",
      label: "Won revenue",
      value: wonMoney.total,
      unit: "money",
      currency: cur,
      formula: `Σ amount of ${wonMoney.counted} won opportunities closed in the period`,
      rows: wonRows,
      state: wonMoney.missing ? "partial" : undefined,
      reason: wonMoney.missing
        ? `${wonMoney.missing} won opportunities have no amount in ${cur}`
        : undefined,
      grain: "opportunity",
      basis: "total",
    });
    a.metric({
      id: "win_rate",
      label: "Win rate",
      value: rate(wonRows.length, closed.length),
      unit: "percent",
      formula: `${wonRows.length} won / ${closed.length} closed (won + lost) in the period`,
      rows: closed,
      reason: closed.length
        ? `Only ${closed.length} closed opportunities (minimum cohort ${minCohort}); treat as indicative`
        : "No opportunity closed in the period",
      grain: "opportunity",
      basis: "derived",
      state: closed.length && closed.length < minCohort ? "partial" : undefined,
    });
    a.metric({
      id: "avg_won_deal",
      label: "Average won deal",
      value: wonMoney.counted ? wonMoney.total.div(wonMoney.counted) : null,
      unit: "money",
      currency: cur,
      formula: `Σ won amount / ${wonMoney.counted} won opportunities with an amount`,
      rows: wonRows,
      reason: "No won opportunity with an amount in the period",
      grain: "opportunity",
      basis: "derived",
    });
    const cycle = wonRows
      .filter((o) => present(o.createdAt))
      .map((o) => (ms(o.closedAt) - ms(o.createdAt)) / DAY)
      .filter((d) => d >= 0);
    a.metric({
      id: "sales_cycle_days",
      label: "Median sales cycle",
      value: round(median(cycle)),
      unit: "days",
      formula: `Median(closedAt − createdAt) of ${cycle.length} won opportunities`,
      reason: "No won opportunity with both dates in the period",
      grain: "opportunity",
      basis: "derived",
    });
    const aged = openOpps.filter(
      (o) => asOf - ms(o.createdAt) > staleOpp * DAY,
    );
    if (aged.length) {
      const v = money(aged);
      a.finding({
        rule: "aging_pipeline",
        scope: "aging_pipeline",
        detail: `${aged.length} open opportunities (${v.total.toDecimalPlaces(2).toString()} ${cur}${v.missing ? `, ${v.missing} without amount` : ""}) were created more than ${staleOpp} days ago.`,
        rows: aged,
        affected: aged.length,
      });
    }
    const byStage = new Map<string, RecordData[]>();
    for (const o of openOpps)
      byStage.set(text(o.stage) || "Not recorded", [
        ...(byStage.get(text(o.stage) || "Not recorded") || []),
        o,
      ]);
    if (openOpps.length)
      a.section({
        id: "pipeline-stages",
        kind: "table",
        title: "Open pipeline by stage",
        subtitle: `Snapshot at as-of. Amounts in ${cur} only; other currencies are excluded, never converted.`,
        columns: [
          { key: "stage", label: "Stage" },
          { key: "count", label: "Opportunities", unit: "count" },
          { key: "amount", label: "Amount", unit: "money" },
          { key: "aged", label: `Older than ${staleOpp} days`, unit: "count" },
        ],
        rows: [...byStage.entries()].map(([st, os]) => ({
          key: "stage:" + st,
          stage: st,
          count: os.length,
          amount: fmt(money(os).total),
          aged: os.filter((o) => aged.includes(o)).length,
        })),
      });
  }

  // ---------------- Campaign influence, as recorded ----------------
  if (leadsAll.length || oppsAll.length) {
    const ids = new Set([
      ...leadsAll
        .filter((l) => present(l.campaignId))
        .map((l) => text(l.campaignId)),
      ...oppsAll
        .filter((o) => present(o.campaignId))
        .map((o) => text(o.campaignId)),
    ]);
    const rows = [...ids].map((cid) => {
      const ls = leads.filter((l) => text(l.campaignId) === cid);
      const matureLs = mature.filter((l) => text(l.campaignId) === cid);
      const os = oppsAll.filter((o) => text(o.campaignId) === cid);
      const w = money(
        os.filter(
          (o) => won(o) && present(o.closedAt) && a.inPeriod(o, "closedAt"),
        ),
      );
      const delivered = deliveredByCampaign.get(cid) ?? null;
      return {
        cid,
        matureLs,
        os,
        row: {
          key: "campaign:" + cid,
          campaign: campaignName(cid),
          leads: ls.length,
          mql:
            leadsAll.length && leadsAll.some((l) => present(l.mqlAt))
              ? ls.filter((l) => reached(l, "mqlAt")).length
              : null,
          opps: os.filter((o) => a.inPeriod(o, "createdAt")).length,
          pipeline: fmt(money(os.filter(open)).total),
          won: fmt(w.total),
          perK:
            delivered && delivered.gt(0) && !w.missing
              ? fmt(w.total.div(delivered).mul(1000).toDecimalPlaces(2))
              : null,
        },
      };
    });
    a.section({
      id: "campaign-revenue",
      kind: "table",
      title: "Leads, pipeline and revenue by campaign",
      subtitle:
        "Attribution exactly as recorded on each lead and opportunity (campaignId). This is not a multi-touch model and does not show that the campaign caused the revenue.",
      columns: [
        { key: "campaign", label: "Campaign" },
        { key: "leads", label: "Leads", unit: "count" },
        { key: "mql", label: "MQLs", unit: "count" },
        { key: "opps", label: "Opportunities", unit: "count" },
        { key: "pipeline", label: "Open pipeline", unit: "money" },
        { key: "won", label: "Won revenue", unit: "money" },
        { key: "perK", label: "Won per 1,000 delivered", unit: "money" },
      ],
      rows: rows.map((r) => r.row),
    });
    for (const r of rows)
      if (
        r.matureLs.length >= minCohort &&
        !r.matureLs.some(converted) &&
        !r.os.length
      )
        a.finding({
          rule: "campaign_no_pipeline",
          scope: "campaign:" + r.cid,
          title: `Leads from ${campaignName(r.cid)} are not reaching pipeline`,
          detail: `${r.matureLs.length} mature leads recorded this campaign and none has an opportunity.`,
          rows: r.matureLs,
          affected: r.matureLs.length,
        });
  }

  // ---------------- Events ----------------
  if (events.length) {
    const attendT = a.policy("eventAttendanceThreshold", 40),
      pipeDays = a.policy("eventPipelineDays", 90);
    const inPeriod = events.filter((e) => a.inPeriod(e, "startsAt"));
    const oppByContact = new Map<string, RecordData[]>();
    for (const o of oppsAll)
      if (present(o.contactId))
        oppByContact.set(text(o.contactId), [
          ...(oppByContact.get(text(o.contactId)) || []),
          o,
        ]);
    let regTotal = 0,
      pastRegs = 0,
      attendedTotal = 0,
      attendeeOpps = 0;
    const attendanceKnown = regs.some((r) => present(r.attended));
    const rows = inPeriod
      .sort((x, y) => text(x.startsAt).localeCompare(text(y.startsAt)))
      .map((e) => {
        const rs = regs.filter(
          (r) => text(r.eventId) === e.id && !bool(r.cancelled),
        );
        const past = ms(e.startsAt) <= asOf;
        const att = rs.filter((r) => bool(r.attended));
        regTotal += rs.length;
        const start = ms(e.startsAt);
        const opps = past
          ? [
              ...new Set(
                att.flatMap((r) =>
                  (oppByContact.get(text(r.contactId)) || []).filter(
                    (o) =>
                      ms(o.createdAt) > start &&
                      ms(o.createdAt) <= start + pipeDays * DAY,
                  ),
                ),
              ),
            ]
          : [];
        if (past) {
          pastRegs += rs.length;
          attendedTotal += att.length;
          attendeeOpps += opps.length;
        }
        const ar = past && attendanceKnown ? rate(att.length, rs.length) : null;
        if (past && ar && rs.length >= minCohort && ar.lt(attendT))
          a.finding({
            rule: "event_low_attendance",
            entity: e,
            title: `Low attendance at ${text(e.name) || e.id}`,
            detail: `${att.length} of ${rs.length} registrants attended (${fmt(ar.toDecimalPlaces(1))}%); the approved threshold is ${attendT}%.`,
            rows: rs.filter((r) => !bool(r.attended)),
            affected: rs.length - att.length,
          });
        return {
          key: "event:" + e.id,
          event: text(e.name) || e.id,
          date: dayKey(e.startsAt),
          type: text(e.eventType) || "—",
          registrations: rs.length,
          attended: past && attendanceKnown ? att.length : null,
          attendance: fmt(ar),
          noShows: past && attendanceKnown ? rs.length - att.length : null,
          opps:
            past && oppsAll.some((o) => present(o.contactId))
              ? opps.length
              : null,
          pipeline:
            past && oppsAll.some((o) => present(o.contactId))
              ? fmt(money(opps).total)
              : null,
          status: past ? "Held" : "Upcoming",
        };
      });
    a.metric({
      id: "event_registrations",
      label: "Event registrations",
      value: regs.length ? regTotal : null,
      unit: "count",
      formula: "Non-cancelled registrations for events starting in the period",
      reason: "Upload event registrant records",
      grain: "registrant",
      basis: "unique",
    });
    a.metric({
      id: "event_attendance_rate",
      label: "Event attendance rate",
      value: attendanceKnown ? rate(attendedTotal, pastRegs) : null,
      unit: "percent",
      formula: `${attendedTotal} attended / ${pastRegs} non-cancelled registrations of past events`,
      reason: attendanceKnown
        ? "No past event with registrations in the period"
        : "Registrant records have no attended value",
      grain: "registrant",
      basis: "derived",
    });
    a.metric({
      id: "event_attendee_opportunities",
      label: `Opportunities from attendees within ${pipeDays} days`,
      value: oppsAll.some((o) => present(o.contactId)) ? attendeeOpps : null,
      unit: "count",
      formula: `Opportunities created by attending contacts within ${pipeDays} days after the event (association, not causation)`,
      reason: "Opportunities need contactId to be associated with attendees",
      grain: "opportunity",
      basis: "unique",
    });
    a.section({
      id: "events",
      kind: "table",
      title: "Events and webinars",
      subtitle: `Attendance counts non-cancelled registrations of held events. Opportunities are those created by attendees within ${pipeDays} days after the event: an association, not proof the event caused them.`,
      columns: [
        { key: "event", label: "Event" },
        { key: "date", label: "Date" },
        { key: "type", label: "Type" },
        { key: "registrations", label: "Registrations", unit: "count" },
        { key: "attended", label: "Attended", unit: "count" },
        { key: "attendance", label: "Attendance %", unit: "percent" },
        { key: "noShows", label: "No-shows", unit: "count" },
        { key: "opps", label: "Attendee opportunities", unit: "count" },
        { key: "pipeline", label: "Attendee pipeline", unit: "money" },
        { key: "status", label: "Status" },
      ],
      rows,
    });
  }

  // ---------------- Website visits ----------------
  if (visitsAll.length) {
    const knownT = a.policy("knownVisitorThreshold", 10),
      shortT = a.policy("shortVisitSeconds", 10),
      win = a.policy("attributionWindowDays", 7);
    const visits = visitsAll.filter((v) => a.inPeriod(v, "visitedAt"));
    const known = visits.filter((v) => present(v.contactId));
    const withPages = visits.filter((v) => D(v.pages) !== null);
    const timed = visits.filter((v) => D(v.durationSeconds) !== null);
    a.metric({
      id: "web_visits",
      label: "Website visits",
      value: visits.length,
      unit: "count",
      formula: "Count of visits with visitedAt in the period",
      rows: visits,
      grain: "visit",
      basis: "unique",
    });
    const knownShare = a.metric({
      id: "web_known_visitor_share",
      label: "Known-visitor share",
      value: rate(known.length, visits.length),
      unit: "percent",
      formula: `${known.length} visits with a contact / ${visits.length} visits`,
      rows: visits,
      reason: "No visits in the period",
      grain: "visit",
      basis: "derived",
    });
    a.metric({
      id: "web_pages_per_visit",
      label: "Pages per visit",
      value: withPages.length
        ? withPages
            .reduce((s, v) => s.plus(D(v.pages)!), new Decimal(0))
            .div(withPages.length)
        : null,
      unit: "count",
      formula: `Σ pages / ${withPages.length} visits with a page count`,
      reason: withPages.length
        ? `${visits.length - withPages.length} visits have no page count`
        : "The visit export has no page counts",
      grain: "visit",
      basis: "derived",
      state:
        withPages.length && withPages.length < visits.length
          ? "partial"
          : undefined,
    });
    a.metric({
      id: "web_median_visit_seconds",
      label: "Median visit duration",
      value: round(
        median(timed.map((v) => D(v.durationSeconds)!.toNumber())),
        0,
      ),
      unit: "seconds",
      formula: `Median durationSeconds of ${timed.length} timed visits`,
      reason: timed.length
        ? `${visits.length - timed.length} visits have no duration`
        : "The visit export has no durations",
      grain: "visit",
      basis: "derived",
      state:
        timed.length && timed.length < visits.length ? "partial" : undefined,
    });
    // Known visitors who became leads within the attribution window after a visit.
    const leadByContact = new Map<string, number>();
    for (const l of leadsAll)
      if (present(l.contactId) && present(l.createdAt))
        leadByContact.set(
          text(l.contactId),
          Math.min(
            leadByContact.get(text(l.contactId)) ?? Infinity,
            ms(l.createdAt),
          ),
        );
    if (leadsAll.some((l) => present(l.contactId)) && known.length) {
      const firstVisit = new Map<string, number>();
      for (const v of known)
        firstVisit.set(
          text(v.contactId),
          Math.min(
            firstVisit.get(text(v.contactId)) ?? Infinity,
            ms(v.visitedAt),
          ),
        );
      const eligible = [...firstVisit.entries()].filter(
        ([c, t]) => !(leadByContact.has(c) && leadByContact.get(c)! < t),
      );
      const became = eligible.filter(([c, t]) => {
        const l = leadByContact.get(c);
        return l !== undefined && l >= t && l <= t + win * DAY;
      });
      a.metric({
        id: "web_visit_to_lead",
        label: `Known visitors who became leads within ${win} days`,
        value: rate(became.length, eligible.length),
        unit: "percent",
        formula: `${became.length} / ${eligible.length} known visitors who were not already leads`,
        reason: "No eligible known visitors",
        grain: "contact",
        basis: "derived",
      });
    }
    if (knownShare && visits.length >= minCohort && knownShare.lt(knownT))
      a.finding({
        rule: "website_low_known",
        scope: "website",
        detail: `${known.length} of ${visits.length} visits (${fmt(knownShare.toDecimalPlaces(1))}%) are linked to a known contact; the approved threshold is ${knownT}%.`,
        evidence: ["web_known_visitor_share"],
        rows: visits.slice(0, 200),
        affected: visits.length - known.length,
      });
    const byPage = new Map<string, RecordData[]>();
    for (const v of visits)
      byPage.set(text(v.firstPageUrl), [
        ...(byPage.get(text(v.firstPageUrl)) || []),
        v,
      ]);
    const pageRows = [...byPage.entries()]
      .sort((x, y) => y[1].length - x[1].length)
      .map(([page, vs]) => {
        const t = vs.filter((v) => D(v.durationSeconds) !== null);
        const p = vs.filter((v) => D(v.pages) !== null);
        const med = median(t.map((v) => D(v.durationSeconds)!.toNumber()));
        if (t.length >= minCohort && med !== null && med < shortT)
          a.finding({
            rule: "landing_short_visits",
            scope: "page:" + page,
            title: `Visits starting on ${page} end within seconds`,
            detail: `Median duration of ${t.length} timed visits starting on ${page} is ${Math.round(med)} seconds; the approved minimum is ${shortT} seconds.`,
            rows: vs,
            affected: vs.length,
            hypotheses: [
              "The page may not match the message of the link that sends visitors to it.",
              "The page may load slowly or hide its call to action on mobile.",
            ],
          });
        return {
          key: "page:" + page,
          page,
          visits: vs.length,
          known: fmt(
            rate(vs.filter((v) => present(v.contactId)).length, vs.length),
          ),
          pages: p.length
            ? fmt(
                p
                  .reduce((s, v) => s.plus(D(v.pages)!), new Decimal(0))
                  .div(p.length),
              )
            : null,
          duration: med === null ? null : Math.round(med),
          campaign: vs.filter((v) => present(v.campaignId)).length,
        };
      });
    a.section({
      id: "landing-pages",
      kind: "table",
      title: "Website landing pages",
      subtitle:
        "First page of each visit. Median duration uses visits with a recorded duration only.",
      columns: [
        { key: "page", label: "Landing page" },
        { key: "visits", label: "Visits", unit: "count" },
        { key: "known", label: "Known %", unit: "percent" },
        { key: "pages", label: "Pages per visit", unit: "count" },
        { key: "duration", label: "Median duration", unit: "seconds" },
        { key: "campaign", label: "From campaigns", unit: "count" },
      ],
      rows: pageRows,
    });
  }

  // ---------------- Capabilities ----------------
  const mqlDates = leadsAll.some((l) => present(l.mqlAt));
  a.capability(
    "leads",
    "Leads and lead stages",
    leadsAll.length ? (mqlDates ? true : "partial") : false,
    "Lead export with createdAt, leadSource, campaignId, rating and stage milestone dates (mqlAt, salAt, sqlAt, convertedAt, disqualifiedAt).",
  );
  a.capability(
    "sales",
    "Sales pipeline and revenue",
    oppsAll.length
      ? oppsAll.every((o) => present(o.amount))
        ? true
        : "partial"
      : false,
    "Opportunity export (CRM) with createdAt, closedAt, outcome, stage, amount, currency, leadId/contactId and campaignId.",
  );
  a.capability(
    "events",
    "Events and webinars",
    events.length ? (regs.length ? true : "partial") : false,
    "Event export plus registrants with attended and cancelled flags.",
  );
  a.capability(
    "website",
    "Website visits",
    visitsAll.length
      ? visitsAll.some((v) => present(v.durationSeconds))
        ? true
        : "partial"
      : false,
    "Eloqua site visit export with visitor/contact IDs, first page URL, pages and duration.",
  );
  if (!leadsAll.length && !oppsAll.length)
    a.warnings.push(
      "Lead stages, pipeline and revenue are unavailable until you upload lead and opportunity exports.",
    );
}
