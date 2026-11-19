/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle Responsys-style Program Designer canvas (left → right).
 * Entry → Filter → Activities / Waits → Decision → Yes / No branches → Exit
 */

import React from 'react';
import type { FlowNode, FlowNodeType, ProgramFlow } from '../features/planner/flow';
import { Users, Filter, Mail, MessageSquare, Bell, Clock, GitBranch, Flag } from 'lucide-react';
import { layoutFlow } from '../features/planner/layout';
import { programObjects } from '../features/planner/details';

const NODE_STYLE: Record<FlowNodeType, { icon: React.ElementType; ring: string; chip: string; label: string }> = {
  entry: { icon: Users, ring: 'border-sky-500', chip: 'bg-sky-500', label: 'Entry' },
  filter: { icon: Filter, ring: 'border-amber-500', chip: 'bg-amber-500', label: 'Filter' },
  email: { icon: Mail, ring: 'border-[#C74634]', chip: 'bg-[#C74634]', label: 'Email' },
  sms: { icon: MessageSquare, ring: 'border-pink-500', chip: 'bg-pink-500', label: 'SMS' },
  push: { icon: Bell, ring: 'border-violet-500', chip: 'bg-violet-500', label: 'Push' },
  wait: { icon: Clock, ring: 'border-gray-400 border-dashed', chip: 'bg-gray-400', label: 'Wait' },
  decision: { icon: GitBranch, ring: 'border-indigo-500', chip: 'bg-indigo-500', label: 'Decision' },
  exit: { icon: Flag, ring: 'border-emerald-600', chip: 'bg-emerald-600', label: 'Exit' },
};

const EXIT_TONE = {
  good: 'border-emerald-600 bg-emerald-50',
  bad: 'border-rose-500 bg-rose-50',
  neutral: 'border-gray-400 bg-gray-50',
};

const Node: React.FC<{ node: FlowNode; selectedNodeId?: string }> = ({ node, selectedNodeId }) => {
  const st = NODE_STYLE[node.type];
  const Icon = st.icon;
  const exitTone = node.type === 'exit' ? EXIT_TONE[node.tone || 'good'] : 'bg-white';
  const compact = node.type === 'wait';
  return (
    <div
      className={`shrink-0 ${compact ? 'w-[104px]' : 'w-[152px]'} h-[88px] rounded-xl border-2 ${st.ring} ${exitTone} ${node.id === selectedNodeId ? 'ring-4 ring-indigo-200' : ''} px-2 py-1.5 flex flex-col justify-center`}
      title={`${st.label}: ${node.title}${node.sub ? ` — ${node.sub}` : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`w-5 h-5 rounded-md ${st.chip} text-white flex items-center justify-center shrink-0`}>
          <Icon className="w-3 h-3" />
        </span>
        <span className="text-[9px] text-[#8a7668] font-semibold">{st.label}</span>
      </div>
      <div className="text-[11px] font-bold leading-tight mt-0.5 line-clamp-2 text-[#2d241d]">{node.title}</div>
      {node.sub && <div className="text-[9px] text-[#6b554d] leading-tight truncate">{node.sub}</div>}
    </div>
  );
};

const Decision: React.FC<{ node: FlowNode }> = ({ node }) => (
  <div className="relative shrink-0 w-[124px] h-[68px] flex items-center justify-center" title={node.title}>
    <div className="w-12 h-12 rotate-45 rounded-md border-2 border-indigo-500 bg-indigo-50 flex items-center justify-center">
      <GitBranch className="-rotate-45 w-4 h-4 text-indigo-600" />
    </div>
    <div className="absolute top-full left-0 right-0 mt-1 text-center">
      <div className="text-[11px] font-bold leading-tight">{node.title}</div>
      {node.sub && <div className="text-[9px] text-[#6b554d]">{node.sub}</div>}
    </div>
  </div>
);

export const ProgramFlowDiagram: React.FC<{ flow: ProgramFlow; selectedNodeId?: string }> = ({ flow, selectedNodeId }) => {
  const layout = layoutFlow(flow);
  const objects = programObjects(flow);
  const exits = objects.filter((node) => node.type === 'exit');
  const visibleTypes = [...new Set(objects.map((node) => node.type))];
  const arrowId = 'program-arrow-' + React.useId().replace(/:/g, '');
  return <div className="space-y-3">
    {flow.summary && <p className="text-xs text-[#6b554d]" data-testid="strategy-flow-summary">{flow.summary}</p>}
    <div className="overflow-x-auto rounded-xl border border-[#e8dcc9]" style={{ backgroundColor: '#fff', backgroundImage: 'radial-gradient(#eadfd3 1px, transparent 1px)', backgroundSize: '14px 14px' }}>
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: '100%' }} data-testid="program-canvas">
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id={arrowId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6 Z" fill="#b9a593" /></marker></defs>
          {layout.lines.map((line, i) => <g key={i} data-flow-from={line.from} data-flow-to={line.to} data-flow-branch={line.label}>
            <path d={line.path} fill="none" stroke="#b9a593" strokeWidth="2" markerEnd={'url(#' + arrowId + ')'} />
            {line.label && <g><rect x={line.labelX! - 3} y={line.labelY! - 10} width="27" height="15" rx="3" fill={line.label === 'Yes' ? '#d1fae5' : '#ffe4e6'} /><text x={line.labelX} y={line.labelY} fill={line.label === 'Yes' ? '#047857' : '#be123c'} fontSize="10" fontWeight="700">{line.label}</text></g>}
          </g>)}
        </svg>
        {layout.nodes.map(({ node, x, y }) => <div key={node.id} className="absolute" style={{ left: x, top: y }} data-flow-node={node.id} data-flow-type={node.type}>
          {node.type === 'decision' ? <Decision node={node} /> : <Node node={node} selectedNodeId={selectedNodeId} />}
        </div>)}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-2">{visibleTypes.map((type) => <span key={type} className="inline-flex items-center gap-1 text-[10px] text-[#6b554d]"><span className={'w-2.5 h-2.5 rounded-sm ' + NODE_STYLE[type].chip} />{NODE_STYLE[type].label}</span>)}</div>
      <div className="flex flex-wrap gap-1.5">{exits.map((node) => <span key={node.id} className={'text-[10px] font-semibold px-2 py-0.5 rounded-full border ' + EXIT_TONE[node.tone || 'neutral']}>Exit: {node.title}</span>)}</div>
    </div>
  </div>;
};
