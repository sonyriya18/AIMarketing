/**
 * Report periods in an account's IANA timezone, as half-open intervals
 * [startInclusive, endExclusive). Presets follow the injected clock — never fixed dates.
 *
 * "Last N complete days" = N local calendar dates ending at the start of today.
 * "Last 7 days including today" is a different, explicitly partial preset.
 * Calendar months and rolling day counts are distinct presets.
 */
import type { Clock } from './clock';
import { addDays, addMonths, diffDays, isIsoDate, localDate, startOfMonth, startOfYear, zonedStartOfDay } from './zoned';

export const PERIOD_PRESETS = [
  'last_7_complete_days',
  'last_7_days_including_today',
  'last_14_complete_days',
  'last_30_complete_days',
  'last_60_complete_days',
  'last_90_complete_days',
  'last_180_complete_days',
  'last_365_complete_days',
  'month_to_date',
  'previous_calendar_month',
  'last_3_complete_calendar_months',
  'last_6_complete_calendar_months',
  'last_12_complete_calendar_months',
  'last_24_complete_calendar_months',
  'last_36_complete_calendar_months',
  'year_to_date',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PRESET_LABEL: Record<PeriodPreset, string> = {
  last_7_complete_days: 'Last 7 complete days',
  last_7_days_including_today: 'Last 7 days including today (partial)',
  last_14_complete_days: 'Last 14 complete days',
  last_30_complete_days: 'Last 30 complete days',
  last_60_complete_days: 'Last 60 complete days',
  last_90_complete_days: 'Last 90 complete days',
  last_180_complete_days: 'Last 180 complete days',
  last_365_complete_days: 'Last 365 complete days',
  month_to_date: 'Month to date (partial)',
  previous_calendar_month: 'Previous calendar month',
  last_3_complete_calendar_months: 'Last 3 complete calendar months',
  last_6_complete_calendar_months: 'Last 6 months',
  last_12_complete_calendar_months: 'Last 1 year',
  last_24_complete_calendar_months: 'Last 2 years',
  last_36_complete_calendar_months: 'Last 3 years',
  year_to_date: 'Year to date (partial)',
  custom: 'Custom range',
};

export const COMPARISON_POLICIES = ['none', 'preceding_equal_duration', 'preceding_calendar_period'] as const;
export type ComparisonPolicy = (typeof COMPARISON_POLICIES)[number];

export interface PeriodRequest {
  preset: PeriodPreset;
  /** Custom only: first local date, inclusive. */
  startDate?: string;
  /** Custom only: last local date, inclusive (converted to the next day, exclusive). */
  endDate?: string;
}

export interface ResolvedPeriod {
  preset: PeriodPreset;
  label: string;
  timezone: string;
  startDate: string;
  endDateExclusive: string;
  /** Inclusive last date, for display. */
  endDateInclusive: string;
  startInclusive: string;
  endExclusive: string;
  days: number;
  /** True when the period includes today or later, so results are still maturing. */
  partial: boolean;
  calendarUnit: 'day' | 'month' | 'year';
}

export class PeriodError extends Error {}

function build(preset: PeriodPreset, tz: string, start: string, endExclusive: string, today: string, unit: ResolvedPeriod['calendarUnit'], label?: string): ResolvedPeriod {
  if (endExclusive <= start) throw new PeriodError('The period end must be after its start');
  return {
    preset,
    label: label ?? `${PRESET_LABEL[preset]} (${start} – ${addDays(endExclusive, -1)})`,
    timezone: tz,
    startDate: start,
    endDateExclusive: endExclusive,
    endDateInclusive: addDays(endExclusive, -1),
    startInclusive: zonedStartOfDay(start, tz).toISOString(),
    endExclusive: zonedStartOfDay(endExclusive, tz).toISOString(),
    days: diffDays(start, endExclusive),
    partial: endExclusive > today,
    calendarUnit: unit,
  };
}

export function resolvePeriod(req: PeriodRequest, tz: string, clock: Clock): ResolvedPeriod {
  const today = localDate(clock.now(), tz);
  const lastN = (n: number) => build(req.preset, tz, addDays(today, -n), today, today, 'day');
  switch (req.preset) {
    case 'last_7_complete_days':
      return lastN(7);
    case 'last_14_complete_days':
      return lastN(14);
    case 'last_30_complete_days':
      return lastN(30);
    case 'last_60_complete_days':
      return lastN(60);
    case 'last_90_complete_days':
      return lastN(90);
    case 'last_180_complete_days':
      return lastN(180);
    case 'last_365_complete_days':
      return lastN(365);
    case 'last_7_days_including_today':
      return build(req.preset, tz, addDays(today, -6), addDays(today, 1), today, 'day');
    case 'month_to_date':
      return build(req.preset, tz, startOfMonth(today), addDays(today, 1), today, 'month');
    case 'previous_calendar_month': {
      const thisMonth = startOfMonth(today);
      return build(req.preset, tz, addMonths(thisMonth, -1), thisMonth, today, 'month');
    }
    case 'last_3_complete_calendar_months':
    case 'last_6_complete_calendar_months':
    case 'last_12_complete_calendar_months':
    case 'last_24_complete_calendar_months':
    case 'last_36_complete_calendar_months': {
      const months = Number(req.preset.split('_')[1]);
      const thisMonth = startOfMonth(today);
      return build(req.preset, tz, addMonths(thisMonth, -months), thisMonth, today, 'month');
    }
    case 'year_to_date':
      return build(req.preset, tz, startOfYear(today), addDays(today, 1), today, 'year');
    case 'custom': {
      const { startDate, endDate } = req;
      if (!startDate || !endDate || !isIsoDate(startDate) || !isIsoDate(endDate)) {
        throw new PeriodError('A custom range needs valid start and end dates (YYYY-MM-DD)');
      }
      if (endDate < startDate) throw new PeriodError('The end date is before the start date');
      if (diffDays(startDate, endDate) > 366 * 5) throw new PeriodError('Custom ranges are limited to five years');
      return build('custom', tz, startDate, addDays(endDate, 1), today, 'day');
    }
    default:
      throw new PeriodError(`Unknown period preset: ${String(req.preset)}`);
  }
}

/**
 * Comparison window. `preceding_equal_duration`: the same number of days immediately before.
 * `preceding_calendar_period`: the previous calendar month(s)/year for calendar presets;
 * for a partial month-to-date it is the same day span at the start of the previous month.
 */
export function resolveComparison(p: ResolvedPeriod, policy: ComparisonPolicy): ResolvedPeriod | null {
  if (policy === 'none') return null;
  const label = (s: string, e: string) => `Comparison (${s} – ${addDays(e, -1)})`;
  if (policy === 'preceding_calendar_period' && p.calendarUnit !== 'day') {
    const months = p.calendarUnit === 'year' ? 12 : Math.max(1, monthsBetween(p.startDate, p.endDateExclusive));
    const start = addMonths(p.startDate, -months);
    const end = p.partial ? addDays(start, p.days) : p.startDate;
    return build(p.preset, p.timezone, start, end, '9999-12-31', p.calendarUnit, label(start, end));
  }
  const start = addDays(p.startDate, -p.days);
  return { ...build(p.preset, p.timezone, start, p.startDate, '9999-12-31', 'day', label(start, p.startDate)), partial: false };
}

function monthsBetween(start: string, endExclusive: string): number {
  const [y1, m1] = start.split('-').map(Number) as [number, number];
  const [y2, m2, d2] = endExclusive.split('-').map(Number) as [number, number, number];
  return (y2 - y1) * 12 + (m2 - m1) + (d2 > 1 ? 1 : 0);
}
