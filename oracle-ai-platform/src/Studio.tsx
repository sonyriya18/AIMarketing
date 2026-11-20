// Studio screens, modelled on the Responsys screens: entity deep dive against the account
// pattern, head-to-head and portfolio comparison, flow diagrams, the Eloqua email builder and
// campaign preview, the Unity audience builder and customer profile. All numbers come from the
// server (/sources/:id/studio); this file only arranges and draws them.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Monitor,
  Smartphone,
  Search,
  Sparkles,
  Save,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { api } from "./api";
import { Button, Empty, ErrorBox, Field, Panel } from "./ui";
import { ChartView, SERIES, fmtValue } from "./Charts";
import type {
  Flow,
  Report,
  Source,
  Studio,
  StudioEntity,
  StudioMetric,
} from "../shared/catalog";

/* ------------------------------- data ------------------------------- */

export function useStudio(
  source: Source,
  report: Report | null,
  periodStart?: string,
  periodEnd?: string,
) {
  const [studio, setStudio] = useState<Studio | null>(null),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api<Studio>("/sources/" + source.id + "/studio", {
      datasetId: report?.datasetId,
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
    })
      .then((s) => live && setStudio(s))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [source.id, report?.datasetId, periodStart, periodEnd]);
  return { studio, error };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** The account pattern: median of the other entities in the same group (at least two). */
export function benchmark(studio: Studio, e: StudioEntity, metric: string) {
  const peers = studio.entities.filter(
    (x) => x.group === e.group && x.key !== e.key && x.values[metric] != null,
  );
  if (peers.length < 2) return null;
  return {
    value: median(peers.map((p) => p.values[metric]!)),
    n: peers.length,
  };
}
const MIN_SAMPLE = 100;
const small = (e: StudioEntity, m: StudioMetric) =>
  m.unit === "percent" &&
  e.sample[m.id] != null &&
  (e.sample[m.id] as number) < MIN_SAMPLE;

function delta(m: StudioMetric, v: number | null, b: number | null) {
  if (v == null || b == null) return null;
  const diff = v - b;
  const sign = diff >= 0 ? "+" : "−";
  const text =
    m.unit === "percent"
      ? `${sign}${Math.round(Math.abs(diff) * 10) / 10} pts`
      : b
        ? `${sign}${Math.round(Math.abs(diff / b) * 1000) / 10}%`
        : `${sign}${fmtValue(Math.abs(diff), m.unit)}`;
  const tone =
    Math.abs(diff) < 1e-9 || !m.better
      ? "neutral"
      : diff > 0 === (m.better === "higher")
        ? "good"
        : "bad";
  return { text, tone, up: diff > 0, flat: Math.abs(diff) < 1e-9 };
}

/* ------------------------------- flow diagram ------------------------------- */

/** Columns of nodes joined by bands whose width follows the number of people or visits. */
export function FlowDiagram({ flow, title }: { flow: Flow; title: string }) {
  const W = 960,
    nodeW = 14,
    gap = 16,
    top = 30;
  const cols = flow.columns.length;
  const byCol = flow.columns.map((_, i) =>
    flow.nodes.filter((n) => n.column === i),
  );
  const maxTotal = Math.max(
    1,
    ...byCol.map((c) => c.reduce((t, n) => t + Math.max(n.value, 0), 0)),
  );
  const maxCount = Math.max(1, ...byCol.map((c) => c.length));
  // Each node gets at least one label line of space, so labels never overlap.
  const minSlot = 20;
  const H = Math.max(220, Math.min(620, 60 + maxCount * 50));
  const usable = H - top - 10 - (gap + minSlot) * (maxCount - 1);
  const scale = usable / maxTotal;
  const x = (c: number) =>
    cols === 1 ? 40 : 40 + (c * (W - 300)) / Math.max(1, cols - 1);
  const pos = new Map<string, { x: number; y: number; h: number; i: number }>();
  let bottom = top;
  byCol.forEach((nodes, c) => {
    let y = top;
    nodes.forEach((n, i) => {
      const h = Math.max(4, n.value * scale);
      pos.set(n.id, { x: x(c), y, h, i });
      y += Math.max(h, minSlot) + gap;
    });
    bottom = Math.max(bottom, y - gap);
  });
  const viewH = Math.min(H, bottom + 12);
  const color = (id: string) => {
    const idx = flow.nodes.findIndex((n) => n.id === id);
    return SERIES[idx % SERIES.length];
  };
  // Bands leave and enter each node in the vertical order of the node at the other end, so they
  // cross as little as possible.
  const links = flow.links.filter(
    (l) => pos.has(l.from) && pos.has(l.to) && l.value > 0,
  );
  const width = (v: number) => Math.max(1.5, v * scale);
  const outOff = new Map<(typeof links)[number], number>(),
    inOff = new Map<(typeof links)[number], number>();
  for (const [key, other, store] of [
    ["from", "to", outOff],
    ["to", "from", inOff],
  ] as const) {
    const byNode = new Map<string, typeof links>();
    for (const l of links)
      byNode.set(l[key], [...(byNode.get(l[key]) || []), l]);
    for (const list of byNode.values()) {
      let used = 0;
      for (const l of [...list].sort(
        (a, b) => pos.get(a[other])!.y - pos.get(b[other])!.y,
      )) {
        store.set(l, used);
        used += width(l.value);
      }
    }
  }
  const bands = links.map((l) => {
    const a = pos.get(l.from)!,
      b = pos.get(l.to)!;
    const w = width(l.value);
    const ay = a.y + outOff.get(l)!,
      by = b.y + inOff.get(l)!;
    const x1 = a.x + nodeW,
      x2 = b.x,
      mx = (x1 + x2) / 2;
    return {
      l,
      d: `M${x1},${ay} C${mx},${ay} ${mx},${by} ${x2},${by} L${x2},${by + w} C${mx},${by + w} ${mx},${ay + w} ${x1},${ay + w} Z`,
      fill: color(l.from),
    };
  });
  return (
    <figure className="flow">
      <svg
        viewBox={`0 0 ${W} ${viewH}`}
        role="img"
        aria-label={`${title}: flow diagram. The list below gives every path.`}
      >
        {flow.columns.map((c, i) => (
          <text key={c} x={x(i)} y={14} className="flow-col">
            {c}
          </text>
        ))}
        {bands.map((b, i) => (
          <path key={i} d={b.d} fill={b.fill} opacity={0.28}>
            <title>
              {`${flow.nodes.find((n) => n.id === b.l.from)?.label} → ${flow.nodes.find((n) => n.id === b.l.to)?.label}: ${b.l.value} ${flow.unit}`}
            </title>
          </path>
        ))}
        {flow.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <rect
                x={p.x}
                y={p.y}
                width={nodeW}
                height={p.h}
                rx={3}
                fill={color(n.id)}
              >
                <title>{`${n.label}: ${n.value} ${flow.unit}`}</title>
              </rect>
              <text
                x={p.x + nodeW + 8}
                y={p.y + Math.max(p.h, 12) / 2 + 4}
                className="flow-label"
              >
                {(n.label.length > 34 ? n.label.slice(0, 33) + "…" : n.label) +
                  " · " +
                  n.value.toLocaleString("en")}
              </text>
            </g>
          );
        })}
      </svg>
      {flow.note && <figcaption className="muted">{flow.note}</figcaption>}
      <details className="chart-table">
        <summary>Show as list</summary>
        <ul className="flow-list">
          {flow.links.map((l, i) => (
            <li key={i}>
              {flow.nodes.find((n) => n.id === l.from)?.label} →{" "}
              {flow.nodes.find((n) => n.id === l.to)?.label}:{" "}
              <b>{l.value.toLocaleString("en")}</b> {flow.unit}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}

/* ------------------------------- email preview ------------------------------- */

/**
 * Untrusted email HTML in a frame with no scripts, forms or same-origin access. Remote images
 * (which can include tracking pixels) load only when asked.
 */
export function EmailPreview({
  subject,
  preheader,
  html,
  from,
}: {
  subject: string;
  preheader?: string;
  html: string;
  from?: string;
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop"),
    [images, setImages] = useState(false);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${images ? "https:" : ""}; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <div className="email-preview">
      <div className="preview-bar">
        <div className="seg" role="group" aria-label="Preview size">
          <button
            className={device === "desktop" ? "active" : ""}
            aria-pressed={device === "desktop"}
            onClick={() => setDevice("desktop")}
          >
            <Monitor size={14} /> Desktop
          </button>
          <button
            className={device === "mobile" ? "active" : ""}
            aria-pressed={device === "mobile"}
            onClick={() => setDevice("mobile")}
          >
            <Smartphone size={14} /> Mobile
          </button>
        </div>
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={images}
            onChange={(e) => setImages(e.target.checked)}
          />
          Load images
        </label>
      </div>
      <div className={"inbox " + device}>
        <div className="inbox-head">
          <b>{from || "Your brand"}</b>
          <span className="subject">{subject || "(no subject)"}</span>
          {preheader && <span className="preheader">{preheader}</span>}
        </div>
        <iframe
          title={`Email preview: ${subject || "untitled"}`}
          sandbox="allow-popups"
          srcDoc={doc}
        />
      </div>
    </div>
  );
}

/* ------------------------------- deep dive ------------------------------- */

function EntityPicker({
  studio,
  value,
  onChange,
}: {
  studio: Studio;
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <Field label={`Choose ${studio.entityLabel.toLowerCase()}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {studio.groups.map((g) => {
          const list = studio.entities.filter((e) => e.group === g.id);
          return list.length ? (
            <optgroup key={g.id} label={g.label}>
              {list.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
    </Field>
  );
}

function KpiCard({
  studio,
  e,
  m,
}: {
  studio: Studio;
  e: StudioEntity;
  m: StudioMetric;
}) {
  const v = e.values[m.id] ?? null;
  const b = benchmark(studio, e, m.id);
  const d = delta(m, v, b?.value ?? null);
  return (
    <div className={"kpi " + (d ? d.tone : "")}>
      <span className="kpi-label">{m.label}</span>
      <strong>{fmtValue(v, m.unit, studio.currency)}</strong>
      {d && (
        <span className={"kpi-delta " + d.tone}>
          {d.flat ? (
            <Minus size={13} />
          ) : d.up ? (
            <ArrowUpRight size={13} />
          ) : (
            <ArrowDownRight size={13} />
          )}
          {d.text} vs account
        </span>
      )}
      <small className="muted">
        {b
          ? `Account pattern ${fmtValue(b.value, m.unit, studio.currency)} (median of ${b.n} other ${studio.entityLabel.toLowerCase()}s)`
          : v == null
            ? "Not in this data"
            : "No account pattern (fewer than two comparable)"}
      </small>
      {small(e, m) && (
        <small className="warn-chip">Small sample (n={e.sample[m.id]})</small>
      )}
    </div>
  );
}

export function DeepDive({
  studio,
  selected,
  onSelect,
  onAsk,
}: {
  studio: Studio;
  selected: string;
  onSelect: (k: string) => void;
  onAsk?: (q: string) => void;
}) {
  const e =
    studio.entities.find((x) => x.key === selected) || studio.entities[0];
  const [all, setAll] = useState(false);
  if (!e)
    return (
      <Empty title={`No ${studio.entityPlural.toLowerCase()} in this data`}>
        Upload exports that include {studio.entityPlural.toLowerCase()} to see a
        deep dive.
      </Empty>
    );
  const shown = (all ? studio.metrics.map((m) => m.id) : studio.headline)
    .map((id) => studio.metrics.find((m) => m.id === id)!)
    .filter((m) => all || e.values[m.id] != null);
  return (
    <div className="deep-dive">
      <section className="studio-hero">
        <div>
          <span className="eyebrow">{studio.entityLabel} deep dive</span>
          <h2>{e.label}</h2>
          <div className="chips">
            {e.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="hero-actions">
          <EntityPicker studio={studio} value={e.key} onChange={onSelect} />
          {onAsk && (
            <Button
              onClick={() =>
                onAsk(
                  `Deep dive on ${studio.entityLabel.toLowerCase()} "${e.label}": how does it compare with the account pattern, what explains the gaps, and what should we do next?`,
                )
              }
            >
              <Sparkles size={15} /> Ask AI about this{" "}
              {studio.entityLabel.toLowerCase()}
            </Button>
          )}
        </div>
      </section>
      <div className="kpi-row">
        {shown.map((m) => (
          <KpiCard key={m.id} studio={studio} e={e} m={m} />
        ))}
      </div>
      <button className="link-button" onClick={() => setAll(!all)}>
        {all ? "Show key measures only" : "Show all measures"}
      </button>
      <div className="studio-grid">
        {e.trend && (
          <section className="chart-card">
            <header>
              <h3>{e.trend.title}</h3>
            </header>
            <ChartView chart={e.trend} title={e.trend.title} />
          </section>
        )}
        {e.related?.map((r) => (
          <section className="chart-card" key={r.title}>
            <header>
              <h3>{r.title}</h3>
            </header>
            <ul className="related">
              {r.items.map((it, i) => (
                <li key={i}>
                  <b>{it.label}</b>
                  {it.detail && <span className="muted"> · {it.detail}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {e.flow && (
        <section className="chart-card wide">
          <header>
            <h3>{e.flow.title}</h3>
          </header>
          <FlowDiagram flow={e.flow} title={e.flow.title} />
        </section>
      )}
      {!!e.previews?.length && (
        <section className="chart-card wide">
          <header>
            <h3>Campaign preview</h3>
          </header>
          <p className="about">
            The email content from your export, as subscribers see it. Images
            load only when you tick "Load images".
          </p>
          <PreviewTabs previews={e.previews} />
        </section>
      )}
      <MeasureTable studio={studio} e={e} />
    </div>
  );
}

function PreviewTabs({
  previews,
}: {
  previews: NonNullable<StudioEntity["previews"]>;
}) {
  const [i, setI] = useState(0);
  const p = previews[Math.min(i, previews.length - 1)]!;
  return (
    <>
      {previews.length > 1 && (
        <div className="seg" role="group" aria-label="Email">
          {previews.map((x, j) => (
            <button
              key={j}
              className={j === i ? "active" : ""}
              onClick={() => setI(j)}
            >
              {x.name}
            </button>
          ))}
        </div>
      )}
      <EmailPreview subject={p.subject} html={p.html} />
    </>
  );
}

function MeasureTable({ studio, e }: { studio: Studio; e: StudioEntity }) {
  return (
    <details className="chart-table measure-table">
      <summary>How each measure is calculated</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Measure</th>
              <th>This {studio.entityLabel.toLowerCase()}</th>
              <th>Account pattern</th>
              <th>Calculation</th>
            </tr>
          </thead>
          <tbody>
            {studio.metrics.map((m) => {
              const b = benchmark(studio, e, m.id);
              return (
                <tr key={m.id}>
                  <td>{m.label}</td>
                  <td className="numeric">
                    {fmtValue(e.values[m.id], m.unit, studio.currency)}
                  </td>
                  <td className="numeric">
                    {b ? fmtValue(b.value, m.unit, studio.currency) : "—"}
                  </td>
                  <td className="muted">{m.formula}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ------------------------------- compare ------------------------------- */

export function HeadToHead({ studio }: { studio: Studio }) {
  const first = studio.groups.find((g) =>
    studio.entities.some((e) => e.group === g.id),
  );
  const inGroup = studio.entities.filter((e) => e.group === first?.id);
  const [a, setA] = useState(inGroup[0]?.key || ""),
    [b, setB] = useState(inGroup[1]?.key || "");
  const A = studio.entities.find((e) => e.key === a),
    B = studio.entities.find((e) => e.key === b);
  if (studio.entities.length < 2)
    return (
      <Empty title="Two are needed for a head-to-head">
        This data has fewer than two {studio.entityPlural.toLowerCase()}.
      </Empty>
    );
  const metrics = studio.metrics.filter(
    (m) => A?.values[m.id] != null || B?.values[m.id] != null,
  );
  let winsA = 0,
    winsB = 0;
  const rows = metrics.map((m) => {
    const va = A?.values[m.id] ?? null,
      vb = B?.values[m.id] ?? null;
    const comparable =
      va != null &&
      vb != null &&
      !!m.better &&
      !(A && small(A, m)) &&
      !(B && small(B, m));
    const lead =
      comparable && va !== vb
        ? va! > vb! === (m.better === "higher")
          ? "a"
          : "b"
        : null;
    if (lead === "a") winsA++;
    if (lead === "b") winsB++;
    const max = Math.max(Math.abs(va ?? 0), Math.abs(vb ?? 0), 1e-9);
    return { m, va, vb, lead, comparable, max };
  });
  return (
    <div className="battle">
      <div className="battle-head">
        <div className="side a">
          <Field label="Left">
            <select value={a} onChange={(e) => setA(e.target.value)}>
              {studio.entities.map((e) => (
                <option key={e.key} value={e.key} disabled={e.key === b}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
          <strong className="score">{winsA}</strong>
          <span className="muted">measures ahead</span>
        </div>
        <div className="vs">VS</div>
        <div className="side b">
          <Field label="Right">
            <select value={b} onChange={(e) => setB(e.target.value)}>
              {studio.entities.map((e) => (
                <option key={e.key} value={e.key} disabled={e.key === a}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
          <strong className="score">{winsB}</strong>
          <span className="muted">measures ahead</span>
        </div>
      </div>
      {A && B && A.group !== B.group && (
        <p className="warn-chip">
          These are different kinds of {studio.entityPlural.toLowerCase()};
          compare with care.
        </p>
      )}
      <div className="battle-rows" role="table" aria-label="Head-to-head">
        {rows.map((r) => (
          <div className="battle-row" role="row" key={r.m.id}>
            <div
              className={"cell a " + (r.lead === "a" ? "lead" : "")}
              role="cell"
            >
              <span>{fmtValue(r.va, r.m.unit, studio.currency)}</span>
              <i
                style={{
                  width: `${(Math.abs(r.va ?? 0) / r.max) * 100}%`,
                }}
              />
            </div>
            <div className="metric" role="rowheader">
              {r.m.label}
              {!r.comparable && r.m.better && r.va != null && r.vb != null && (
                <small className="muted">small sample: no winner</small>
              )}
            </div>
            <div
              className={"cell b " + (r.lead === "b" ? "lead" : "")}
              role="cell"
            >
              <i
                style={{
                  width: `${(Math.abs(r.vb ?? 0) / r.max) * 100}%`,
                }}
              />
              <span>{fmtValue(r.vb, r.m.unit, studio.currency)}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="muted small">
        A side is ahead on a measure only when both values exist, the direction
        is clear and each rate rests on at least {MIN_SAMPLE} people or visits.
        Measured differences are not proof of cause.
      </p>
    </div>
  );
}

export function Portfolio({
  studio,
  onOpen,
}: {
  studio: Studio;
  onOpen: (key: string) => void;
}) {
  const groups = studio.groups.filter((g) =>
    studio.entities.some((e) => e.group === g.id),
  );
  const [group, setGroup] = useState(groups[0]?.id || ""),
    [sort, setSort] = useState<{ id: string; desc: boolean }>({
      id: studio.headline[0] || "",
      desc: true,
    });
  const list = studio.entities.filter((e) => e.group === group);
  const cols = studio.headline
    .map((id) => studio.metrics.find((m) => m.id === id)!)
    .filter((m) => list.some((e) => e.values[m.id] != null));
  const med = Object.fromEntries(
    cols.map((m) => {
      const vs = list
        .map((e) => e.values[m.id])
        .filter((v): v is number => v != null);
      return [m.id, vs.length >= 3 ? median(vs) : null];
    }),
  );
  const sorted = [...list].sort((x, y) => {
    const a = x.values[sort.id] ?? -Infinity,
      b = y.values[sort.id] ?? -Infinity;
    return sort.desc ? b - a : a - b;
  });
  const tint = (m: StudioMetric, v: number | null) => {
    const b = med[m.id];
    if (v == null || b == null || !m.better || b === 0) return undefined;
    const rel = (v - b) / Math.abs(b);
    const good = rel > 0 === (m.better === "higher");
    const a = Math.min(0.32, Math.abs(rel) * 0.4);
    return good ? `rgba(27,175,122,${a})` : `rgba(227,73,72,${a})`;
  };
  return (
    <div className="portfolio">
      {groups.length > 1 && (
        <div className="seg" role="group" aria-label="Group">
          {groups.map((g) => (
            <button
              key={g.id}
              className={g.id === group ? "active" : ""}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="portfolio-table">
          <thead>
            <tr>
              <th>{studio.entityLabel}</th>
              {cols.map((m) => (
                <th key={m.id}>
                  <button
                    className="sort"
                    onClick={() =>
                      setSort({
                        id: m.id,
                        desc: sort.id === m.id ? !sort.desc : true,
                      })
                    }
                  >
                    {m.label}
                    {sort.id === m.id &&
                      (sort.desc ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronUp size={13} />
                      ))}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.key}>
                <td>
                  <button className="link-button" onClick={() => onOpen(e.key)}>
                    {e.label}
                  </button>
                </td>
                {cols.map((m) => (
                  <td
                    key={m.id}
                    className="numeric"
                    style={{ background: tint(m, e.values[m.id] ?? null) }}
                  >
                    {fmtValue(e.values[m.id], m.unit, studio.currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Green and red shading compares each value with the median of this list
        (shown when at least three have a value). Click a name for its deep
        dive.
      </p>
    </div>
  );
}

export function StudioCompare({
  studio,
  onOpen,
}: {
  studio: Studio;
  onOpen: (key: string) => void;
}) {
  const [mode, setMode] = useState<"vs2" | "all">("vs2");
  return (
    <Panel
      title={
        mode === "vs2"
          ? "Head-to-head"
          : `All ${studio.entityPlural.toLowerCase()}`
      }
      subtitle={
        mode === "vs2"
          ? `Two ${studio.entityPlural.toLowerCase()} side by side, measure by measure.`
          : `Every ${studio.entityLabel.toLowerCase()} on the key measures, shaded against the median.`
      }
      extra={
        <div className="seg" role="group" aria-label="Comparison view">
          <button
            className={mode === "vs2" ? "active" : ""}
            onClick={() => setMode("vs2")}
          >
            VS 2
          </button>
          <button
            className={mode === "all" ? "active" : ""}
            onClick={() => setMode("all")}
          >
            VS all
          </button>
        </div>
      }
    >
      {mode === "vs2" ? (
        <HeadToHead studio={studio} />
      ) : (
        <Portfolio studio={studio} onOpen={onOpen} />
      )}
    </Panel>
  );
}

/* ------------------------------- Eloqua: email builder ------------------------------- */

type Block = {
  id: string;
  type: "heading" | "text" | "button" | "image" | "divider";
  text: string;
  url: string;
};
const STARTERS: Record<
  string,
  { subject: string; preheader: string; blocks: Omit<Block, "id">[] }
> = {
  blank: { subject: "", preheader: "", blocks: [] },
  webinar: {
    subject: "Join our live webinar",
    preheader: "Save your seat: 45 minutes, practical answers.",
    blocks: [
      { type: "heading", text: "Join our live webinar", url: "" },
      {
        type: "text",
        text: "In 45 minutes we show how teams like yours solve this, with time for your questions.",
        url: "",
      },
      {
        type: "button",
        text: "Save my seat",
        url: "https://example.com/webinar",
      },
    ],
  },
  newsletter: {
    subject: "This month: three ideas worth your time",
    preheader: "Short reads picked for you.",
    blocks: [
      { type: "heading", text: "This month", url: "" },
      {
        type: "text",
        text: "Three short ideas from our team, chosen for people in your role.",
        url: "",
      },
      { type: "divider", text: "", url: "" },
      { type: "text", text: "1. Idea one, in a sentence.", url: "" },
      { type: "button", text: "Read more", url: "https://example.com/blog" },
    ],
  },
  product: {
    subject: "New: what changed and why it matters",
    preheader: "The update in one minute.",
    blocks: [
      { type: "heading", text: "What's new", url: "" },
      {
        type: "text",
        text: "Here is what changed, who it helps and how to start.",
        url: "",
      },
      {
        type: "button",
        text: "See what's new",
        url: "https://example.com/new",
      },
    ],
  },
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const safeUrl = (u: string) => (/^https:\/\//i.test(u.trim()) ? u.trim() : "#");
let blockSeq = 0;
const newId = () => "b" + ++blockSeq;

export function emailHtml(blocks: Block[], brand: string) {
  const body = blocks
    .map((b) => {
      if (b.type === "heading")
        return `<h1 style="font-size:24px;line-height:1.3;margin:0 0 12px;color:#1d1d1f">${esc(b.text)}</h1>`;
      if (b.type === "text")
        return `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;color:#3a3a3c">${esc(b.text).replace(/\n/g, "<br>")}</p>`;
      if (b.type === "button")
        return `<p style="margin:18px 0"><a href="${esc(safeUrl(b.url))}" style="display:inline-block;background:#c74634;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">${esc(b.text || "Learn more")}</a></p>`;
      if (b.type === "image")
        return `<p style="margin:0 0 14px"><img src="${esc(safeUrl(b.url))}" alt="${esc(b.text)}" style="max-width:100%;border-radius:6px"></p>`;
      return `<hr style="border:0;border-top:1px solid #e5e5e5;margin:20px 0">`;
    })
    .join("\n");
  return `<div style="background:#f4f4f2;padding:24px 0"><div style="max-width:600px;margin:0 auto;background:#fff;padding:32px;border-radius:8px">${body}<p style="font-size:12px;color:#8a8a8e;margin-top:28px;border-top:1px solid #eee;padding-top:14px">${esc(brand)} · You receive this email because you subscribed. <a href="#unsubscribe" style="color:#8a8a8e">Unsubscribe</a></p></div></div>`;
}

export function emailChecks(
  subject: string,
  preheader: string,
  blocks: Block[],
) {
  const out: { ok: boolean; text: string }[] = [];
  out.push({
    ok: subject.trim().length > 0 && subject.length <= 60,
    text: subject.trim()
      ? `Subject is ${subject.length} characters (aim for 60 or fewer)`
      : "Add a subject line",
  });
  out.push({
    ok: preheader.length >= 30 && preheader.length <= 130,
    text: preheader
      ? `Preheader is ${preheader.length} characters (30–130 reads well)`
      : "Add a preheader: it shows next to the subject in the inbox",
  });
  const buttons = blocks.filter((b) => b.type === "button");
  out.push({
    ok: buttons.length >= 1,
    text: buttons.length
      ? `${buttons.length} call-to-action button(s)`
      : "Add one clear call-to-action button",
  });
  const badLinks = blocks.filter(
    (b) =>
      (b.type === "button" || b.type === "image") &&
      !/^https:\/\//i.test(b.url.trim()),
  );
  out.push({
    ok: !badLinks.length,
    text: badLinks.length
      ? `${badLinks.length} link(s) or image(s) without an https:// address`
      : "All links and images use https://",
  });
  const noAlt = blocks.filter((b) => b.type === "image" && !b.text.trim());
  out.push({
    ok: !noAlt.length,
    text: noAlt.length
      ? `${noAlt.length} image(s) without alt text`
      : "Images have alt text",
  });
  out.push({
    ok: true,
    text: "Unsubscribe link and sender line are added in the footer",
  });
  return out;
}

export function EmailBuilder({
  source,
  report,
  notify,
}: {
  source: Source;
  report: Report | null;
  notify: (m: string) => void;
}) {
  const [brand, setBrand] = useState(source.name.replace(/\s*[—-].*$/, "")),
    [subject, setSubject] = useState(""),
    [preheader, setPreheader] = useState(""),
    [blocks, setBlocks] = useState<Block[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const start = (k: string) => {
    const s = STARTERS[k]!;
    setSubject(s.subject);
    setPreheader(s.preheader);
    setBlocks(s.blocks.map((b) => ({ ...b, id: newId() })));
  };
  useEffect(() => start("webinar"), []);
  const html = useMemo(() => emailHtml(blocks, brand), [blocks, brand]);
  const checks = emailChecks(subject, preheader, blocks);
  const set = (id: string, patch: Partial<Block>) =>
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const move = (i: number, d: number) =>
    setBlocks((bs) => {
      const n = [...bs];
      const j = i + d;
      if (j < 0 || j >= n.length) return bs;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const save = async (useAI: boolean) => {
    if (!report)
      return setError(
        Error("Load data first: a draft is linked to an assessment."),
      );
    setBusy(true);
    setError(null);
    try {
      const r = await api("/sources/" + source.id + "/drafts", {
        draftType: "email_copy",
        reportId: report.id,
        title: subject || "Email draft",
        useAI,
      });
      if (useAI) {
        // Fill the builder from the AI (or rule-based) draft.
        const list: any[] = await api("/sources/" + source.id + "/drafts");
        const d = list.find((x) => x.id === r.id);
        const c =
          typeof d?.content === "string"
            ? JSON.parse(d.content)
            : d?.content || {};
        if (c.subject) setSubject(c.subject);
        if (c.preheader) setPreheader(c.preheader);
        const next: Block[] = [];
        if (c.body)
          String(c.body)
            .split(/\n{2,}/)
            .filter(Boolean)
            .forEach((t) =>
              next.push({
                id: newId(),
                type: "text",
                text: t.replace(/<[^>]+>/g, ""),
                url: "",
              }),
            );
        if (c.cta)
          next.push({
            id: newId(),
            type: "button",
            text: c.cta,
            url: "https://example.com",
          });
        if (next.length) setBlocks(next);
        notify(
          r.generator === "ai"
            ? "AI draft loaded into the builder. Review it before saving."
            : `AI unavailable (${r.note}); the builder keeps your content.`,
        );
      } else {
        await api(
          "/drafts/" + r.id,
          {
            content: {
              subject,
              preheader,
              body: html.slice(0, 20000),
              cta: blocks.find((b) => b.type === "button")?.text || "",
              notes: "Built in Email Builder. Body holds the email HTML.",
            },
            version: 1,
            note: "Saved from Email Builder",
          },
          "PATCH",
        );
        notify(
          "Saved as a draft. Find it under Follow-up → Drafts for review.",
        );
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="builder">
      <Panel
        title="Email Builder"
        subtitle="Write an email and see it as subscribers will. Saved emails are drafts in this platform for review; nothing is sent or published to Eloqua."
        extra={
          <Field label="Start from">
            <select
              defaultValue="webinar"
              onChange={(e) => start(e.target.value)}
            >
              <option value="blank">Blank</option>
              <option value="webinar">Webinar invitation</option>
              <option value="newsletter">Newsletter</option>
              <option value="product">Product update</option>
            </select>
          </Field>
        }
      >
        <div className="builder-grid">
          <div className="builder-form">
            <Field label="Sender name">
              <input value={brand} onChange={(e) => setBrand(e.target.value)} />
            </Field>
            <Field label="Subject line">
              <input
                value={subject}
                maxLength={150}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
            <Field label="Preheader">
              <input
                value={preheader}
                maxLength={200}
                onChange={(e) => setPreheader(e.target.value)}
              />
            </Field>
            <h3 className="builder-h">Content blocks</h3>
            {blocks.map((b, i) => (
              <div className="block-row" key={b.id}>
                <div className="block-head">
                  <b>{b.type[0]!.toUpperCase() + b.type.slice(1)}</b>
                  <span>
                    <button
                      className="icon-button"
                      aria-label="Move up"
                      onClick={() => move(i, -1)}
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Move down"
                      onClick={() => move(i, 1)}
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Remove block"
                      onClick={() =>
                        setBlocks((bs) => bs.filter((x) => x.id !== b.id))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                {b.type === "text" ? (
                  <textarea
                    rows={3}
                    value={b.text}
                    aria-label="Text"
                    onChange={(e) => set(b.id, { text: e.target.value })}
                  />
                ) : b.type !== "divider" ? (
                  <input
                    value={b.text}
                    aria-label={
                      b.type === "image"
                        ? "Alt text"
                        : b.type === "button"
                          ? "Button text"
                          : "Heading"
                    }
                    placeholder={
                      b.type === "image" ? "Alt text (describe the image)" : ""
                    }
                    onChange={(e) => set(b.id, { text: e.target.value })}
                  />
                ) : null}
                {(b.type === "button" || b.type === "image") && (
                  <input
                    value={b.url}
                    aria-label={
                      b.type === "image" ? "Image address" : "Link address"
                    }
                    placeholder="https://"
                    onChange={(e) => set(b.id, { url: e.target.value })}
                  />
                )}
              </div>
            ))}
            <div className="button-row">
              {(["heading", "text", "button", "image", "divider"] as const).map(
                (t) => (
                  <Button
                    key={t}
                    onClick={() =>
                      setBlocks((bs) => [
                        ...bs,
                        { id: newId(), type: t, text: "", url: "" },
                      ])
                    }
                  >
                    <Plus size={14} /> {t[0]!.toUpperCase() + t.slice(1)}
                  </Button>
                ),
              )}
            </div>
            <h3 className="builder-h">Checks</h3>
            <ul className="checks">
              {checks.map((c, i) => (
                <li key={i} className={c.ok ? "ok" : "todo"}>
                  {c.ok ? "✓" : "!"} {c.text}
                </li>
              ))}
            </ul>
            <ErrorBox error={error} />
            <div className="button-row">
              <Button primary disabled={busy} onClick={() => save(false)}>
                <Save size={15} /> Save as draft
              </Button>
              <Button disabled={busy} onClick={() => save(true)}>
                <Sparkles size={15} /> Write with AI
              </Button>
            </div>
          </div>
          <EmailPreview
            subject={subject}
            preheader={preheader}
            html={html}
            from={brand}
          />
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------- Unity: audience builder, profile ------------------------------- */

type Cond = { field: string; operator: string; value: string };
const OP_LABEL: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  starts_with: "starts with",
  is_present: "has a value",
  is_missing: "is empty",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  before: "before",
  after: "after",
  in: "is one of",
};

export function AudienceBuilder({
  source,
  report,
  notify,
}: {
  source: Source;
  report: Report | null;
  notify: (m: string) => void;
}) {
  const [match, setMatch] = useState<"all" | "any">("all"),
    [conds, setConds] = useState<Cond[]>([]),
    [fields, setFields] = useState<Record<string, string>>({}),
    [operators, setOperators] = useState<string[]>([]),
    [preview, setPreview] = useState<{ count: number; basis: string } | null>(
      null,
    ),
    [problem, setProblem] = useState(""),
    [request, setRequest] = useState(""),
    [name, setName] = useState("New audience"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const toDef = (cs: Cond[]) => ({
    match,
    conditions: cs.map((c) => ({
      field: c.field,
      operator: c.operator,
      ...(["is_present", "is_missing"].includes(c.operator)
        ? {}
        : c.operator === "in"
          ? {
              value: c.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            }
          : ["gt", "gte", "lt", "lte"].includes(c.operator) &&
              c.value !== "" &&
              !Number.isNaN(Number(c.value))
            ? { value: Number(c.value) }
            : { value: c.value }),
    })),
  });
  const timer = useRef<number | null>(null);
  const check = (cs: Cond[], body?: Record<string, unknown>) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      async () => {
        try {
          const r = await api(
            "/sources/" + source.id + "/audience/validate",
            body || { definition: toDef(cs) },
          );
          setFields(r.fields || {});
          setOperators(r.operators || []);
          if (r.ok) {
            setPreview(r.preview);
            setProblem(r.previewNote || "");
            if (body?.request && r.definition) {
              setMatch(r.definition.match);
              setConds(
                r.definition.conditions.map((c: any) => ({
                  field: c.field,
                  operator: c.operator,
                  value: Array.isArray(c.value)
                    ? c.value.join(", ")
                    : c.value == null
                      ? ""
                      : String(c.value),
                })),
              );
              notify("AI built the conditions. Check them before saving.");
            }
          } else {
            setPreview(null);
            setProblem(r.error || "");
          }
        } catch (e) {
          setError(e);
        }
      },
      body ? 0 : 350,
    );
  };
  useEffect(() => check(conds), [conds, match]);
  const fieldNames = Object.keys(fields).sort();
  const opsFor = (f: string) =>
    operators.filter((o) =>
      ["gt", "gte", "lt", "lte"].includes(o)
        ? fields[f] === "number"
        : ["before", "after"].includes(o)
          ? fields[f] === "date"
          : true,
    );
  const save = async () => {
    if (!report)
      return setError(
        Error("Load data first: a draft is linked to an assessment."),
      );
    setBusy(true);
    setError(null);
    try {
      const r = await api("/sources/" + source.id + "/drafts", {
        draftType: "segment_definition",
        reportId: report.id,
        title: name,
        useAI: false,
      });
      await api(
        "/drafts/" + r.id,
        {
          content: {
            request: request || name,
            definition: JSON.stringify(toDef(conds)),
            destination: "",
            notes: preview
              ? `Preview: ${preview.count} people in the local snapshot.`
              : "",
          },
          version: 1,
          note: "Saved from Audience Builder",
        },
        "PATCH",
      );
      notify("Audience saved as a draft. Find it under Follow-up → Drafts.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Audience Builder"
      subtitle="Describe who you want, see how many people match in this snapshot, and save it as a draft for review. Nothing is created in Unity."
    >
      <div className="ai-line">
        <input
          value={request}
          aria-label="Describe the audience"
          placeholder="Describe it in words, e.g. people in the US with an email address"
          onChange={(e) => setRequest(e.target.value)}
        />
        <Button
          disabled={!request.trim()}
          onClick={() => check(conds, { request })}
        >
          <Sparkles size={15} /> Build with AI
        </Button>
      </div>
      <div className="cond-head">
        People who match
        <select
          value={match}
          aria-label="Match"
          onChange={(e) => setMatch(e.target.value as "all" | "any")}
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of these conditions:
      </div>
      {conds.map((c, i) => (
        <div className="cond-row" key={i}>
          <select
            aria-label="Field"
            value={c.field}
            onChange={(e) =>
              setConds(
                conds.map((x, j) =>
                  j === i ? { ...x, field: e.target.value } : x,
                ),
              )
            }
          >
            {fieldNames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            aria-label="Operator"
            value={c.operator}
            onChange={(e) =>
              setConds(
                conds.map((x, j) =>
                  j === i ? { ...x, operator: e.target.value } : x,
                ),
              )
            }
          >
            {opsFor(c.field).map((o) => (
              <option key={o} value={o}>
                {OP_LABEL[o] || o}
              </option>
            ))}
          </select>
          {!["is_present", "is_missing"].includes(c.operator) && (
            <input
              aria-label="Value"
              value={c.value}
              placeholder={c.operator === "in" ? "a, b, c" : "value"}
              onChange={(e) =>
                setConds(
                  conds.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x,
                  ),
                )
              }
            />
          )}
          <button
            className="icon-button"
            aria-label="Remove condition"
            onClick={() => setConds(conds.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <Button
        disabled={!fieldNames.length}
        onClick={() =>
          setConds([
            ...conds,
            {
              field: fieldNames.includes("country")
                ? "country"
                : fieldNames[0]!,
              operator: "equals",
              value: "",
            },
          ])
        }
      >
        <Plus size={14} /> Add condition
      </Button>
      <div className="audience-result">
        <div>
          <span className="kpi-label">People who match</span>
          <strong>{preview ? preview.count.toLocaleString("en") : "—"}</strong>
          {preview && <small className="muted">{preview.basis}</small>}
          {problem && !preview && (
            <small className="warn-chip">{problem}</small>
          )}
        </div>
        <div className="save-line">
          <Field label="Audience name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button
            primary
            disabled={busy || !conds.length || !preview}
            onClick={save}
          >
            <Save size={15} /> Save as draft
          </Button>
        </div>
      </div>
      <ErrorBox error={error} />
    </Panel>
  );
}

export function ProfileLookup({ source }: { source: Source }) {
  const [q, setQ] = useState(""),
    [result, setResult] = useState<any>(undefined),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api("/sources/" + source.id + "/profile", { query: q }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const p = result?.profile;
  return (
    <Panel
      title="Customer profile"
      subtitle="One person across every linked source record: merged fields, consent and audiences. Each lookup is recorded in the audit log."
    >
      <form
        className="ai-line"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={q}
          aria-label="Find a person"
          placeholder="Master ID, source record ID, email or phone (exact)"
          onChange={(e) => setQ(e.target.value)}
        />
        <Button primary disabled={busy || q.trim().length < 2}>
          <Search size={15} /> Find
        </Button>
      </form>
      <ErrorBox error={error} />
      {result && !result.found && (
        <p className="muted">No profile matches that exactly.</p>
      )}
      {p && (
        <div className="profile">
          <div className="profile-head">
            <div className="avatar">
              {(p.fields.firstName || p.fields.email || "?")
                .slice(0, 1)
                .toUpperCase()}
            </div>
            <div>
              <h3>
                {[p.fields.firstName, p.fields.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                  p.fields.email ||
                  p.masterId}
              </h3>
              <span className="muted">
                {p.masterId
                  ? `Master ID ${p.masterId}`
                  : "Not linked to a master profile"}{" "}
                · {p.records.length} source record(s)
              </span>
            </div>
          </div>
          <div className="profile-grid">
            <section>
              <h4>Merged fields (latest value)</h4>
              <dl className="fields">
                {Object.entries(p.fields).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
            <section>
              <h4>Consent</h4>
              {p.consents.length ? (
                <ul className="related">
                  {p.consents.map((c: any, i: number) => (
                    <li key={i}>
                      <span
                        className={
                          "pill " + (c.status === "granted" ? "ok" : "bad")
                        }
                      >
                        {c.status}
                      </span>{" "}
                      {c.channel} · {c.purpose}
                      {c.expiresAt && (
                        <span className="muted"> · expires {c.expiresAt}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No consent records.</p>
              )}
              <h4>Audiences</h4>
              {p.audiences.length ? (
                <ul className="related">
                  {p.audiences.map((a: any, i: number) => (
                    <li key={i}>
                      <span className={"pill " + (a.ready ? "ok" : "bad")}>
                        {a.ready ? "ready" : "blocked"}
                      </span>{" "}
                      <b>{a.name}</b>
                      {a.destination && (
                        <span className="muted"> → {a.destination}</span>
                      )}
                      {!a.ready && a.blockers.length > 0 && (
                        <span className="muted">
                          {" "}
                          ({a.blockers.join(", ")})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">In no audience.</p>
              )}
            </section>
          </div>
          <details className="chart-table">
            <summary>Source records ({p.records.length})</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>System</th>
                    <th>Updated</th>
                    <th>Fields</th>
                  </tr>
                </thead>
                <tbody>
                  {p.records.map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td>{r.sourceSystem || "—"}</td>
                      <td>
                        {r.updatedAt ? String(r.updatedAt).slice(0, 10) : "—"}
                      </td>
                      <td className="muted">
                        {Object.entries(r.fields)
                          .filter(
                            ([k]) => !["sourceSystem", "updatedAt"].includes(k),
                          )
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------- builder tab per app ------------------------------- */

export const BUILDER_LABEL: Record<string, string> = {
  eloqua: "Email Builder",
  unity: "Audience Builder",
  infinity: "Journey Flow",
};

export function BuilderPage({
  app,
  studio,
  source,
  report,
  notify,
  onOpen,
}: {
  app: string;
  studio: Studio | null;
  source: Source;
  report: Report | null;
  notify: (m: string) => void;
  onOpen: (key: string) => void;
}) {
  const [view, setView] = useState("builder");
  if (app === "eloqua")
    return <EmailBuilder source={source} report={report} notify={notify} />;
  if (app === "unity")
    return (
      <>
        <div className="sub-tabs" role="group" aria-label="Audience tools">
          {[
            ["builder", "Audience builder"],
            ["profile", "Customer profile"],
            ["identity", "Identity flow"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-pressed={view === id}
              onClick={() => setView(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "builder" && (
          <AudienceBuilder source={source} report={report} notify={notify} />
        )}
        {view === "profile" && <ProfileLookup source={source} />}
        {view === "identity" && <StudioFlows studio={studio} />}
      </>
    );
  return (
    <>
      <StudioFlows studio={studio} />
      {studio && (
        <Panel
          title="Pages to look at first"
          subtitle="Highest single-page (bounce) rate among pages with enough entries. Click a page for its deep dive."
        >
          <ul className="related">
            {studio.entities
              .filter(
                (e) =>
                  e.group === "pages" &&
                  (e.sample.bounceRate ?? 0) >= MIN_SAMPLE &&
                  e.values.bounceRate != null,
              )
              .sort((a, b) => b.values.bounceRate! - a.values.bounceRate!)
              .slice(0, 6)
              .map((e) => (
                <li key={e.key}>
                  <button className="link-button" onClick={() => onOpen(e.key)}>
                    {e.label}
                  </button>{" "}
                  <span className="muted">
                    · bounce {fmtValue(e.values.bounceRate, "percent")} · exit{" "}
                    {fmtValue(e.values.exitRate, "percent")} · avg time{" "}
                    {fmtValue(e.values.avgTime, "seconds")}
                  </span>
                </li>
              ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

export function StudioFlows({ studio }: { studio: Studio | null }) {
  if (!studio) return null;
  if (!studio.flows.length)
    return (
      <Empty title="No flow in this data yet">
        Upload event data (Infinity) or profiles with master IDs and audiences
        (Unity) to draw the flow.
      </Empty>
    );
  return (
    <>
      {studio.flows.map((f) => (
        <Panel key={f.id} title={f.title} subtitle={f.about}>
          <FlowDiagram flow={f.flow} title={f.title} />
        </Panel>
      ))}
    </>
  );
}

/** The studio part of a tab: loads the studio data and shows the right screen. */
export function StudioTab({
  view,
  source,
  report,
  periodStart,
  periodEnd,
  selected,
  onSelect,
  onAsk,
  notify,
}: {
  view: "analyze" | "compare" | "builder";
  source: Source;
  report: Report | null;
  periodStart?: string;
  periodEnd?: string;
  selected: string;
  onSelect: (key: string) => void;
  onAsk?: (q: string) => void;
  notify: (m: string) => void;
}) {
  const { studio, error } = useStudio(source, report, periodStart, periodEnd);
  if (error) return <ErrorBox error={error} />;
  if (!studio && view !== "builder")
    return (
      <div className="loading" role="status">
        Loading…
      </div>
    );
  if (view === "builder")
    return (
      <BuilderPage
        app={source.app}
        studio={studio}
        source={source}
        report={report}
        notify={notify}
        onOpen={onSelect}
      />
    );
  if (view === "compare")
    return <StudioCompare studio={studio!} onOpen={onSelect} />;
  return (
    <DeepDive
      studio={studio!}
      selected={selected}
      onSelect={onSelect}
      onAsk={onAsk}
    />
  );
}
