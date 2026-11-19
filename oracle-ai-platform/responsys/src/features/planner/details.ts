import type { JourneyPlan } from '../../../shared/scenario/journeys';
import type { FlowNode, ProgramFlow } from './flow';

/** Details are a projection of the visible graph, never a second independently generated program. */
export function programObjects(flow: ProgramFlow): FlowNode[] {
  const walk = (nodes: FlowNode[]): FlowNode[] => nodes.flatMap((node) => [node, ...(node.branches ? [...walk(node.branches.yes), ...walk(node.branches.no)] : [])]);
  return walk([...flow.main, { ...flow.decision, branches: { yes: flow.yes, no: flow.no } }]);
}

export function journeyForFlow(journey: JourneyPlan, flow: ProgramFlow): JourneyPlan {
  const nodes = programObjects(flow);
  const rows = (group: NonNullable<FlowNode['conditionGroup']>) => {
    const found = nodes.filter((node) => node.conditionGroup === group).flatMap((node) => node.criteria ?? journey[group]);
    return found.filter((row, i) => found.findIndex((other) => other.field === row.field && other.condition === row.condition) === i);
  };
  return { ...journey, entry: rows('entry'), filters: rows('filters'), exclusions: rows('exclusions') };
}

export function conditionObjects(flow: ProgramFlow, journey: JourneyPlan) {
  return programObjects(flow).flatMap((node) => node.conditionGroup ? [{ node, group: node.conditionGroup, rows: node.criteria ?? journey[node.conditionGroup] }] : []);
}

export function programEdges(flow: ProgramFlow): { from: string; to: string; label?: 'Yes' | 'No' }[] {
  const edges: { from: string; to: string; label?: 'Yes' | 'No' }[] = [];
  const walk = (nodes: FlowNode[]) => {
    nodes.forEach((node, i) => {
      if (i > 0) edges.push({ from: nodes[i - 1]!.id, to: node.id });
      if (node.branches) for (const [label, branch] of [['Yes', node.branches.yes], ['No', node.branches.no]] as const) {
        if (branch[0]) edges.push({ from: node.id, to: branch[0].id, label });
        walk(branch);
      }
    });
  };
  walk([...flow.main, { ...flow.decision, branches: { yes: flow.yes, no: flow.no } }]);
  return edges;
}

export function campaignObjects(flow: ProgramFlow, journey: JourneyPlan) {
  return programObjects(flow).flatMap((node) => {
    if (node.type !== 'email') return [];
    const campaign = journey.campaigns.find((item) => item.id === node.campaignId);
    return campaign ? [{ node, campaign }] : [];
  });
}
