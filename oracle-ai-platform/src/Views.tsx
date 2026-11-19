import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ClipboardList,
  FileText,
  Sparkles,
  Info,
  MessageSquare,
  Microscope,
  Search,
  Send,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from "lucide-react";
import { api } from "./api";
import { ChartView } from "./Charts";
import {
  Button,
  Panel,
  Field,
  ErrorBox,
  Empty,
  Loading,
  value,
  date,
} from "./ui";
import {
  QUESTIONS,
  product,
  type Report,
  type Source,
  type Finding,
  type Metric,
  type Section,
  type ChartSpec,
  type Session,
} from "../shared/catalog";

export const HEADLINES: Record<string, string[]> = {
  eloqua: [
    "total_sends",
    "unique_click_rate",
    "bounce_rate",
    "leads_created",
    "mql_to_sal",
    "open_pipeline",
    "won_revenue",
    "win_rate",
    "event_attendance_rate",
    "web_visits",
    "ctor",
    "unsubscribe_rate",
  ],
  unity: [
    "source_records",
    "link_coverage",
    "completeness",
    "ready_members",
    "duplicate_candidates",
    "failed_jobs",
  ],
  infinity: [
    "event_sessions",
    "event_conversion_rate",
    "web_single_page_rate",
    "web_median_session_seconds",
    "web_avg_time_on_page_seconds",
    "web_report_bounce_rate",
    "web_report_avg_time_seconds",
    "report_sessions",
    "report_conversion_rate",
    "tracking_issues",
    "daily_events",
  ],
};
const fmtCell = (v: unknown, unit?: string, currency?: string) => {
  if (v === null || v === undefined || v === "")
    return <span className="muted">Unavailable</span>;
  if (["percent", "count", "money", "seconds", "days"].includes(unit || ""))
    return value({ value: String(v), unit, currency } as Metric);
  return String(v);
};
const STATE_LABEL: Record<string, string> = {
  observed: "Observed",
  partial: "Partial data",
  unavailable: "Unavailable",
  not_applicable: "Not applicable",
};

export function ContextHeader({
  report,
  source,
}: {
  report: Report;
  source: Source;
}) {
  const ageDays = (Date.now() - Date.parse(report.asOf)) / 86_400_000;
  const meta: any = report.sourceMetadata || {};
  return (
    <div className="context-strip" aria-label="Assessment context">
      <span>
        <b>Source</b> {source.name} ({source.environment || "production"})
      </span>
      <span>
        <b>Dataset</b> {meta.datasetName || report.datasetId.slice(0, 8)} ·{" "}
        {report.sourceMode === "upload"
          ? "uploaded export"
          : report.sourceMode === "stream"
            ? "stream window"
            : "connected snapshot"}
      </span>
      <span>
        <b>Period</b> {report.period?.start || "all"} –{" "}
        {report.period?.end || "all"}
      </span>
      <span>
        <b>Timezone</b> {report.timezone}
      </span>
      <span
        className={
          ageDays > Number(source.policy.staleDays ?? 30) ? "stale" : ""
        }
      >
        <b>Data as of</b> {date(report.asOf)} (
        {ageDays < 1 ? "today" : Math.floor(ageDays) + " days old"})
      </span>
      <span>
        <b>Coverage</b>{" "}
        {meta.completeness === "partial"
          ? "partial snapshot"
          : `${(report.capabilities || []).filter((c) => c.state !== "available").length} capability gaps`}
      </span>
    </div>
  );
}

export function MetricTable({
  report,
  ids,
}: {
  report: Report;
  ids?: string[];
}) {
  const rows = ids
    ? report.metrics.filter((m) => ids.includes(m.id))
    : report.metrics;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Measure</th>
            <th>Value</th>
            <th>Status</th>
            <th>Definition and evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.label}</td>
              <td className={m.value === null ? "muted" : "numeric"}>
                {value(m)}
              </td>
              <td>
                <span className={"badge state-" + (m.state || "observed")}>
                  {STATE_LABEL[m.state || "observed"]}
                </span>
              </td>
              <td>
                <details>
                  <summary>Inspect calculation</summary>
                  <p>{m.formula}</p>
                  {m.reason && <p className="muted">{m.reason}</p>}
                  <small>
                    {m.grain && `Grain: ${m.grain} · `}
                    {m.basis && `Basis: ${m.basis} · `}
                    {m.recordIds.length} source references ·{" "}
                    {m.version || report.definitionVersion}
                  </small>
                  {m.recordIds.length > 0 && (
                    <p className="code-list">
                      {m.recordIds.slice(0, 12).join(", ")}
                      {m.recordIds.length > 12 ? " …" : ""}
                    </p>
                  )}
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SectionView({
  s,
  currency,
}: {
  s: Section;
  currency?: string;
}) {
  if (s.kind === "table")
    return (
      <Panel title={s.title} subtitle={s.subtitle}>
        {s.about && <p className="about">{s.about}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {s.columns!.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows!.map((r, i) => (
                <tr key={String(r.key ?? i)}>
                  {s.columns!.map((c) => (
                    <td key={c.key} className={c.unit ? "numeric" : ""}>
                      {fmtCell(r[c.key], c.unit, currency)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!s.rows!.length && <p className="muted">No rows.</p>}
        </div>
        {s.note && <small className="muted">{s.note}</small>}
      </Panel>
    );
  if (s.kind === "chart" && s.chart)
    return (
      <Panel title={s.title} subtitle={s.subtitle}>
        {s.about && <p className="about">{s.about}</p>}
        <ChartView chart={s.chart} title={s.title} currency={currency} />
      </Panel>
    );
  if (s.kind === "checklist")
    return (
      <Panel title={s.title} subtitle={s.subtitle}>
        {s.about && <p className="about">{s.about}</p>}
        <ul className="checklist">
          {s.items!.map((it, i) => (
            <li key={i} className={"check-" + it.state}>
              <span className="badge">
                {it.state === "ok"
                  ? "OK"
                  : it.state === "issue"
                    ? "Issue"
                    : it.state}
              </span>{" "}
              <b>{it.label}</b> — {it.detail}
            </li>
          ))}
        </ul>
      </Panel>
    );
  const bars = s.bars || [];
  const max = Math.max(1, ...bars.map((b) => b.value ?? 0));
  const unit = s.unit === "percent" ? "%" : "";
  return (
    <Panel title={s.title} subtitle={s.subtitle}>
      <div
        className={"barchart " + (s.kind === "funnel" ? "funnel" : "")}
        role="img"
        aria-label={
          s.title +
          ": " +
          bars
            .map((b) => `${b.label} ${b.value ?? "unavailable"}${unit}`)
            .join("; ")
        }
      >
        {bars.map((b, i) => (
          <div
            className="bar-row"
            key={i}
            title={`${b.label}: ${b.value === null ? "unavailable" : b.value + unit}${b.note ? " · " + b.note : ""}`}
          >
            <span className="bar-label">{b.label}</span>
            <span className="bar-track">
              {b.value === null ? (
                <span className="bar-missing">Unavailable</span>
              ) : (
                <span
                  className="bar-fill"
                  style={{ width: `${Math.max(1, (b.value / max) * 100)}%` }}
                />
              )}
            </span>
            <span className="bar-value">
              {b.value === null
                ? "—"
                : new Intl.NumberFormat("en", {
                    maximumFractionDigits: 2,
                  }).format(b.value) + unit}
              {b.note && <small> {b.note}</small>}
            </span>
          </div>
        ))}
      </div>
      <details>
        <summary>Show as table</summary>
        <table>
          <tbody>
            {bars.map((b, i) => (
              <tr key={i}>
                <td>{b.label}</td>
                <td>{b.value === null ? "Unavailable" : b.value + unit}</td>
                <td>{b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {s.note && <small className="muted">{s.note}</small>}
    </Panel>
  );
}

export interface FindingHandlers {
  canWrite: boolean;
  onAction?: (f: Finding) => void;
  onInvestigate?: (f: Finding) => void;
  onDraft?: (f: Finding) => void;
  onFeedback?: (f: Finding, verdict: "useful" | "dismissed") => void;
  /** Open Ask AI with this question and send it. */
  onAsk?: (question: string) => void;
  /** Open Data & connections. */
  onUpload?: () => void;
}
export function FindingCard({
  f,
  report,
  h,
}: {
  f: Finding;
  report: Report;
  h: FindingHandlers;
}) {
  const r = f.recommendation;
  return (
    <article className={"finding severity-" + f.severity}>
      <div className="finding-mark">
        <Info size={18} />
      </div>
      <div>
        <span className="severity">
          #{f.priority?.rank} · {String(f.severity).toUpperCase()} · AUTOMATION{" "}
          {r?.automation}
        </span>
        <h3>{f.title}</h3>
        <p>
          <b>Observed:</b> {f.detail}
        </p>
        <p className="recommendation">
          <b>Proposed action:</b> {f.action}
        </p>
        {r && r.hypotheses.length > 0 && (
          <p className="hypotheses">
            <b>Possible explanations (hypotheses, not proven):</b>{" "}
            {r.hypotheses.join(" · ")}
          </p>
        )}
        {f.caveats && f.caveats.length > 0 && (
          <p className="muted">Caveats: {f.caveats.join(" ")}</p>
        )}
        <details>
          <summary>Evidence and plan</summary>
          <dl className="facts">
            <dt>Rule</dt>
            <dd>
              {f.rule} — {r?.rationale}
            </dd>
            <dt>Evidence</dt>
            <dd>
              {f.evidenceIds
                .map((id) => report.metrics.find((m) => m.id === id))
                .filter(Boolean)
                .map((m) => `${m!.label}: ${value(m!)}`)
                .join("; ") || f.entityScope}
            </dd>
            <dt>Records</dt>
            <dd className="code-list">
              {f.recordIds.slice(0, 10).join(", ") || "Source-level"}
            </dd>
            <dt>Owner role</dt>
            <dd>{r?.ownerRole}</dd>
            <dt>Effort (editable estimate)</dt>
            <dd>{r?.effort}</dd>
            <dt>Data still needed</dt>
            <dd>{r?.dataNeeded.join("; ") || "None"}</dd>
            <dt>Measurement</dt>
            <dd>{r?.measurement}</dd>
            <dt>Permission</dt>
            <dd>{r?.permission}</dd>
            <dt>Uncertainty</dt>
            <dd>{r?.uncertainty}</dd>
            <dt>Priority basis</dt>
            <dd>{f.priority?.basis}</dd>
          </dl>
        </details>
      </div>
      {h.canWrite && (
        <div className="finding-actions">
          {h.onAction && (
            <Button onClick={() => h.onAction!(f)}>
              <ClipboardList size={15} /> Save plan
            </Button>
          )}
          {h.onInvestigate && (
            <Button onClick={() => h.onInvestigate!(f)}>
              <Microscope size={15} /> Investigate
            </Button>
          )}
          {h.onDraft && (
            <Button onClick={() => h.onDraft!(f)}>
              <FileText size={15} /> Draft
            </Button>
          )}
          {h.onFeedback && (
            <span className="button-row">
              <Button
                aria-label="Mark useful"
                onClick={() => h.onFeedback!(f, "useful")}
              >
                <ThumbsUp size={14} />
              </Button>
              <Button
                aria-label="Dismiss with reason"
                onClick={() => h.onFeedback!(f, "dismissed")}
              >
                <ThumbsDown size={14} />
              </Button>
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** Bars and funnels drawn as charts, so every visual uses the same look and table view. */
const dayTick = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
function asChart(s: Section): ChartSpec | null {
  if (s.kind === "chart") return s.chart || null;
  if (
    s.kind === "bars" &&
    s.bars &&
    s.bars.length > 3 &&
    s.bars.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.label))
  )
    // Values per day read best as a trend line, oldest first.
    return {
      type: "area",
      x: "label",
      unit: s.unit === "percent" ? "percent" : "count",
      series: [{ key: "value", label: s.title }],
      data: [...s.bars]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((b) => ({ label: dayTick(b.label), value: b.value })),
    };
  if ((s.kind === "bars" || s.kind === "funnel") && s.bars?.length)
    return {
      type:
        s.kind === "funnel" ||
        s.bars.length > 7 ||
        s.bars.some((b) => b.label.length > 14)
          ? "hbar"
          : "bar",
      x: "label",
      unit: s.unit === "percent" ? "percent" : "count",
      series: [{ key: "value", label: s.title }],
      data: s.bars.map((b) => ({ label: b.label, value: b.value })),
    };
  return null;
}
function ChartCard({
  s,
  report,
  h,
}: {
  s: Section;
  report: Report;
  h: FindingHandlers;
}) {
  const chart = asChart(s)!;
  return (
    <section className="chart-card">
      <header>
        <h3>{s.title}</h3>
        {h.onAsk && (
          <button
            className="ask-chip"
            onClick={() =>
              h.onAsk!(
                `Explain "${s.title}": what stands out, why it matters and what should we do next?`,
              )
            }
          >
            <Sparkles size={13} /> Ask AI about this
          </button>
        )}
      </header>
      {s.about && <p className="about">{s.about}</p>}
      <ChartView chart={chart} title={s.title} currency={report.currency} />
      {s.subtitle && <small className="muted">{s.subtitle}</small>}
    </section>
  );
}

function AiInsights({ report, h }: { report: Report; h: FindingHandlers }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const c = new AbortController();
    api("/reports/" + report.id + "/insights", {}, "POST", c.signal)
      .then(setData)
      .catch((e) => e.name !== "AbortError" && setError(e));
    return () => c.abort();
  }, [report.id]);
  const metric = (id: string) => report.metrics.find((m) => m.id === id);
  return (
    <section className="insights">
      <header>
        <div>
          <span className="eyebrow">
            <Sparkles size={13} /> AI INSIGHTS
          </span>
          <h2>What matters in this data</h2>
        </div>
        {data && (
          <span
            className={"badge " + (data.generator === "ai" ? "ai" : "rules")}
          >
            {data.generator === "ai"
              ? `Written by AI · ${data.model}`
              : "Rule-based (AI not used)"}
          </span>
        )}
      </header>
      {!data && !error && (
        <p className="muted insight-loading">
          <Sparkles size={14} className="spin" /> Reading the evidence…
        </p>
      )}
      <ErrorBox error={error} />
      {data && (
        <>
          <ul className="insight-list">
            {data.statements.slice(0, 6).map((st: any, i: number) => (
              <li key={i} className={"kind-" + st.kind}>
                <span className="badge">{st.kind}</span>
                <p>{st.text}</p>
                <div className="citations">
                  {st.metricIds.map((id: string) => {
                    const m = metric(id);
                    return m ? (
                      <span key={id}>
                        {m.label}: {value(m)}
                      </span>
                    ) : null;
                  })}
                </div>
              </li>
            ))}
          </ul>
          {data.generator !== "ai" && (
            <small className="muted">{data.status}</small>
          )}
          {h.onAsk && (
            <div className="button-row">
              <Button
                onClick={() =>
                  h.onAsk!(
                    "What are the three most valuable actions this week, and which evidence supports each?",
                  )
                }
              >
                <MessageSquare size={15} /> Ask a follow-up
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MissingData({
  caps,
  h,
}: {
  caps: NonNullable<Report["capabilities"]>;
  h: FindingHandlers;
}) {
  const missing = caps.filter((c) => c.state !== "available");
  if (!missing.length) return null;
  return (
    <div className="unlock">
      <Info size={18} />
      <div>
        <b>Add data to complete this view</b>
        <ul>
          {missing.map((c) => (
            <li key={c.id}>
              <b>{c.label}</b>
              {c.state === "partial" ? " (partly available)" : ""}: {c.needs}
            </li>
          ))}
        </ul>
        {h.onUpload && (
          <Button onClick={h.onUpload}>
            Upload data <ArrowRight size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

function GroupView({
  report,
  group,
  h,
}: {
  report: Report;
  group: string;
  h: FindingHandlers;
}) {
  const sections = (report.sections || []).filter((s) => s.group === group);
  const charts = sections.filter((s) => asChart(s));
  const tables = sections.filter((s) => !asChart(s));
  const findings = report.findings.filter((f) => f.group === group);
  const caps = (report.capabilities || []).filter((c) => c.group === group);
  return (
    <>
      <MissingData caps={caps} h={h} />
      {charts.length > 0 && (
        <div className="chart-grid">
          {charts.map((s) => (
            <ChartCard key={s.id} s={s} report={report} h={h} />
          ))}
        </div>
      )}
      {findings.length > 0 && (
        <Panel
          title={`${group}: recommendations`}
          subtitle="Ordered by the published priority rule. Each one shows the evidence, the next step and how to measure it."
        >
          <div className="findings">
            {findings.map((f) => (
              <FindingCard key={f.id} f={f} report={report} h={h} />
            ))}
          </div>
        </Panel>
      )}
      {tables.map((s) => (
        <SectionView key={s.id} s={s} currency={report.currency} />
      ))}
      {!sections.length && !findings.length && (
        <Empty title={`No ${group.toLowerCase()} data in this snapshot`}>
          Upload the exports listed above to see this view.
        </Empty>
      )}
    </>
  );
}

function Overview({
  report,
  h,
  go,
}: {
  report: Report;
  h: FindingHandlers;
  go: (g: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Up to eight headline measures, those with values first (unavailable is still shown, never zero).
  const listed = HEADLINES[report.app]
    .map((id) => report.metrics.find((m) => m.id === id))
    .filter(Boolean) as Metric[];
  const headline = [
    ...listed.filter((m) => m.value !== null),
    ...listed.filter((m) => m.value === null),
  ].slice(0, 8);
  const findings = expanded ? report.findings : report.findings.slice(0, 5);
  return (
    <>
      {headline.length > 0 && (
        <div className="metric-grid">
          {headline.map((m) => (
            <div
              className={"metric-card state-" + (m.state || "observed")}
              key={m.id}
              title={m.formula}
            >
              <span>{m.label}</span>
              <strong className={m.value === null ? "unavailable" : ""}>
                {value(m)}
              </strong>
              <small>
                {m.state === "partial" ? "Partial data · " : ""}
                {m.reason || m.formula}
              </small>
            </div>
          ))}
        </div>
      )}
      <AiInsights report={report} h={h} />
      <div className="glance-grid">
        {(report.groups || []).map((g) => {
          const first = (report.sections || []).find(
            (s) => s.group === g && asChart(s),
          );
          const fs = report.findings.filter((f) => f.group === g);
          const high = fs.filter((f) => f.severity === "high").length;
          const caps = (report.capabilities || []).filter((c) => c.group === g);
          const empty = !(report.sections || []).some((s) => s.group === g);
          return (
            <button key={g} className="glance-card" onClick={() => go(g)}>
              <header>
                <h3>{g}</h3>
                <span
                  className={
                    "pill " + (high ? "high" : fs.length ? "medium" : "ok")
                  }
                >
                  {fs.length
                    ? `${fs.length} signal${fs.length > 1 ? "s" : ""}${high ? ` · ${high} high` : ""}`
                    : empty
                      ? "No data yet"
                      : "No issues"}
                </span>
              </header>
              {first ? (
                <div className="glance-chart">
                  <ChartView
                    chart={asChart(first)!}
                    title={first.title}
                    currency={report.currency}
                    compact
                  />
                  <small>{first.title}</small>
                </div>
              ) : (
                <p className="muted">
                  {empty
                    ? caps.find((c) => c.state !== "available")?.needs ||
                      "Upload the matching export to see this topic."
                    : "Open to see the tables and recommendations."}
                </p>
              )}
              <span className="product-open">
                Open {g} <ArrowRight size={14} />
              </span>
            </button>
          );
        })}
      </div>
      <Panel
        title="Top recommendations"
        subtitle={`${report.findings.length} review signals across all topics, ordered by the published priority rule.`}
      >
        <div className="findings">
          {findings.map((f) => (
            <FindingCard key={f.id} f={f} report={report} h={h} />
          ))}
          {!report.findings.length && (
            <Empty title="No rules triggered">
              No review signals in the available data. Check the data
              limitations before drawing broader conclusions.
            </Empty>
          )}
        </div>
        {report.findings.length > 5 && (
          <Button onClick={() => setExpanded(!expanded)}>
            {expanded
              ? "Show fewer"
              : `Show all ${report.findings.length} signals`}
          </Button>
        )}
      </Panel>
    </>
  );
}

function Definitions({ report }: { report: Report }) {
  return (
    <>
      <Panel
        title="Measures"
        subtitle="Every value links to its formula, grain and source records. Unavailable is not zero."
      >
        <MetricTable report={report} />
      </Panel>
      {(report.capabilities || []).length > 0 && (
        <Panel
          title="What data would make this assessment stronger"
          subtitle="Capabilities depend on the exports or connections supplied."
        >
          <ul className="checklist">
            {report.capabilities!.map((c) => (
              <li key={c.id} className={"check-" + c.state}>
                <span className="badge">{c.state}</span> <b>{c.label}</b>
                {c.state !== "available" && <> — {c.needs}</>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel title="Data limitations">
        <ul className="limitations">
          {report.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <details>
          <summary>Rule thresholds used</summary>
          <pre>{JSON.stringify(report.thresholds, null, 2)}</pre>
        </details>
        <small>
          Snapshot {report.id} · dataset {report.datasetId} · generated{" "}
          {date(report.generatedAt)}
        </small>
      </Panel>
    </>
  );
}

export function AssessmentBody({
  report,
  h,
  showAll = true,
  flat = false,
}: {
  report: Report;
  h: FindingHandlers;
  showAll?: boolean;
  /** Scoped views (Analyze): everything on one page, no topic tabs and no AI call. */
  flat?: boolean;
}) {
  if (flat) {
    const charts = (report.sections || []).filter((s) => asChart(s));
    const tables = (report.sections || []).filter((s) => !asChart(s));
    return (
      <>
        <Panel
          title="Recommendations for this selection"
          subtitle="Ordered by the published priority rule."
        >
          <div className="findings">
            {report.findings.map((f) => (
              <FindingCard key={f.id} f={f} report={report} h={h} />
            ))}
            {!report.findings.length && (
              <Empty title="No rules triggered">
                No review signals for this selection.
              </Empty>
            )}
          </div>
        </Panel>
        {charts.length > 0 && (
          <div className="chart-grid">
            {charts.map((s) => (
              <ChartCard key={s.id} s={s} report={report} h={h} />
            ))}
          </div>
        )}
        {tables.map((s) => (
          <SectionView key={s.id} s={s} currency={report.currency} />
        ))}
      </>
    );
  }
  const topics = [
    "Overview",
    ...(report.groups || []),
    ...(showAll ? ["Data & definitions"] : []),
  ];
  const [topic, setTopic] = useState("Overview");
  const count = (g: string) =>
    report.findings.filter((f) => f.group === g).length;
  return (
    <>
      <nav className="topic-tabs" aria-label="Topics">
        {topics.map((t) => (
          <button
            key={t}
            className={topic === t ? "active" : ""}
            aria-current={topic === t ? "page" : undefined}
            onClick={() => setTopic(t)}
          >
            {t}
            {t !== "Overview" && t !== "Data & definitions" && count(t) > 0 && (
              <span className="count">{count(t)}</span>
            )}
          </button>
        ))}
      </nav>
      {topic === "Overview" ? (
        <Overview report={report} h={h} go={setTopic} />
      ) : topic === "Data & definitions" ? (
        <Definitions report={report} />
      ) : (
        <GroupView report={report} group={topic} h={h} />
      )}
    </>
  );
}

const scopedReport = (
  source: Source,
  report: Report,
  body: Record<string, unknown>,
) =>
  api<Report>("/sources/" + source.id + "/reports", {
    datasetId: report.datasetId,
    periodStart: report.period?.start || undefined,
    periodEnd: report.period?.end || undefined,
    ...body,
  });

export function Analyze({
  report,
  source,
  h,
}: {
  report: Report;
  source: Source;
  h: FindingHandlers;
}) {
  // Start with the first record selected, so the page is ready to assess.
  const [selected, setSelected] = useState(
      report.candidates?.analyze?.[0]?.key || "",
    ),
    [field, setField] = useState(""),
    [steps, setSteps] = useState<string[]>(
      ((source.policy.funnelSteps as string[]) || []).slice(0, 6),
    ),
    [windowMinutes, setWindowMinutes] = useState(
      Number(source.policy.funnelWindowMinutes ?? 30),
    ),
    [identity, setIdentity] = useState(
      String(source.policy.funnelIdentity ?? "session"),
    ),
    [detail, setDetail] = useState<Report | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const cands = report.candidates?.analyze || [];
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await scopedReport(source, report, body));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {report.app === "infinity" ? (
        <Panel
          title="Configure a journey"
          subtitle="Choose meaningful events in order and a conversion window. Funnels are built only from timestamped events, never from report totals."
        >
          {!report.candidates?.eventNames?.length ? (
            <Empty title="No event data in this snapshot">
              Upload timestamped events to analyze ordered journeys.
              Saved-report rows cannot reconstruct paths.
            </Empty>
          ) : (
            <>
              <div className="form-row">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Field key={i} label={`Step ${i + 1}`}>
                    <select
                      value={steps[i] || ""}
                      onChange={(e) =>
                        setSteps((s) => {
                          const n = [...s];
                          n[i] = e.target.value;
                          return n.filter((x, j) => x || j < i);
                        })
                      }
                    >
                      <option value="">
                        {i < 2 ? "Choose an event" : "(none)"}
                      </option>
                      {report.candidates!.eventNames!.map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="form-row">
                <Field label="Conversion window (minutes from step 1)">
                  <input
                    type="number"
                    min={1}
                    max={43200}
                    value={windowMinutes}
                    onChange={(e) => setWindowMinutes(Number(e.target.value))}
                  />
                </Field>
                <Field
                  label="Identity"
                  hint="Visitor (cross-session) progression needs a visitor ID on every event."
                >
                  <select
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                  >
                    <option value="session">Same session</option>
                    <option value="visitor">
                      Same visitor (cross-session)
                    </option>
                  </select>
                </Field>
                <Button
                  primary
                  busy={busy}
                  disabled={steps.filter(Boolean).length < 2}
                  onClick={() =>
                    run({
                      options: {
                        steps: steps.filter(Boolean),
                        windowMinutes,
                        identity,
                      },
                    })
                  }
                >
                  <Search size={16} /> Run journey analysis
                </Button>
              </div>
            </>
          )}
          <ErrorBox error={error} />
        </Panel>
      ) : (
        <Panel
          title={product(report.app).analyze}
          subtitle={
            report.app === "eloqua"
              ? "Choose a campaign to see its metrics, assets, nurture structure and evidence."
              : "Choose an audience to check readiness and blockers, or a profile field to trace completeness by source system."
          }
        >
          <div className="form-row">
            <Field label={report.app === "eloqua" ? "Campaign" : "Audience"}>
              <select
                aria-label="Select record"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Choose…</option>
                {cands.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              primary
              busy={busy}
              disabled={!selected}
              onClick={() => run({ selectedIds: [selected] })}
            >
              <Search size={16} /> Assess
            </Button>
            {report.app === "unity" && (
              <>
                <Field label="Profile field">
                  <select
                    value={field}
                    onChange={(e) => setField(e.target.value)}
                  >
                    <option value="">Choose a field…</option>
                    {(report.candidates?.fields || []).map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </Field>
                <Button
                  busy={busy}
                  disabled={!field}
                  onClick={() => run({ options: { field } })}
                >
                  Trace field
                </Button>
              </>
            )}
          </div>
          {!cands.length && (
            <p className="muted">
              This snapshot has no{" "}
              {report.app === "eloqua" ? "campaigns" : "segments"} to analyze.
            </p>
          )}
          <ErrorBox error={error} />
        </Panel>
      )}
      {busy && <Loading />}
      {detail && (
        <>
          <Panel
            title="Scoped assessment"
            subtitle={`Scope: ${detail.scope?.join(", ") || JSON.stringify(detail.options)} · same snapshot and definitions as the summary`}
          >
            <span />
          </Panel>
          <AssessmentBody report={detail} h={h} flat />
        </>
      )}
    </>
  );
}

export function Compare({
  report,
  source,
}: {
  report: Report;
  source: Source;
}) {
  // Start with the first two choices ticked, so a comparison is one click away.
  const [ids, setIds] = useState<string[]>(
      (report.candidates?.compare || []).slice(0, 2).map((c) => c.key),
    ),
    [query, setQuery] = useState(""),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const cands = (report.candidates?.compare || []).filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Panel
        title={product(report.app).compare}
        subtitle="Compare 2–4 entities from the same snapshot. Definition, audience and period differences are listed; no winner is declared from incomparable samples."
      >
        <Field label="Find">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or ID"
          />
        </Field>
        <div className="comparison-choices">
          {cands.slice(0, 100).map((c) => (
            <label className="checkbox" key={c.key}>
              <input
                type="checkbox"
                checked={ids.includes(c.key)}
                disabled={busy || (!ids.includes(c.key) && ids.length >= 4)}
                onChange={(e) => {
                  setResult(null);
                  setIds(
                    e.target.checked
                      ? [...ids, c.key]
                      : ids.filter((x) => x !== c.key),
                  );
                }}
              />
              <span>
                {c.label}
                <small>{c.key}</small>
              </span>
            </label>
          ))}
          {!cands.length && (
            <p className="muted">Nothing to compare in this snapshot.</p>
          )}
        </div>
        <Button
          primary
          busy={busy}
          disabled={ids.length < 2}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(
                await api("/sources/" + source.id + "/compare", {
                  datasetId: report.datasetId,
                  keys: ids,
                  periodStart: report.period?.start || undefined,
                  periodEnd: report.period?.end || undefined,
                }),
              );
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Compare selected
        </Button>
        <ErrorBox error={error} />
      </Panel>
      {result && (
        <>
          <Panel title="Side-by-side assessment">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Measure</th>
                    {result.columns.map((c: any) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r: any) => (
                    <tr key={r.metric}>
                      <td>{r.metric}</td>
                      {r.values.map((v: any, i: number) => (
                        <td key={i} className="numeric">
                          {fmtCell(v, r.unit, report.currency)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title="Comparability"
            subtitle="Read these before drawing conclusions."
          >
            <ul className="limitations">
              {result.caveats.map((c: string, i: number) => (
                <li key={i}>{c}</li>
              ))}
              {!result.caveats.length && (
                <li>
                  No comparability issues detected for the supplied attributes.
                </li>
              )}
            </ul>
            {result.test && (
              <div className="notice">
                <b>{result.test.metric}:</b> difference {result.test.diffPp}{" "}
                percentage points, p = {result.test.pValue} (
                {result.test.method}). {result.test.conclusion}
              </div>
            )}
          </Panel>
          {(result.extra || []).map((x: any) => (
            <Panel key={x.title} title={x.title}>
              <table>
                <tbody>
                  {x.rows.map((r: any) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="numeric">
                        {r.value === null ? "Unavailable" : r.value}
                      </td>
                      <td className="muted">{r.definition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))}
        </>
      )}
    </>
  );
}

export function Simulator({
  report,
  source,
  canWrite,
}: {
  report: Report;
  source: Source;
  canWrite: boolean;
}) {
  const [dict, setDict] = useState<any>(null),
    [scope, setScope] = useState(""),
    [base, setBase] = useState<Report>(report),
    [inputs, setInputs] = useState<Record<string, string>>({}),
    [result, setResult] = useState<any>(),
    [history, setHistory] = useState<any[]>([]),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [ss, setSs] = useState({ baselinePct: "", mdePp: "" }),
    [ssOut, setSsOut] = useState<any>(null);
  useEffect(() => {
    api("/dictionary/" + report.app)
      .then(setDict)
      .catch(setError);
    api<any[]>("/sources/" + report.sourceId + "/scenarios")
      .then(setHistory)
      .catch(setError);
  }, [report.id]);
  useEffect(() => {
    if (!dict) return;
    // Measured inputs are prefilled only when the required data is available; others stay empty.
    const init: Record<string, string> = {};
    // Measured values are shown with at most two decimals (still editable).
    const tidy = (v: unknown) => {
      const n = Number(v);
      return v === null || v === undefined || v === ""
        ? ""
        : Number.isFinite(n)
          ? String(Math.round(n * 100) / 100)
          : String(v);
    };
    for (const f of dict.scenario)
      init[f.key] = tidy(
        f.prefill && base.metrics.find((m) => m.id === f.prefill)?.value,
      );
    setInputs(init);
  }, [dict, base.id]);
  const cands = report.candidates?.analyze || [];
  return (
    <div className="two-column">
      <Panel
        title="Explore a planning scenario"
        subtitle="Measured values come from the snapshot; everything else is your assumption. A scenario never changes Oracle data and is never shown as an observed result."
      >
        {report.app !== "infinity" && cands.length > 0 && (
          <div className="form-row">
            <Field
              label={
                report.app === "unity"
                  ? "Audience (for measured readiness inputs)"
                  : "Scope (optional)"
              }
            >
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">Whole snapshot</option>
                {cands.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              disabled={!scope}
              onClick={async () => {
                try {
                  setBase(
                    await scopedReport(source, report, {
                      selectedIds: [scope],
                    }),
                  );
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Load measured inputs
            </Button>
          </div>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const body = Object.fromEntries(
                Object.entries(inputs).filter(([, v]) => v !== ""),
              );
              setResult(await api("/reports/" + base.id + "/scenarios", body));
              setHistory(
                await api("/sources/" + report.sourceId + "/scenarios"),
              );
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {dict?.scenario.map((f: any) => (
            <Field
              key={f.key}
              label={f.label}
              hint={
                f.prefill
                  ? base.metrics.find((m) => m.id === f.prefill)?.value
                    ? "Measured from this snapshot"
                    : "Not measured in this snapshot: enter your own value"
                  : "Your assumption"
              }
            >
              <input
                type={f.unit === "text" ? "text" : "number"}
                step="any"
                min={f.unit === "text" ? undefined : 0}
                required={!f.optional}
                value={inputs[f.key] || ""}
                onChange={(e) =>
                  setInputs((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
              />
            </Field>
          ))}
          <Button primary busy={busy} disabled={!canWrite || !dict}>
            Calculate and save scenario
          </Button>
          <ErrorBox error={error} />
        </form>
        {report.app !== "unity" && (
          <details>
            <summary>Experiment sample-size calculator</summary>
            <div className="form-row">
              <Field label="Baseline rate (%)">
                <input
                  type="number"
                  step="any"
                  value={ss.baselinePct}
                  onChange={(e) =>
                    setSs({ ...ss, baselinePct: e.target.value })
                  }
                />
              </Field>
              <Field label="Smallest change worth detecting (percentage points)">
                <input
                  type="number"
                  step="any"
                  value={ss.mdePp}
                  onChange={(e) => setSs({ ...ss, mdePp: e.target.value })}
                />
              </Field>
              <Button
                onClick={async () => {
                  try {
                    setSsOut(
                      await api("/tools/sample-size", {
                        baselinePct: Number(ss.baselinePct),
                        mdePp: Number(ss.mdePp),
                      }),
                    );
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Calculate
              </Button>
            </div>
            {ssOut && (
              <p className="notice">
                About {ssOut.perArm.toLocaleString()} recipients/sessions per
                group (5% significance, 80% power; {ssOut.method}).
              </p>
            )}
          </details>
        )}
      </Panel>
      <div>
        {result ? (
          <Panel
            title="Scenario result"
            subtitle={`Formula ${result.formulaVersion}`}
          >
            <p className="muted">{result.formula}</p>
            <dl className="scenario-result">
              {Object.entries(result.measured).map(([k, v]) => (
                <React.Fragment key={"m" + k}>
                  <dt>Measured · {k}</dt>
                  <dd>{String(v ?? "Unavailable")}</dd>
                </React.Fragment>
              ))}
              {Object.entries(result.assumed).map(([k, v]) => (
                <React.Fragment key={"a" + k}>
                  <dt>Assumed · {k}</dt>
                  <dd>{String(v)}</dd>
                </React.Fragment>
              ))}
              {Object.entries(result.projected).map(([k, v]) => (
                <React.Fragment key={"p" + k}>
                  <dt>Projected (hypothetical) · {k}</dt>
                  <dd>
                    {String(v ?? "Unavailable")}{" "}
                    {result.currency && k.toLowerCase().includes("value")
                      ? result.currency
                      : ""}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
            <div className="notice warning">{result.note}</div>
          </Panel>
        ) : (
          <Empty title="Make your assumptions explicit">
            Measured inputs are prefilled when the data supports them. Other
            fields stay empty for you to define.
          </Empty>
        )}
        <Panel title="Saved scenarios">
          {history.length ? (
            history.map((x) => (
              <details key={x.id}>
                <summary>
                  {date(x.created_at)} · {x.result.formulaVersion}
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      assumptions: x.input,
                      projected: x.result.projected,
                      baseline: x.result.baseline,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ))
          ) : (
            <p className="muted">No scenarios saved yet.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function Chat({
  report,
  canWrite,
  initialQuestion = "",
  autoAsk = false,
}: {
  report: Report;
  canWrite: boolean;
  initialQuestion?: string;
  /** Send the initial question straight away (from an "Ask AI about this" button). */
  autoAsk?: boolean;
}) {
  const [question, setQuestion] = useState(initialQuestion),
    [messages, setMessages] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const send = async (q: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/reports/" + report.id + "/chat", { question: q });
      setMessages((x) => [
        ...x,
        { id: r.id, question: q, result: r, report_id: report.id },
      ]);
      setQuestion("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoAsk && initialQuestion && canWrite) void send(initialQuestion);
    // Run once for the question this view was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Chat context is per source; a new report or source clears the view.
    setMessages([]);
    const c = new AbortController();
    api<any[]>(
      "/sources/" + report.sourceId + "/chat",
      undefined,
      undefined,
      c.signal,
    )
      .then((rows) =>
        // Keep any answer sent while the history was loading.
        setMessages((prev) => [
          ...rows.reverse().filter((r) => !prev.some((m) => m.id === r.id)),
          ...prev,
        ]),
      )
      .catch((e) => e.name !== "AbortError" && setError(e));
    return () => c.abort();
  }, [report.sourceId]);
  const metricLabel = useMemo(
    () => new Map(report.metrics.map((m) => [m.id, m])),
    [report.id],
  );
  return (
    <Panel
      title={product(report.app).ask}
      subtitle={`Scope: ${report.name} · snapshot ${report.id.slice(0, 8)} · data as of ${date(report.asOf)}. Answers cite this source's evidence and approved playbooks only.`}
    >
      <div className="question-chips">
        {QUESTIONS[report.app].map((q) => (
          <Button key={q} onClick={() => setQuestion(q)}>
            {q}
          </Button>
        ))}
      </div>
      <div className="chat-messages" aria-live="polite">
        {!messages.length && (
          <Empty title="Ask a question about this assessment">
            The AI explains authorized evidence. Numbers are shown from verified
            calculations, not written by the model.
          </Empty>
        )}
        {messages.map((m) => (
          <div key={m.id} className="chat-turn">
            <div className="question">
              <MessageSquare size={17} />
              {m.question}
            </div>
            {m.result && (
              <div className="answer">
                <span
                  className={
                    "badge " + (m.result.generator === "ai" ? "ai" : "rules")
                  }
                >
                  {m.result.generator === "ai"
                    ? `AI explanation · ${m.result.model}`
                    : "Rule-based guidance (no AI)"}
                </span>
                <small> {m.result.status}</small>
                {m.result.statements?.map((s: any, i: number) => (
                  <div key={i} className={"statement kind-" + s.kind}>
                    <span className="badge">{s.kind}</span>
                    <p>{s.text}</p>
                    <div className="citations">
                      {s.metricIds.map((mid: string) => {
                        const metric =
                          report.id === m.report_id
                            ? metricLabel.get(mid)
                            : null;
                        return (
                          <span key={mid}>
                            {metric ? metric.label + ": " + value(metric) : mid}
                          </span>
                        );
                      })}
                      {s.findingIds.map((fid: string) => (
                        <span key={fid}>
                          Finding:{" "}
                          {report.findings.find((f) => f.id === fid)?.title ||
                            fid}
                        </span>
                      ))}
                      {s.documentIds.map((did: string) => (
                        <span key={did}>Playbook: {did.slice(0, 8)}</span>
                      ))}
                      {(s.toolIds || []).map((t: number) => (
                        <span key={"t" + t}>
                          Tool: {m.result.tools?.[t]?.tool} —{" "}
                          {m.result.tools?.[t]?.summary}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {m.result.tools?.length > 0 && (
                  <details>
                    <summary>
                      <Wrench size={13} /> Tools used ({m.result.tools.length})
                    </summary>
                    {m.result.tools.map((t: any, i: number) => (
                      <p key={i}>
                        {t.ok ? "✓" : "✗"} {t.tool} — {t.summary}
                      </p>
                    ))}
                  </details>
                )}
                {!m.result.statements?.length && (
                  <p>
                    No rules triggered in the available data. Review the data
                    limitations.
                  </p>
                )}
                <details>
                  <summary>Data limitations</summary>
                  {m.result.limitations?.map((x: string, i: number) => (
                    <p key={i}>{x}</p>
                  ))}
                </details>
                <a
                  className="source-ref"
                  href={"/api/reports/" + m.report_id + "/export?format=print"}
                  target="_blank"
                  rel="noreferrer"
                >
                  View the evidence snapshot
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(question);
        }}
      >
        <Field label="Your question">
          <textarea
            rows={3}
            required
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What needs attention, and which evidence supports it?"
          />
        </Field>
        <Button primary busy={busy} disabled={!canWrite}>
          <Send size={16} /> Ask AI
        </Button>
      </form>
      <ErrorBox error={error} />
    </Panel>
  );
}
export type { Session };
