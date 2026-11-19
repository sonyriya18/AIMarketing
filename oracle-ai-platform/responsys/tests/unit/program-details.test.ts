import { describe, expect, it } from 'vitest';
import { journeyFor } from '../../shared/scenario/journeys';
import { buildFlow, type ProgramFlow } from '../../src/features/planner/flow';
import { campaignObjects, conditionObjects, journeyForFlow, programObjects } from '../../src/features/planner/details';

const definition = journeyFor('engagement', 'dental');
const createFlow = () => buildFlow({ audienceName: 'Dental prospects', suppressionRule: 'Opt-in and deliverable', first: 'email', followUp: 'email', waitDays: definition.waitDays, decisionMetric: definition.decision, firstCampaignId: definition.campaigns[0].id, followUpCampaignId: definition.campaigns[1].id });

describe('details reflect only visible program objects', () => {
  it('does not add exclusion details or retain hidden exclusion criteria for a flow without that object', () => {
    const flow = createFlow();
    const scoped = journeyForFlow(definition, flow);
    expect(definition.exclusions.length).toBeGreaterThan(0);
    expect(scoped.exclusions).toEqual([]);
    expect(conditionObjects(flow, scoped).map((item) => item.group)).toEqual(['entry', 'filters']);
    expect(programObjects(flow).filter((node) => !node.conditionGroup && node.type !== 'email').map((node) => node.type)).toEqual(['wait', 'decision', 'exit', 'exit']);
    expect(campaignObjects(flow, scoped).map((item) => item.campaign.id)).toEqual(definition.campaigns.map((item) => item.id));
  });
  it('includes exclusion details only when an explicit exclusion-filter object is present', () => {
    const flow = createFlow();
    flow.main.splice(2, 0, { id: 'exclusion-filter', type: 'filter', title: 'Exclusion filter', conditionGroup: 'exclusions' });
    const scoped = journeyForFlow(definition, flow);
    expect(scoped.exclusions).toEqual(definition.exclusions);
    expect(conditionObjects(flow, scoped).find((item) => item.node.id === 'exclusion-filter')?.rows).toEqual(definition.exclusions);
  });
  it('omits filters and campaign choices removed from the visible graph', () => {
    const full = createFlow();
    const flow: ProgramFlow = { ...full, main: full.main.filter((node) => node.type !== 'filter'), no: full.no.filter((node) => node.type === 'exit') };
    const scoped = journeyForFlow(definition, flow);
    expect(scoped.filters).toEqual([]);
    expect(conditionObjects(flow, scoped).map((item) => item.group)).toEqual(['entry']);
    expect(campaignObjects(flow, scoped)).toHaveLength(1);
  });
});
