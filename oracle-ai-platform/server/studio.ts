// Studio data: per-entity measures for deep dives and head-to-head comparisons, plus flow
// diagrams. Eloqua campaigns, Infinity pages and segments, Unity audiences. Every value is
// computed here from the snapshot's records (numerator / denominator, never averaged rates);
// missing inputs stay null. The browser only draws them.
import type {
  ChartSpec,
  Flow,
  RecordData,
  Source,
  Studio,
  StudioEntity,
  StudioMetric,
} from "../shared/catalog";

const text = (v: unknown) => String(v ?? "");
const present = (v: unknown) =>
  v !== null && v !== undefined && String(v).trim() !== "";
const num = (v: unknown) => {
  if (!present(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sum = (rows: RecordData[], k: string) => {
  let t = 0,
    any = false;
  for (const r of rows) {
    const n = num(r[k]);
    if (n !== null) {
      t += n;
      any = true;
    }
  }
  return any ? t : null;
};
/** A rate in percent, or null when the denominator is missing or zero. */
const rate = (n: number | null, d: number | null) =>
  n === null || d === null || d <= 0 ? null : (n / d) * 100;
const ms = (v: unknown) => Date.parse(text(v));
const day = (v: unknown) => text(v).slice(0, 10);
const monthLabel = (iso: string) =>
  new Date(iso.slice(0, 7) + "-01T00:00:00Z").toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const within = (v: unknown, start?: string, end?: string) => {
  const d = day(v);
  if (!d) return !start && !end;
  return (!start || d >= start) && (!end || d <= end);
};

export interface StudioInput {
  periodStart?: string;
  periodEnd?: string;
  asOf: string;
  datasetId: string;
}

export function buildStudio(
  source: Source,
  records: RecordData[],
  input: StudioInput,
): Studio {
  if (source.app === "eloqua") return eloquaStudio(source, records, input);
  if (source.app === "infinity") return infinityStudio(source, records, input);
  return unityStudio(source, records, input);
}

/* ------------------------------------ Eloqua ------------------------------------ */

const ELOQUA_METRICS: StudioMetric[] = [
  {
    id: "sends",
    label: "Sends",
    unit: "count",
    better: null,
    formula: "Σ total sends",
  },
  {
    id: "delivered",
    label: "Delivered",
    unit: "count",
    better: null,
    formula: "Σ total delivered",
  },
  {
    id: "deliveryRate",
    label: "Delivery rate",
    unit: "percent",
    better: "higher",
    formula: "Σ delivered / Σ sends",
  },
  {
    id: "openRate",
    label: "Unique open rate",
    unit: "percent",
    better: "higher",
    formula: "Σ unique opens / Σ delivered (machine opens may inflate it)",
  },
  {
    id: "clickRate",
    label: "Unique click rate",
    unit: "percent",
    better: "higher",
    formula: "Σ unique clicks / Σ delivered",
  },
  {
    id: "clickToOpen",
    label: "Click-to-open",
    unit: "percent",
    better: "higher",
    formula: "Σ unique clicks / Σ unique opens",
  },
  {
    id: "bounceRate",
    label: "Bounce rate",
    unit: "percent",
    better: "lower",
    formula: "Σ (hard + soft bounces) / Σ sends",
  },
  {
    id: "unsubRate",
    label: "Unsubscribe rate",
    unit: "percent",
    better: "lower",
    formula: "Σ unsubscribes / Σ delivered",
  },
  {
    id: "formRate",
    label: "Form submits per click",
    unit: "percent",
    better: "higher",
    formula: "Σ form submissions / Σ unique clicks",
  },
  {
    id: "leads",
    label: "Leads",
    unit: "count",
    better: "higher",
    formula: "Leads with this campaign, created in the period",
  },
  {
    id: "mqls",
    label: "MQLs",
    unit: "count",
    better: "higher",
    formula: "Of those leads, with an MQL date",
  },
  {
    id: "opportunities",
    label: "Opportunities",
    unit: "count",
    better: "higher",
    formula: "Opportunities with this campaign, created in the period",
  },
  {
    id: "pipeline",
    label: "Open pipeline",
    unit: "money",
    better: "higher",
    formula: "Σ amount of open opportunities (account currency only)",
  },
  {
    id: "won",
    label: "Won revenue",
    unit: "money",
    better: "higher",
    formula: "Σ amount of won opportunities (account currency only)",
  },
  {
    id: "winRate",
    label: "Win rate",
    unit: "percent",
    better: "higher",
    formula: "Won / (won + lost) closed opportunities",
  },
];

function eloquaStudio(
  source: Source,
  all: RecordData[],
  input: StudioInput,
): Studio {
  const { periodStart: ps, periodEnd: pe } = input;
  const by = (t: string) => all.filter((r) => r.type === t);
  const campaigns = by("campaign");
  const metricsRows = by("campaign_metrics").filter(
    (r) =>
      (!ps || text(r.periodStart) >= ps) && (!pe || text(r.periodEnd) <= pe),
  );
  const leads = by("lead").filter((r) => within(r.createdAt, ps, pe));
  const opps = by("opportunity").filter((r) => within(r.createdAt, ps, pe));
  const assets = by("asset");
  const steps = by("step");
  const members = by("step_membership");
  const events = by("marketing_event");
  const registrants = by("event_registrant");
  const ids = new Set([
    ...campaigns.map((c) => c.id),
    ...metricsRows.map((r) => text(r.campaignId)),
  ]);
  const notes: string[] = [];
  const otherCurrency = opps.filter(
    (o) => present(o.currency) && text(o.currency) !== source.currency,
  ).length;
  if (otherCurrency)
    notes.push(
      `${otherCurrency} opportunities in another currency are left out of pipeline and revenue (currencies are never mixed).`,
    );
  const entities: StudioEntity[] = [];
  for (const cid of ids) {
    if (!cid) continue;
    const c = campaigns.find((x) => x.id === cid);
    const m = metricsRows.filter((r) => text(r.campaignId) === cid);
    const sends = sum(m, "totalSends"),
      delivered = sum(m, "totalDelivered"),
      opens = sum(m, "uniqueOpens"),
      clicks = sum(m, "uniqueClicks"),
      unsubs = sum(m, "unsubscribes"),
      forms = sum(m, "formSubmissions");
    const hard = sum(m, "hardBounces"),
      soft = sum(m, "softBounces");
    const bounces =
      hard === null && soft === null ? null : (hard || 0) + (soft || 0);
    const cl = leads.filter((l) => text(l.campaignId) === cid);
    const co = opps.filter(
      (o) =>
        text(o.campaignId) === cid &&
        (!present(o.currency) || text(o.currency) === source.currency),
    );
    const isWon = (o: RecordData) =>
      /won/i.test(text(o.outcome) || text(o.stage));
    const isLost = (o: RecordData) =>
      /lost/i.test(text(o.outcome) || text(o.stage));
    const won = co.filter(isWon),
      lost = co.filter(isLost),
      open = co.filter((o) => !isWon(o) && !isLost(o));
    const hasSales = cl.length > 0 || co.length > 0;
    const values: Record<string, number | null> = {
      sends,
      delivered,
      deliveryRate: rate(delivered, sends),
      openRate: rate(opens, delivered),
      clickRate: rate(clicks, delivered),
      clickToOpen: rate(clicks, opens),
      bounceRate: rate(bounces, sends),
      unsubRate: rate(unsubs, delivered),
      formRate: rate(forms, clicks),
      leads: hasSales || m.length ? cl.length : null,
      mqls: cl.length
        ? cl.filter((l) => present(l.mqlAt)).length
        : hasSales
          ? 0
          : null,
      opportunities: hasSales || m.length ? co.length : null,
      pipeline: co.length ? (sum(open, "amount") ?? 0) : null,
      won: co.length ? (sum(won, "amount") ?? 0) : null,
      winRate: rate(won.length, won.length + lost.length || null),
    };
    const sample: Record<string, number | null> = {
      deliveryRate: sends,
      openRate: delivered,
      clickRate: delivered,
      clickToOpen: opens,
      bounceRate: sends,
      unsubRate: delivered,
      formRate: clicks,
      winRate: won.length + lost.length,
    };
    // Monthly delivered and clicks, oldest first.
    const months = new Map<string, { delivered: number; clicks: number }>();
    for (const r of m) {
      const k = text(r.periodStart).slice(0, 7);
      if (!k) continue;
      const cur = months.get(k) || { delivered: 0, clicks: 0 };
      cur.delivered += num(r.totalDelivered) || 0;
      cur.clicks += num(r.uniqueClicks) || 0;
      months.set(k, cur);
    }
    const trend =
      months.size >= 1
        ? {
            title: "Delivered and unique clicks by month",
            type: (months.size > 1 ? "line" : "bar") as ChartSpec["type"],
            x: "label",
            unit: "count" as const,
            series: [
              { key: "delivered", label: "Delivered" },
              { key: "clicks", label: "Unique clicks" },
            ],
            data: [...months.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => ({ label: monthLabel(k), ...v })),
          }
        : undefined;
    const flow = nurtureFlow(
      steps.filter((s) => text(s.campaignId) === cid),
      members.filter((s) => text(s.campaignId) === cid),
    );
    const related: StudioEntity["related"] = [];
    const ca = assets.filter((a) => text(a.campaignId) === cid);
    if (ca.length)
      related.push({
        title: "Assets",
        items: ca.map((a) => ({
          label: text(a.name) || a.id,
          detail: [
            text(a.assetType),
            present(a.subject) ? `Subject: ${text(a.subject)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
      });
    const ce = events.filter((e) => text(e.campaignId) === cid);
    if (ce.length)
      related.push({
        title: "Events",
        items: ce.map((e) => {
          const regs = registrants.filter(
            (r) =>
              text(r.eventId) === e.id &&
              r.cancelled !== true &&
              text(r.cancelled) !== "true",
          );
          const att = regs.filter(
            (r) => r.attended === true || text(r.attended) === "true",
          );
          return {
            label: text(e.name) || e.id,
            detail: `${regs.length} registered · ${att.length} attended`,
          };
        }),
      });
    entities.push({
      key: "campaign:" + cid,
      scopeKey: "campaign:" + cid,
      label: text(c?.name) || cid,
      group: text(c?.channel) || "email",
      tags: [
        text(c?.campaignType),
        text(c?.objective),
        text(c?.status),
        c?.startDate ? `${day(c.startDate)} → ${day(c.endDate) || "open"}` : "",
      ].filter(Boolean),
      values,
      sample,
      trend,
      flow,
      related,
      previews: ca
        .filter((a) => present(a.html))
        .slice(0, 5)
        .map((a) => ({
          name: text(a.name) || a.id,
          subject: text(a.subject),
          html: text(a.html).slice(0, 200_000),
        })),
    });
  }
  const channels = [...new Set(entities.map((e) => e.group))];
  return {
    app: "eloqua",
    entityLabel: "Campaign",
    entityPlural: "Campaigns",
    groups: channels.map((g) => ({ id: g, label: g })),
    metrics: ELOQUA_METRICS,
    headline: [
      "delivered",
      "openRate",
      "clickRate",
      "bounceRate",
      "leads",
      "pipeline",
      "won",
    ],
    entities,
    flows: [],
    currency: source.currency,
    asOf: input.asOf,
    datasetId: input.datasetId,
    notes,
  };
}

/** Steps as columns by distance from the entry step; contacts per step and per path. */
function nurtureFlow(steps: RecordData[], members: RecordData[]) {
  if (steps.length < 2) return undefined;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const next = (s: RecordData) =>
    text(s.nextStepIds)
      .split(/[;,|]/)
      .map((x) => x.trim())
      .filter((x) => byId.has(x));
  const depth = new Map<string, number>();
  const entries = steps.filter(
    (s) => s.isEntry === true || text(s.isEntry) === "true",
  );
  const queue = (entries.length ? entries : [steps[0]!]).map((s) => s.id);
  queue.forEach((id) => depth.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of next(byId.get(id)!))
      if (!depth.has(n)) {
        depth.set(n, depth.get(id)! + 1);
        queue.push(n);
      }
  }
  for (const s of steps) if (!depth.has(s.id)) depth.set(s.id, 0);
  const contacts = new Map<string, Set<string>>();
  for (const m of members) {
    const set = contacts.get(text(m.stepId)) || new Set<string>();
    set.add(text(m.contactId));
    contacts.set(text(m.stepId), set);
  }
  const maxDepth = Math.max(...depth.values());
  const flow: Flow & { title: string } = {
    title: "Nurture flow: contacts per step",
    columns: Array.from({ length: maxDepth + 1 }, (_, i) =>
      i === 0 ? "Entry" : `Step ${i + 1}`,
    ),
    nodes: steps.map((s) => ({
      id: s.id,
      label: text(s.name) || s.id,
      column: depth.get(s.id)!,
      value: contacts.get(s.id)?.size ?? 0,
    })),
    links: steps.flatMap((s) =>
      next(s).map((n) => {
        const a = contacts.get(s.id) || new Set<string>(),
          b = contacts.get(n) || new Set<string>();
        return {
          from: s.id,
          to: n,
          value: [...b].filter((x) => a.has(x)).length,
        };
      }),
    ),
    unit: "contacts",
    note: "Contacts recorded in each step; a path shows contacts recorded in both steps.",
  };
  return flow;
}

/* ------------------------------------ Infinity ------------------------------------ */

const INFINITY_METRICS: StudioMetric[] = [
  {
    id: "views",
    label: "Page views",
    unit: "count",
    better: null,
    formula: "Σ page views (saved report)",
  },
  {
    id: "entries",
    label: "Entries",
    unit: "count",
    better: null,
    formula: "Σ entries (saved report)",
  },
  {
    id: "bounceRate",
    label: "Single-page (bounce) rate",
    unit: "percent",
    better: "lower",
    formula: "Σ bounces / Σ entries",
  },
  {
    id: "exitRate",
    label: "Exit rate",
    unit: "percent",
    better: "lower",
    formula: "Σ exits / Σ page views",
  },
  {
    id: "avgTime",
    label: "Average time on page",
    unit: "seconds",
    better: "higher",
    formula: "Σ time on page / Σ timed page views",
  },
  {
    id: "sessions",
    label: "Sessions",
    unit: "count",
    better: null,
    formula: "Distinct sessions with events on this page / in this segment",
  },
  {
    id: "conversion",
    label: "Session conversion",
    unit: "percent",
    better: "higher",
    formula: "Sessions with the conversion event / sessions",
  },
  {
    id: "pagesPerSession",
    label: "Pages per session",
    unit: "count",
    better: "higher",
    formula: "Distinct pages per session (events), averaged over sessions",
  },
  {
    id: "sessionTime",
    label: "Time per session",
    unit: "seconds",
    better: "higher",
    formula: "Last − first event, over sessions with at least two events",
  },
];

function infinityStudio(
  source: Source,
  all: RecordData[],
  input: StudioInput,
): Studio {
  const { periodStart: ps, periodEnd: pe } = input;
  const pm = all.filter(
    (r) =>
      r.type === "page_metrics" &&
      (!ps || text(r.periodStart) >= ps) &&
      (!pe || text(r.periodEnd) <= pe),
  );
  const events = all
    .filter((r) => r.type === "event" && within(r.timestamp, ps, pe))
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
  const conv = text(source.policy?.conversionEvent) || "";
  const notes: string[] = [];
  if (!conv)
    notes.push(
      "No conversion event is set in the source policy, so session conversion is unavailable.",
    );
  // Sessions: ordered events.
  const sessions = new Map<string, RecordData[]>();
  for (const e of events) {
    const k = text(e.sessionId);
    if (!k) continue;
    sessions.set(k, [...(sessions.get(k) || []), e]);
  }
  const converted = (evs: RecordData[]) =>
    conv ? evs.some((e) => text(e.event) === conv) : false;
  const sessionStats = (list: RecordData[][]) => {
    const n = list.length;
    const timed = list.filter((s) => s.length >= 2);
    const dur = timed.reduce(
      (t, s) =>
        t + (ms(s[s.length - 1]!.timestamp) - ms(s[0]!.timestamp)) / 1000,
      0,
    );
    const pages = list.reduce(
      (t, s) => t + new Set(s.map((e) => text(e.page)).filter(Boolean)).size,
      0,
    );
    return {
      sessions: n || null,
      conversion: conv ? rate(list.filter(converted).length, n) : null,
      pagesPerSession: n ? pages / n : null,
      sessionTime: timed.length ? dur / timed.length : null,
      timed: timed.length,
    };
  };
  // Page paths (consecutive duplicates collapsed).
  const paths = [...sessions.values()].map((evs) => {
    const p: string[] = [];
    for (const e of evs) {
      const pg = text(e.page);
      if (pg && p[p.length - 1] !== pg) p.push(pg);
    }
    return p;
  });
  const pages = [
    ...new Set(
      [
        ...pm.map((r) => text(r.page)),
        ...events.map((e) => text(e.page)),
      ].filter(Boolean),
    ),
  ];
  const entities: StudioEntity[] = [];
  for (const page of pages) {
    const rows = pm.filter((r) => text(r.page) === page);
    const views = sum(rows, "pageViews"),
      entries = sum(rows, "entries"),
      exits = sum(rows, "exits"),
      bounces = sum(rows, "bounces"),
      time = sum(rows, "timeOnPageSeconds"),
      timedViews = sum(rows, "timedPageViews");
    const onPage = [...sessions.values()].filter((s) =>
      s.some((e) => text(e.page) === page),
    );
    const st = sessionStats(onPage);
    // Where visitors came from and went next.
    const prev = new Map<string, number>(),
      nxt = new Map<string, number>();
    for (const p of paths)
      p.forEach((pg, i) => {
        if (pg !== page) return;
        const a = i === 0 ? "Entered here" : p[i - 1]!;
        const b = i === p.length - 1 ? "Left the site" : p[i + 1]!;
        prev.set(a, (prev.get(a) || 0) + 1);
        nxt.set(b, (nxt.get(b) || 0) + 1);
      });
    const top = (m: Map<string, number>, col: number, prefix: string) => {
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
      const keep = sorted.slice(0, 5);
      const rest = sorted.slice(5).reduce((t, [, v]) => t + v, 0);
      if (rest) keep.push(["Other pages", rest]);
      return keep.map(([label, value]) => ({
        id: prefix + label,
        label,
        column: col,
        value,
      }));
    };
    const before = top(prev, 0, "from:"),
      after = top(nxt, 2, "to:");
    const through = [...prev.values()].reduce((t, v) => t + v, 0);
    const flow =
      through > 0
        ? {
            title: "Where visitors came from and went next",
            columns: ["Came from", "This page", "Went to"],
            nodes: [
              ...before,
              { id: "page", label: page, column: 1, value: through },
              ...after,
            ],
            links: [
              ...before.map((n) => ({
                from: n.id,
                to: "page",
                value: n.value,
              })),
              ...after.map((n) => ({ from: "page", to: n.id, value: n.value })),
            ],
            unit: "visits",
            note: "Page-to-page steps in sessions (events). Repeated views of the same page in a row count once.",
          }
        : undefined;
    // Events on this page per day.
    const perDay = new Map<string, number>();
    for (const e of events)
      if (text(e.page) === page)
        perDay.set(day(e.timestamp), (perDay.get(day(e.timestamp)) || 0) + 1);
    const trend =
      perDay.size > 1
        ? {
            title: "Events on this page per day",
            type: "area" as const,
            x: "label",
            unit: "count" as const,
            series: [{ key: "events", label: "Events" }],
            data: [...perDay.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([d, v]) => ({ label: dayLabel(d), events: v })),
          }
        : undefined;
    const devices = rows.map((r) => text(r.device)).filter(Boolean);
    entities.push({
      key: "page:" + page,
      label: page,
      group: "pages",
      tags: devices.length
        ? ["Devices: " + [...new Set(devices)].join(", ")]
        : ["From events only"],
      values: {
        views,
        entries,
        bounceRate: rate(bounces, entries),
        exitRate: rate(exits, views),
        avgTime: timedViews ? (time ?? 0) / timedViews : null,
        sessions: st.sessions,
        conversion: st.conversion,
        pagesPerSession: st.pagesPerSession,
        sessionTime: st.sessionTime,
      },
      sample: {
        bounceRate: entries,
        exitRate: views,
        avgTime: timedViews,
        conversion: st.sessions,
        sessionTime: st.timed,
      },
      trend,
      flow,
    });
  }
  // Busiest pages first (sessions in events, then saved-report views).
  entities.sort(
    (a, b) =>
      (b.values.sessions ?? 0) - (a.values.sessions ?? 0) ||
      (b.values.views ?? 0) - (a.values.views ?? 0),
  );
  // Segments: device and channel, from events.
  for (const dim of ["device", "channel"]) {
    const values = [
      ...new Set(events.map((e) => text(e[dim])).filter(Boolean)),
    ];
    for (const v of values) {
      const list = [...sessions.values()].filter((s) => text(s[0]![dim]) === v);
      const st = sessionStats(list);
      entities.push({
        key: `cohort:${dim}=${v}`,
        scopeKey: `cohort:${dim}=${v}`,
        label: `${dim === "device" ? "Device" : "Channel"}: ${v}`,
        group: "segments",
        tags: [`Sessions whose first event has ${dim} = ${v}`],
        values: {
          views: null,
          entries: null,
          bounceRate: null,
          exitRate: null,
          avgTime: null,
          sessions: st.sessions,
          conversion: st.conversion,
          pagesPerSession: st.pagesPerSession,
          sessionTime: st.sessionTime,
        },
        sample: { conversion: st.sessions, sessionTime: st.timed },
      });
    }
  }
  // Site journey: entry page → second → third page.
  const flows: Studio["flows"] = [];
  if (paths.length) {
    const cols = ["Entry page", "2nd page", "3rd page"];
    const topBy = (i: number) => {
      const c = new Map<string, number>();
      for (const p of paths) if (p[i]) c.set(p[i]!, (c.get(p[i]!) || 0) + 1);
      return new Set(
        [...c.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k]) => k),
      );
    };
    const keep = cols.map((_, i) => topBy(i));
    const label = (i: number, p: string[]) =>
      p[i] === undefined
        ? "Left the site"
        : keep[i]!.has(p[i]!)
          ? p[i]!
          : "Other pages";
    const nodes = new Map<
      string,
      { id: string; label: string; column: number; value: number }
    >();
    const links = new Map<
      string,
      { from: string; to: string; value: number }
    >();
    for (const p of paths) {
      let prevId: string | null = null;
      for (let i = 0; i < cols.length; i++) {
        const l = label(i, p);
        const id = `${i}:${l}`;
        const n = nodes.get(id) || { id, label: l, column: i, value: 0 };
        n.value++;
        nodes.set(id, n);
        if (prevId) {
          const k = prevId + "→" + id;
          const lk = links.get(k) || { from: prevId, to: id, value: 0 };
          lk.value++;
          links.set(k, lk);
        }
        if (l === "Left the site") break;
        prevId = id;
      }
    }
    flows.push({
      id: "journey",
      title: "Visitor journeys: first three pages",
      about:
        'How sessions move from their entry page to the next pages, from events. The widest paths are where most visitors go; "Left the site" shows where journeys end.',
      flow: {
        columns: cols,
        nodes: [...nodes.values()],
        links: [...links.values()],
        unit: "sessions",
        note: 'Top six pages per step; the rest are grouped as "Other pages".',
      },
    });
  }
  return {
    app: "infinity",
    entityLabel: "Page",
    entityPlural: "Pages and segments",
    groups: [
      { id: "pages", label: "Pages" },
      { id: "segments", label: "Segments (device, channel)" },
    ],
    metrics: INFINITY_METRICS,
    headline: [
      "views",
      "bounceRate",
      "exitRate",
      "avgTime",
      "sessions",
      "conversion",
    ],
    entities,
    flows,
    currency: source.currency,
    asOf: input.asOf,
    datasetId: input.datasetId,
    notes,
  };
}

/* ------------------------------------ Unity ------------------------------------ */

const UNITY_METRICS: StudioMetric[] = [
  {
    id: "members",
    label: "Members (local)",
    unit: "count",
    better: null,
    formula: "Distinct members in the membership export",
  },
  {
    id: "reported",
    label: "Members (Unity reported)",
    unit: "count",
    better: null,
    formula: "Count reported by Unity for the segment",
  },
  {
    id: "ready",
    label: "Ready for destination",
    unit: "percent",
    better: "higher",
    formula: "Members with every required field and valid consent / members",
  },
  {
    id: "consentGranted",
    label: "Valid consent",
    unit: "percent",
    better: "higher",
    formula:
      "Members with granted, unexpired consent for the destination's channel and purpose / members",
  },
  {
    id: "missingFields",
    label: "Missing required data",
    unit: "count",
    better: "lower",
    formula: "Members missing at least one required field",
  },
  {
    id: "consentUnknown",
    label: "No consent record",
    unit: "count",
    better: "lower",
    formula:
      "Members with no consent record for the destination's channel and purpose",
  },
  {
    id: "consentBlocked",
    label: "Denied or expired consent",
    unit: "count",
    better: "lower",
    formula: "Members whose latest consent is denied or expired",
  },
];

/** One merged view per master profile: latest non-empty value per field. */
export function masterProfiles(all: RecordData[]) {
  const masters = new Map<
    string,
    { id: string; records: RecordData[]; fields: Record<string, string> }
  >();
  for (const p of all.filter((r) => r.type === "profile")) {
    const k = text(p.masterId) || "source:" + p.id;
    const m = masters.get(k) || { id: k, records: [], fields: {} };
    m.records.push(p);
    masters.set(k, m);
  }
  for (const m of masters.values()) {
    const ordered = [...m.records].sort(
      (a, b) => (ms(a.updatedAt) || 0) - (ms(b.updatedAt) || 0),
    );
    for (const r of ordered)
      for (const [k, v] of Object.entries(r))
        if (
          !["type", "id", "masterId", "sourceSystem", "updatedAt"].includes(
            k,
          ) &&
          present(v)
        )
          m.fields[k] = text(v);
  }
  return masters;
}

/** Latest consent per master, channel and purpose, judged at the snapshot time. */
export function consentState(all: RecordData[], asOf: string) {
  const latest = new Map<string, RecordData>();
  for (const c of all.filter((r) => r.type === "consent")) {
    const k = `${text(c.masterId)}|${text(c.channel)}|${text(c.purpose)}`;
    const cur = latest.get(k);
    if (!cur || (ms(c.effectiveDate) || 0) >= (ms(cur.effectiveDate) || 0))
      latest.set(k, c);
  }
  const at = ms(asOf);
  return (masterId: string, channel: string, purpose: string) => {
    const c = latest.get(`${masterId}|${channel}|${purpose}`);
    if (!c) return "unknown" as const;
    if (present(c.expiresAt) && ms(c.expiresAt) < at) return "expired" as const;
    return /granted|opt.?in|yes/i.test(text(c.status))
      ? ("granted" as const)
      : ("denied" as const);
  };
}

function unityStudio(
  source: Source,
  all: RecordData[],
  input: StudioInput,
): Studio {
  const masters = masterProfiles(all);
  const consent = consentState(all, input.asOf);
  const destinations = new Map(
    all.filter((r) => r.type === "destination").map((d) => [d.id, d]),
  );
  const segments = all.filter((r) => r.type === "segment");
  const membership = all.filter((r) => r.type === "membership");
  const entities: StudioEntity[] = [];
  for (const s of segments) {
    const dest = destinations.get(text(s.destinationId));
    const req = text(dest?.requiredFields)
      .split(/[;,|]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const ch = text(dest?.consentChannel),
      pu = text(dest?.consentPurpose);
    const ids = [
      ...new Set(
        membership
          .filter((m) => text(m.segmentId) === s.id)
          .map((m) => text(m.memberId)),
      ),
    ];
    let ready = 0,
      missing = 0,
      unknown = 0,
      blocked = 0,
      granted = 0;
    const missingBy = new Map<string, number>();
    for (const id of ids) {
      const f = masters.get(id)?.fields || {};
      const lacks = req.filter((k) => !present(f[k]));
      lacks.forEach((k) => missingBy.set(k, (missingBy.get(k) || 0) + 1));
      const c = dest && ch ? consent(id, ch, pu) : "unknown";
      if (lacks.length) missing++;
      if (c === "unknown") unknown++;
      else if (c === "granted") granted++;
      else blocked++;
      if (!lacks.length && c === "granted") ready++;
    }
    const n = ids.length;
    const withData = n - missing;
    const flow: (Flow & { title: string }) | undefined = n
      ? {
          title: "Why members are or are not ready",
          columns: [
            "Audience",
            "Checks",
            dest ? "Destination" : "Destination (not set)",
          ],
          nodes: [
            { id: "aud", label: text(s.name) || s.id, column: 0, value: n },
            {
              id: "missing",
              label: "Missing required data",
              column: 1,
              value: missing,
            },
            {
              id: "consent",
              label: "Data complete, no valid consent",
              column: 1,
              value: withData - ready,
            },
            { id: "ready", label: "Ready", column: 1, value: ready },
            {
              id: "dest",
              label: text(dest?.name) || "No destination",
              column: 2,
              value: ready,
            },
          ].filter((x) => x.value > 0 || x.id === "aud"),
          links: [
            { from: "aud", to: "missing", value: missing },
            { from: "aud", to: "consent", value: withData - ready },
            { from: "aud", to: "ready", value: ready },
            { from: "ready", to: "dest", value: ready },
          ].filter((l) => l.value > 0),
          unit: "members",
          note: "A member missing data is counted there even if consent is also missing.",
        }
      : undefined;
    const related: StudioEntity["related"] = [];
    if (missingBy.size)
      related.push({
        title: "Missing required fields",
        items: [...missingBy.entries()].map(([k, v]) => ({
          label: k,
          detail: `${v} members`,
        })),
      });
    if (dest)
      related.push({
        title: "Destination",
        items: [
          {
            label: text(dest.name) || dest.id,
            detail: `Requires ${req.join(", ") || "no fields"}; consent ${ch || "?"} / ${pu || "?"}`,
          },
        ],
      });
    entities.push({
      key: "segment:" + s.id,
      scopeKey: "segment:" + s.id,
      label: text(s.name) || s.id,
      group: "audiences",
      tags: [
        text(s.identityLevel) ? `Identity: ${text(s.identityLevel)}` : "",
        s.membershipComplete === false || text(s.membershipComplete) === "false"
          ? "Membership export incomplete"
          : "",
        present(s.snapshotAt) ? `Snapshot ${day(s.snapshotAt)}` : "",
      ].filter(Boolean),
      values: {
        members: n,
        reported: num(s.reportedCount),
        ready: rate(ready, n),
        consentGranted: dest ? rate(granted, n) : null,
        missingFields: dest ? missing : null,
        consentUnknown: dest ? unknown : null,
        consentBlocked: dest ? blocked : null,
      },
      sample: { ready: n, consentGranted: n },
      flow,
      related,
    });
  }
  // Identity flow: source systems → master profiles → audiences.
  const flows: Studio["flows"] = [];
  const profiles = all.filter((r) => r.type === "profile");
  if (profiles.length) {
    const systems = new Map<string, Set<string>>();
    let unlinked = 0;
    for (const p of profiles) {
      if (!present(p.masterId)) {
        unlinked++;
        continue;
      }
      const sys = text(p.sourceSystem) || "unknown system";
      const set = systems.get(sys) || new Set<string>();
      set.add(text(p.masterId));
      systems.set(sys, set);
    }
    const linked = [...masters.keys()].filter((k) => !k.startsWith("source:"));
    const inAudience = new Set(membership.map((m) => text(m.memberId)));
    const nodes: Flow["nodes"] = [
      ...[...systems.entries()].map(([k, v]) => ({
        id: "sys:" + k,
        label: k,
        column: 0,
        value: v.size,
      })),
      {
        id: "masters",
        label: "Master profiles",
        column: 1,
        value: linked.length,
      },
      ...(unlinked
        ? [
            {
              id: "unlinked",
              label: "Unlinked source records",
              column: 1,
              value: unlinked,
            },
          ]
        : []),
      ...segments.map((s) => ({
        id: "seg:" + s.id,
        label: text(s.name) || s.id,
        column: 2,
        value: new Set(
          membership
            .filter((m) => text(m.segmentId) === s.id)
            .map((m) => text(m.memberId)),
        ).size,
      })),
      {
        id: "none",
        label: "In no audience",
        column: 2,
        value: linked.filter((k) => !inAudience.has(k)).length,
      },
    ];
    flows.push({
      id: "identity",
      title: "Identity: source systems → master profiles → audiences",
      about:
        "How records from each source system resolve into master profiles, and how many master profiles each audience uses. A profile can come from several systems and be in several audiences, so the columns do not add up.",
      flow: {
        columns: ["Source systems", "Profiles", "Audiences"],
        nodes,
        links: [
          ...[...systems.entries()].map(([k, v]) => ({
            from: "sys:" + k,
            to: "masters",
            value: v.size,
          })),
          ...nodes
            .filter((n) => n.column === 2)
            .map((n) => ({ from: "masters", to: n.id, value: n.value })),
        ],
        unit: "profiles",
      },
    });
  }
  return {
    app: "unity",
    entityLabel: "Audience",
    entityPlural: "Audiences",
    groups: [{ id: "audiences", label: "Audiences" }],
    metrics: UNITY_METRICS,
    headline: [
      "members",
      "ready",
      "consentGranted",
      "missingFields",
      "consentUnknown",
    ],
    entities,
    flows,
    currency: source.currency,
    asOf: input.asOf,
    datasetId: input.datasetId,
    notes: [],
  };
}

/** Customer profile (360): every linked source record, consent and audience for one person. */
export function profile360(all: RecordData[], query: string, asOf: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  const profiles = all.filter((r) => r.type === "profile");
  const hit = profiles.find(
    (p) =>
      text(p.masterId).toLowerCase() === q ||
      p.id.toLowerCase() === q ||
      text(p.email).toLowerCase() === q ||
      text(p.phone).replace(/\s/g, "") === q.replace(/\s/g, ""),
  );
  if (!hit) return null;
  const masterId = text(hit.masterId) || "source:" + hit.id;
  const records = present(hit.masterId)
    ? profiles.filter((p) => text(p.masterId) === masterId)
    : [hit];
  const merged = masterProfiles(records).get(masterId)!;
  const consent = consentState(all, asOf);
  const consents = all
    .filter((r) => r.type === "consent" && text(r.masterId) === masterId)
    .map((c) => ({
      channel: text(c.channel),
      purpose: text(c.purpose),
      status: consent(masterId, text(c.channel), text(c.purpose)),
      effectiveDate: day(c.effectiveDate) || null,
      expiresAt: day(c.expiresAt) || null,
    }));
  const seen = new Set<string>();
  const uniqueConsents = consents.filter((c) => {
    const k = c.channel + "|" + c.purpose;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const segments = new Map(
    all.filter((r) => r.type === "segment").map((s) => [s.id, s]),
  );
  const destinations = new Map(
    all.filter((r) => r.type === "destination").map((d) => [d.id, d]),
  );
  const audiences = all
    .filter((r) => r.type === "membership" && text(r.memberId) === masterId)
    .map((m) => {
      const s = segments.get(text(m.segmentId));
      const d = destinations.get(text(s?.destinationId));
      const req = text(d?.requiredFields)
        .split(/[;,|]/)
        .map((x) => x.trim())
        .filter(Boolean);
      const lacks = req.filter((k) => !present(merged.fields[k]));
      const c = d
        ? consent(masterId, text(d.consentChannel), text(d.consentPurpose))
        : "unknown";
      return {
        name: text(s?.name) || text(m.segmentId),
        destination: text(d?.name) || null,
        ready: !!d && !lacks.length && c === "granted",
        blockers: [
          ...lacks.map((k) => `missing ${k}`),
          ...(d && c !== "granted" ? [`consent ${c}`] : []),
        ],
      };
    });
  return {
    masterId: present(hit.masterId) ? masterId : null,
    fields: merged.fields,
    records: records.map((r) => ({
      id: r.id,
      sourceSystem: text(r.sourceSystem) || null,
      updatedAt: text(r.updatedAt) || null,
      fields: Object.fromEntries(
        Object.entries(r).filter(
          ([k]) => !["type", "id", "masterId"].includes(k),
        ),
      ),
    })),
    consents: uniqueConsents,
    audiences,
  };
}
