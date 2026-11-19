/**
 * Analyze Campaign (Single Campaign Deep-Dive) in the original layout, from the campaign
 * report snapshot. "Account pattern" is the explicit benchmark: the other campaigns on the same
 * channel in the same period.
 */
import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, MousePointer, Sliders, TrendingDown, TrendingUp } from 'lucide-react';
import type { CampaignReportResult, MetricChange, MetricValue } from '../lib/types';
import { changeOf, clickRate, openRate, show, why } from '../lib/metrics';
import { EvidenceListModal, EvidenceModal } from './ui';
import { NotInData } from './ExecutiveBriefing';
import { AiInsight, AiSummaryCard } from './AiSummary';

interface Props {
  report: CampaignReportResult;
  onNavigateToSimulator: () => void;
}

const BLUEPRINTS: Record<string, { name: string; flow: string; feature: string }> = {
  open: { name: 'Send Time Optimization Program', flow: 'Enable STO on the launch, keep a 10% control group, compare opens after 72 hours', feature: 'Send Time Optimization + A/B Split' },
  click: { name: 'Single Primary CTA Layout', flow: 'One hero call to action above the fold, dynamic product block below', feature: 'Content Designer + Dynamic Content' },
  ctor: { name: 'Subject-to-Body Alignment Test', flow: 'Repeat the subject promise in the hero; A/B test hero image vs text-led layout', feature: 'A/B Testing + RPL personalisation' },
  conversion: { name: 'Cart Recovery Sequence', flow: 'Send a reminder with the dynamic cart token, wait 24h, follow up with an incentive if unpurchased', feature: 'Program Designer Stage Gate + Dynamic Product Blocks' },
  revenue: { name: 'Browse Abandonment Retargeting', flow: 'Personalised product recommendations with review ratings for recent browsers', feature: 'Responsys RPL / Personalization Engine' },
  delivery: { name: 'List Hygiene Program', flow: 'Suppress hard bounces and long-inactive contacts before each launch', feature: 'Filter Rules + Suppression Lists' },
  bounce: { name: 'Address Validation at Sign-up', flow: 'Validate addresses at capture and suppress hard bounces automatically', feature: 'Form Validation + Suppression Lists' },
  unsub: { name: 'Frequency Cap Policy', flow: 'Cap contacts at 3 messages per 72 hours and offer a preference centre', feature: 'Audience Filter Rule + Contact Frequency Exception' },
  default: { name: 'VIP Early Access Flow', flow: 'Priority exclusive window for the most engaged segment before the mass broadcast', feature: 'Audience Filter Rule + Contact Frequency Exception' },
};
const keyFor = (id: string) =>
  /open_rate/.test(id) ? 'open' : /click_to_open/.test(id) ? 'ctor' : /click_rate/.test(id) ? 'click' : /conversion/.test(id) ? 'conversion' : /revenue/.test(id) ? 'revenue' : /delivered_rate/.test(id) ? 'delivery' : /bounce/.test(id) ? 'bounce' : /unsubscribe|complaint/.test(id) ? 'unsub' : 'default';

export const SingleCampaignAnalysis: React.FC<Props> = ({ report: r, onNavigateToSimulator }) => {
  const [inspect, setInspect] = useState<MetricValue | null>(null);
  const [evIds, setEvIds] = useState<string[] | null>(null);
  const cur = Object.fromEntries(r.metrics.map((m) => [m.metricId, m.current]));
  const latest = [...r.launches].sort((a, b) => (a.launchDate < b.launchDate ? 1 : -1))[0];
  const first = [...r.launches].sort((a, b) => (a.launchDate < b.launchDate ? -1 : 1))[0];
  const benchLabel = r.benchmark?.type === 'campaign' ? 'benchmark campaign' : 'account pattern';

  const tileIds = [
    'delivered',
    openRate(cur)?.metricId ?? 'unique_open_rate',
    clickRate(cur)?.metricId ?? 'unique_click_rate',
    'unique_click_to_open_rate',
    'conversion_event_rate',
    'revenue_per_delivered',
    'delivered_rate',
    'unsubscribe_rate',
    'bounce_rate',
  ];
  const tiles = tileIds.map((id) => ({ id, m: cur[id], vs: changeOf(r.benchmarkComparison, id) })).filter((t) => t.m) as { id: string; m: MetricValue; vs: MetricChange | undefined }[];

  const working = r.findings.filter((f) => f.severity === 'positive');
  const attention = r.findings.filter((f) => f.severity === 'attention' || f.kind === 'limitation');
  // Only rates and per-message values: a smaller campaign is not a flaw.
  const weak = r.benchmarkComparison.filter((c) => c.interpretation === 'worse' && (c.current.unit === 'percent' || c.current.unit === 'money_per_message'));
  const blueprintKeys = [...new Set(weak.map((c) => keyFor(c.metricId)))];
  const blueprints = [...blueprintKeys, 'default', 'conversion', 'revenue'].filter((k, i, a) => a.indexOf(k) === i).slice(0, 3).map((k) => ({ key: k, ...BLUEPRINTS[k]! }));

  return (
    <div className="space-y-6 text-[#2d241d]">
      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e8dcc9] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-[#f1dfcf] text-[#7d4d35] border border-[#e2c4a8]">{r.campaign.externalId}</span>
              <span className="text-xs text-[#8a7668]">
                {r.launches.length === 1 ? `Launched: ${first?.launchDate}` : r.launches.length ? `Launched: ${first?.launchDate} – ${latest?.launchDate} (${r.launches.length} launches)` : 'No launches in this period'}
              </span>
            </div>
            <h2 className="text-xl font-bold tracking-tight text-[#2d241d] mt-1">{r.campaign.name}</h2>
            <p className="text-xs text-[#6b554d] mt-1">
              Program: <strong>{r.campaign.program || 'Not in the data'}</strong> · Channel: <strong>{r.campaign.channel}</strong> · {r.period?.label}
            </p>
          </div>
          <div className="text-right">
            <span className="text-xs text-[#78665a]">Campaign Revenue</span>
            <div className="text-xl font-bold font-mono text-emerald-800">{show(cur.revenue)}</div>
          </div>
        </div>
        <div className="mt-3 text-xs text-[#6b554d] flex flex-wrap items-center gap-4">
          <span>Subject: {latest?.subjectLine ? <em className="text-[#2d241d]">"{latest.subjectLine}"</em> : <span className="text-[#8a7668]">not in the data</span>}</span>
          <span>•</span>
          <span>Delivered: <strong className="text-gray-900">{show(cur.delivered)}</strong></span>
          <span>•</span>
          <span>Compared with: <strong>{r.benchmark?.label ?? 'no benchmark'}</strong></span>
        </div>
      </section>

      <AiSummaryCard reportId={r.meta.reportId} id="ai-campaign-summary" />

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-3">
          <h3 className="text-base font-bold text-gray-900">1. Campaign Performance Metrics</h3>
          <p className="text-xs text-gray-500">Analysing this campaign against the {benchLabel}: {r.benchmark?.label ?? 'none selected'}</p>
        </div>
        <AiInsight reportId={r.meta.reportId} section="performance" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {tiles.map(({ id, m, vs }) => {
            const good = vs?.interpretation === 'better';
            const bad = vs?.interpretation === 'worse';
            return (
              <button key={id} type="button" onClick={() => setInspect(m)} className="text-left rounded-xl border border-gray-200 bg-gray-50/60 p-3.5 flex flex-col justify-between hover:border-[#C74634]/40">
                <div>
                  <div className="text-[11px] font-semibold text-gray-600">{id === 'delivered' ? 'Target audience (delivered)' : m.label}</div>
                  <div className={`mt-1 font-bold font-mono ${m.value === null ? 'text-sm text-gray-400' : 'text-lg text-gray-900'}`}>{show(m)}</div>
                  {m.value === null && <div className="text-[10px] text-gray-500">{why(m)}</div>}
                </div>
                {vs?.previous ? (
                  <div className={`mt-2 text-[10px] font-semibold flex items-center gap-1 ${good ? 'text-emerald-700' : bad ? 'text-rose-700' : 'text-gray-600'}`}>
                    {good ? <TrendingUp className="w-3 h-3" /> : bad ? <TrendingDown className="w-3 h-3" /> : null}
                    <span>
                      {vs.interpretation === 'neutral' || !vs.interpretation ? 'Compared with' : good ? 'Above' : 'Below'} {benchLabel} ({show(vs.previous)})
                    </span>
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-gray-500">No {benchLabel} value</div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-emerald-950"><CheckCircle2 className="w-4 h-4 text-emerald-700" /> 2. What Is Working</h3>
          <p className="text-[11px] text-emerald-800 mt-0.5">Measured strengths against the {benchLabel} and the previous period</p>
          <div className="mt-3"><AiInsight reportId={r.meta.reportId} section="strengths" /></div>
          <ul className="mt-3 space-y-2 text-xs text-emerald-950">
            {working.length === 0 && <li>No metric is ahead of the {benchLabel} in this period.</li>}
            {working.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mt-1.5 shrink-0" />
                <span className="leading-relaxed flex-1">{f.text}</span>
                <button className="text-[10px] underline font-semibold shrink-0" onClick={() => setEvIds(f.evidenceIds)}>Evidence</button>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-rose-950"><AlertTriangle className="w-4 h-4 text-rose-700" /> 3. What Needs Attention</h3>
          <p className="text-[11px] text-rose-800 mt-0.5">Measured gaps and data limitations</p>
          <div className="mt-3"><AiInsight reportId={r.meta.reportId} section="weaknesses" /></div>
          <ul className="mt-3 space-y-2 text-xs text-rose-950">
            {attention.length === 0 && <li>Nothing needs attention for this campaign in this period.</li>}
            {attention.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-600 mt-1.5 shrink-0" />
                <span className="leading-relaxed flex-1">{f.text}</span>
                {f.evidenceIds.length > 0 && <button className="text-[10px] underline font-semibold shrink-0" onClick={() => setEvIds(f.evidenceIds)}>Evidence</button>}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><MousePointer className="w-4 h-4 text-[#8d563b]" /> 4. Link Placement Click Distribution</h3>
            <p className="text-xs text-[#6b554d]">Responsys link alias tracking breakdown across email layout sections</p>
          </div>
          <span className="text-[11px] text-[#8a7668]">Total Clicks: {show(cur.total_clicks?.value !== null ? cur.total_clicks : cur.unique_clicks)}</span>
        </div>
        <NotInData need="Link-level click data is not imported. Total clicks for the campaign are shown above." />
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><Clock className="w-4 h-4 text-[#8d563b]" /> 5. Hourly Engagement &amp; Send-Time Velocity</h3>
        <p className="text-xs text-[#6b554d] mb-3">Launch-by-launch results (the file has dates, not hours)</p>
        <NotInData need="Send hours and hourly opens/clicks are not in the file, so hourly velocity cannot be shown." />
        {r.launches.length > 0 && (
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs bg-white rounded-xl">
              <thead className="text-left text-[#8a7668]"><tr><th className="p-2">Launch date</th><th>Launch ID</th><th>Subject</th><th>Delivered</th><th>Open rate</th><th>Click rate</th><th>Revenue</th></tr></thead>
              <tbody>
                {r.launches.map((l) => (
                  <tr key={`${l.launchExternalId}-${l.launchDate}`} className="border-t border-[#efe3d6]">
                    <td className="p-2 font-mono">{l.launchDate}</td>
                    <td className="font-mono">{l.launchExternalId ?? '—'}</td>
                    <td className="max-w-xs truncate" title={l.subjectLine ?? ''}>{l.subjectLine ?? '—'}</td>
                    <td className="font-mono">{show(l.metrics.delivered)}</td>
                    <td className="font-mono">{show(openRate(l.metrics))}</td>
                    <td className="font-mono">{show(clickRate(l.metrics))}</td>
                    <td className="font-mono">{show(l.metrics.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-[#2d241d]">6. Campaign Recommendations &amp; Next Steps</h3>
            <p className="text-xs text-[#6b554d]">
              {weak.length ? `Chosen because ${weak.map((c) => c.label.toLowerCase()).slice(0, 3).join(', ')} ${weak.length === 1 ? 'is' : 'are'} below the ${benchLabel}` : `No metric is below the ${benchLabel}; next steps to build on it`}
            </p>
          </div>
          <button onClick={onNavigateToSimulator} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#b77a57] hover:bg-[#a86d4d] text-white shadow-xs">
            <Sliders className="w-3.5 h-3.5" /> <span>Simulate Improvements in What-If</span> <ChevronRight className="w-3 h-3" />
          </button>
        </div>
        <AiInsight reportId={r.meta.reportId} section="next_steps" />
        <div className="grid gap-3 sm:grid-cols-3">
          {blueprints.map((b) => (
            <div key={b.key} className="p-3.5 rounded-xl border border-[#e8dcc9] bg-white text-xs flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-bold text-[#8d563b] uppercase">Program Blueprint</span>
                <h4 className="text-xs font-bold text-[#2d241d] mt-0.5">{b.name}</h4>
                <p className="text-[11px] text-[#5f4d42] mt-1 leading-relaxed">{b.flow}</p>
              </div>
              <div className="mt-2.5 pt-2 border-t border-[#f0e6dc] text-[10px] text-[#78665a]"><strong>Module:</strong> {b.feature}</div>
            </div>
          ))}
        </div>
      </section>

      {inspect && <EvidenceModal metric={inspect} evidence={r.evidence} source={r.source} onClose={() => setInspect(null)} />}
      {evIds && <EvidenceListModal ids={evIds} evidence={r.evidence} onClose={() => setEvIds(null)} />}
    </div>
  );
};
