/**
 * Deterministic metric computation with exact decimals.
 *
 * Rules (blueprint 10.2–10.6):
 * - Aggregate numerators and denominators first, then divide. Never average rates.
 * - Zero denominator → unavailable (insufficient_data), never 0%, 100% or Infinity.
 * - Blank → unavailable; a field missing on some rows → unavailable (partial_field).
 * - Event rates may exceed 100%; only probability-like rates above 100% are flagged.
 * - Percent changes are percentage points; relative change is undefined when prior is zero.
 */
import Decimal from 'decimal.js';
import type { MetricChange, MetricValue } from '../contracts/reports';
import {
  BASE_DEFS,
  DEFINITION_VERSION,
  RATE_DEFS,
  type BaseMeasure,
  type MeasurementOrigin,
  type MetricAvailability,
  type MetricUnit,
  type RateId,
  type UnavailableReason,
} from './registry';

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });

/** Canonical decimal string: up to `dp` places, no trailing zeros, no exponent. */
export function dstr(v: Decimal.Value, dp = 10): string {
  const s = new D(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed();
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
}

export interface MeasureAggregate {
  /** Exact sum as a decimal string, or null when no row has the field. */
  sum: string | null;
  rowsWithValue: number;
  rowsTotal: number;
}

export type Aggregates = Record<BaseMeasure, MeasureAggregate>;

export interface ComputeContext {
  currency: string | null;
  /** False when facts are daily rows of the same launch (launch-unique measures cannot be summed). */
  launchUniqueSummable: boolean;
  /** True when the requested period lies inside the dataset's declared coverage. */
  coverageComplete: boolean;
  evidencePrefix: string;
}

export function emptyAggregates(): Aggregates {
  const out = {} as Aggregates;
  for (const k of Object.keys(BASE_DEFS) as BaseMeasure[]) out[k] = { sum: null, rowsWithValue: 0, rowsTotal: 0 };
  return out;
}

function mv(
  metricId: string,
  label: string,
  unit: MetricUnit,
  currency: string | null,
  value: string | null,
  availability: MetricAvailability,
  origin: MeasurementOrigin | null,
  extra: Partial<MetricValue> = {}
): MetricValue {
  return {
    metricId,
    label,
    value,
    unit,
    currency,
    availability,
    origin,
    definitionVersion: DEFINITION_VERSION,
    numeratorMetricId: null,
    denominatorMetricId: null,
    evidenceIds: [],
    warnings: [],
    reason: null,
    higherIsBetter: null,
    ...extra,
  };
}

export function baseMetric(id: BaseMeasure, agg: MeasureAggregate, ctx: ComputeContext): MetricValue {
  const def = BASE_DEFS[id];
  const currency = def.unit === 'money' ? ctx.currency : null;
  const evidenceIds = [`${ctx.evidencePrefix}:${id}`];
  const hib = id === 'bounces' || id === 'unsubscribes' || id === 'complaints' || id === 'skipped' ? false : true;
  const unavailable = (reason: UnavailableReason, availability: MetricAvailability, warnings: string[] = []) =>
    mv(id, def.label, def.unit, currency, null, availability, null, { reason, warnings, evidenceIds, higherIsBetter: hib });

  if (!ctx.coverageComplete) return unavailable('missing_history', 'missing', ['The requested period is outside the data coverage']);
  if (def.additivity === 'launch_unique' && !ctx.launchUniqueSummable) {
    return unavailable('not_additive', 'not_applicable', ['Unique counts cannot be summed across days of the same launch']);
  }
  if (agg.rowsTotal === 0) {
    // Covered period with no activity: a measured zero.
    return mv(id, def.label, def.unit, currency, '0', 'available', 'observed', { evidenceIds, higherIsBetter: hib, warnings: ['No activity in this period'] });
  }
  if (agg.rowsWithValue === 0 || agg.sum === null) return unavailable('missing_field', 'missing', ['The source does not provide this field']);
  if (agg.rowsWithValue < agg.rowsTotal) {
    return unavailable('partial_field', 'missing', [`${agg.rowsTotal - agg.rowsWithValue} of ${agg.rowsTotal} rows have no value, so a total would be incomplete`]);
  }
  const warnings = def.additivity === 'launch_unique' ? ['Summed across launches: counts messages, not unique people'] : [];
  return mv(id, def.label, def.unit, currency, dstr(agg.sum, 4), 'available', 'observed', { evidenceIds, warnings, higherIsBetter: hib });
}

export function rateMetric(id: RateId, num: MetricValue, den: MetricValue, ctx: ComputeContext): MetricValue {
  const def = RATE_DEFS[id];
  const currency = def.unit === 'percent' ? null : ctx.currency;
  const base = {
    numeratorMetricId: def.numerator,
    denominatorMetricId: def.denominator,
    evidenceIds: [`${ctx.evidencePrefix}:${id}`],
    higherIsBetter: def.higherIsBetter,
  };
  const unavailable = (reason: UnavailableReason, availability: MetricAvailability, warnings: string[]) =>
    mv(id, def.label, def.unit, currency, null, availability, null, { ...base, reason, warnings });

  if (num.value === null) return unavailable(num.reason ?? 'missing_field', num.availability === 'not_applicable' ? 'not_applicable' : 'missing', [`Numerator unavailable: ${num.label}`]);
  if (den.value === null) return unavailable(den.reason ?? 'missing_field', den.availability === 'not_applicable' ? 'not_applicable' : 'missing', [`Denominator unavailable: ${den.label}`]);
  const d = new D(den.value);
  if (d.isZero()) return unavailable('zero_denominator', 'insufficient_data', [`${den.label} is zero, so the ratio is undefined`]);
  const value = new D(num.value).div(d).mul(def.scale);
  const warnings: string[] = [];
  let availability: MetricAvailability = 'available';
  if (def.probabilityLike && value.gt(100)) {
    availability = 'conflicted';
    warnings.push(`${def.label} exceeds 100%, which this definition does not allow — check the source fields`);
  }
  return mv(id, def.label, def.unit, currency, dstr(value), availability, 'derived', { ...base, warnings });
}

export const DEFAULT_RATES: RateId[] = [
  'delivered_rate',
  'bounce_rate',
  'unique_open_rate',
  'total_open_rate',
  'unique_click_rate',
  'total_click_rate',
  'unique_click_to_open_rate',
  'conversion_event_rate',
  'unsubscribe_rate',
  'complaint_rate',
  'revenue_per_delivered',
  'revenue_per_1000_delivered',
  'average_order_value',
];

/** All base measures and default rates for one aggregate. */
export function computeAll(aggs: Aggregates, ctx: ComputeContext): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const id of Object.keys(BASE_DEFS) as BaseMeasure[]) out[id] = baseMetric(id, aggs[id], ctx);
  for (const id of DEFAULT_RATES) {
    const def = RATE_DEFS[id];
    out[id] = rateMetric(id, out[def.numerator]!, out[def.denominator]!, ctx);
  }
  return out;
}

/** Change between two compatible metric values. */
export function compareMetric(current: MetricValue, previous: MetricValue | null): MetricChange {
  const res: MetricChange = {
    metricId: current.metricId,
    label: current.label,
    current,
    previous,
    absoluteChange: null,
    absoluteChangeUnit: null,
    relativeChangePct: null,
    note: null,
    direction: null,
    interpretation: null,
  };
  if (!previous) {
    res.note = 'No comparison period';
    return res;
  }
  if (current.value === null || previous.value === null) {
    res.note = previous.value === null ? `Comparison value unavailable${previous.reason ? ` (${previous.reason})` : ''}` : 'Current value unavailable';
    return res;
  }
  if (current.unit !== previous.unit || current.currency !== previous.currency) {
    res.note = 'Values use different units or currencies and cannot be compared';
    return res;
  }
  const c = new D(current.value);
  const p = new D(previous.value);
  const diff = c.minus(p);
  res.absoluteChange = dstr(diff);
  res.absoluteChangeUnit = current.unit === 'percent' ? 'pp' : current.unit;
  if (p.isZero()) {
    res.note = 'Relative change is undefined because the comparison value is zero';
  } else {
    res.relativeChangePct = dstr(diff.div(p.abs()).mul(100));
  }
  res.direction = diff.isZero() ? 'flat' : diff.gt(0) ? 'up' : 'down';
  const hib = current.higherIsBetter;
  res.interpretation = hib === null || diff.isZero() ? 'neutral' : (diff.gt(0) === hib ? 'better' : 'worse');
  return res;
}

/** Sum aggregates (e.g. channel totals); currencies must already match. */
export function addAggregates(a: Aggregates, b: Aggregates): Aggregates {
  const out = emptyAggregates();
  for (const k of Object.keys(out) as BaseMeasure[]) {
    const x = a[k];
    const y = b[k];
    out[k] = {
      sum: x.sum === null && y.sum === null ? null : dstr(new D(x.sum ?? 0).plus(y.sum ?? 0), 4),
      rowsWithValue: x.rowsWithValue + y.rowsWithValue,
      rowsTotal: x.rowsTotal + y.rowsTotal,
    };
  }
  return out;
}

export { D as Dec };
