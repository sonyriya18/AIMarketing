/**
 * Small display helpers over report snapshots. They only read and format values the server
 * computed; they never fill a missing value with a number.
 */
import type { MetricChange, MetricValue } from './types';
import { fmtChange, fmtMetric, reasonText } from '../../shared/format';

type MetricBag = MetricValue[] | Record<string, MetricValue> | undefined | null;

export function metricOf(bag: MetricBag, id: string): MetricValue | undefined {
  if (!bag) return undefined;
  return Array.isArray(bag) ? bag.find((m) => m.metricId === id) : bag[id];
}

export const changeOf = (list: MetricChange[] | undefined, id: string) => list?.find((c) => c.metricId === id);

/** Number for charts and ranking; null when unavailable. */
export const num = (m: MetricValue | null | undefined): number | null => (m && m.value !== null ? Number(m.value) : null);

/** Display string, or "Unavailable" — never 0 for a missing value. */
export const show = (m: MetricValue | null | undefined, compact = false) => (m ? fmtMetric(m, { compact }) : 'Unavailable');

export const why = (m: MetricValue | null | undefined) => (m && m.value === null ? reasonText(m.reason) : '');

export const showChange = (c: MetricChange | undefined) => (c && c.absoluteChange !== null ? fmtChange(c) : '—');

/** Opens: prefer the source's unique opens; fall back to total opens (labelled as such). */
export function openRate(bag: MetricBag): MetricValue | undefined {
  const u = metricOf(bag, 'unique_open_rate');
  return u && u.value !== null ? u : metricOf(bag, 'total_open_rate') ?? u;
}
export function clickRate(bag: MetricBag): MetricValue | undefined {
  const u = metricOf(bag, 'unique_click_rate');
  return u && u.value !== null ? u : metricOf(bag, 'total_click_rate') ?? u;
}
export const openRateId = (bag: MetricBag) => openRate(bag)?.metricId ?? 'unique_open_rate';
export const clickRateId = (bag: MetricBag) => clickRate(bag)?.metricId ?? 'unique_click_rate';

export const money = (v: number | null, currency: string, digits = 0) =>
  v === null ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
export const count = (v: number | null) => (v === null ? 'Unavailable' : Math.round(v).toLocaleString('en-US'));
export const pct = (v: number | null, digits = 2) => (v === null ? 'Unavailable' : `${v.toFixed(digits)}%`);

/** Relative position of a value against a benchmark, for "above / below" labels. */
export function versus(value: MetricValue | undefined, bench: MetricValue | undefined): 'better' | 'worse' | 'same' | null {
  const a = num(value);
  const b = num(bench);
  if (a === null || b === null || value?.higherIsBetter === null || value?.higherIsBetter === undefined) return null;
  if (a === b) return 'same';
  return (a > b) === value.higherIsBetter ? 'better' : 'worse';
}
