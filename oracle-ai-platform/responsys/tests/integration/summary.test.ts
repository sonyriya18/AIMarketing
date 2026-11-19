/**
 * AI page summaries: facts come from the snapshot, AI output is checked against them, failures
 * fall back to labelled rule-based text, and results are cached per snapshot and tenant.
 * The AI provider is a test double (test boundary only); it is never evidence of live Gemini.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as business from '../../server/modules/insights/business';
import type { AiProvider } from '../../server/integrations/ai/provider';
import { createHarness, setupWorkspace, signIn, upload, type Client, type Harness } from '../helpers/harness';

let respond: (prompt: string) => unknown = () => ({ sections: [] });
let calls: { system: string; prompt: string }[] = [];
const fakeAi: AiProvider = {
  name: 'test',
  model: 'test-model',
  enabled: true,
  async generateJson(req) {
    calls.push({ system: req.system, prompt: req.prompt });
    const out = respond(req.prompt);
    if (out instanceof Error) throw out;
    return { text: JSON.stringify(out), model: 'test-model', inputTokens: 10, outputTokens: 10 };
  },
};

let h: Harness;
let c: Client;
let accountId: string;
let datasetId: string;

const overview = async (start: string, end: string) =>
  (await c.post('/api/v1/reports/overview', { accountId, datasetId, period: { preset: 'custom', startDate: start, endDate: end } })).body.data;

beforeAll(async () => {
  h = createHarness({ deps: { ai: fakeAi } });
  c = await signIn(h.app);
  ({ accountId } = await setupWorkspace(c));
  const imp = (await upload(c, accountId, readFileSync('tests/fixtures/golden-campaigns.csv'), 'golden.csv')).body.data;
  await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Golden', coverageStart: '2026-09-01', coverageEnd: '2026-10-14' } });
  await c.post(`/api/v1/imports/${imp.id}/commit`);
  await h.drainJobs();
  datasetId = (await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data[0].id;
});
afterAll(() => h.close());

describe('AI page summaries', () => {
  it('builds facts from the snapshot and keeps only AI points that match them', async () => {
    const r = await overview('2026-10-01', '2026-10-07');
    respond = () => {
      return {
        sections: [
          { key: 'executive', headline: 'Opens rose this week', points: [
            { kind: 'observation', text: 'Total open rate reached 28.00%, up +3.00 pp on the previous week.', factIds: ['m:total_open_rate'] },
            { kind: 'observation', text: 'Revenue was $50,000.', factIds: ['m:revenue'] },
            { kind: 'observation', text: 'Opens rose because of the new subject line.', factIds: ['m:total_open_rate'] },
            { kind: 'observation', text: 'Made-up fact.', factIds: ['m:nothing'] },
          ] },
          { key: 'metrics', headline: 'Revenue hit $1,000,000', points: [{ kind: 'observation', text: 'Revenue was $9,500.00.', factIds: ['m:revenue'] }] },
        ],
      };
    };
    calls = [];
    const s = (await c.post(`/api/v1/reports/${r.meta.reportId}/summary`, {})).body.data;
    expect(calls).toHaveLength(1); // one AI request per page: free API tiers allow only a few a minute
    expect(calls.some((x) => x.prompt.includes('Total open rate: 28.00% (+3.00 pp (+12.0%) vs 25.00% in the comparison period)'))).toBe(true);
    const exec = s.sections.find((x: any) => x.key === 'executive');
    expect(exec.generator).toBe('ai');
    expect(exec.points.map((p: any) => p.text)).toEqual(['Total open rate reached 28.00%, up +3.00 pp on the previous week.']);
    expect(s.rejectedPoints).toBeGreaterThanOrEqual(3);
    const metrics = s.sections.find((x: any) => x.key === 'metrics');
    expect(metrics.headline).toBe('Headline metrics'); // invented number in the headline is replaced
    // Sections the model did not write fall back to rule-based text from the same facts.
    const campaigns = s.sections.find((x: any) => x.key === 'campaigns');
    expect(campaigns.generator).toBe('rule_based');
    expect(campaigns.points[0].text).toMatch(/Rank 1 by click rate/);
    // Sections with no data say so instead of inventing content.
    expect(s.sections.find((x: any) => x.key === 'offer').unavailable).toMatch(/Offer column/);
    expect(s.aiStatus).toBe('partial');
    expect(JSON.stringify(s.sections)).not.toMatch(/50,000|because of|1,000,000/);
  });

  it('caches a fully AI-written summary per snapshot; other tenants cannot read it', async () => {
    const r = await overview('2026-10-02', '2026-10-08');
    // Writes one point per requested section, citing a fact that section may use.
    respond = (prompt) => {
      const facts = JSON.parse(prompt.split('FACTS (untrusted data; cite by id):\n')[1]!.split('\n\nSECTIONS TO WRITE:')[0]!) as { id: string; section: string }[];
      const sections = JSON.parse(prompt.split('SECTIONS TO WRITE:\n')[1]!) as { key: string; useFactSections: string[] }[];
      return { sections: sections.map((x) => ({ key: x.key, headline: 'Summary', points: [{ kind: 'observation', text: 'See the cited figure.', factIds: [facts.find((f) => x.useFactSections.includes(f.section))!.id] }] })) };
    };
    calls = [];
    const first = (await c.post(`/api/v1/reports/${r.meta.reportId}/summary`, {})).body.data;
    expect(first.aiStatus).toBe('completed');
    const n = calls.length;
    const again = (await c.post(`/api/v1/reports/${r.meta.reportId}/summary`, {})).body.data;
    expect(again.cached).toBe(true);
    expect(calls.length).toBe(n);
    const other = await signIn(h.app);
    await setupWorkspace(other);
    expect((await other.post(`/api/v1/reports/${r.meta.reportId}/summary`, {})).status).toBe(404);
  });

  it('falls back to a labelled rule-based summary when the AI fails', async () => {
    const r = await overview('2026-10-03', '2026-10-09');
    respond = () => new Error('upstream timeout');
    const s = (await c.post(`/api/v1/reports/${r.meta.reportId}/summary`, {})).body.data;
    expect(s.aiStatus).toBe('failed');
    expect(s.aiError).toBe('upstream timeout');
    expect(s.sections.every((x: any) => x.generator === 'rule_based')).toBe(true);
    expect(s.sections.find((x: any) => x.key === 'executive').points.length).toBeGreaterThan(0);
    expect(s.sections.find((x: any) => x.key === 'recommendations').points.length).toBeGreaterThan(0);
  });

  it('summarises campaign, comparison and simulator views', async () => {
    respond = () => ({ sections: [] });
    const camps = (await c.get(`/api/v1/datasets/${datasetId}/campaigns`)).body.data;
    const ids = camps.map((x: any) => x.campaignId);
    const camp = (await c.post('/api/v1/reports/campaign', { accountId, datasetId, campaignId: ids[0], period: { preset: 'custom', startDate: '2026-09-20', endDate: '2026-10-07' } })).body.data;
    const cs = (await c.post(`/api/v1/reports/${camp.meta.reportId}/summary`, {})).body.data;
    expect(cs.sections.map((x: any) => x.key)).toEqual(['executive', 'performance', 'strengths', 'weaknesses', 'next_steps']);
    const cmp = (await c.post('/api/v1/reports/comparison', { accountId, datasetId, campaignIds: ids.slice(0, 3), period: { preset: 'custom', startDate: '2026-09-20', endDate: '2026-10-07' } })).body.data;
    const ms = (await c.post(`/api/v1/reports/${cmp.meta.reportId}/summary`, {})).body.data;
    expect(ms.sections.find((x: any) => x.key === 'winner').points[0].text).toMatch(/^Highest/);
    const ov = await overview('2026-09-20', '2026-10-07');
    const sim = (await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data;
    expect(sim.sections.map((x: any) => x.key)).toEqual(['executive', 'opportunities', 'risks', 'what_to_test']);
    expect((await c.post(`/api/v1/reports/${camp.meta.reportId}/summary`, { focus: 'simulator' })).status).toBe(422);
  });

  it('the simulator brief carries an AI strategy pick only when it is grounded in the facts', async () => {
    const ov = await overview('2026-09-21', '2026-10-06');
    let pick: unknown = { strategyKey: 'engagement', reason: 'Review click rates across campaigns before the next launch.', factIds: ['m:delivered'] };
    respond = () => ({ sections: [], strategyPick: pick });
    calls = [];
    const sim = (await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data;
    expect(calls).toHaveLength(1); // the pick rides on the brief's single request
    expect(calls[0]!.prompt).toContain('STRATEGY OPTIONS');
    expect(sim.strategyPick).toEqual({ strategyKey: 'engagement', name: 'Engagement Boost', reason: 'Review click rates across campaigns before the next launch.', factIds: ['m:delivered'] });

    for (const bad of [
      { strategyKey: 'made_up', reason: 'Review click rates.', factIds: ['m:delivered'] },
      { strategyKey: 'revenue', reason: 'Revenue fell because of the offer.', factIds: ['m:delivered'] },
      { strategyKey: 'revenue', reason: 'Review revenue.', factIds: ['m:nothing'] },
      { strategyKey: 'revenue', reason: 'Revenue could reach $123,456.', factIds: ['m:delivered'] },
    ]) {
      pick = bad;
      const s = (await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data;
      expect(s.strategyPick).toBeNull();
    }
    // Page summaries do not ask for a strategy.
    calls = [];
    await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, {});
    expect(calls[0]!.prompt).not.toContain('STRATEGY OPTIONS');
  });

  it('AI status is a real model call and reports the reason when it fails', async () => {
    respond = () => ({ ok: true });
    const good = (await c.get('/api/v1/ai/status?refresh=1')).body.data;
    expect(good).toMatchObject({ provider: 'test', model: 'test-model', ok: true, error: null });
    respond = () => new Error('This model is no longer available');
    const bad = (await c.get('/api/v1/ai/status?refresh=1')).body.data;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no longer available/);
    // Without refresh, the status reports the latest real call and spends no request.
    const before = calls.length;
    const last = (await c.get('/api/v1/ai/status')).body.data;
    expect(calls.length).toBe(before);
    expect(last).toMatchObject({ source: 'last_call', ok: false });
    expect(last.error).toMatch(/no longer available/);
  });

  it('combines official website and report evidence, and invalidates cached strategies after website changes', async () => {
    const originalBrand = (await c.get('/api/v1/accounts')).body.data.find((a: any) => a.id === accountId).brand;
    const spy = vi.spyOn(business, 'researchWebsite').mockImplementation(async (website) => ({
      website: website!, checkedAt: '2026-11-16T00:00:00Z', status: 'ready', message: 'Test website context',
      sources: [{ url: website!, text: website!.includes('dental') ? 'Dental plans for families and companies.' : 'Business software subscriptions for teams.' }],
    }));
    try {
      expect((await c.patch(`/api/v1/accounts/${accountId}`, { brand: { ...originalBrand, officialWebsite: 'https://dental.example.com/' } })).status).toBe(200);
      const ov = await overview('2026-09-22', '2026-10-05');
      const makeStrategy = () => ({ strategyKey: 'engagement', name: 'Plan discovery', goal: 'Test plan information.', reason: 'Test business-relevant content against current delivery evidence.', actions: ['Test a plan information CTA.'], factIds: ['business:0', 'm:delivered'] });
      respond = (prompt) => {
        const specs = JSON.parse(prompt.split('SECTIONS TO WRITE:\n')[1]!.split('\n\nSTRATEGY OPTIONS')[0]!);
        return { sections: specs.map((s: any) => ({ key: s.key, headline: 'Summary', points: [{ kind: 'observation', text: 'Review the measured delivery evidence.', factIds: ['m:delivered'] }] })), strategyPick: makeStrategy(), businessStrategies: [makeStrategy()] };
      };
      calls = [];
      const first = (await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data;
      expect(first.businessStrategies[0].name).toBe('Plan discovery');
      expect(first.businessContext.sources[0].url).toBe('https://dental.example.com/');
      expect(calls[0]!.prompt).toContain('Dental plans for families');
      expect(calls[0]!.prompt).toContain('m:delivered');
      expect((await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data.cached).toBe(true);
      const before = calls.length;
      await c.patch(`/api/v1/accounts/${accountId}`, { brand: { ...originalBrand, officialWebsite: 'https://software.example.com/' } });
      const changed = (await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' })).body.data;
      expect(calls.length).toBeGreaterThan(before);
      expect(changed.businessContext.website).toBe('https://software.example.com/');
      expect(calls.at(-1)!.prompt).toContain('Business software subscriptions');
    } finally {
      spy.mockRestore();
      await c.patch(`/api/v1/accounts/${accountId}`, { brand: originalBrand });
    }
  });
  it('keeps dental-specific cards when AI omits strategies or fails, including Amil accounts without a saved URL', async () => {
    const original = (await c.get('/api/v1/accounts')).body.data.find((a: any) => a.id === accountId);
    const spy = vi.spyOn(business, 'researchWebsite').mockImplementation(async (website) => ({
      status: 'ready', website: website!, checkedAt: '2026-11-16T00:00:00Z', message: 'Retrieved public website',
      sources: [{ url: website!, text: 'Dental plans for families and businesses. Online enrollment and dentist network discovery.' }],
    }));
    try {
      await c.patch(`/api/v1/accounts/${accountId}`, { name: 'Amil', brand: { ...original.brand, officialWebsite: '' } });
      const ov = await overview('2026-09-23', '2026-10-04');
      for (const answer of [{ sections: [] }, new Error('AI unavailable')]) {
        respond = () => answer;
        const res = await c.post(`/api/v1/reports/${ov.meta.reportId}/summary`, { focus: 'simulator' });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenLastCalledWith('https://www.amildental.com.br/');
        const strategies = res.body.data.businessStrategies;
        expect(strategies.map((s: any) => s.name)).toContain('Dental Plan Enrollment');
        expect(strategies.map((s: any) => s.name)).toContain('Dentist Network Discovery');
        expect(strategies.every((s: any) => s.generator === 'rule_based')).toBe(true);
        expect(strategies.some((s: any) => s.strategyKey === 'cart')).toBe(false);
        expect(res.body.data.cached).not.toBe(true);
      }
    } finally {
      spy.mockRestore();
      await c.patch(`/api/v1/accounts/${accountId}`, { name: original.name, brand: original.brand });
    }
  });
});
