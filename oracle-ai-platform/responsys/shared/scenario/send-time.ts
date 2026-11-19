import type { OverviewResult } from '../contracts/reports';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Row = NonNullable<OverviewResult['sendTime']>[number];
export interface SendTimeBaseline { open: number | null; click: number | null; openMetricId: string | null; clickMetricId: string | null }
const number = (row: Row, id: string | null): number | null => {
  const raw = row.metrics.find((m) => m.metricId === id)?.value;
  return raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
};

/** Historical association, shrunk toward the selected baseline. No assumed lift or user multipliers. */
export function estimateSendTime(rows: Row[], channel: string, baseline: SendTimeBaseline, weekday: number | null, time: string) {
  const candidates = rows.filter((r) => r.channel.toLowerCase() === channel.toLowerCase() && r.launches >= 3 && (number(r, 'delivered') ?? 0) >= 100 && number(r, baseline.openMetricId) !== null);
  const best = (list: Row[]) => [...list].sort((a, b) => (number(b, baseline.openMetricId) ?? -1) - (number(a, baseline.openMetricId) ?? -1) || (number(b, baseline.clickMetricId) ?? -1) - (number(a, baseline.clickMetricId) ?? -1) || a.weekday - b.weekday || (a.hour ?? 0) - (b.hour ?? 0))[0];
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? Number(time.slice(0, 2)) : null;
  const recommended = best(candidates.filter((r) => r.hour !== null)) ?? best(candidates.filter((r) => r.hour === null));
  const selected = weekday === null ? recommended : candidates.find((r) => r.weekday === weekday && r.hour === hour && hour !== null) ?? candidates.find((r) => r.weekday === weekday && r.hour === null);
  const delivered = selected ? number(selected, 'delivered') ?? 0 : 0;
  // A fixed prior prevents tiny cohorts from dominating the estimate. This is not a calibrated forecast.
  const weight = delivered / (delivered + 500);
  const blend = (id: string | null, fallback: number | null) => {
    const observed = selected ? number(selected, id) : null;
    return observed === null || fallback === null ? fallback : observed * weight + fallback * (1 - weight);
  };
  return {
    open: blend(baseline.openMetricId, baseline.open), click: blend(baseline.clickMetricId, baseline.click),
    basis: selected ? selected.hour === null ? 'weekday' as const : 'hour' as const : 'baseline' as const,
    weekday: selected?.weekday ?? weekday, hour: selected?.hour ?? null,
    launches: selected?.launches ?? 0, delivered, recommended,
    explanation: selected
      ? `${WEEKDAYS[selected.weekday - 1]}${selected.hour === null ? ' (weekday only; no reliable hour estimate)' : ` ${String(selected.hour).padStart(2, '0')}:00–${String(selected.hour).padStart(2, '0')}:59`}: ${selected.launches} historical launches, ${Math.round(delivered).toLocaleString('en-US')} delivered in this channel. Small historical samples are balanced against the selected baseline. Historical association, not guaranteed uplift.`
      : 'Not enough matching send-time history (at least 3 launches and 100 delivered are required). Estimates use baseline rates; changing the clock time does not add an assumed uplift.',
  };
}
