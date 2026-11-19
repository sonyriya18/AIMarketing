import { describe, expect, it } from 'vitest';
import { estimateSendTime } from '../../shared/scenario/send-time';
import type { OverviewResult } from '../../shared/contracts/reports';
type Row = NonNullable<OverviewResult['sendTime']>[number];
const baseline = { open: 20, click: 2, openMetricId: 'unique_open_rate', clickMetricId: 'unique_click_rate' };
const row = (hour: number | null, open = 30, click = 4, weekday = 1, launches = 4): Row => ({
  channel: 'Email', weekday, hour, launches,
  metrics: [{ metricId: 'delivered', value: '500' }, { metricId: 'unique_open_rate', value: String(open) }, { metricId: 'unique_click_rate', value: String(click) }] as Row['metrics'],
});

describe('launch-time estimates', () => {
  it('blends hour history with the baseline and recommends the best observed eligible window', () => {
    const estimate = estimateSendTime([row(9), row(15, 40, 6)], 'Email', baseline, null, '');
    expect(estimate).toMatchObject({ open: 30, click: 4, hour: 15, weekday: 1, basis: 'hour', launches: 4 });
  });
  it('changes estimates with selected launch hours without scaling conversions', () => {
    const morning = estimateSendTime([row(9), row(15, 40, 6)], 'Email', baseline, 1, '09:30');
    const afternoon = estimateSendTime([row(9), row(15, 40, 6)], 'Email', baseline, 1, '15:30');
    expect(morning.open).toBe(25); expect(afternoon.open).toBe(30);
    expect(morning.click).toBe(3); expect(afternoon.click).toBe(4);
  });
  it('uses weekday-only history without claiming to know the selected hour', () => {
    const estimate = estimateSendTime([row(null)], 'Email', baseline, 1, '09:00');
    expect(estimate.basis).toBe('weekday'); expect(estimate.hour).toBeNull();
    expect(estimate.explanation).toContain('no reliable hour estimate');
  });
  it('keeps baseline rates for missing, sparse or unrelated channel history', () => {
    for (const rows of [[], [row(9, 90, 5, 1, 1)], [{ ...row(9), channel: 'SMS' }]]) {
      expect(estimateSendTime(rows, 'Email', baseline, 1, '09:00')).toMatchObject({ open: 20, click: 2, basis: 'baseline' });
    }
  });
  it('does not replace unique rates with incompatible total rates', () => {
    const incompatible = { ...row(9), metrics: [{ metricId: 'delivered', value: '500' }, { metricId: 'total_open_rate', value: '90' }] } as Row;
    expect(estimateSendTime([incompatible], 'Email', baseline, 1, '09:00').basis).toBe('baseline');
  });
  it('preserves unavailable metrics rather than inventing estimates', () => {
    expect(estimateSendTime([], 'Email', { ...baseline, open: null, click: null }, 1, '09:00')).toMatchObject({ open: null, click: null });
  });
});
