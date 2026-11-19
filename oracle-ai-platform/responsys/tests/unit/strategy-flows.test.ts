import { describe, expect, it } from 'vitest';
import { journeyFor, JourneyRecordSchema } from '../../shared/scenario/journeys';
import { STRATEGY_KEYS, type StrategyKey } from '../../shared/scenario/strategies';
import { buildStrategyFlow, type FlowNode } from '../../src/features/planner/flow';
import { campaignObjects, conditionObjects, journeyForFlow, programEdges, programObjects } from '../../src/features/planner/details';
import { layoutFlow } from '../../src/features/planner/layout';

const make = (key: StrategyKey) => buildStrategyFlow(journeyFor(key, 'dental'), key);
const shape = (nodes: FlowNode[]): unknown => nodes.map((node) => ({ type: node.type, ...(node.branches ? { yes: shape(node.branches.yes), no: shape(node.branches.no) } : {}) }));

describe('strategy-specific program routing', () => {
  it('gives all eight strategies different structures, independent of labels and wait durations', () => {
    const shapes = STRATEGY_KEYS.map((key) => {
      const flow = make(key);
      return JSON.stringify(shape([...flow.main, { ...flow.decision, branches: { yes: flow.yes, no: flow.no } }]));
    });
    expect(new Set(shapes).size).toBe(STRATEGY_KEYS.length);
  });
  it('uses a scheduled onboarding series before evaluating engagement', () => {
    const flow = make('welcome');
    expect(flow.main.filter((node) => node.type === 'email')).toHaveLength(2);
    expect(flow.yes.every((node) => node.type === 'exit')).toBe(true);
    expect(flow.no.every((node) => node.type === 'exit')).toBe(true);
  });
  it('checks support need before any retention email', () => {
    const flow = make('retention');
    expect(flow.main.some((node) => node.type === 'email')).toBe(false);
    expect(flow.decision.criteria?.[0]?.field).toContain('SUPPORT_REQUESTED');
    expect(flow.yes.filter((node) => node.type === 'email')).toHaveLength(2);
    expect(flow.no.every((node) => node.type === 'exit')).toBe(true);
  });
  it('stops inactive re-engagement contacts instead of reminding non-responders again', () => {
    const flow = make('reengage');
    expect(flow.yes.some((node) => node.campaignId?.endsWith('follow-up'))).toBe(true);
    expect(flow.no.some((node) => node.type === 'email')).toBe(false);
    expect(flow.no[0]!.title).toContain('Pause');
    expect(make('engagement').no.some((node) => node.type === 'email')).toBe(true);
  });
  it('gates hygiene on eligibility and sends the second message only after preference confirmation', () => {
    const flow = make('hygiene');
    expect(flow.main.map((node) => node.type)).toEqual(['entry']);
    expect(flow.decision.criteria?.some((row) => row.field.includes('EMAIL_PERMISSION_STATUS_'))).toBe(true);
    const preferenceCheck = flow.yes.find((node) => node.branches)!;
    expect(preferenceCheck.criteria?.[0]?.field).toContain('PREFERENCE_CONFIRMED');
    expect(preferenceCheck.branches!.yes.some((node) => node.type === 'email')).toBe(true);
    expect(preferenceCheck.branches!.no.every((node) => node.type === 'exit')).toBe(true);
  });
  it.each(STRATEGY_KEYS)('keeps %s details, campaigns, graph layout and saved metadata consistent', (key) => {
    const original = journeyFor(key, 'dental'), flow = make(key);
    const journey = journeyForFlow(original, flow), nodes = programObjects(flow), edges = programEdges(flow);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    expect(campaignObjects(flow, journey)).toHaveLength(2);
    expect(conditionObjects(flow, journey).some((item) => item.group === 'exclusions')).toBe(nodes.some((node) => node.conditionGroup === 'exclusions'));
    const layout = layoutFlow(flow);
    expect(layout.nodes).toHaveLength(nodes.length);
    expect(layout.lines).toHaveLength(edges.length);
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i]!, b = layout.nodes[j]!;
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + 88 && a.y + 88 > b.y;
      expect(overlaps, `${key}: ${a.node.id} overlaps ${b.node.id}`).toBe(false);
    }
    const record = { ...journey, selectedCampaignId: journey.campaigns[0].id, selectedTemplateId: 'chosen', program: { summary: flow.summary, nodes: nodes.map(({ branches: _branches, tone: _tone, ...node }) => node), edges } };
    expect(JourneyRecordSchema.safeParse(record).success).toBe(true);
    expect(JourneyRecordSchema.safeParse({ ...record, program: { ...record.program, edges: [{ from: 'missing', to: 'first' }] } }).success).toBe(false);
  });
});
