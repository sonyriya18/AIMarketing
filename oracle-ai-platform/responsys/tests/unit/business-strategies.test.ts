import { describe, expect, it } from 'vitest';
import { pageText, publicAddress, researchWebsite, websiteUrl } from '../../server/modules/insights/business';
import { validateBusinessStrategies, validateStrategyPick, validateSummary, sectionsFor, summaryJsonSchema, type Fact } from '../../server/modules/insights/summary';

const facts: Fact[] = [
  { id: 'business:0', section: 'business', text: 'Official website: Dental plans for individuals and businesses, with a dentist network.' },
  { id: 'm:click', section: 'attention', text: 'Click rate is 2.00%.' },
];
const strategy = { strategyKey: 'engagement', name: 'Dental plan discovery', goal: 'Test a dentist network discovery message.', reason: 'Test dental plan information to address weak click engagement.', actions: ['Test a dentist network CTA against plan information.'], factIds: ['business:0', 'm:click'] };

describe('business strategy grounding', () => {
  it('accepts strategies backed by website and report facts', () => {
    expect(validateBusinessStrategies({ businessStrategies: [strategy] }, facts, [])).toEqual([strategy]);
  });
  it.each([
    { ...strategy, factIds: ['m:click'] },
    { ...strategy, factIds: ['business:0'] },
    { ...strategy, factIds: ['business:0', 'unknown'] },
    { ...strategy, actions: ['Guarantee 97% conversion.'] },
    { ...strategy, strategyKey: 'made_up' },
    { ...strategy, name: 'Engagement Boost' },
    null,
  ])('rejects unsupported or malformed strategies: %j', (bad) => {
    expect(validateBusinessStrategies({ businessStrategies: [bad] }, facts, [])).toEqual([]);
  });
  it('rejects business-specific strategies when website evidence is unavailable', () => {
    expect(validateBusinessStrategies({ businessStrategies: [strategy] }, facts.slice(1), [])).toEqual([]);
    expect(validateStrategyPick({ strategyPick: { ...strategy, factIds: ['m:click'] } }, facts, [])).toBeNull();
  });
  it('requires a non-empty business strategy list in simulator output when website facts exist', () => {
    const schema = summaryJsonSchema(['executive'], true, true);
    expect(schema.required).toContain('businessStrategies');
    expect(schema.properties.businessStrategies?.minItems).toBe(1);
  });
  it('requires both sources in recommendations while preserving metric observations', () => {
    const raw = { sections: [{ key: 'what_to_test', points: [
      { kind: 'recommendation', text: 'Test dental plan messages.', factIds: ['business:0'] },
      { kind: 'recommendation', text: 'Test dental plan messages.', factIds: ['business:0', 'm:click'] },
    ] }] };
    const result = validateSummary(raw, sectionsFor('overview', 'simulator'), facts, []);
    expect(result.rejected).toBe(1);
    expect(result.sections.get('what_to_test')?.points).toHaveLength(1);
  });
});

describe('official website reader', () => {
  it.each(['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://user:pass@example.com', 'https://example.com:8443'])('refuses unsafe URLs: %s', (url) => {
    expect(() => websiteUrl(url)).toThrow();
  });
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '198.18.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1'])('blocks non-public addresses: %s', (ip) => {
    expect(publicAddress(ip)).toBe(false);
  });
  it('allows public HTTPS and public IPv4 addresses', () => {
    expect(websiteUrl('https://www.amildental.com.br/').hostname).toBe('www.amildental.com.br');
    expect(publicAddress('8.8.8.8')).toBe(true);
  });
  it('extracts readable content without scripts, styles or markup', () => {
    expect(pageText('<style>ignore</style><h1>Dental &amp; care</h1><script>ignore</script><p>Plans&nbsp;for families</p>')).toBe('Dental & care Plans for families');
  });
  it('reports missing websites without claiming research', async () => {
    expect(await researchWebsite(undefined)).toMatchObject({ status: 'not_configured', sources: [] });
  });
});
