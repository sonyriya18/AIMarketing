import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../shared/time/clock';
import { resolveComparison, resolvePeriod } from '../../shared/time/periods';
import { zonedStartOfDay, localDate } from '../../shared/time/zoned';

describe('periods follow the injected clock (A04)', () => {
  it('last 7 complete days ends at the start of today in the account timezone', () => {
    const p = resolvePeriod({ preset: 'last_7_complete_days' }, 'UTC', fixedClock('2026-10-15T12:00:00Z'));
    expect(p.startDate).toBe('2026-10-08');
    expect(p.endDateExclusive).toBe('2026-10-15');
    expect(p.days).toBe(7);
    expect(p.partial).toBe(false);
  });

  it('uses the account timezone, not UTC, to decide "today"', () => {
    // 2026-10-15T20:00Z is already 2026-10-16 01:30 in Kolkata.
    const p = resolvePeriod({ preset: 'last_7_complete_days' }, 'Asia/Kolkata', fixedClock('2026-10-15T20:00:00Z'));
    expect(p.endDateExclusive).toBe('2026-10-16');
    expect(p.startInclusive).toBe('2026-10-08T18:30:00.000Z');
    expect(p.endExclusive).toBe('2026-10-15T18:30:00.000Z');
  });

  it('including-today preset is partial and distinct', () => {
    const p = resolvePeriod({ preset: 'last_7_days_including_today' }, 'UTC', fixedClock('2026-10-15T12:00:00Z'));
    expect(p.startDate).toBe('2026-10-09');
    expect(p.endDateExclusive).toBe('2026-10-16');
    expect(p.partial).toBe(true);
  });

  it('T16: custom inclusive end date becomes the next local midnight (half-open)', () => {
    const p = resolvePeriod({ preset: 'custom', startDate: '2026-03-01', endDate: '2026-03-31' }, 'America/New_York', fixedClock('2026-10-15T12:00:00Z'));
    expect(p.endDateExclusive).toBe('2026-04-01');
    expect(p.startInclusive).toBe('2026-03-01T05:00:00.000Z'); // EST
    expect(p.endExclusive).toBe('2026-04-01T04:00:00.000Z'); // EDT after the DST change
  });

  it('T17: DST spring-forward day still has a valid local midnight boundary', () => {
    // America/New_York DST began 2026-03-08 at 02:00 local.
    expect(zonedStartOfDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedStartOfDay('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    // A timezone whose DST jump skips midnight (America/Santiago, 2026-09-06 00:00 → 01:00).
    const s = zonedStartOfDay('2026-09-06', 'America/Santiago');
    expect(localDate(s, 'America/Santiago')).toBe('2026-09-06');
  });

  it('T17: leap date and calendar months differ from rolling days', () => {
    const feb = resolvePeriod({ preset: 'previous_calendar_month' }, 'UTC', fixedClock('2028-03-10T00:00:00Z'));
    expect(feb.startDate).toBe('2028-02-01');
    expect(feb.endDateExclusive).toBe('2028-03-01');
    expect(feb.days).toBe(29);
    const rolling = resolvePeriod({ preset: 'last_30_complete_days' }, 'UTC', fixedClock('2028-03-10T00:00:00Z'));
    expect(rolling.days).toBe(30);
    expect(rolling.startDate).toBe('2028-02-09');
  });

  it('comparison windows: preceding equal duration and preceding calendar period', () => {
    const clock = fixedClock('2026-10-15T12:00:00Z');
    const p = resolvePeriod({ preset: 'last_30_complete_days' }, 'UTC', clock);
    const c = resolveComparison(p, 'preceding_equal_duration')!;
    expect(c.endDateExclusive).toBe(p.startDate);
    expect(c.days).toBe(30);
    const m = resolvePeriod({ preset: 'previous_calendar_month' }, 'UTC', clock);
    const mc = resolveComparison(m, 'preceding_calendar_period')!;
    expect(mc.startDate).toBe('2026-08-01');
    expect(mc.endDateExclusive).toBe('2026-09-01');
    expect(resolveComparison(p, 'none')).toBeNull();
  });

  it('rejects malformed or reversed custom dates', () => {
    const clock = fixedClock('2026-10-15T12:00:00Z');
    expect(() => resolvePeriod({ preset: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' }, 'UTC', clock)).toThrow();
    expect(() => resolvePeriod({ preset: 'custom', startDate: '2026-03-02', endDate: '2026-03-01' }, 'UTC', clock)).toThrow();
  });
});

describe('reference period choices (60 days, 6 months, 1–3 years)', () => {
  const clock = fixedClock('2026-10-16T12:00:00Z');
  it('last 60 complete days ends at the start of today', () => {
    const p = resolvePeriod({ preset: 'last_60_complete_days' }, 'UTC', clock);
    expect([p.startDate, p.endDateExclusive, p.days]).toEqual(['2026-08-17', '2026-10-16', 60]);
  });
  it.each([
    ['last_6_complete_calendar_months', '2026-04-01'],
    ['last_12_complete_calendar_months', '2025-10-01'],
    ['last_24_complete_calendar_months', '2024-10-01'],
    ['last_36_complete_calendar_months', '2023-10-01'],
  ] as const)('%s covers whole calendar months up to the end of last month', (preset, start) => {
    const p = resolvePeriod({ preset }, 'UTC', clock);
    expect(p.startDate).toBe(start);
    expect(p.endDateExclusive).toBe('2026-10-01');
    expect(p.partial).toBe(false);
    expect(p.calendarUnit).toBe('month');
  });
  it('6-month comparison is the six calendar months before', () => {
    const p = resolvePeriod({ preset: 'last_6_complete_calendar_months' }, 'UTC', clock);
    const c = resolveComparison(p, 'preceding_calendar_period')!;
    expect([c.startDate, c.endDateExclusive]).toEqual(['2025-10-01', '2026-04-01']);
  });
});
