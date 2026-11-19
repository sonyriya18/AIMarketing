/**
 * Recommendations & Next Best Actions (Summary page), in the original layout:
 * one tile per channel group, then compact action cards with "How to do it".
 * Every card is triggered by a measured fact from the report; no revenue is promised here —
 * the plan is estimated in the AI Simulator under explicit assumptions.
 */
import React, { useEffect, useState } from 'react';
import { ArrowRight, Bell, Check, ChevronDown, Database, Mail, MessageSquare, Sliders, TrendingDown, Zap } from 'lucide-react';
import type { RecGroup, Recommendation } from '../lib/recommendations';

const PRIORITY: Record<Recommendation['priority'], { bar: string; pill: string }> = {
  'Fix first': { bar: '#e11d48', pill: 'bg-rose-50 text-rose-700' },
  'This month': { bar: '#f59e0b', pill: 'bg-amber-50 text-amber-700' },
  'Plan next': { bar: '#0ea5e9', pill: 'bg-sky-50 text-sky-700' },
};

const GROUP: Record<RecGroup, { icon: React.ElementType; color: string; bg: string; blurb: string }> = {
  Email: { icon: Mail, color: '#461bff', bg: '#eef0ff', blurb: 'Fix opens, clicks & bounces' },
  'Data jobs (Connect)': { icon: Database, color: '#b45309', bg: '#fff4e5', blurb: 'Keep Connect jobs running' },
  SMS: { icon: MessageSquare, color: '#db2777', bg: '#fdf0f6', blurb: 'Reminders that get read' },
  WebPush: { icon: Bell, color: '#7c3aed', bg: '#f4efff', blurb: 'Instant nudges on the web' },
};
const GROUPS: RecGroup[] = ['Email', 'Data jobs (Connect)', 'SMS', 'WebPush'];

interface Props {
  recs: Recommendation[];
  periodLabel: string;
  onSimulate: (recIds: string[]) => void;
  onOpenSimulator: () => void;
  onAsk: () => void;
}

export const RecommendationPlaybook: React.FC<Props> = ({ recs, periodLabel, onSimulate, onAsk }) => {
  const [inPlan, setInPlan] = useState<string[]>(() => recs.map((r) => r.id));
  const [filter, setFilter] = useState<RecGroup | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setInPlan(recs.map((r) => r.id));
    setOpen(null);
  }, [recs]);

  const toggle = (id: string) => setInPlan((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const filtered = filter ? recs.filter((r) => r.group === filter) : recs;
  const LIMIT = 6;
  const shown = showAll || filter ? filtered : filtered.slice(0, LIMIT);
  const urgent = recs.filter((r) => r.priority === 'Fix first').length;

  return (
    <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm space-y-4" id="recommendations">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-[#2d241d] flex items-center gap-2">
            <Zap className="w-5 h-5 text-[#C74634]" /> Recommendations &amp; Next Best Actions
          </h3>
          <p className="text-xs text-[#6b554d]">What to fix, how to do it, and what triggered it — for email, data jobs, SMS and WebPush in {periodLabel}</p>
        </div>
        <button onClick={onAsk} className="text-xs font-semibold text-[#C74634] hover:underline">Ask AI about these →</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {GROUPS.map((g) => {
          const list = recs.filter((r) => r.group === g);
          const G = GROUP[g];
          const active = filter === g;
          const crit = list.filter((r) => r.priority === 'Fix first').length;
          return (
            <button
              key={g}
              onClick={() => setFilter(active ? null : g)}
              aria-pressed={active}
              className={`text-left rounded-2xl p-3.5 border-2 bg-white transition-all cursor-pointer ${active ? 'shadow-md' : 'border-transparent hover:shadow-sm'}`}
              style={active ? { borderColor: G.color } : { boxShadow: '0 0 0 1px #ece6df inset' }}
            >
              <div className="flex items-center justify-between">
                <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: G.bg, color: G.color }}>
                  <G.icon className="w-4.5 h-4.5" />
                </span>
                <span className="text-2xl font-bold text-[#2d241d]">{list.length}</span>
              </div>
              <div className="mt-2 text-sm font-bold text-[#2d241d]">{g}</div>
              <div className="text-[11px] text-[#8a7668]">{G.blurb}</div>
              <div className="mt-2 text-[11px]">
                <span className={crit ? 'text-rose-600 font-semibold' : 'text-[#8a7668]'}>{crit ? `${crit} to fix first` : 'No urgent fixes'}</span>
              </div>
            </button>
          );
        })}
        <div className="col-span-2 lg:col-span-1 rounded-2xl p-3.5 text-white flex flex-col justify-between bg-gradient-to-br from-[#2d241d] to-[#5a3a24]">
          <div>
            <div className="text-[11px] text-white/70">Your plan</div>
            <div className="text-2xl font-bold font-mono">{inPlan.length} actions</div>
            <div className="text-[11px] text-white/70">{inPlan.length} of {recs.length} in plan · {urgent} urgent</div>
            <div className="text-[10px] text-white/60 mt-1">Estimate the result in the AI Simulator with your own assumptions.</div>
          </div>
          <button
            onClick={() => onSimulate(inPlan)}
            disabled={inPlan.length === 0}
            className="mt-3 inline-flex items-center justify-center gap-1.5 bg-[#C74634] hover:bg-[#b03d2d] disabled:opacity-40 text-white px-3 py-2 rounded-xl text-xs font-bold cursor-pointer"
          >
            <Sliders className="w-3.5 h-3.5" /> Simulate plan
          </button>
        </div>
      </div>

      {recs.length === 0 ? (
        <p className="text-xs text-[#6b554d]">No action is triggered by this period's data.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-[#6b554d]">
            <span>
              {filter ? (
                <>Showing <strong>{filter}</strong> · <button onClick={() => setFilter(null)} className="text-[#C74634] font-semibold cursor-pointer">show all</button></>
              ) : (
                <>Top {Math.min(LIMIT, filtered.length)} most urgent · tap a channel above to see all of its actions</>
              )}
            </span>
            <span className="hidden sm:flex items-center gap-3">
              {(Object.keys(PRIORITY) as Recommendation['priority'][]).map((p) => (
                <span key={p} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: PRIORITY[p].bar }} /> {p}</span>
              ))}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
            {shown.map((rec) => {
              const G = GROUP[rec.group];
              const P = PRIORITY[rec.priority];
              const planned = inPlan.includes(rec.id);
              const expanded = open === rec.id;
              return (
                <article key={rec.id} className={`relative rounded-2xl bg-white overflow-hidden transition-all ${planned ? '' : 'opacity-60'} ${expanded ? 'shadow-md' : 'hover:shadow-sm'}`} style={{ boxShadow: '0 0 0 1px #ece6df inset' }}>
                  <span className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: P.bar }} aria-hidden />
                  <div className="p-3.5 pl-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: G.bg, color: G.color }}><G.icon className="w-3.5 h-3.5" /></span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${P.pill}`}>{rec.priority}</span>
                      </div>
                      <button
                        onClick={() => toggle(rec.id)}
                        aria-pressed={planned}
                        aria-label={planned ? 'Remove from plan' : 'Add to plan'}
                        className={`w-5 h-5 rounded-md border flex items-center justify-center cursor-pointer ${planned ? 'bg-[#C74634] border-[#C74634] text-white' : 'border-[#d4bfa9]'}`}
                      >
                        {planned && <Check className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <h4 className="text-[14px] font-bold text-[#2d241d] leading-snug">{rec.title}</h4>
                    <p className="text-[12px] text-[#6b554d] leading-snug">{rec.evidence}</p>
                    {rec.metricLabel && rec.change && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-800">
                        <TrendingDown className="w-3 h-3" /> {rec.metricLabel} {rec.change}
                      </span>
                    )}
                    {expanded && (
                      <ol className="pt-1 space-y-1.5">
                        {rec.howTo.map((s, i) => (
                          <li key={s} className="flex items-start gap-2 text-[12px] text-[#4b3a30]">
                            <span className="min-w-[18px] h-[18px] rounded-full text-white text-[10px] font-bold flex items-center justify-center mt-px" style={{ backgroundColor: G.color }}>{i + 1}</span>
                            <span className="leading-snug">{s}</span>
                          </li>
                        ))}
                        <li className="text-[10px] text-[#8a7668]">General Responsys practice — test before rolling out.</li>
                      </ol>
                    )}
                  </div>
                  <div className="flex items-center justify-between px-4 py-2 border-t border-[#f3ece4] bg-[#fdfbf8]">
                    <button onClick={() => setOpen(expanded ? null : rec.id)} aria-expanded={expanded} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6b554d] hover:text-[#2d241d] cursor-pointer">
                      {expanded ? 'Hide steps' : 'How to do it'} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </button>
                    <button onClick={() => onSimulate([rec.id])} className="inline-flex items-center gap-1 text-[11px] font-bold text-[#C74634] hover:underline cursor-pointer">
                      Simulate <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {!filter && filtered.length > LIMIT && (
            <div className="text-center">
              <button onClick={() => setShowAll((v) => !v)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white text-xs font-bold text-[#2d241d] cursor-pointer hover:shadow-sm" style={{ boxShadow: '0 0 0 1px #ece6df inset' }}>
                {showAll ? 'Show top 6 only' : `Show all ${filtered.length} actions`} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAll ? 'rotate-180' : ''}`} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
