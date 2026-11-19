// Charts for module sections. Values come from the assessment engine; the chart only draws them.
// Categorical colours follow a validated, colour-blind-checked order and are never cycled.
import React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartSpec, Metric } from "../shared/catalog";

/** Fixed categorical order (blue, orange, aqua, yellow, magenta, green, violet, red). */
export const SERIES = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];
const INK = "#52514e",
  GRID = "#e8e8e5";

export function fmtValue(
  v: unknown,
  unit?: Metric["unit"],
  currency = "USD",
): string {
  if (v === null || v === undefined || v === "") return "Unavailable";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (unit === "money")
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n);
  if (unit === "percent")
    return (
      new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n) + "%"
    );
  if (unit === "seconds") {
    const r = Math.round(n);
    return r >= 60 ? `${Math.floor(r / 60)}m ${r % 60}s` : `${r}s`;
  }
  if (unit === "days")
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n)} days`;
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n);
}
const compactNum = (v: number, unit?: Metric["unit"], currency?: string) =>
  unit === "money"
    ? new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency || "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(v)
    : unit === "percent"
      ? `${Math.round(v * 10) / 10}%`
      : unit === "seconds"
        ? v >= 60
          ? `${Math.round((v / 60) * 10) / 10}m`
          : `${Math.round(v)}s`
        : new Intl.NumberFormat("en", {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(v);

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  currency,
}: {
  active?: boolean;
  payload?: { name: string; value: number | null; color: string }[];
  label?: string;
  unit?: Metric["unit"];
  currency?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && <b>{label}</b>}
      {payload.map((p) => (
        <div key={p.name}>
          <i style={{ background: p.color }} /> {p.name}:{" "}
          <span>{fmtValue(p.value, unit, currency)}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartView({
  chart,
  title,
  currency,
  compact = false,
}: {
  chart: ChartSpec;
  title: string;
  currency?: string;
  /** Small preview (overview tiles): no legend or table. */
  compact?: boolean;
}) {
  const { x, series, data, unit } = chart;
  // Small tiles with many categories read better as horizontal bars (labels stay legible).
  const type =
    compact && chart.type === "bar" && data.length > 4 ? "hbar" : chart.type;
  // Category labels are shortened to the space each one has.
  // Few categories: every label is shown, shortened to its space. Many (such as days): labels are
  // thinned out by the chart instead, so each one can stay readable.
  const room =
    data.length > 8
      ? 10
      : Math.max(
          4,
          Math.min(
            14,
            Math.floor((compact ? 300 : 900) / Math.max(1, data.length) / 7.5),
          ),
        );
  const color = (i: number) => SERIES[i % SERIES.length];
  const axisProps = {
    tick: { fill: INK, fontSize: 12 },
    tickLine: false,
    axisLine: { stroke: GRID },
  };
  const valueAxis = {
    ...axisProps,
    axisLine: false,
    width: 64,
    // Counts are whole numbers on the axis.
    allowDecimals: unit !== "count",
    tickFormatter: (v: number) => compactNum(v, unit, currency),
  };
  const tip = (
    <Tooltip
      content={<ChartTooltip unit={unit} currency={currency} />}
      cursor={{ fill: "rgba(42,120,214,0.06)", stroke: GRID }}
    />
  );
  const legend = !compact && series.length > 1 && (
    <Legend
      verticalAlign="top"
      align="left"
      iconType="circle"
      iconSize={9}
      wrapperStyle={{ fontSize: 12, color: INK, paddingBottom: 8 }}
    />
  );
  const height = compact
    ? type === "hbar"
      ? Math.max(150, data.length * 24 + 30)
      : 150
    : type === "hbar"
      ? Math.max(180, data.length * 34 + 40)
      : 260;
  let body: React.ReactElement;
  if (type === "donut") {
    const s = series[0];
    const total = data.reduce((t, d) => t + (Number(d[s.key]) || 0), 0);
    body = (
      <PieChart>
        {tip}
        <Pie
          data={data}
          dataKey={s.key}
          nameKey={x}
          innerRadius="58%"
          outerRadius="85%"
          paddingAngle={1.5}
          stroke="#fff"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={color(i)} />
          ))}
        </Pie>
        {!compact && (
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            iconType="circle"
            iconSize={9}
            wrapperStyle={{ fontSize: 12, color: INK }}
            formatter={(name: string, entry: any) =>
              `${name} · ${total ? Math.round((Number(entry.payload?.value ?? entry.payload?.[s.key]) / total) * 1000) / 10 : 0}%`
            }
          />
        )}
      </PieChart>
    );
  } else if (type === "line") {
    body = (
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={x} {...axisProps} minTickGap={16} />
        <YAxis {...valueAxis} />
        {tip}
        {legend}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={color(i)}
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, fill: "#fff" }}
            activeDot={{ r: 6 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  } else if (type === "area") {
    body = (
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient
              key={s.key}
              id={`g-${s.key}-${i}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={color(i)} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color(i)} stopOpacity={0.03} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={x} {...axisProps} minTickGap={24} />
        <YAxis {...valueAxis} />
        {tip}
        {legend}
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId={chart.stacked ? "a" : undefined}
            stroke={color(i)}
            strokeWidth={2}
            fill={`url(#g-${s.key}-${i})`}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  } else {
    const horizontal = type === "hbar";
    const stacked = type === "stacked";
    body = (
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        barCategoryGap={horizontal ? 8 : "22%"}
        barGap={2}
      >
        <CartesianGrid
          stroke={GRID}
          horizontal={!horizontal}
          vertical={horizontal}
        />
        {horizontal ? (
          <>
            <XAxis type="number" {...valueAxis} axisLine={false} />
            <YAxis
              type="category"
              dataKey={x}
              {...axisProps}
              interval={0}
              width={150}
              tickFormatter={(v: string) =>
                String(v).length > 22 ? String(v).slice(0, 21) + "…" : v
              }
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={x}
              {...axisProps}
              interval={data.length <= 8 ? 0 : "preserveStartEnd"}
              minTickGap={8}
              tickFormatter={(v: string) =>
                String(v).length > room ? String(v).slice(0, room - 1) + "…" : v
              }
            />
            <YAxis {...valueAxis} />
          </>
        )}
        {tip}
        {legend}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={color(i)}
            stackId={stacked ? "s" : undefined}
            radius={
              stacked && i < series.length - 1
                ? 0
                : horizontal
                  ? [0, 4, 4, 0]
                  : [4, 4, 0, 0]
            }
            maxBarSize={horizontal ? 22 : 44}
            stroke="#fff"
            strokeWidth={stacked ? 1 : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  }
  return (
    <div className="chart">
      <div
        className="chart-canvas"
        role="img"
        aria-label={`${title}: chart. A table view is available below.`}
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          {body}
        </ResponsiveContainer>
      </div>
      {!compact && (
        <details className="chart-table">
          <summary>Show as table</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{x === "label" ? "" : x}</th>
                  {series.map((s) => (
                    <th key={s.key}>{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={i}>
                    <td>{String(d[x] ?? "")}</td>
                    {series.map((s) => (
                      <td key={s.key} className="numeric">
                        {fmtValue(d[s.key], unit, currency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
