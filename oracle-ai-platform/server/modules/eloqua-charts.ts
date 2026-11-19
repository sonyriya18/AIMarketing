// Eloqua dashboard: topic groups, section explanations and charts. Chart values use the same
// definitions as the measures (numerators and denominators summed, never averaged percentages).
import Decimal from "decimal.js";
import type { RecordData } from "../../shared/catalog";
import { Assessment, D, bool, lower, present, rate, text } from "./common";
import {
  dayLabel,
  dayRange,
  key,
  monthLabel,
  monthRange,
  num,
  topLabels,
  type ModuleLayout,
} from "./layout";

export const ELOQUA_LAYOUT: ModuleLayout = {
  groups: [
    "Campaigns",
    "Leads",
    "Sales",
    "Events",
    "Website",
    "Nurture & assets",
  ],
  sections: {
    "email-trend": {
      group: "Campaigns",
      about:
        "Unique open and click rates per month across all comparable campaigns. A falling line means fewer recipients engaged; compare it with the send volume chart before drawing conclusions.",
    },
    "sends-trend": {
      group: "Campaigns",
      about:
        "Delivered emails per month, split by campaign. Use it to see which campaigns drive volume and whether sending changed.",
    },
    campaigns: {
      group: "Campaigns",
      about:
        "Every campaign with its delivery and engagement rates. Rows marked 'Below N sends' or 'Still accruing' are not compared with others.",
    },
    "click-chart": {
      group: "Campaigns",
      about:
        "Unique click rate per comparable campaign. Higher bars mean more recipients clicked at least once.",
    },
    "leads-trend": {
      group: "Leads",
      about:
        "New leads per month by lead source. Shows which sources are growing and which are drying up.",
    },
    "lead-funnel": {
      group: "Leads",
      about:
        "How many mature leads reached each stage, from your own milestone dates. The biggest step down is where leads get stuck.",
    },
    "lead-sources": {
      group: "Leads",
      about:
        "Leads, MQL rate, opportunity rate and won revenue per lead source. Use it to invest in sources that turn into revenue, not just volume.",
    },
    "lead-ratings": {
      group: "Leads",
      about:
        "How your lead scoring model rated the leads created in the period.",
    },
    "won-trend": {
      group: "Sales",
      about:
        "Won revenue per month (closed date). Amounts in other currencies are left out, never converted.",
    },
    "pipeline-donut": {
      group: "Sales",
      about:
        "Open pipeline value by sales stage at the as-of time. A large early-stage share means revenue is still far away.",
    },
    "pipeline-stages": {
      group: "Sales",
      about:
        "Open opportunities per stage, their value and how many are older than the approved age.",
    },
    "campaign-revenue": {
      group: "Sales",
      about:
        "Leads, pipeline and won revenue per campaign, exactly as recorded on leads and opportunities. This is attribution as recorded, not proof that the campaign caused the revenue.",
    },
    "event-chart": {
      group: "Events",
      about:
        "Registrations versus attendees for each held event. A big gap means many no-shows: follow up with the recording.",
    },
    events: {
      group: "Events",
      about:
        "Every event with registrations, attendance, no-shows and the opportunities attendees created afterwards.",
    },
    "visits-trend": {
      group: "Website",
      about:
        "Website visits per day, split into known contacts and anonymous visitors. Growing known visits means your forms and email links identify more people.",
    },
    "referrer-donut": {
      group: "Website",
      about:
        "Where website visits came from. Use it to see which channels bring traffic.",
    },
    "nurture-chart": {
      group: "Nurture & assets",
      about:
        "Contacts who entered each nurture step, in canvas order. A sharp fall between two steps shows where contacts leave the program.",
    },
    "landing-pages": {
      group: "Website",
      about:
        "First page of each visit with visits, known share, pages per visit and median visit time. Short visits on a busy page usually mean the page does not match the visitor's expectation.",
    },
    nurture: {
      group: "Nurture & assets",
      about:
        "Each nurture step and how many contacts moved on to the next step. Unreachable or dead-end steps are structural problems.",
    },
    assets: {
      group: "Nurture & assets",
      about:
        "Email assets checked for subject, alt text, secure links and personalization fields.",
    },
  },
  rules: {
    bounce_rate: "Campaigns",
    unsubscribe_rate: "Campaigns",
    ctor_gap: "Campaigns",
    immature_activity: "Campaigns",
    unmatched_activity: "Campaigns",
    exposure: "Campaigns",
    click_to_form: "Campaigns",
    nurture_unreachable: "Nurture & assets",
    nurture_dead_end: "Nurture & assets",
    nurture_drop: "Nurture & assets",
    asset_readiness: "Nurture & assets",
    stalled_mqls: "Leads",
    low_mql_acceptance: "Leads",
    aging_pipeline: "Sales",
    campaign_no_pipeline: "Sales",
    event_low_attendance: "Events",
    website_low_known: "Website",
    landing_short_visits: "Website",
  },
  capabilities: {
    campaigns: "Campaigns",
    aggregates: "Campaigns",
    activities: "Campaigns",
    forms: "Campaigns",
    exposure: "Campaigns",
    nurture: "Nurture & assets",
    history: "Nurture & assets",
    assets: "Nurture & assets",
    leads: "Leads",
    sales: "Sales",
    events: "Events",
    website: "Website",
  },
};

export function eloquaCharts(
  a: Assessment,
  campaignName: (id: string) => string,
  withheld: Set<string>,
) {
  const cur = a.source.currency;
  // ---- Campaigns: monthly rates and volume (single-month rows inside the period) ----
  const { periodStart, periodEnd } = a.meta;
  const monthly = a
    .rows("campaign_metrics")
    .filter(
      (r) =>
        !withheld.has(text(r.campaignId)) &&
        text(r.periodStart).slice(0, 7) === text(r.periodEnd).slice(0, 7) &&
        (!periodStart || text(r.periodStart) >= periodStart) &&
        (!periodEnd || text(r.periodEnd) <= periodEnd),
    );
  const months = monthRange(
    monthly.map((r) => text(r.periodStart).slice(0, 7)),
  );
  if (months.length) {
    const sum = (rows: RecordData[], f: string) =>
      rows.every((r) => D(r[f]) !== null) && rows.length
        ? rows.reduce((s, r) => s.plus(D(r[f])!), new Decimal(0))
        : null;
    a.chart({
      id: "email-trend",
      title: "Open and click rate by month",
      chart: {
        type: "line",
        x: "month",
        unit: "percent",
        series: [
          { key: "open", label: "Unique open rate" },
          { key: "click", label: "Unique click rate" },
        ],
        data: months.map((m) => {
          const rows = monthly.filter((r) => text(r.periodStart).startsWith(m));
          const del = sum(rows, "totalDelivered");
          return {
            month: monthLabel(m),
            open: num(rate(sum(rows, "uniqueOpens"), del)),
            click: num(rate(sum(rows, "uniqueClicks"), del)),
          };
        }),
      },
    });
    const top = topLabels(monthly, (r) => campaignName(text(r.campaignId)), 6);
    a.chart({
      id: "sends-trend",
      title: "Delivered emails by month and campaign",
      chart: {
        type: "stacked",
        x: "month",
        unit: "count",
        series: top.labels.map((l) => ({ key: key(l), label: l })),
        data: months.map((m) => {
          const row: Record<string, string | number | null> = {
            month: monthLabel(m),
          };
          for (const l of top.labels) {
            const rows = monthly.filter(
              (r) => text(r.periodStart).startsWith(m) && top.of(r) === l,
            );
            row[key(l)] = rows.length
              ? rows.reduce((s, r) => s + (Number(r.totalDelivered) || 0), 0)
              : null;
          }
          return row;
        }),
      },
    });
  }

  // ---- Leads per month by source ----
  const leads = a.rows("lead").filter((l) => a.inPeriod(l, "createdAt"));
  if (leads.length) {
    const lm = monthRange(leads.map((l) => a.day(l.createdAt).slice(0, 7)));
    const top = topLabels(
      leads,
      (l) => text(l.leadSource) || "Not recorded",
      5,
    );
    a.chart({
      id: "leads-trend",
      title: "New leads per month by source",
      chart: {
        type: "stacked",
        x: "month",
        unit: "count",
        series: top.labels.map((l) => ({ key: key(l), label: l })),
        data: lm.map((m) => {
          const row: Record<string, string | number | null> = {
            month: monthLabel(m),
          };
          for (const l of top.labels)
            row[key(l)] = leads.filter(
              (x) => a.day(x.createdAt).startsWith(m) && top.of(x) === l,
            ).length;
          return row;
        }),
      },
    });
  }

  // ---- Sales: won revenue per month, open pipeline by stage ----
  const opps = a
    .rows("opportunity")
    .filter(
      (o) => !present(o.currency) || text(o.currency).toUpperCase() === cur,
    );
  const won = opps.filter(
    (o) =>
      lower(o.outcome) === "won" &&
      present(o.closedAt) &&
      a.inPeriod(o, "closedAt"),
  );
  if (won.length) {
    const wm = monthRange(won.map((o) => a.day(o.closedAt).slice(0, 7)));
    a.chart({
      id: "won-trend",
      title: `Won revenue by month (${cur})`,
      chart: {
        type: "bar",
        x: "month",
        unit: "money",
        series: [{ key: "won", label: "Won revenue" }],
        data: wm.map((m) => {
          const rows = won.filter((o) => a.day(o.closedAt).startsWith(m));
          return {
            month: monthLabel(m),
            won: rows.length
              ? rows.reduce((s, o) => s + (Number(o.amount) || 0), 0)
              : 0,
          };
        }),
      },
    });
  }
  const open = opps.filter(
    (o) => lower(o.outcome) === "open" && D(o.amount) !== null,
  );
  if (open.length) {
    const top = topLabels(open, (o) => text(o.stage) || "Not recorded", 6);
    a.chart({
      id: "pipeline-donut",
      title: `Open pipeline by stage (${cur})`,
      chart: {
        type: "donut",
        x: "stage",
        unit: "money",
        series: [{ key: "value", label: "Open pipeline" }],
        data: top.labels.map((l) => ({
          stage: l,
          value: open
            .filter((o) => top.of(o) === l)
            .reduce((s, o) => s + Number(o.amount), 0),
        })),
      },
    });
  }

  // ---- Events: registrations vs attended (held events only) ----
  const asOf = Date.parse(a.meta.asOf);
  const held = a
    .rows("marketing_event")
    .filter(
      (e) => a.inPeriod(e, "startsAt") && Date.parse(text(e.startsAt)) <= asOf,
    )
    .sort((x, y) => text(x.startsAt).localeCompare(text(y.startsAt)));
  const regs = a.rows("event_registrant");
  if (held.length && regs.some((r) => present(r.attended))) {
    a.chart({
      id: "event-chart",
      title: "Registrations and attendees per event",
      chart: {
        type: "grouped",
        x: "event",
        unit: "count",
        series: [
          { key: "registered", label: "Registered" },
          { key: "attended", label: "Attended" },
        ],
        data: held.map((e) => {
          const rs = regs.filter(
            (r) => text(r.eventId) === e.id && !bool(r.cancelled),
          );
          return {
            event: text(e.name) || e.id,
            registered: rs.length,
            attended: rs.filter((r) => bool(r.attended)).length,
          };
        }),
      },
    });
  }

  // ---- Nurture: contacts entering each step (canvas order as exported) ----
  const steps = a.rows("step"),
    hist = a.rows("step_membership");
  if (steps.length && hist.length) {
    const byCampaign = new Map<string, RecordData[]>();
    for (const st of steps)
      byCampaign.set(text(st.campaignId), [
        ...(byCampaign.get(text(st.campaignId)) || []),
        st,
      ]);
    const [cid, list] = [...byCampaign.entries()].sort(
      (x, y) => y[1].length - x[1].length,
    )[0];
    a.chart({
      id: "nurture-chart",
      title: `Contacts entering each step: ${campaignName(cid)}`,
      chart: {
        type: "hbar",
        x: "step",
        unit: "count",
        series: [{ key: "contacts", label: "Contacts entered" }],
        data: list.map((st) => ({
          step: text(st.name) || st.id,
          contacts: new Set(
            hist
              .filter((h) => text(h.stepId) === st.id)
              .map((h) => text(h.contactId)),
          ).size,
        })),
      },
    });
  }

  // ---- Website: visits per day (known vs anonymous) and by referrer ----
  const visits = a.rows("site_visit").filter((v) => a.inPeriod(v, "visitedAt"));
  if (visits.length) {
    const days = dayRange(visits.map((v) => a.day(v.visitedAt)));
    a.chart({
      id: "visits-trend",
      title: "Website visits per day",
      chart: {
        type: "area",
        x: "day",
        unit: "count",
        stacked: true,
        series: [
          { key: "anonymous", label: "Anonymous visitors" },
          { key: "known", label: "Known contacts" },
        ],
        data: days.map((d) => {
          const vs = visits.filter((v) => a.day(v.visitedAt) === d);
          const known = vs.filter((v) => present(v.contactId)).length;
          return { day: dayLabel(d), anonymous: vs.length - known, known };
        }),
      },
    });
    if (visits.some((v) => present(v.referrer))) {
      const top = topLabels(
        visits,
        (v) => text(v.referrer) || "Not recorded",
        6,
      );
      a.chart({
        id: "referrer-donut",
        title: "Website visits by source",
        chart: {
          type: "donut",
          x: "source",
          unit: "count",
          series: [{ key: "visits", label: "Visits" }],
          data: top.labels.map((l) => ({
            source: l,
            visits: visits.filter((v) => top.of(v) === l).length,
          })),
        },
      });
    }
  }
}
