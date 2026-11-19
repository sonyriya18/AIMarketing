/**
 * Compare Campaigns in the original layout: "VS 2" (head-to-head) and "VS Multiple"
 * (portfolio). All values come from the comparison report snapshot for the selected period.
 */
import React, { useEffect, useMemo } from 'react';
import { ArrowLeftRight, Check, CheckCircle2, Clock, FileDown, GitCompare, Layers, Mail, Radio, Server, Tag, Users, Workflow, Zap } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Account, CampaignListItem, CampaignReportResult, CampaignRow, ComparisonResult } from '../lib/types';
import { useReport } from '../lib/queries';
import { changeOf, clickRate, metricOf, money, num, openRate, show, showChange } from '../lib/metrics';
import { ErrorBox, Loading } from './ui';
import { NotInData } from './ExecutiveBriefing';
import type { Selection } from '../app/selection';
import { AiSummaryCard } from './AiSummary';

interface Props {
  account: Account;
  datasetId: string;
  period: Record<string, unknown> | undefined;
  campaigns: CampaignListItem[];
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  onReport: (r: ComparisonResult | null) => void;
  onSave: () => void;
}

const SCORE_METRICS = ['delivered', 'delivered_rate', 'OPEN', 'CLICK', 'unique_click_to_open_rate', 'conversion_event_rate', 'revenue', 'revenue_per_delivered', 'unsubscribe_rate', 'bounce_rate'];

const SaveBtn: React.FC<{ id: string; onClick: () => void; disabled?: boolean }> = ({ id, onClick, disabled }) => (
  <button id={id} onClick={onClick} disabled={disabled} className="inline-flex items-center space-x-2 bg-[#C74634] hover:bg-[#b03d2d] text-white px-4 py-2 rounded-xl text-xs font-semibold shadow-xs transition-all cursor-pointer shrink-0 disabled:opacity-50">
    <FileDown className="w-4 h-4" />
    <span>Save Report</span>
    <span className="text-[10px] bg-red-800/70 px-1.5 py-0.5 rounded text-red-100 font-mono">PDF</span>
  </button>
);

export const ComparativeBattlecard: React.FC<Props> = ({ account, datasetId, period, campaigns, sel, update, onReport, onSave }) => {
  const subTab = sel.compareMode;
  const ids = campaigns.map((c) => c.campaignId);
  const campA = sel.campaignId && ids.includes(sel.campaignId) ? sel.campaignId : ids[0] ?? null;
  const campB = sel.benchmarkId && ids.includes(sel.benchmarkId) && sel.benchmarkId !== campA ? sel.benchmarkId : ids.find((x) => x !== campA) ?? null;
  const multi = (sel.compareIds.length ? sel.compareIds : ids.slice(0, 3)).filter((x) => ids.includes(x)).slice(0, 10);

  const vs2Body = useMemo(
    () => (subTab === 'vs2' && campA && campB ? { accountId: account.id, datasetId, campaignIds: [campA, campB], baselineCampaignId: campB, period } : null),
    [subTab, account.id, datasetId, campA, campB, period]
  );
  const multiBody = useMemo(
    () => (subTab === 'multi' && multi.length >= 2 ? { accountId: account.id, datasetId, campaignIds: multi, baselineCampaignId: multi[0], period } : null),
    [subTab, account.id, datasetId, multi.join(","), period]
  );
  const cmp = useReport<ComparisonResult>('comparison', subTab === 'vs2' ? vs2Body : multiBody);
  const repA = useReport<CampaignReportResult>('campaign', subTab === 'vs2' && campA ? { accountId: account.id, datasetId, campaignId: campA, period, benchmark: { type: 'none' } } : null);
  const repB = useReport<CampaignReportResult>('campaign', subTab === 'vs2' && campB ? { accountId: account.id, datasetId, campaignId: campB, period, benchmark: { type: 'none' } } : null);
  useEffect(() => {
    onReport(cmp.data ?? null);
  }, [cmp.data, onReport]);

  const r = cmp.data;
  const rowOf = (id: string | null) => r?.campaigns.find((c) => c.campaignId === id);
  const A = rowOf(campA);
  const B = rowOf(campB);
  const listItem = (id: string | null) => campaigns.find((c) => c.campaignId === id);
  const name = (c: CampaignRow | undefined, id: string | null) => c?.name ?? listItem(id)?.name ?? '—';
  const short = (s: string) => (s.length > 22 ? `${s.slice(0, 20)}…` : s);
  const metricIdOf = (key: string, row?: CampaignRow) => (key === 'OPEN' ? openRate(row?.metrics)?.metricId ?? 'unique_open_rate' : key === 'CLICK' ? clickRate(row?.metrics)?.metricId ?? 'unique_click_rate' : key);

  if (campaigns.length < 2) {
    return <NotInData need="At least two campaigns are needed to compare. Upload a campaign file with more than one campaign." />;
  }

  const header = (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-gray-200 shadow-sm">
      <div className="flex items-center space-x-3">
        <div className="w-10 h-10 rounded-xl bg-red-50 text-[#C74634] flex items-center justify-center"><GitCompare className="w-5 h-5" /></div>
        <div>
          <div className="flex items-center space-x-2">
            <h2 className="text-base font-bold text-gray-950">Compare Campaigns</h2>
            <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-mono">{subTab === 'vs2' ? 'Head-to-Head Mode' : 'Portfolio Mode'}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{subTab === 'vs2' ? 'Head-to-head comparison between two campaigns with variance deltas' : `Multi-campaign performance analysis across ${multi.length} selected campaigns`}</p>
        </div>
      </div>
      <div className="flex items-center p-1 bg-gray-100 rounded-xl border border-gray-200 text-xs">
        <button id="subtab-vs2" onClick={() => update({ compareMode: 'vs2' })} className={`px-4 py-2 rounded-lg font-bold flex items-center space-x-2 transition-all cursor-pointer ${subTab === 'vs2' ? 'bg-white text-[#C74634] shadow-xs' : 'text-gray-600 hover:text-gray-900'}`}>
          <Users className="w-3.5 h-3.5" /> <span>VS 2</span>
        </button>
        <button id="subtab-vsmultiple" onClick={() => update({ compareMode: 'multi' })} className={`px-4 py-2 rounded-lg font-bold flex items-center space-x-2 transition-all cursor-pointer ${subTab === 'multi' ? 'bg-white text-[#C74634] shadow-xs' : 'text-gray-600 hover:text-gray-900'}`}>
          <Layers className="w-3.5 h-3.5" /> <span>VS Multiple</span>
        </button>
      </div>
    </div>
  );

  const engagementData = (rows: CampaignRow[]) => rows.map((c) => ({ name: short(c.name), open: num(openRate(c.metrics)), click: num(clickRate(c.metrics)) }));
  const revenueData = (rows: CampaignRow[]) => rows.map((c) => ({ name: short(c.name), revenue: num(c.metrics.revenue) }));
  const charts = (rows: CampaignRow[]) => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
        <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wider mb-1">Open Rate &amp; Click-Through Rate (%)</h4>
        <p className="text-[11px] text-gray-500 mb-3">Engagement comparison between the selected campaigns</p>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={engagementData(rows)} margin={{ top: 5, right: 10, left: -10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-10} textAnchor="end" />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => (v === null ? 'Unavailable' : `${Number(v).toFixed(2)}%`)} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar isAnimationActive={false} dataKey="open" name="Open Rate %" fill="#C74634" radius={[3, 3, 0, 0]} />
              <Bar isAnimationActive={false} dataKey="click" name="Click Rate %" fill="#10b981" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
        <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wider mb-1">Revenue Generation ({account.currency})</h4>
        <p className="text-[11px] text-gray-500 mb-3">Attributed revenue comparison between the selected campaigns</p>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={revenueData(rows)} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-10} textAnchor="end" />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => (v === null ? 'Unavailable' : money(Number(v), account.currency))} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar isAnimationActive={false} dataKey="revenue" name="Revenue" fill="#7c3aed" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );

  const status = (
    <>
      {cmp.isLoading && <Loading label="Building the comparison…" />}
      {cmp.error && <ErrorBox error={cmp.error} onRetry={() => cmp.refetch()} />}
      {r && !r.compatibility.compatible && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">Note: {r.compatibility.issues.join(' ')}</div>
      )}
    </>
  );

  if (subTab === 'vs2') {
    const latest = (rep: CampaignReportResult | undefined) => [...(rep?.launches ?? [])].sort((a, b) => (a.launchDate < b.launchDate ? 1 : -1))[0];
    const dates = (rep: CampaignReportResult | undefined) => {
      const l = [...(rep?.launches ?? [])].map((x) => x.launchDate).sort();
      return l.length ? (l.length === 1 ? l[0] : `${l[0]} – ${l[l.length - 1]} (${l.length} launches)`) : 'No launches in this period';
    };
    const diff = r?.differences.find((d) => d.campaignId === campA);
    const select = (which: 'A' | 'B') => {
      const value = which === 'A' ? campA : campB;
      const other = which === 'A' ? campB : campA;
      const row = which === 'A' ? A : B;
      const item = listItem(value);
      return (
        <div className={`w-full lg:w-5/12 rounded-xl p-3.5 border ${which === 'A' ? 'bg-red-50/50 border-red-200/80' : 'bg-blue-50/50 border-blue-200/80'}`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${which === 'A' ? 'text-[#C74634]' : 'text-blue-700'}`}>
              <span className={`w-2 h-2 rounded-full ${which === 'A' ? 'bg-[#C74634]' : 'bg-blue-600'}`} />
              {which === 'A' ? 'Campaign 1 (Target)' : 'Campaign 2 (Benchmark)'}
            </span>
            <span className="text-[10px] font-mono font-bold text-gray-500">{item?.externalId}</span>
          </div>
          <select
            id={which === 'A' ? 'select-campaign-1' : 'select-campaign-2'}
            value={value ?? ''}
            onChange={(e) => update(which === 'A' ? { campaignId: e.target.value } : { benchmarkId: e.target.value })}
            className="w-full bg-white border border-gray-300 text-gray-900 text-xs rounded-lg p-2.5 font-semibold focus:outline-none focus:ring-2 focus:ring-[#C74634]"
          >
            {campaigns.map((c) => (
              <option key={c.campaignId} value={c.campaignId} disabled={c.campaignId === other}>
                {c.name} ({c.program || c.externalId})
              </option>
            ))}
          </select>
          <div className="mt-2 flex items-center justify-between text-[11px] text-gray-600">
            <span>Channel: <strong>{item?.channel}</strong></span>
            <span>Rev: <strong className="text-emerald-700">{row ? show(row.metrics.revenue) : '…'}</strong></span>
            <span>Open: <strong className={which === 'A' ? 'text-[#C74634]' : 'text-blue-700'}>{row ? show(openRate(row.metrics)) : '…'}</strong></span>
          </div>
        </div>
      );
    };
    const tactical: { icon: React.ElementType; label: string; a: React.ReactNode; b: React.ReactNode }[] = [
      { icon: Clock, label: 'Send Dates', a: dates(repA.data), b: dates(repB.data) },
      { icon: Mail, label: 'Subject Line', a: latest(repA.data)?.subjectLine ? `"${latest(repA.data)!.subjectLine}"` : 'Not in the data', b: latest(repB.data)?.subjectLine ? `"${latest(repB.data)!.subjectLine}"` : 'Not in the data' },
      { icon: Tag, label: 'Offer & Incentive', a: <span className="text-gray-400">Not in the data</span>, b: <span className="text-gray-400">Not in the data</span> },
      { icon: Zap, label: 'Launch Frequency', a: `${A?.launchCount ?? '—'} launch(es) in period`, b: `${B?.launchCount ?? '—'} launch(es) in period` },
      { icon: Radio, label: 'Channel', a: A?.channel ?? '—', b: B?.channel ?? '—' },
      { icon: Workflow, label: 'Program Flow & Strategy', a: A?.program || 'Not in the data', b: B?.program || 'Not in the data' },
    ];
    return (
      <div className="space-y-6">
        {header}
        <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-gray-100">
            <div>
              <h3 className="text-sm font-bold text-gray-950 flex items-center gap-2"><Users className="w-4 h-4 text-[#C74634]" /> <span>VS 2 Campaign Comparison</span></h3>
              <p className="text-xs text-gray-500 mt-0.5">Select any two campaigns to analyze side-by-side performance variance for {r?.period?.label ?? 'the selected period'}</p>
            </div>
            <SaveBtn id="btn-save-report-vs2" onClick={onSave} disabled={!r} />
          </div>
          <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
            {select('A')}
            <button onClick={() => update({ campaignId: campB, benchmarkId: campA })} className="p-2.5 bg-gray-100 hover:bg-[#C74634] text-gray-600 hover:text-white rounded-full border border-gray-200 transition-all shadow-xs shrink-0 cursor-pointer" title="Swap Campaign 1 and Campaign 2" aria-label="Swap campaigns">
              <ArrowLeftRight className="w-4 h-4" />
            </button>
            {select('B')}
          </div>
          <div className="flex items-center space-x-2 text-xs text-gray-600 pt-3 mt-3 border-t border-gray-100">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Head-to-head evaluation: <strong className="text-[#C74634]">{name(A, campA)}</strong> vs <strong className="text-blue-700">{name(B, campB)}</strong></span>
          </div>
        </section>
        {status}
        {r && A && B && (
          <>
            <AiSummaryCard reportId={r.meta.reportId} sections={['executive', 'winner', 'differences', 'next_steps']} id="ai-comparison-summary" />
            {charts([A, B])}
            <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><GitCompare className="w-4 h-4 text-[#C74634]" /> Head-to-Head KPI Scorecard</h3>
                  <p className="text-xs text-[#6b554d]">Variance between Campaign 1 and Campaign 2 (Campaign 2 is the baseline)</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#f6ece1] text-[#6b554d] text-[10px] uppercase tracking-wider text-left">
                      <th className="p-3">Performance Metric</th><th className="p-3 text-[#C74634]">Campaign 1</th><th className="p-3 text-blue-700">Campaign 2</th><th className="p-3">Absolute Delta</th><th className="p-3">Shift %</th><th className="p-3">Leader</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {SCORE_METRICS.map((k) => {
                      const id = metricIdOf(k, A);
                      const c = changeOf(diff?.changes, id);
                      const a = metricOf(A.metrics, id);
                      const b = metricOf(B.metrics, id);
                      if (!a) return null;
                      const lead = c?.interpretation === 'better' ? 'Campaign 1' : c?.interpretation === 'worse' ? 'Campaign 2' : null;
                      return (
                        <tr key={k} className="border-t border-[#efe3d6]">
                          <td className="p-3 font-semibold text-[#2d241d]">{a.label}</td>
                          <td className="p-3 font-mono">{show(a)}</td>
                          <td className="p-3 font-mono">{show(b)}</td>
                          <td className={`p-3 font-mono font-semibold ${c?.interpretation === 'better' ? 'text-emerald-700' : c?.interpretation === 'worse' ? 'text-rose-700' : ''}`}>{c?.absoluteChange !== null && c ? showChange(c).split(' (')[0] : '—'}</td>
                          <td className="p-3 font-mono text-[#6b554d]">{c?.relativeChangePct ? `${Number(c.relativeChangePct).toFixed(1)}%` : '—'}</td>
                          <td className="p-3">{lead ? <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${lead === 'Campaign 1' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>{lead}</span> : <span className="text-[10px] text-gray-400">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5">
                <h3 className="text-base font-bold text-[#2d241d]">Tactical Variance Battlecard</h3>
                <p className="text-xs text-[#6b554d]">Operational settings from your data</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs bg-white">
                  <thead>
                    <tr className="bg-[#f6ece1] text-[#6b554d] text-[10px] uppercase tracking-wider text-left">
                      <th className="p-3 w-1/4">Campaign Attribute</th><th className="p-3 text-[#C74634]">Campaign 1: {name(A, campA)}</th><th className="p-3 text-blue-700">Campaign 2: {name(B, campB)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tactical.map((t) => (
                      <tr key={t.label} className="border-t border-[#efe3d6] align-top">
                        <td className="p-3 font-semibold text-[#2d241d]"><span className="inline-flex items-center gap-2"><t.icon className="w-3.5 h-3.5 text-[#C74634]" />{t.label}</span></td>
                        <td className="p-3">{t.a}</td>
                        <td className="p-3">{t.b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm p-5">
              <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><Clock className="w-4 h-4 text-[#C74634]" /> Hourly Results (Velocity Telemetry)</h3>
              <p className="text-xs text-[#6b554d] mb-3">Hour-by-hour comparison after dispatch</p>
              <NotInData need="Hourly opens and clicks are not in the file. Launch dates for both campaigns are listed in the battlecard above." />
            </section>
            <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm p-5">
              <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><Server className="w-4 h-4 text-[#C74634]" /> Mailbox Provider (ISP) Delivery Telemetry</h3>
              <p className="text-xs text-[#6b554d] mb-3">Side-by-side delivery by mailbox provider</p>
              <NotInData need="Delivery by mailbox provider (gmail.com, outlook.com…) is not imported. Overall delivery rates are compared in the scorecard above." />
            </section>
          </>
        )}
      </div>
    );
  }

  // VS Multiple
  const rows = r?.campaigns ?? [];
  const toggle = (id: string) => {
    const next = multi.includes(id) ? multi.filter((x) => x !== id) : [...multi, id];
    update({ compareIds: next.slice(0, 10) });
  };
  const battleRows: { label: string; value: (c: CampaignRow) => React.ReactNode }[] = [
    { label: 'Delivered (audience reached)', value: (c) => show(c.metrics.delivered) },
    { label: 'Launches in period', value: (c) => (c.launchCount === 0 || !c.firstLaunchDate ? '0 (none in this period)' : `${c.launchCount} (${c.firstLaunchDate === c.lastLaunchDate ? c.firstLaunchDate : `${c.firstLaunchDate} – ${c.lastLaunchDate}`})`) },
    { label: 'Channel', value: (c) => c.channel },
    { label: 'Delivery rate', value: (c) => show(c.metrics.delivered_rate) },
    { label: 'Open rate', value: (c) => show(openRate(c.metrics)) },
    { label: 'Click rate', value: (c) => show(clickRate(c.metrics)) },
    { label: 'Conversion event rate', value: (c) => show(c.metrics.conversion_event_rate) },
    { label: 'Revenue & revenue per delivered', value: (c) => `${show(c.metrics.revenue)} · ${show(c.metrics.revenue_per_delivered)}` },
    { label: 'Unsubscribe rate', value: (c) => show(c.metrics.unsubscribe_rate) },
    { label: 'Program', value: (c) => c.program || 'Not in the data' },
  ];
  return (
    <div className="space-y-6">
      {header}
      <section className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2"><Layers className="w-5 h-5 text-[#C74634]" /><h2 className="text-base font-bold text-gray-900">Multi-Campaign Performance Campaign Selection</h2></div>
            <p className="text-xs text-gray-500 mt-1">Select up to 10 campaigns to compare side by side ({multi.length} selected)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => update({ compareIds: ids.slice(0, Math.min(3, ids.length)) })} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-xs font-semibold text-gray-700 rounded-xl border border-gray-300">Select Top 3</button>
            <button onClick={() => update({ compareIds: ids.slice(0, 10) })} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-xs font-semibold text-gray-700 rounded-xl border border-gray-300">Select All ({Math.min(ids.length, 10)}{ids.length > 10 ? ' of ' + ids.length : ''})</button>
            <SaveBtn id="btn-save-report-vsmultiple" onClick={onSave} disabled={!r} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {campaigns.map((c) => {
            const on = multi.includes(c.campaignId);
            const row = rows.find((x) => x.campaignId === c.campaignId);
            return (
              <button key={c.campaignId} onClick={() => toggle(c.campaignId)} aria-pressed={on} className={`p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between cursor-pointer ${on ? 'bg-red-50/60 border-[#C74634] text-gray-900 shadow-sm ring-1 ring-[#C74634]' : 'bg-gray-50/60 border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded" style={{ backgroundColor: on ? '#fee2e2' : '#f3f4f6', color: on ? '#991b1b' : '#4b5563' }}>{c.externalId}</span>
                    <span className={`w-4 h-4 rounded-md flex items-center justify-center border ${on ? 'bg-[#C74634] border-[#C74634] text-white' : 'border-gray-300 bg-white'}`}>{on && <Check className="w-3 h-3" />}</span>
                  </div>
                  <div className="text-xs font-semibold text-gray-900 mt-2 line-clamp-2">{c.name}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{c.program || c.channel}</div>
                </div>
                <div className="mt-3 pt-2 border-t border-gray-200/80 flex justify-between text-[11px] text-gray-500">
                  {row ? (<><span>Rev: {show(row.metrics.revenue)}</span><span className="text-emerald-700 font-semibold">{show(openRate(row.metrics))} Open</span></>) : <span>{c.channel} · last {c.lastLaunchDate}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </section>
      {multi.length < 2 && <p className="text-xs text-gray-600">Select at least two campaigns.</p>}
      {status}
      {r && rows.length >= 2 && (
        <>
          <AiSummaryCard reportId={r.meta.reportId} sections={['executive', 'winner', 'differences', 'next_steps']} id="ai-comparison-summary" />
          {charts(rows)}
          <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm overflow-hidden">
            <div className="p-5">
              <h3 className="text-base font-bold text-[#2d241d]">Comparative Battlecard (Multi-Campaign)</h3>
              <p className="text-xs text-[#6b554d]">{r.period?.label}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs bg-white">
                <thead>
                  <tr className="bg-[#f6ece1] text-[#6b554d] text-[10px] uppercase tracking-wider text-left">
                    <th className="p-3">Attribute</th>
                    {rows.map((c) => <th key={c.campaignId} className="p-3 min-w-[140px]">{c.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {battleRows.map((b) => (
                    <tr key={b.label} className="border-t border-[#efe3d6]">
                      <td className="p-3 font-semibold text-[#2d241d]">{b.label}</td>
                      {rows.map((c) => <td key={c.campaignId} className="p-3 font-mono">{b.value(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="bg-[#fffaf5] border border-[#e8dcc9] rounded-2xl shadow-sm p-5">
            <h3 className="text-base font-bold text-[#2d241d] flex items-center gap-2"><Clock className="w-4 h-4 text-[#C74634]" /> Multi-Curve Hourly Velocity</h3>
            <NotInData need="Hourly opens and clicks are not in the file." />
          </section>
        </>
      )}
    </div>
  );
};
