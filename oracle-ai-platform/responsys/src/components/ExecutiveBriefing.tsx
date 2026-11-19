/**
 * Summary (Account Performance Summary) in the original layout. Every figure comes from the
 * report snapshot for the selected period; sections the data cannot support say what is
 * missing instead of showing numbers.
 */
import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Eye,
  Layers,
  MousePointer,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  CircleSlash,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import type { Account, MetricValue, OverviewResult } from '../lib/types';
import { changeOf, clickRate, count, metricOf, money, num, openRate, show, showChange, why } from '../lib/metrics';
import { useConnectSummary } from '../lib/queries';
import { EvidenceModal, EvidenceListModal } from './ui';
import { RecommendationPlaybook } from './RecommendationPlaybook';
import { buildRecommendations } from '../lib/recommendations';
import { DimensionBreakdown } from './DimensionBreakdown';
import { AiInsight, AiSummaryCard } from './AiSummary';

interface ExecutiveBriefingProps {
  report: OverviewResult;
  account: Account;
  onNavigateToSimulator: () => void;
  onNavigateToChat: () => void;
  onSelectCampaignForDetail: (campaignId: string) => void;
  onSimulateRecommendations: (recIds: string[]) => void;
  connectSection: React.ReactNode;
}

const CHANNEL_COLORS = ['#C74634', '#8b5cf6', '#ec4899', '#0ea5e9', '#f59e0b'];

/** Same frame as the original sections, used where the data has no such field. */
export const NotInData: React.FC<{ need: string; children?: React.ReactNode }> = ({ need, children }) => (
  <div className="rounded-xl border border-dashed border-[#dcc7b0] bg-white/70 p-4 text-xs text-[#6b554d] flex items-start gap-2">
    <CircleSlash className="w-4 h-4 text-[#b8a493] shrink-0 mt-0.5" />
    <div>
      <div className="font-semibold text-[#4d4039]">Not in your data</div>
      <div>{need}</div>
      {children}
    </div>
  </div>
);

const Kpi: React.FC<{ label: string; icon: React.ElementType; iconCls: string; value: string; valueCls?: string; sub: string; subCls?: string; onClick?: () => void }> = ({ label, icon: Icon, iconCls, value, valueCls, sub, subCls, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="text-left bg-white border border-[#e8dcc9] rounded-xl p-3 shadow-xs flex flex-col justify-between hover:border-[#C74634]/40 transition-colors"
    title="Show how this number was calculated"
  >
    <div className="flex items-center justify-between text-gray-500 mb-1">
      <span className="text-[10px] font-semibold text-[#6b554d] uppercase tracking-wider">{label}</span>
      <Icon className={`w-3.5 h-3.5 ${iconCls}`} />
    </div>
    <div className={`text-lg font-bold font-mono truncate ${value === 'Unavailable' ? 'text-gray-400 text-sm' : valueCls ?? 'text-gray-900'}`}>{value}</div>
    <div className={`text-[10px] mt-1 font-medium truncate ${subCls ?? 'text-[#8a7668]'}`}>{sub}</div>
  </button>
);

export const ExecutiveBriefing: React.FC<ExecutiveBriefingProps> = ({ report: r, account, onNavigateToSimulator, onNavigateToChat, onSelectCampaignForDetail, onSimulateRecommendations, connectSection }) => {
  const [inspect, setInspect] = useState<MetricValue | null>(null);
  const [evIds, setEvIds] = useState<string[] | null>(null);

  const connect = useConnectSummary(account.id, r.period?.startDate, r.period?.endDateExclusive);
  const cur = useMemo(() => Object.fromEntries(r.totals.map((t) => [t.metricId, t.current])), [r.totals]);
  const currency = r.meta.currency;
  const label = r.period && 'label' in r.period ? r.period.label : 'Selected period';
  const hasPrev = Boolean(r.comparison) && r.capabilities.find((c) => c.key === 'previous_period')?.status === 'available';

  const revenue = cur.revenue;
  const delivered = cur.delivered;
  const open = openRate(cur);
  const click = clickRate(cur);
  const programs = (r.byProgram ?? []).filter((p) => p.program);
  const hasValues = (rows: OverviewResult['bySubjectLine'] | undefined) => (rows ?? []).some((x) => x.value);
  const creative = hasValues(r.byCreativeType) ? r.byCreativeType : [];
  const subjects = hasValues(r.bySubjectLine) ? r.bySubjectLine : [];
  const offers = hasValues(r.byOffer) ? r.byOffer : [];
  const orders = cur.orders?.value !== null ? cur.orders : cur.conversion_events;
  const recs = useMemo(() => buildRecommendations(r, connect.data), [r, connect.data]);

  const metricRows = [
    open,
    click,
    cur.unique_click_to_open_rate,
    cur.conversion_event_rate,
    cur.revenue_per_delivered,
    cur.delivered_rate,
    cur.unsubscribe_rate,
    cur.bounce_rate,
  ].filter(Boolean) as MetricValue[];

  const positives = r.findings.filter((f) => f.severity === 'positive');
  const attention = r.findings.filter((f) => f.severity === 'attention' || f.kind === 'limitation');

  // Campaigns that worked / need optimisation: each campaign's click rate (else conversion
  // rate) against the same rate across all campaigns in the period. No invented targets.
  const ranking = useMemo(() => {
    const acct = num(click) ?? num(cur.conversion_event_rate);
    const rateOf = (c: (typeof r.campaigns)[number]) => (num(click) !== null ? num(clickRate(c.metrics)) : num(c.metrics.conversion_event_rate));
    const rows = r.campaigns.map((c) => ({ c, v: rateOf(c) })).filter((x) => x.v !== null && (num(x.c.metrics.delivered) ?? 0) > 0) as { c: (typeof r.campaigns)[number]; v: number }[];
    const sorted = [...rows].sort((a, b) => b.v - a.v);
    return {
      acct,
      label: num(click) !== null ? 'click rate' : 'conversion rate',
      top: acct === null ? [] : sorted.filter((x) => x.v >= acct).slice(0, 3),
      low: acct === null ? [] : sorted.filter((x) => x.v < acct).reverse().slice(0, 3),
    };
  }, [r, click, cur.conversion_event_rate]);

  const revenueChartData = [...r.campaigns]
    .filter((c) => num(c.metrics.revenue) !== null)
    .sort((a, b) => (num(b.metrics.revenue) ?? 0) - (num(a.metrics.revenue) ?? 0))
    .slice(0, 10)
    .map((c) => ({ id: c.campaignId, name: c.name.length > 18 ? `${c.name.substring(0, 16)}...` : c.name, revenue: num(c.metrics.revenue) ?? 0 }));
  const channelShareData = r.byChannel
    .map((c, i) => ({ name: c.channel, value: num(metricOf(c.metrics, 'delivered')) ?? 0, color: CHANNEL_COLORS[i % CHANNEL_COLORS.length]! }))
    .filter((c) => c.value > 0);
  const channelTotal = channelShareData.reduce((s, c) => s + c.value, 0);

  const weekdays = (r.byWeekday ?? []).filter((w) => (num(metricOf(w.metrics, 'delivered')) ?? 0) > 0);
  const bestBy = (pickRate: (m: MetricValue[]) => MetricValue | undefined) =>
    weekdays.map((w) => ({ w, v: num(pickRate(w.metrics)) })).filter((x) => x.v !== null).sort((a, b) => b.v! - a.v!)[0];
  const bestOpen = bestBy((m) => openRate(m));
  const bestClick = bestBy((m) => clickRate(m));
  const bestRevenue = bestBy((m) => metricOf(m, 'revenue_per_delivered'));
  const programStatus = (p: (typeof programs)[number]) => {
    const pv = num(clickRate(p.metrics));
    const av = num(click);
    if (pv === null || av === null || av === 0) return { tag: 'Healthy', cls: 'bg-sky-100 text-sky-800 border-sky-200' };
    if (pv >= av * 1.1) return { tag: 'Strong', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    if (pv <= av * 0.9) return { tag: 'Needs Attention', cls: 'bg-amber-100 text-amber-800 border-amber-200' };
    return { tag: 'Healthy', cls: 'bg-sky-100 text-sky-800 border-sky-200' };
  };

  return (
    <div className="space-y-6 text-[#2d241d]">
      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#e8dcc9] pb-4">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#f1dfcf] text-[#8d563b] border border-[#e2c4a8] mb-2">
              <Calendar className="w-3.5 h-3.5" />
              <span>{label}</span>
            </div>
            <h2 className="text-xl font-bold tracking-tight text-[#2d241d]">Account Performance &amp; Campaign Intelligence</h2>
            <p className="text-xs text-[#6b554d] mt-1">
              Performance results across <strong>{r.counts.campaigns} campaigns</strong> and <strong>{show(delivered)} total delivered messages</strong> for <strong>{label}</strong>.
              {r.comparison && <> Compared with {r.comparison.label.replace('Comparison ', '')}.</>}
            </p>
            <p className="text-[10px] text-[#8a7668] mt-1">Source: {r.source.datasetName} · version {r.source.version} · {r.meta.timezone} · {r.meta.currency}</p>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs text-[#78665a]">Total Revenue Generated</span>
            <span className="text-2xl font-bold font-mono text-emerald-800">{show(revenue)}</span>
            <span className="text-[10px] text-[#8a7668]">provider-attributed</span>
          </div>
        </div>

        {r.meta.warnings.length > 0 && (
          <div className="mt-3 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900 space-y-0.5">
            {r.meta.warnings.slice(0, 4).map((w) => <div key={w}>• {w}</div>)}
          </div>
        )}

        <div className="mt-4">
          <div className="text-[11px] font-bold text-[#8d563b] uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#C74634]" />
            <span>Executive Performance Summary Indicators (8 Core KPI Dimensions)</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Revenue" icon={DollarSign} iconCls="text-emerald-600" value={show(revenue)} valueCls="text-emerald-800" sub={cur.revenue_per_delivered?.value ? `${show(cur.revenue_per_delivered)} / delivered message` : why(revenue) || 'Revenue per message unavailable'} onClick={() => revenue && setInspect(revenue)} />
            <Kpi label="Campaigns" icon={Layers} iconCls="text-indigo-600" value={String(r.counts.campaigns)} sub={programs.length ? `Across ${programs.length} programs` : `${r.counts.launches} launches`} />
            <Kpi label="Delivered" icon={Send} iconCls="text-[#C74634]" value={show(delivered)} sub={cur.delivered_rate?.value ? `${show(cur.delivered_rate)} delivery rate` : 'Delivery rate unavailable'} subCls="text-emerald-700" onClick={() => delivered && setInspect(delivered)} />
            <Kpi label="Open Rate" icon={Eye} iconCls="text-blue-600" value={show(open)} sub={open?.value ? `${show(open?.metricId === 'unique_open_rate' ? cur.unique_opens : cur.total_opens)} ${open?.metricId === 'unique_open_rate' ? 'unique' : 'total'} opens` : why(open) || 'Not in the source'} onClick={() => open && setInspect(open)} />
            <Kpi label="CTR" icon={MousePointer} iconCls="text-purple-600" value={show(click)} sub={click?.value ? `${show(click?.metricId === 'unique_click_rate' ? cur.unique_clicks : cur.total_clicks)} clicks` : why(click) || 'Not in the source'} onClick={() => click && setInspect(click)} />
            <Kpi label={cur.orders?.value !== null ? 'Orders' : 'Conversions'} icon={CheckCircle2} iconCls="text-emerald-600" value={show(cur.conversion_event_rate)} sub={orders?.value ? `${show(orders)} ${cur.orders?.value !== null ? 'orders' : 'conversion events'}` : why(orders) || 'Not in the source'} onClick={() => cur.conversion_event_rate && setInspect(cur.conversion_event_rate)} />
            <Kpi label="Yield (RPE)" icon={DollarSign} iconCls="text-[#8d563b]" value={show(cur.revenue_per_delivered)} valueCls="text-emerald-800" sub="Revenue / delivered message" onClick={() => cur.revenue_per_delivered && setInspect(cur.revenue_per_delivered)} />
            <Kpi label="Bounce Rate" icon={ShieldCheck} iconCls="text-emerald-600" value={show(cur.bounce_rate)} sub={cur.bounces?.value ? `${show(cur.bounces)} bounces` : why(cur.bounce_rate) || 'Not in the source'} subCls="text-emerald-700" onClick={() => cur.bounce_rate && setInspect(cur.bounce_rate)} />
          </div>
        </div>

        {connectSection}
      </section>

      <AiSummaryCard reportId={r.meta.reportId} id="ai-executive-summary" />

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-base font-bold text-[#2d241d]">1. Account Performance Metrics</h3>
            <p className="text-xs text-[#6b554d]">Aggregated KPI performance for {label}</p>
          </div>
          <span className="text-[10px] font-mono text-[#8a7668]">Source: {r.source.datasetName} (v{r.source.version})</span>
        </div>
        <AiInsight reportId={r.meta.reportId} section="metrics" />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#f6ece1] text-[#6b554d] text-[10px] uppercase tracking-wider text-left">
                <th className="p-2.5 font-semibold">Metric</th>
                <th className="p-2.5 font-semibold">Current Period</th>
                <th className="p-2.5 font-semibold">Previous Period</th>
                <th className="p-2.5 font-semibold">Change</th>
                <th className="p-2.5 font-semibold">What Has Improved in {label.split(' (')[0]}</th>
              </tr>
            </thead>
            <tbody>
              {metricRows.map((m) => {
                const c = changeOf(r.totals, m.metricId);
                const good = c?.interpretation === 'better';
                const bad = c?.interpretation === 'worse';
                return (
                  <tr key={m.metricId} className="border-t border-[#efe3d6]">
                    <td className="p-2.5 font-semibold text-[#2d241d]">
                      <button type="button" onClick={() => setInspect(m)} className="hover:underline text-left">{m.label}</button>
                    </td>
                    <td className="p-2.5 font-mono">{show(m)}</td>
                    <td className="p-2.5 font-mono text-[#6b554d]">{hasPrev && c?.previous ? show(c.previous) : '—'}</td>
                    <td className={`p-2.5 font-mono font-semibold ${good ? 'text-emerald-700' : bad ? 'text-rose-700' : 'text-[#6b554d]'}`}>
                      <span className="inline-flex items-center gap-1">
                        {c?.direction === 'up' && <ArrowUpRight className="w-3 h-3" />}
                        {c?.direction === 'down' && <ArrowDownRight className="w-3 h-3" />}
                        {hasPrev ? showChange(c) : '—'}
                      </span>
                    </td>
                    <td className="p-2.5">
                      {!hasPrev || !c?.interpretation ? (
                        <span className="text-[10px] text-[#8a7668]">{c?.note ?? 'No comparison'}</span>
                      ) : (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${good ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : bad ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                          {good ? `${m.label} improved` : bad ? `${m.label} needs attention` : `${m.label} unchanged`}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-bold text-emerald-950">
            <ArrowUpRight className="w-4 h-4 text-emerald-700" /> 2. What Has Improved in {label.split(' (')[0]}
          </h3>
          <p className="text-[11px] text-emerald-800 mb-3">Key areas of positive movement versus the previous period</p>
          <AiInsight reportId={r.meta.reportId} section="improved" />
          {positives.length ? (
            <ul className="space-y-2 text-xs text-emerald-950">
              {positives.map((f) => (
                <li key={f.id} className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0" />
                  <span className="flex-1">{f.text}</span>
                  <button className="text-[10px] font-semibold text-emerald-800 underline shrink-0" onClick={() => setEvIds(f.evidenceIds)}>Evidence</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-emerald-900">{hasPrev ? 'No metric improved against the comparison period.' : 'No comparison period with data, so improvements cannot be measured.'}</p>
          )}
        </section>
        <section className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-bold text-rose-950">
            <AlertTriangle className="w-4 h-4 text-rose-700" /> 3. Needs Attention
          </h3>
          <p className="text-[11px] text-rose-800 mb-3">Friction points and performance areas requiring tuning in Responsys</p>
          <AiInsight reportId={r.meta.reportId} section="attention" />
          {attention.length ? (
            <ul className="space-y-2 text-xs text-rose-950">
              {attention.map((f) => (
                <li key={f.id} className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-600 shrink-0" />
                  <span className="flex-1">{f.text}</span>
                  {f.evidenceIds.length > 0 && <button className="text-[10px] font-semibold text-rose-800 underline shrink-0" onClick={() => setEvIds(f.evidenceIds)}>Evidence</button>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-rose-900">Nothing needs attention in this period.</p>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <h3 className="text-base font-bold text-[#2d241d]">4. Campaign Performance (Which Campaigns Worked)</h3>
        <p className="text-xs text-[#6b554d] mb-4">
          Each campaign's {ranking.label} compared with {ranking.acct !== null ? `${ranking.acct.toFixed(2)}%` : 'the account rate'} across all campaigns in this period
        </p>
        <AiInsight reportId={r.meta.reportId} section="campaigns" />
        {ranking.acct === null ? (
          <NotInData need="Campaign click or conversion counts are needed to rank campaigns." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { title: 'Top-Performing Campaigns', rows: ranking.top, tone: 'emerald' as const },
              { title: 'Campaigns Needing Optimization', rows: ranking.low, tone: 'rose' as const },
            ].map((col) => (
              <div key={col.title}>
                <div className={`text-xs font-bold mb-2 ${col.tone === 'emerald' ? 'text-emerald-800' : 'text-rose-800'}`}>{col.title}</div>
                <div className="space-y-2">
                  {col.rows.length === 0 && <p className="text-xs text-[#8a7668]">None in this period.</p>}
                  {col.rows.map(({ c, v }) => (
                    <button
                      key={c.campaignId}
                      type="button"
                      onClick={() => onSelectCampaignForDetail(c.campaignId)}
                      className={`w-full text-left p-3 rounded-xl border bg-white hover:shadow-sm transition ${col.tone === 'emerald' ? 'border-emerald-200' : 'border-rose-200'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-bold text-[#2d241d]">{c.name}</span>
                        <span className={`text-[10px] font-mono font-bold shrink-0 ${col.tone === 'emerald' ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {v.toFixed(2)}% · {show(c.metrics.revenue)}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#6b554d] mt-0.5">
                        {c.program ? <>Program: <strong>{c.program}</strong> · </> : null}
                        {c.channel} · {c.launchCount} launch{c.launchCount === 1 ? '' : 'es'} in period · last {c.lastLaunchDate}
                      </div>
                      <div className="text-[11px] text-[#4d4039] mt-1">
                        {show(c.metrics.delivered)} delivered, {ranking.label} {v.toFixed(2)}% ({(v - ranking.acct!).toFixed(2)} pp vs all campaigns).
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-bold text-gray-900">Campaign Revenue Performance</h3>
              <p className="text-[11px] text-gray-500">Revenue by campaign launched during {label.split(' (')[0]}</p>
            </div>
          </div>
          <AiInsight reportId={r.meta.reportId} section="revenue" />
          {revenueChartData.length ? (
            <div className="h-64" role="img" aria-label="Revenue by campaign">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueChartData} margin={{ top: 8, right: 8, left: 8, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-12} textAnchor="end" />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => money(Number(v), currency)} />
                  <Bar isAnimationActive={false} dataKey="revenue" name="Revenue" fill="#C74634" radius={[4, 4, 0, 0]} onClick={(d: any) => d?.id && onSelectCampaignForDetail(d.id)} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NotInData need="Revenue per campaign is not available for this period." />
          )}
        </section>
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold text-gray-900">Channel Share</h3>
          <p className="text-[11px] text-gray-500">Delivered volume by marketing channel</p>
          {channelShareData.length ? (
            <div className="h-64" role="img" aria-label="Delivered share by channel">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie isAnimationActive={false} data={channelShareData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={channelShareData.length > 1 ? 2 : 0}>
                    {channelShareData.map((c) => <Cell key={c.name} fill={c.color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => `${count(Number(v))} (${((Number(v) / channelTotal) * 100).toFixed(1)}%)`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => { const c = channelShareData.find((x) => x.name === v); return `${v} (${c ? ((c.value / channelTotal) * 100).toFixed(0) : 0}%)`; }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <NotInData need="No delivered volume by channel in this period." />
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-bold text-gray-900">5. Responsys Program &amp; Journey Performance</h3>
        <p className="text-xs text-gray-500 mb-4">Programs as named in your data, compared on click rate with all campaigns in the period</p>
        <AiInsight reportId={r.meta.reportId} section="programs" />
        {programs.length ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {programs.map((p) => {
              const st = programStatus(p);
              return (
                <div key={p.program} className="rounded-xl border border-[#e8dcc9] bg-[#fffaf5] p-3.5">
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${st.cls}`}>{st.tag}</span>
                    <span className="text-[10px] font-mono text-[#8a7668]">{p.launches} dispatches</span>
                  </div>
                  <div className="text-sm font-bold text-[#2d241d] mt-2">{p.program}</div>
                  <div className="mt-2 space-y-1 text-[11px]">
                    <div className="flex justify-between"><span className="text-[#6b554d]">Avg Open Rate:</span><span className="font-mono font-semibold">{show(openRate(p.metrics))}</span></div>
                    <div className="flex justify-between"><span className="text-[#6b554d]">Avg CTR:</span><span className="font-mono font-semibold">{show(clickRate(p.metrics))}</span></div>
                    <div className="flex justify-between"><span className="text-[#6b554d]">Revenue:</span><span className="font-mono font-semibold text-emerald-800">{show(metricOf(p.metrics, 'revenue'))}</span></div>
                  </div>
                  <p className="text-[10px] text-[#8a7668] mt-2">{p.campaigns} campaign{p.campaigns === 1 ? '' : 's'} · {show(metricOf(p.metrics, 'delivered'))} delivered</p>
                </div>
              );
            })}
          </div>
        ) : (
          <NotInData need="Add a Program (or Program Name) column to your file to see results by program and journey." />
        )}
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <h3 className="text-base font-bold text-[#2d241d]">6. Content &amp; Creative Performance</h3>
        <p className="text-xs text-[#6b554d] mb-4">Engagement by creative format and messaging theme</p>
        <AiInsight reportId={r.meta.reportId} section="content" />
        {creative.length > 0 && (
          <div className="mb-5">
            <div className="text-xs font-bold text-[#2d241d] mb-2">By creative type</div>
            <DimensionBreakdown rows={creative} noun="creative type" />
          </div>
        )}
        {subjects.length > 0 && (
          <div>
            <div className="text-xs font-bold text-[#2d241d] mb-2">By subject line (messaging)</div>
            <DimensionBreakdown rows={subjects} noun="subject line" limit={8} />
          </div>
        )}
        {!creative.length && !subjects.length && (
          <NotInData need="Add a Creative Type or Subject Line column to your file to compare content. Campaign results above cover each campaign as a whole." />
        )}
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-bold text-[#2d241d]"><Clock className="w-4 h-4 text-[#C74634]" /> 7. Best Send Time &amp; Launch Windows</h3>
            <p className="text-xs text-[#6b554d]">Results by day of the week of the {r.source.timeBasis === 'event_time' ? 'activity' : 'launch'} date</p>
          </div>
          <span className="text-[10px] font-mono text-[#8a7668]">Day of week only</span>
        </div>
        <AiInsight reportId={r.meta.reportId} section="send_time" />
        {weekdays.length ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { t: 'Best Open Engagement Day', b: bestOpen, m: (w: (typeof weekdays)[number]) => show(openRate(w.metrics)), s: 'open rate' },
                { t: 'Best Click Engagement Day', b: bestClick, m: (w: (typeof weekdays)[number]) => show(clickRate(w.metrics)), s: 'click rate' },
                { t: 'Best Revenue Day', b: bestRevenue, m: (w: (typeof weekdays)[number]) => show(metricOf(w.metrics, 'revenue_per_delivered')), s: 'revenue per delivered message' },
              ].map((x) => (
                <div key={x.t} className="p-3 rounded-xl border border-[#e8dcc9] bg-white">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#8d563b]">{x.t}</div>
                  <div className="text-base font-bold font-mono text-[#2d241d] mt-1">{x.b ? x.b.w.label : 'Unavailable'}</div>
                  <div className="text-[11px] text-[#6b554d]">{x.b ? `${x.m(x.b.w)} ${x.s} · ${x.b.w.launches} launches` : 'Not in the source'}</div>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-[11px]">
                <thead className="text-left text-[#8a7668]"><tr><th className="py-1">Day</th><th>Launches</th><th>Delivered</th><th>Open rate</th><th>Click rate</th><th>Revenue</th></tr></thead>
                <tbody>
                  {weekdays.map((w) => (
                    <tr key={w.weekday} className="border-t border-[#efe3d6] font-mono">
                      <td className="py-1 font-sans font-semibold">{w.label}</td>
                      <td>{w.launches}</td>
                      <td>{show(metricOf(w.metrics, 'delivered'))}</td>
                      <td>{show(openRate(w.metrics))}</td>
                      <td>{show(clickRate(w.metrics))}</td>
                      <td>{show(metricOf(w.metrics, 'revenue'))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-[#8a7668] mt-2">Send hours are not in the file, so hourly windows cannot be shown. Few launches on a day make its rate less reliable.</p>
          </>
        ) : (
          <NotInData need="No launches in this period." />
        )}
      </section>

      <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-5 shadow-sm">
        <h3 className="flex items-center gap-2 text-base font-bold text-[#2d241d]"><Tag className="w-4 h-4 text-[#C74634]" /> 8. Offer &amp; Incentive Performance</h3>
        <p className="text-xs text-[#6b554d] mb-4">Subscriber response across promotional discount depths</p>
        <AiInsight reportId={r.meta.reportId} section="offer" />
        {offers.length ? (
          <DimensionBreakdown rows={offers} noun="offer" />
        ) : (
          <NotInData need="Add an Offer (or Discount / Incentive) column to your file to compare offers." />
        )}
      </section>

      <AiSummaryCard reportId={r.meta.reportId} sections={['recommendations']} id="ai-recommendations" />

      <RecommendationPlaybook
        recs={recs}
        periodLabel={label.split(' (')[0] ?? label}
        onSimulate={(ids) => onSimulateRecommendations(ids)}
        onOpenSimulator={onNavigateToSimulator}
        onAsk={onNavigateToChat}
      />

      {inspect && <EvidenceModal metric={inspect} evidence={r.evidence} source={r.source} onClose={() => setInspect(null)} />}
      {evIds && <EvidenceListModal ids={evIds} evidence={r.evidence} onClose={() => setEvIds(null)} />}
    </div>
  );
};
