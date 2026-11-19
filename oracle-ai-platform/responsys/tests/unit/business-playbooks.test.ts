import { describe, expect, it } from 'vitest';
import { businessPlaybooks } from '../../server/modules/insights/business-strategies';
import { businessWebsite } from '../../shared/business/accounts';
import type { Fact } from '../../server/modules/insights/summary';

const metric: Fact = { id: 'down:click', section: 'attention', text: 'Unique click rate: 2.00%, down from 3.00%.' };
const dental: Fact = { id: 'business:0', section: 'business', text: 'Official website for Amil: https://www.amildental.com.br/\nAmil Dental offers dental plans for families and companies, online enrollment and a dentist network.' };

describe('website-informed dental strategies', () => {
  it('changes titles, goals and actions using website evidence even without AI', () => {
    const plans = businessPlaybooks([metric, dental]);
    expect(plans.map((p) => p.name)).toContain('Dentist Network Discovery');
    expect(plans.map((p) => p.name)).toContain('Dental Plan Enrollment');
    expect(plans.map((p) => p.name)).toContain('New Dental Member Welcome');
    expect(plans.some((p) => p.strategyKey === 'cart' || p.strategyKey === 'winback')).toBe(false);
    for (const plan of plans) {
      expect(plan.generator).toBe('rule_based');
      expect(plan.factIds).toEqual(['business:0', 'down:click']);
      expect(plan.reason).toContain('2.00%');
      expect(plan.actions.length).toBeGreaterThan(0);
    }
  });
  it('requires retrieved business content and report evidence', () => {
    expect(businessPlaybooks([dental])).toEqual([]);
    expect(businessPlaybooks([metric])).toEqual([]);
    expect(businessPlaybooks([metric, { ...dental, text: 'Official website for Dental Amil: https://dental.example.com/\nBusiness software subscriptions.' }])).toEqual([]);
  });
  it('does not assume every dental business sells plans or offers online enrollment', () => {
    const clinic = { ...dental, text: 'A dental practice providing dental services.' };
    expect(businessPlaybooks([metric, clinic]).some((p) => /enrollment|member/i.test(p.name))).toBe(false);
    expect(businessPlaybooks([metric, { ...dental, text: 'Dental plans for families.' }]).some((p) => p.name === 'Dental Plan Enrollment')).toBe(false);
  });
});

describe('public account website mapping', () => {
  it('resolves the configured Amil website when the selected account has no saved website', () => {
    expect(businessWebsite({ name: 'Amil', brand: {} })).toBe('https://www.amildental.com.br/');
    expect(businessWebsite({ name: ' Amil Dental ' })).toBe('https://www.amildental.com.br/');
  });
  it('preserves explicit websites and does not guess websites for unknown businesses', () => {
    expect(businessWebsite({ name: 'Amil', brand: { officialWebsite: 'https://custom.example.com/' } })).toBe('https://custom.example.com/');
    expect(businessWebsite({ name: 'Another business' })).toBeUndefined();
  });
  it('resolves the Endeavour DM website independently of Amil', () => {
    expect(businessWebsite({ name: 'Endeavour Group - DM', brand: {} })).toBe('https://www.danmurphys.com.au/dm/home');
  });
});
