import type { FlowNode, ProgramFlow } from './flow';

const GAP = 26, BRANCH_GAP = 68, ROW_GAP = 30, MIN_HEIGHT = 116, PAD = 24;
const widthOf = (node: FlowNode) => node.type === 'decision' ? 124 : node.type === 'wait' ? 104 : 152;
interface Size { width: number; height: number }
export interface PositionedNode { node: FlowNode; x: number; y: number; width: number; centerY: number }
export interface FlowLine { from: string; to: string; path: string; label?: 'Yes' | 'No'; labelX?: number; labelY?: number }

/** Layout full branches, including nested decisions; unrelated strategies need no shared visual skeleton. */
export function layoutFlow(flow: ProgramFlow) {
  const measure = (nodes: FlowNode[]): Size => {
    let width = 0, height = MIN_HEIGHT;
    for (const [i, node] of nodes.entries()) {
      if (i) width += GAP;
      width += widthOf(node);
      if (node.branches) {
        const yes = measure(node.branches.yes), no = measure(node.branches.no);
        width += BRANCH_GAP + Math.max(yes.width, no.width);
        height = Math.max(height, yes.height + no.height + ROW_GAP);
      }
    }
    return { width, height };
  };
  const positioned: PositionedNode[] = [], lines: FlowLine[] = [];
  const draw = (nodes: FlowNode[], left: number, top: number): PositionedNode | undefined => {
    const size = measure(nodes), centerY = top + size.height / 2;
    let x = left, first: PositionedNode | undefined, previous: PositionedNode | undefined;
    for (const node of nodes) {
      const width = widthOf(node);
      const here = { node, x, y: centerY - (node.type === 'decision' ? 34 : 44), width, centerY };
      positioned.push(here); first ??= here;
      if (previous) lines.push({ from: previous.node.id, to: node.id, path: `M ${previous.x + previous.width} ${previous.centerY} H ${x + (node.type === 'decision' ? 28 : 0)}` });
      x += width;
      if (node.branches) {
        const yesSize = measure(node.branches.yes), noSize = measure(node.branches.no);
        const branchTop = top + (size.height - yesSize.height - noSize.height - ROW_GAP) / 2;
        const childX = x + BRANCH_GAP;
        const yes = draw(node.branches.yes, childX, branchTop);
        const no = draw(node.branches.no, childX, branchTop + yesSize.height + ROW_GAP);
        for (const [label, target] of [['Yes', yes], ['No', no]] as const) if (target) {
          const busX = x + 28;
          lines.push({ from: node.id, to: target.node.id, path: `M ${x - 24} ${centerY} H ${busX} V ${target.centerY} H ${childX}`, label, labelX: busX + 7, labelY: target.centerY - 9 });
        }
        x = childX + Math.max(yesSize.width, noSize.width);
      }
      previous = here;
      x += GAP;
    }
    return first;
  };
  const root = [...flow.main, { ...flow.decision, branches: { yes: flow.yes, no: flow.no } }];
  const size = measure(root);
  draw(root, PAD, PAD);
  return { nodes: positioned, lines, width: size.width + PAD * 2, height: size.height + PAD * 2 };
}
