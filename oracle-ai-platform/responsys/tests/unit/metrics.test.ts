/**
 * Golden numerical fixture (blueprint 20.2). Synthetic test-only values.
 */
import { describe, expect, it } from 'vitest';
import { compareMetric, computeAll, emptyAggregates, rateMetric, baseMetric, type Aggregates } from '../../shared/metrics/compute';
import type { BaseMeasure } from '../../shared/metrics/registry';

const CAMP_A = { sent: 1020, delivered: 1000, bounces: 20, total_opens: 100, total_clicks: 20, conversion_events: 5, revenue: '500.00', unsubscribes: 1 };
const CAMP_B = { sent: 9180, delivered: 9000, bounces: 180, total_opens: 2700, total_clicks: 450, conversion_events: 90, revenue: '9000.00', unsubscribes: 9 };

function aggregate(rows: Record<string, number | string>[]): Aggregates {
  const out = emptyAggregates();
  for (const k of Object.keys(out) as BaseMeasure[]) {
    const present = rows.filter((r) => r[k] !== undefined);
    out[k] = {
      sum: present.length ? String(present.reduce((s, r) => s + Number(r[k]), 0)) : null,
      rowsWithValue: present.length,
      rowsTotal: rows.length,
    };
  }
  return out;
}

const ctx = { currency: 'USD', launchUniqueSummable: true, coverageComplete: true, evidencePrefix: 'ev:test' };

describe('golden campaign fixture', () => {
  const m = computeAll(aggregate([CAMP_A, CAMP_B]), ctx);

  it('sums base measures exactly', () => {
    expect(m.sent!.value).toBe('10200');
    expect(m.delivered!.value).toBe('10000');
    expect(m.bounces!.value).toBe('200');
    expect(m.total_opens!.value).toBe('2800');
    expect(m.total_clicks!.value).toBe('470');
    expect(m.conversion_events!.value).toBe('95');
    expect(m.revenue!.value).toBe('9500');
    expect(m.revenue!.currency).toBe('USD');
    expect(m.unsubscribes!.value).toBe('10');
  });

  it('computes ratios from aggregated numerators and denominators', () => {
    expect(m.delivered_rate!.value!.startsWith('98.039215686')).toBe(true);
    expect(m.bounce_rate!.value!.startsWith('1.960784313')).toBe(true);
    expect(m.total_open_rate!.value).toBe('28'); // not the unweighted 20% average
    expect(m.total_click_rate!.value).toBe('4.7');
    expect(m.conversion_event_rate!.value).toBe('0.95');
    expect(m.unsubscribe_rate!.value).toBe('0.1');
    expect(m.revenue_per_delivered!.value).toBe('0.95');
    expect(m.revenue_per_1000_delivered!.value).toBe('950');
  });

  it('does not report AOV without an orders field', () => {
    expect(m.average_order_value!.value).toBeNull();
    expect(m.average_order_value!.availability).toBe('missing');
  });

  it('reports unique measures as missing, not zero, when the source lacks them', () => {
    expect(m.unique_opens!.value).toBeNull();
    expect(m.unique_opens!.reason).toBe('missing_field');
    expect(m.unique_open_rate!.value).toBeNull();
  });

  it('percent change is percentage points; relative change is separate', () => {
    const prev = { ...m.total_open_rate!, value: '25' };
    const c = compareMetric(m.total_open_rate!, prev);
    expect(c.absoluteChange).toBe('3');
    expect(c.absoluteChangeUnit).toBe('pp');
    expect(c.relativeChangePct).toBe('12');
    expect(c.interpretation).toBe('better');
  });

  it('money change is an amount, never "pp"', () => {
    const prev = { ...m.revenue!, value: '10000' };
    const c = compareMetric(m.revenue!, prev);
    expect(c.absoluteChange).toBe('-500');
    expect(c.absoluteChangeUnit).toBe('money');
    expect(c.relativeChangePct).toBe('-5');
    expect(c.interpretation).toBe('worse');
  });
});

describe('null, zero and bounds', () => {
  it('T09: blank stays unavailable while a genuine zero stays zero', () => {
    const aggs = aggregate([{ sent: 0, delivered: 0 }]);
    const m = computeAll(aggs, ctx);
    expect(m.sent!.value).toBe('0');
    expect(m.total_opens!.value).toBeNull();
  });

  it('T10: zero denominator gives an unavailable ratio, not 0/100/Infinity', () => {
    const m = computeAll(aggregate([{ sent: 0, delivered: 0, total_opens: 0 }]), ctx);
    expect(m.total_open_rate!.value).toBeNull();
    expect(m.total_open_rate!.reason).toBe('zero_denominator');
    expect(m.total_open_rate!.availability).toBe('insufficient_data');
  });

  it('T21: total event rates above 100% are preserved', () => {
    const m = computeAll(aggregate([{ delivered: 100, total_clicks: 250 }]), ctx);
    expect(m.total_click_rate!.value).toBe('250');
    expect(m.total_click_rate!.availability).toBe('available');
  });

  it('probability-like rates above 100% are flagged as conflicted', () => {
    const m = computeAll(aggregate([{ delivered: 100, unique_opens: 120 }]), ctx);
    expect(m.unique_open_rate!.availability).toBe('conflicted');
  });

  it('a field missing on some rows makes the total unavailable', () => {
    const m = computeAll(aggregate([{ delivered: 100, total_opens: 10 }, { delivered: 100 }]), ctx);
    expect(m.total_opens!.value).toBeNull();
    expect(m.total_opens!.reason).toBe('partial_field');
  });

  it('T19: launch-unique measures are not summed across days', () => {
    const m = computeAll(aggregate([{ delivered: 100, unique_opens: 10 }, { delivered: 0, unique_opens: 5 }]), { ...ctx, launchUniqueSummable: false });
    expect(m.unique_opens!.value).toBeNull();
    expect(m.unique_opens!.availability).toBe('not_applicable');
    expect(m.total_opens).toBeDefined();
  });

  it('T02: covered period with no rows gives measured zeros and unavailable ratios', () => {
    const m = computeAll(aggregate([]), ctx);
    expect(m.sent!.value).toBe('0');
    expect(m.revenue!.value).toBe('0');
    expect(m.total_open_rate!.value).toBeNull();
  });

  it('period outside coverage is missing history, never zero', () => {
    const m = computeAll(aggregate([]), { ...ctx, coverageComplete: false });
    expect(m.sent!.value).toBeNull();
    expect(m.sent!.reason).toBe('missing_history');
  });

  it('T18: prior zero makes relative change undefined with an explanation', () => {
    const cur = baseMetric('revenue', { sum: '100', rowsWithValue: 1, rowsTotal: 1 }, ctx);
    const prev = baseMetric('revenue', { sum: '0', rowsWithValue: 1, rowsTotal: 1 }, ctx);
    const c = compareMetric(cur, prev);
    expect(c.absoluteChange).toBe('100');
    expect(c.relativeChangePct).toBeNull();
    expect(c.note).toMatch(/undefined/);
  });

  it('unsubscribe increase is interpreted as worse', () => {
    const den = baseMetric('delivered', { sum: '1000', rowsWithValue: 1, rowsTotal: 1 }, ctx);
    const cur = rateMetric('unsubscribe_rate', baseMetric('unsubscribes', { sum: '5', rowsWithValue: 1, rowsTotal: 1 }, ctx), den, ctx);
    const prev = rateMetric('unsubscribe_rate', baseMetric('unsubscribes', { sum: '2', rowsWithValue: 1, rowsTotal: 1 }, ctx), den, ctx);
    expect(compareMetric(cur, prev).interpretation).toBe('worse');
  });
});
