/**
 * Metric registry (blueprint section 10). Semantic IDs — never display labels — are used to
 * join and compute metrics. Each definition states its unit, numerator/denominator, how it
 * aggregates, and whether probability-like bounds apply.
 */

export const DEFINITION_VERSION = 'metrics-2026-10-15.1';

export type MetricUnit = 'count' | 'percent' | 'ratio' | 'money' | 'money_per_message';
export type MeasurementOrigin = 'observed' | 'derived' | 'estimated' | 'user_assumption' | 'scenario';
export type MetricAvailability = 'available' | 'missing' | 'not_applicable' | 'insufficient_data' | 'conflicted';
export type UnavailableReason =
  | 'missing_field'
  | 'unsupported_grain'
  | 'missing_permission'
  | 'missing_history'
  | 'ambiguous_definition'
  | 'source_not_configured'
  | 'zero_denominator'
  | 'partial_field'
  | 'mixed_currency'
  | 'not_additive';

/** Additive base measures stored on campaign launch facts. */
export const BASE_MEASURES = [
  'sent',
  'delivered',
  'skipped',
  'bounces',
  'total_opens',
  'unique_opens',
  'total_clicks',
  'unique_clicks',
  'conversion_events',
  'orders',
  'revenue',
  'unsubscribes',
  'complaints',
] as const;
export type BaseMeasure = (typeof BASE_MEASURES)[number];

export interface BaseMeasureDef {
  id: BaseMeasure;
  label: string;
  unit: 'count' | 'money';
  /**
   * `additive`: sums across launches and days.
   * `launch_unique`: a per-launch distinct count (e.g. messages opened at least once). Sums across
   * different launches are message-level counts (NOT unique people); it cannot be summed across days.
   */
  additivity: 'additive' | 'launch_unique';
  description: string;
}

export const BASE_DEFS: Record<BaseMeasure, BaseMeasureDef> = {
  sent: { id: 'sent', label: 'Sent', unit: 'count', additivity: 'additive', description: 'Messages the source reports as sent.' },
  delivered: { id: 'delivered', label: 'Delivered', unit: 'count', additivity: 'additive', description: 'Messages the source reports as delivered (SMTP/channel acceptance, not inbox placement).' },
  skipped: { id: 'skipped', label: 'Skipped', unit: 'count', additivity: 'additive', description: 'Messages the source reports as skipped.' },
  bounces: { id: 'bounces', label: 'Bounces', unit: 'count', additivity: 'additive', description: 'Bounced messages as reported by the source.' },
  total_opens: { id: 'total_opens', label: 'Total opens', unit: 'count', additivity: 'additive', description: 'All open events, including repeats.' },
  unique_opens: {
    id: 'unique_opens',
    label: 'Unique opens',
    unit: 'count',
    additivity: 'launch_unique',
    description: 'Source-defined unique opens per launch. Summed across launches it counts opened messages, not unique people.',
  },
  total_clicks: { id: 'total_clicks', label: 'Total clicks', unit: 'count', additivity: 'additive', description: 'All click events, including repeats.' },
  unique_clicks: {
    id: 'unique_clicks',
    label: 'Unique clicks',
    unit: 'count',
    additivity: 'launch_unique',
    description: 'Source-defined unique clicks per launch. In Responsys this can count different links clicked by one recipient; it is not unique people.',
  },
  conversion_events: { id: 'conversion_events', label: 'Conversion events', unit: 'count', additivity: 'additive', description: 'Conversion events attributed by the source. Not necessarily orders.' },
  orders: { id: 'orders', label: 'Orders', unit: 'count', additivity: 'additive', description: 'Recognized orders, only when the source states it.' },
  revenue: { id: 'revenue', label: 'Attributed revenue', unit: 'money', additivity: 'additive', description: 'Provider-attributed revenue. Not incremental, net, or reconciled accounting revenue.' },
  unsubscribes: { id: 'unsubscribes', label: 'Unsubscribes', unit: 'count', additivity: 'additive', description: 'Opt-outs attributed to the messages.' },
  complaints: { id: 'complaints', label: 'Complaints', unit: 'count', additivity: 'additive', description: 'Spam complaints reported by the source.' },
};

export const RATE_IDS = [
  'delivered_rate',
  'bounce_rate',
  'total_open_rate',
  'unique_open_rate',
  'total_click_rate',
  'unique_click_rate',
  'unique_click_to_open_rate',
  'conversion_event_rate',
  'unsubscribe_rate',
  'complaint_rate',
  'revenue_per_delivered',
  'revenue_per_1000_delivered',
  'average_order_value',
] as const;
export type RateId = (typeof RATE_IDS)[number];

export interface RateDef {
  id: RateId;
  label: string;
  unit: 'percent' | 'money_per_message' | 'money';
  numerator: BaseMeasure;
  denominator: BaseMeasure;
  /** Multiplier applied to numerator/denominator. */
  scale: number;
  /** True only when the definition justifies a 0–100% bound (one outcome per message). */
  probabilityLike: boolean;
  higherIsBetter: boolean | null;
  formula: string;
}

export const RATE_DEFS: Record<RateId, RateDef> = {
  delivered_rate: { id: 'delivered_rate', label: 'Delivered rate', unit: 'percent', numerator: 'delivered', denominator: 'sent', scale: 100, probabilityLike: true, higherIsBetter: true, formula: 'delivered / sent × 100' },
  bounce_rate: { id: 'bounce_rate', label: 'Bounce rate', unit: 'percent', numerator: 'bounces', denominator: 'sent', scale: 100, probabilityLike: true, higherIsBetter: false, formula: 'bounces / sent × 100' },
  total_open_rate: { id: 'total_open_rate', label: 'Total open rate', unit: 'percent', numerator: 'total_opens', denominator: 'delivered', scale: 100, probabilityLike: false, higherIsBetter: true, formula: 'total opens / delivered × 100 (can exceed 100%)' },
  unique_open_rate: { id: 'unique_open_rate', label: 'Unique open rate', unit: 'percent', numerator: 'unique_opens', denominator: 'delivered', scale: 100, probabilityLike: true, higherIsBetter: true, formula: 'source-defined unique opens / delivered × 100' },
  total_click_rate: { id: 'total_click_rate', label: 'Total click-through rate', unit: 'percent', numerator: 'total_clicks', denominator: 'delivered', scale: 100, probabilityLike: false, higherIsBetter: true, formula: 'total clicks / delivered × 100 (can exceed 100%)' },
  unique_click_rate: { id: 'unique_click_rate', label: 'Unique click-through rate', unit: 'percent', numerator: 'unique_clicks', denominator: 'delivered', scale: 100, probabilityLike: false, higherIsBetter: true, formula: 'source-defined unique clicks / delivered × 100 (link-unique; may exceed unique people)' },
  unique_click_to_open_rate: { id: 'unique_click_to_open_rate', label: 'Unique click-to-open rate', unit: 'percent', numerator: 'unique_clicks', denominator: 'unique_opens', scale: 100, probabilityLike: false, higherIsBetter: true, formula: 'source-defined unique clicks / source-defined unique opens × 100' },
  conversion_event_rate: { id: 'conversion_event_rate', label: 'Conversion event rate', unit: 'percent', numerator: 'conversion_events', denominator: 'delivered', scale: 100, probabilityLike: false, higherIsBetter: true, formula: 'conversion events / delivered × 100 (events, not converters)' },
  unsubscribe_rate: { id: 'unsubscribe_rate', label: 'Unsubscribe rate', unit: 'percent', numerator: 'unsubscribes', denominator: 'delivered', scale: 100, probabilityLike: true, higherIsBetter: false, formula: 'unsubscribes / delivered × 100' },
  complaint_rate: { id: 'complaint_rate', label: 'Complaint rate', unit: 'percent', numerator: 'complaints', denominator: 'delivered', scale: 100, probabilityLike: true, higherIsBetter: false, formula: 'complaints / delivered × 100' },
  revenue_per_delivered: { id: 'revenue_per_delivered', label: 'Revenue per delivered message', unit: 'money_per_message', numerator: 'revenue', denominator: 'delivered', scale: 1, probabilityLike: false, higherIsBetter: true, formula: 'attributed revenue / delivered' },
  revenue_per_1000_delivered: { id: 'revenue_per_1000_delivered', label: 'Revenue per 1,000 delivered', unit: 'money', numerator: 'revenue', denominator: 'delivered', scale: 1000, probabilityLike: false, higherIsBetter: true, formula: 'attributed revenue / delivered × 1000' },
  average_order_value: { id: 'average_order_value', label: 'Average order value', unit: 'money', numerator: 'revenue', denominator: 'orders', scale: 1, probabilityLike: false, higherIsBetter: null, formula: 'attributed revenue / recognized orders (requires an orders field)' },
};

/** Source-reported rates from the legacy account-period summary (no numerators available). */
export const SOURCE_RATE_IDS = [
  'reported_bounce_rate',
  'reported_soft_bounce_rate',
  'reported_hard_bounce_rate',
  'reported_open_rate',
  'reported_unique_open_rate',
  'reported_total_open_rate',
  'reported_click_rate',
  'reported_unique_click_rate',
  'reported_total_click_rate',
  'reported_unsubscribe_rate',
] as const;
export type SourceRateId = (typeof SOURCE_RATE_IDS)[number];

export const SOURCE_RATE_LABEL: Record<SourceRateId, string> = {
  reported_bounce_rate: 'Bounce rate (as reported)',
  reported_soft_bounce_rate: 'Soft bounce rate (as reported)',
  reported_hard_bounce_rate: 'Hard bounce rate (as reported)',
  reported_open_rate: 'Open rate (as reported; definition not stated)',
  reported_unique_open_rate: 'Unique open rate (as reported)',
  reported_total_open_rate: 'Total open rate (as reported)',
  reported_click_rate: 'Click-through rate (as reported; definition not stated)',
  reported_unique_click_rate: 'Unique click-through rate (as reported)',
  reported_total_click_rate: 'Total click-through rate (as reported)',
  reported_unsubscribe_rate: 'Unsubscribe rate (as reported)',
};

export const SOURCE_RATE_HIGHER_IS_BETTER: Record<SourceRateId, boolean> = {
  reported_bounce_rate: false,
  reported_soft_bounce_rate: false,
  reported_hard_bounce_rate: false,
  reported_open_rate: true,
  reported_unique_open_rate: true,
  reported_total_open_rate: true,
  reported_click_rate: true,
  reported_unique_click_rate: true,
  reported_total_click_rate: true,
  reported_unsubscribe_rate: false,
};

export type MetricId = BaseMeasure | RateId | SourceRateId;

export function metricLabel(id: string): string {
  if (id in BASE_DEFS) return BASE_DEFS[id as BaseMeasure].label;
  if (id in RATE_DEFS) return RATE_DEFS[id as RateId].label;
  if (id in SOURCE_RATE_LABEL) return SOURCE_RATE_LABEL[id as SourceRateId];
  return id;
}
