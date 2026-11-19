/**
 * AI Simulator in the original eight-step layout:
 * Strategy → Audience → Actions → Program flow → Campaigns → Simulation → Outcomes → Create.
 *
 * Baselines (delivery, open, click, conversion rates, volumes, AOV) come from the period report.
 * Everything you change is an explicit assumption; projections run through the shared,
 * versioned scenario engine (planning-scenario) and are labelled as estimates — they are not
 * measured results, causal effects, or confidence intervals.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bell,
  BellRing,
  Calendar,
  CheckCircle2,
  DollarSign,
  Eye,
  GitBranch,
  HeartHandshake,
  LayoutTemplate,
  Mail,
  MessageSquare,
  MousePointerClick,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Account, CampaignRow, OverviewResult } from '../lib/types';
import { clickRate, count, metricOf, money, num, openRate, pct } from '../lib/metrics';
import { buildRecommendations, type Recommendation, type StrategyKey } from '../lib/recommendations';
import { runScenario, type ScenarioInputs } from '../../shared/scenario/engine';
import { estimateSendTime, WEEKDAYS } from '../../shared/scenario/send-time';
import { buildStrategyFlow, type FlowPlan } from '../features/planner/flow';
import { campaignObjects, journeyForFlow, programEdges, programObjects } from '../features/planner/details';
import { journeyFor } from '../../shared/scenario/journeys';
import { JourneyCampaigns } from './JourneyCampaigns';
import { ProgramFlowDiagram } from './ProgramFlowDiagram';
import { packFor } from '../content/packs';
import { withWebsiteOffer } from '../content/journeyTemplates';
import { usableWebsiteOffer } from '../../shared/business/offers';
import { WebsiteOfferPicker } from './WebsiteOfferPicker';
import type { CampaignTopic, TemplateChannel } from '../data/amilTemplates';
import { apiSend } from '../lib/api';
import { useConnectSummary, usePageSummary } from '../lib/queries';
import { NotInData } from './ExecutiveBriefing';
import type { BuilderInput } from './CampaignBuilder';
import type { SimulatorScenario } from '../app/askAi';
import { AiSummaryCard } from './AiSummary';

interface Props {
  account: Account;
  report: OverviewResult;
  initialRecIds: string[];
  canSave: boolean;
  onNavigateToSummary: () => void;
  onCreate: (input: Omit<BuilderInput, 'account'>) => void;
  /** The current scenario, so Ask AI can discuss it (assumptions, not measured data). */
  onScenarioChange?: (s: SimulatorScenario | null) => void;
}

interface Strategy {
  key: StrategyKey;
  name: string;
  goal: string;
  color: string;
  icon: React.ElementType;
  kpiChip: string;
  kpi: string;
  topic: CampaignTopic;
  plan: Omit<FlowPlan, 'audienceName'>;
  action: string;
  chips: string[];
}

const STRATEGIES: Strategy[] = [
  { key: 'engagement', name: 'Engagement Boost', goal: 'Lift opens & clicks', color: '#3b5bdb', icon: Zap, kpiChip: '↑ Open · ↑ CTR', kpi: 'Open & click rate', topic: 'promo', plan: { suppressionRule: 'Exclude bounced & unsubscribed', first: 'email', waitDays: 2, decisionMetric: 'opened', followUp: 'email' }, action: 'Target', chips: ['Send Time Optimization', 'Subject line A/B', '1 primary CTA', 'Exclude bounced'] },
  { key: 'cart', name: 'Cart Recovery', goal: 'Recover abandoned carts', color: '#e03131', icon: ShoppingCart, kpiChip: '↑ Conversion', kpi: 'Conversion rate', topic: 'cart', plan: { suppressionRule: 'Exclude recent purchasers', first: 'email', waitDays: 1, decisionMetric: 'converted', followUp: 'sms' }, action: 'Recover', chips: ['Dynamic cart block', '24h reminder', 'SMS follow-up', 'Exclude converters'] },
  { key: 'retention', name: 'Retention & Loyalty', goal: 'Keep customers longer', color: '#d6336c', icon: HeartHandshake, kpiChip: '↓ Unsubs', kpi: 'Unsubscribe rate', topic: 'prefs', plan: { suppressionRule: 'Frequency cap 3 / 72h', first: 'email', waitDays: 3, decisionMetric: 'clicked', followUp: 'none' }, action: 'Retain', chips: ['Frequency cap', 'Preference centre', 'Loyalty content'] },
  { key: 'hygiene', name: 'List Hygiene', goal: 'Protect deliverability', color: '#495057', icon: ShieldCheck, kpiChip: '↓ Bounce · ↑ Inbox', kpi: 'Bounce & delivery rate', topic: 'prefs', plan: { suppressionRule: 'Suppress hard bounces & inactive', first: 'email', waitDays: 7, decisionMetric: 'opened', followUp: 'none' }, action: 'Clean', chips: ['Suppress hard bounces', 'Re-permission inactive', 'Check SPF/DKIM'] },
  { key: 'reengage', name: 'Re-engagement', goal: 'Wake up inactive users', color: '#7048e8', icon: RefreshCw, kpiChip: '↑ Reactivation', kpi: 'Open rate of inactive contacts', topic: 'winback', plan: { suppressionRule: 'No open in 90 days', first: 'email', waitDays: 5, decisionMetric: 'opened', followUp: 'push' }, action: 'Nurture', chips: ['Max 1 / week', 'Personal picks', 'Exit if no response'] },
  { key: 'revenue', name: 'Revenue Growth', goal: 'Upsell & cross-sell', color: '#2b8a3e', icon: TrendingUp, kpiChip: '↑ Revenue / email', kpi: 'Revenue per delivered message', topic: 'upsell', plan: { suppressionRule: 'Exclude bounced & unsubscribed', first: 'email', waitDays: 3, decisionMetric: 'clicked', followUp: 'push' }, action: 'Upsell', chips: ['Recommended products', 'Tiered offer', 'High-intent segment'] },
  { key: 'welcome', name: 'Welcome & Onboarding', goal: 'Convert new sign-ups', color: '#1098ad', icon: UserPlus, kpiChip: '↑ First order', kpi: 'Conversion of new contacts', topic: 'welcome', plan: { suppressionRule: 'Opted in within 30 days', first: 'email', waitDays: 2, decisionMetric: 'clicked', followUp: 'email' }, action: 'Onboard', chips: ['Welcome offer', '3-step series', 'Preference capture'] },
  { key: 'winback', name: 'Win-back', goal: 'Recover lapsed buyers', color: '#e8590c', icon: BellRing, kpiChip: '↑ Returning buyers', kpi: 'Returning buyer rate', topic: 'winback', plan: { suppressionRule: 'No purchase in 180 days', first: 'email', waitDays: 4, decisionMetric: 'converted', followUp: 'sms' }, action: 'Win back', chips: ['Come-back incentive', 'Last-chance reminder', 'Sunset if no response'] },
];

const STEPS = [
  { id: 'wi-strategy', label: 'Strategy', icon: Sparkles },
  { id: 'wi-audience', label: 'Audience', icon: Users },
  { id: 'wi-actions', label: 'Actions', icon: Zap },
  { id: 'wi-flow', label: 'Program flow', icon: GitBranch },
  { id: 'wi-campaigns', label: 'Campaigns', icon: LayoutTemplate },
  { id: 'wi-simulation', label: 'Simulation', icon: TrendingUp },
  { id: 'wi-outcomes', label: 'Outcomes', icon: CheckCircle2 },
  { id: 'wi-create', label: 'Create', icon: Rocket },
];

const EstimatedBadge = () => (
  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[11px] font-bold" title="Projection from your assumptions — not measured results">
    <Sparkles className="w-3 h-3" /> Estimated
  </span>
);

const Stage: React.FC<{ id: string; n: number; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }> = ({ id, n, title, hint, right, children }) => (
  <section id={id} className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-4 sm:p-5 shadow-sm scroll-mt-40">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-full bg-[#2d241d] text-white text-xs font-bold flex items-center justify-center">{n}</span>
        <div>
          <h3 className="text-base font-bold text-[#2d241d] leading-tight">{title}</h3>
          {hint && <p className="text-[11px] text-[#6b554d]">{hint}</p>}
        </div>
      </div>
      {right}
    </div>
    {children}
  </section>
);

const ScoreRing: React.FC<{ value: number; color: string; label: string }> = ({ value, color, label }) => {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="28" cy="28" r={r} fill="none" stroke="#eef0f4" strokeWidth="5" />
      <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} transform="rotate(-90 28 28)" />
      <text x="28" y="33" textAnchor="middle" fontSize="15" fontWeight="700" fill="#1f2937">{value}</text>
    </svg>
  );
};

const ParamCard: React.FC<{ icon: React.ElementType; label: string; display: string; caption: string; baseLabel: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }> = ({ icon: Icon, label, display, caption, baseLabel, min, max, step, value, onChange }) => {
  const p = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <label className="block rounded-xl bg-[#faf6f1] border border-[#eadfd2] p-3">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2d241d]"><Icon className="w-4 h-4 text-[#6b554d]" /> {label}</span>
        <span className="font-mono text-[12px] font-bold text-[#C74634] bg-white border border-[#eadfd2] rounded-md px-2 py-0.5">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full accent-[#C74634] cursor-pointer" style={{ background: `linear-gradient(to right, #b03d2d ${p}%, #e5e0da ${p}%)`, height: 6, borderRadius: 3, appearance: 'none' }} />
      <div className="flex justify-between text-[10px] mt-1.5">
        <span className="text-[#8a7668]">{caption}</span>
        <span className="text-emerald-700 font-semibold shrink-0 ml-2">Data: {baseLabel}</span>
      </div>
    </label>
  );
};

/** Non-negative decimal string accepted by the scenario engine (no exponent). */
const dec = (n: number, dp = 8) => {
  const v = Math.max(0, Number.isFinite(n) ? n : 0);
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
};
const prob = (n: number) => dec(Math.min(1, Math.max(0, n)));
const channelOf = (c: string): TemplateChannel => (/sms/i.test(c) ? 'SMS' : /push|app/i.test(c) ? 'WebPush' : 'Email');

interface Baseline {
  label: string;
  campaignId: string | null;
  deliveredRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  bounceRate: number | null;
  convRate: number | null;
  aov: number | null;
  aovSource: string;
  ordersPerConverter: number;
  sent: number | null;
  unsubscribes: number | null;
  complaints: number | null;
  bounces: number | null;
  channel: TemplateChannel;
}

function baselineFrom(label: string, campaignId: string | null, m: Record<string, any> | any[], channel: TemplateChannel): Baseline {
  const g = (id: string) => num(metricOf(m as any, id));
  const orders = g('orders');
  const conv = g('conversion_events');
  const revenue = g('revenue');
  const aov = g('average_order_value');
  return {
    label,
    campaignId,
    deliveredRate: g('delivered_rate'),
    openRate: num(openRate(m as any)),
    clickRate: num(clickRate(m as any)),
    bounceRate: g('bounce_rate'),
    convRate: g('conversion_event_rate'),
    aov: aov ?? (revenue !== null && conv ? revenue / conv : null),
    aovSource: aov !== null ? 'average order value' : revenue !== null && conv ? 'revenue per conversion event' : 'not in the data',
    ordersPerConverter: orders !== null && conv ? Math.max(0, orders / conv) : 1,
    sent: g('sent'),
    unsubscribes: g('unsubscribes'),
    complaints: g('complaints'),
    bounces: g('bounces'),
    channel,
  };
}

export const WhatIfSimulator: React.FC<Props> = ({ account, report: r, initialRecIds, canSave, onNavigateToSummary, onCreate, onScenarioChange }) => {
  const connect = useConnectSummary(account.id, r.period?.startDate, r.period?.endDateExclusive);
  const allRecs = useMemo(() => buildRecommendations(r, connect.data), [r, connect.data]);
  const planRecs = initialRecIds.length ? allRecs.filter((x) => initialRecIds.includes(x.id)) : allRecs;
  const totals = useMemo(() => Object.fromEntries(r.totals.map((t) => [t.metricId, t.current])), [r.totals]);
  const mainChannel = channelOf([...r.byChannel].sort((a, b) => (num(metricOf(b.metrics, 'delivered')) ?? 0) - (num(metricOf(a.metrics, 'delivered')) ?? 0))[0]?.channel ?? 'Email');

  // The AI picks a strategy from this period's facts (same call as the AI Strategy Brief). Without it,
  // strategies are ranked by rules: how many of the plan's issues each one addresses.
  const brief = usePageSummary(r.meta.reportId, 'simulator');
  const businessStrategies = brief.data?.businessStrategies;
  const rawPick = brief.data?.strategyPick ?? null;
  const pickedBusiness = businessStrategies?.find((s) => s.strategyKey === rawPick?.strategyKey);
  const aiPick = rawPick && (!businessStrategies?.length || pickedBusiness) ? { ...rawPick, name: pickedBusiness?.name ?? rawPick.name } : null;
  const strategies = useMemo(() => STRATEGIES.filter((s) => !businessStrategies?.length || businessStrategies.some((x) => x.strategyKey === s.key)).map((s) => {
    const tailored = businessStrategies?.find((x) => x.strategyKey === s.key);
    const dentalKpis: Partial<Record<StrategyKey, string>> = { engagement: '↑ Dental-plan clicks', revenue: '↑ Plan enquiries', welcome: '↑ Member activation', retention: '↓ Opt-outs', reengage: '↑ Renewed interest', hygiene: '↓ Bounce · ↑ Delivery' };
    const dental = tailored?.generator === 'rule_based';
    return tailored ? { ...s, name: tailored.name, goal: tailored.goal, chips: tailored.actions, ...(dental ? { kpiChip: dentalKpis[s.key] ?? s.kpiChip, kpi: dentalKpis[s.key] ?? s.kpi, ...(s.key === 'revenue' ? { topic: 'promo' as const } : {}) } : {}), plan: { ...s.plan, suppressionRule: 'Exclude bounced and unsubscribed contacts; validate audience eligibility and consent' } } : s;
  }), [businessStrategies]);
  const ranked = useMemo(() => {
    const scored = strategies.map((s, i) => ({ s, fixes: planRecs.filter((x) => x.strategy === s.key).length, i, ai: s.key === aiPick?.strategyKey }));
    return scored.sort((a, b) => Number(b.ai) - Number(a.ai) || b.fixes - a.fixes || a.i - b.i);
  }, [planRecs, aiPick, strategies]);
  const topLabel = aiPick ? 'AI pick' : ranked[0]!.fixes > 0 ? 'Top match (rules)' : null;
  const [chosenKey, setChosenKey] = useState<StrategyKey | null>(null);
  const strategyKey = chosenKey && strategies.some((s) => s.key === chosenKey) ? chosenKey : ranked[0]!.s.key;
  const setStrategyKey = (k: StrategyKey) => { setChosenKey(k); setCampaignId(null); setTemplateId(null); };
  const strategy = strategies.find((s) => s.key === strategyKey)!;
  const businessStrategy = businessStrategies?.find((s) => s.strategyKey === strategyKey);
  const strategyRecs = planRecs.filter((x) => x.strategy === strategyKey);

  // Baseline choices: the account totals for the period, or one of your campaigns.
  const similar = useMemo(
    () =>
      [...r.campaigns]
        .filter((c) => (num(c.metrics.delivered) ?? 0) > 0)
        .sort((a, b) => (num(clickRate(b.metrics)) ?? -1) - (num(clickRate(a.metrics)) ?? -1))
        .slice(0, 3),
    [r.campaigns]
  );
  const accountBase = useMemo(() => baselineFrom('All campaigns in the period', null, totals, mainChannel), [totals, mainChannel]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const baseCampaign: CampaignRow | undefined = similar.find((c) => c.campaignId === baseId);
  const base = useMemo(() => baseCampaign ? baselineFrom(baseCampaign.name, baseCampaign.campaignId, baseCampaign.metrics, channelOf(baseCampaign.channel)) : accountBase, [baseCampaign, accountBase]);

  const pack = packFor(account);
  const journeyDefinition = useMemo(() => journeyFor(strategyKey, pack.id === 'starter' ? 'general' : 'dental'), [strategyKey, pack.id]);
  const flow = useMemo(() => buildStrategyFlow(journeyDefinition, strategy.name), [strategy.name, journeyDefinition]);
  const journey = useMemo(() => journeyForFlow(journeyDefinition, flow), [journeyDefinition, flow]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const selectedCampaign = campaignObjects(flow, journey).find((item) => item.campaign.id === campaignId)?.campaign ?? null;
  const [offerChoice, setOfferChoice] = useState({ campaignId: '', id: '', confirmed: false });
  const websiteOffers = brief.data?.businessContext?.status === 'ready' ? brief.data.businessContext.offers ?? [] : [];
  const selectedOffer = offerChoice.campaignId === selectedCampaign?.id && offerChoice.confirmed ? websiteOffers.find((offer) => offer.id === offerChoice.id && usableWebsiteOffer(offer, strategyKey)) : undefined;
  const templates = selectedCampaign ? pack.templates.filter((t) => t.channel === 'Email' && t.journeyCampaignId === selectedCampaign.id).map((t) => withWebsiteOffer(t, selectedOffer, strategyKey)) : [];
  const [templateId, setTemplateId] = useState<string | null>(null);
  const template = templates.find((t) => t.id === templateId) ?? templates[0] ?? null;

  // Opt-outs (unsubscribes, complaints) in the baseline are removed from the default audience when
  // "exclude" is on. Bounces are not subtracted: the delivery rate already accounts for them.
  const [excludeOptOuts, setExcludeOptOuts] = useState(true);
  const optOuts = (base.unsubscribes ?? 0) + (base.complaints ?? 0);
  const excluded = excludeOptOuts ? Math.min(optOuts, Math.round(base.sent ?? 0)) : 0;
  const defaultAudience = Math.max(0, Math.round(base.sent ?? 0) - excluded);
  const [aud, setAud] = useState<number | null>(null);
  const [launchWeekday, setLaunchWeekday] = useState<number | null>(null);
  const [launchTime, setLaunchTime] = useState('');
  const estimate = useMemo(() => estimateSendTime((r.sendTime ?? []).map((row) => ({ ...row, channel: channelOf(row.channel) })), base.channel, {
    open: base.openRate, click: base.clickRate,
    openMetricId: openRate(baseCampaign?.metrics ?? totals)?.metricId ?? null,
    clickMetricId: clickRate(baseCampaign?.metrics ?? totals)?.metricId ?? null,
  }, launchWeekday, launchTime), [r.sendTime, base.channel, base.openRate, base.clickRate, baseCampaign, totals, launchWeekday, launchTime]);
  const scheduleLabel = `${launchWeekday === null ? (estimate.weekday ? WEEKDAYS[estimate.weekday - 1] : 'No weekday selected') : WEEKDAYS[launchWeekday - 1]} ${launchTime || (estimate.hour === null ? '(hour unavailable)' : `${String(estimate.hour).padStart(2, '0')}:00`)} (${account.timezone})`;
  const [saveState, setSaveState] = useState<{ busy: boolean; msg: string | null; error: string | null }>({ busy: false, msg: null, error: null });
  const audience = aud ?? defaultAudience;
  const aov = base.aov ?? 0;
  const reset = () => {
    setAud(null);
    setLaunchWeekday(null);
    setLaunchTime('');
  };

  const missing: string[] = [];
  if (base.deliveredRate === null) missing.push('delivery rate');
  if (base.convRate === null) missing.push('conversion rate');
  if (!aov) missing.push('order value');
  const canSimulate = audience > 0 && missing.length === 0;

  const inputs: ScenarioInputs | null = useMemo(() => {
    if (!canSimulate) return null;
    const d = base.deliveredRate! / 100;
    const v = base.convRate! / 100;
    const same = (x: string, source: string, note?: string) => ({ low: x, base: x, high: x, source, ...(note ? { note } : {}) });
    return {
      currency: account.currency,
      eligibleAudience: same(String(Math.round(audience)), aud !== null ? 'user_assumption' : excluded > 0 ? 'baseline:sent_minus_opt_outs' : 'baseline:sent', aud === null && excluded > 0 ? `Messages sent minus ${excluded} unsubscribes and complaints` : undefined),
      deliveryProbability: same(prob(d), 'baseline:delivered_rate'),
      conversionProbability: same(prob(v), 'baseline:conversion_event_rate', 'Baseline conversion held constant; send-time engagement does not establish a conversion uplift.'),
      ordersPerConverter: same(dec(base.ordersPerConverter, 4), base.ordersPerConverter === 1 ? 'user_assumption' : 'baseline:orders_per_conversion'),
      netOrderValue: same(dec(aov, 2), `baseline:${base.aovSource.replace(/ /g, '_')}`),
      variableCostPerOrder: null,
      campaignCost: null,
      baselineConversionProbability: same(prob(v), 'baseline:conversion_event_rate'),
      launchSchedule: { weekday: launchWeekday ?? estimate.weekday, time: launchTime || (estimate.hour === null ? null : `${String(estimate.hour).padStart(2, '0')}:00`), timezone: account.timezone, basis: estimate.basis, expectedOpenRate: estimate.open, expectedClickRate: estimate.click },
    } as ScenarioInputs;
  }, [canSimulate, base, audience, aud, excluded, aov, account.currency, account.timezone, launchWeekday, launchTime, estimate]);

  const sim = useMemo(() => {
    if (!inputs) return null;
    try {
      return runScenario(inputs);
    } catch {
      return null;
    }
  }, [inputs]);

  const projected = {
    open: estimate.open,
    click: estimate.click,
    bounce: base.bounceRate,
    conv: base.convRate,
  };
  const delivered = audience * ((base.deliveredRate ?? 0) / 100);
  const funnel = [
    { stage: 'Delivered', current: delivered, projected: delivered },
    { stage: 'Opens', current: base.openRate === null ? null : (delivered * base.openRate) / 100, projected: projected.open === null ? null : (delivered * projected.open) / 100 },
    { stage: 'Clicks', current: base.clickRate === null ? null : (delivered * base.clickRate) / 100, projected: projected.click === null ? null : (delivered * projected.click) / 100 },
    { stage: 'Conversions', current: base.convRate === null ? null : (delivered * base.convRate) / 100, projected: projected.conv === null ? null : (delivered * projected.conv) / 100 },
  ];
  const currentRevenue = sim ? Number(sim.cases.base.expectedRevenue) - Number(sim.cases.base.incrementalRevenue ?? 0) : null;
  const lift = sim?.cases.base.incrementalRevenue ? Number(sim.cases.base.incrementalRevenue) : null;

  const audienceBasis = aud !== null ? 'your own number' : excluded > 0 ? `messages sent (${base.label}) minus ${count(excluded)} unsubscribes and complaints` : `messages sent (${base.label})`;
  const programText = flow.summary ?? programObjects(flow).map((node) => node.title).join(' → ');

  // Share the scenario on screen with Ask AI (assumptions and estimates, labelled as such there).
  useEffect(() => {
    if (!onScenarioChange) return;
    const n = (v: string | undefined) => Number(v ?? 0);
    onScenarioChange({
      reportId: r.meta.reportId,
      strategy: strategy.name,
      template: template?.name ?? null,
      baseline: base.label,
      channel: base.channel,
      currency: account.currency,
      audience: Math.round(audience),
      audienceBasis,
      openMultiplier: 1,
      clickMultiplier: 1,
      averageOrderValue: Math.round(aov * 100) / 100,
      rangePct: 0,
      launchSchedule: scheduleLabel,
      estimateBasis: estimate.basis,
      expectedOpenRate: estimate.open,
      expectedClickRate: estimate.click,
      outcome: sim
        ? {
            delivered: Math.round(n(sim.cases.base.expectedDelivered)),
            conversions: Math.round(n(sim.cases.base.expectedConverters)),
            conversionsLow: Math.round(n(sim.cases.low.expectedConverters)),
            conversionsHigh: Math.round(n(sim.cases.high.expectedConverters)),
            revenue: Math.round(n(sim.cases.base.expectedRevenue)),
            revenueLow: Math.round(n(sim.cases.low.expectedRevenue)),
            revenueHigh: Math.round(n(sim.cases.high.expectedRevenue)),
            baselineRevenue: currentRevenue === null ? null : Math.round(currentRevenue),
          }
        : null,
    });
  }, [onScenarioChange, r.meta.reportId, strategy.name, template?.name, base.label, base.channel, account.currency, audience, audienceBasis, scheduleLabel, estimate.basis, estimate.open, estimate.click, aov, sim, currentRevenue]);

  const reachShare = r.byChannel.map((c) => ({ ch: c.channel, d: num(metricOf(c.metrics, 'delivered')) ?? 0 }));
  const reachTotal = reachShare.reduce((s, x) => s + x.d, 0);

  const save = async () => {
    if (!inputs) return;
    setSaveState({ busy: true, msg: null, error: null });
    try {
      await apiSend('POST', '/scenarios', { accountId: account.id, name: `${strategy.name} · ${template?.name ?? base.channel} · ${r.period?.label ?? ''}`.slice(0, 160), baselineReportId: r.meta.reportId, inputs });
      setSaveState({ busy: false, msg: 'Scenario saved with its assumptions and the report it is based on.', error: null });
    } catch (e) {
      setSaveState({ busy: false, msg: null, error: (e as Error).message });
    }
  };

  const fmtM = (v: number | null) => money(v, account.currency, 0);
  const lbl = r.period?.label ?? 'Selected period';

  return (
    <div className="space-y-5 text-[#2d241d]">
      <div className="rounded-2xl bg-[#2d241d] text-white p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight">AI Simulator</h2>
            <p className="text-xs text-[#d9c6b4] flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> {lbl} · baseline from {r.source.datasetName}</p>
          </div>
          <button onClick={onNavigateToSummary} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 cursor-pointer">Back to Summary</button>
        </div>
        <nav className="flex gap-1 overflow-x-auto pt-1" aria-label="Simulator steps">
          {STEPS.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-[11px] font-semibold">
              <s.icon className="w-3.5 h-3.5 text-[#f0a08f]" />
              <span className="text-white/60">{i + 1}</span>
              {s.label}
              {i < STEPS.length - 1 && <ArrowRight className="w-3 h-3 text-white/30 ml-1" />}
            </a>
          ))}
        </nav>
        {initialRecIds.length > 0 && <p className="text-[11px] text-[#d9c6b4]">Plan from Summary: {planRecs.length} action{planRecs.length === 1 ? '' : 's'} selected.</p>}
      </div>

      <AiSummaryCard reportId={r.meta.reportId} focus="simulator" sections={['executive', 'opportunities', 'risks', 'what_to_test']} id="ai-strategy-brief" />

      <Stage
        id="wi-strategy"
        n={1}
        title="AI Marketing Strategy"
        hint={businessStrategies?.length ? `Strategies for ${account.name} using official website context and ${lbl.split(' (')[0]} report evidence. Select a strategy to build a proposed plan.` : aiPick ? `AI pick from ${lbl.split(' (')[0]} report data · pick one to build the rest` : "General strategies ranked by report issues. Business-specific strategies appear when website context and AI are available."}
        right={topLabel ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#3b5bdb] text-white text-[11px] font-bold" title={aiPick ? aiPick.reason : 'Rule-based ranking (the AI pick appears when the AI Strategy Brief is written by AI)'}><Sparkles className="w-3 h-3" /> {topLabel}: {ranked[0]!.s.name}</span> : undefined}
      >
        {businessStrategies?.some((s) => s.generator === 'rule_based') && <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-900" id="business-strategy-source">
          <strong>Website-informed dental strategies.</strong> These plans use the dental business described on the official website and the report signals shown in each rationale. They are written by rules because the AI did not provide a validated strategy list.
        </div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 pt-2">
          {ranked.map(({ s, fixes }, i) => {
            const Icon = s.icon;
            const selected = s.key === strategyKey;
            const coverage = planRecs.length ? Math.round((fixes / planRecs.length) * 100) : 0;
            return (
              <div
                key={s.key}
                data-strategy={s.key}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => { setStrategyKey(s.key); setTemplateId(null); }}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setStrategyKey(s.key), setTemplateId(null))}
                className={`relative text-left rounded-2xl bg-white p-4 border-2 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C74634] ${selected ? 'shadow-lg' : 'border-[#ece6df] hover:border-[#d9cfc4] hover:shadow-sm'}`}
                style={selected ? { borderColor: s.color } : undefined}
              >
                {i === 0 && topLabel && <span className="absolute -top-3 left-4 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#3b5bdb] text-white text-[11px] font-bold shadow"><Sparkles className="w-3 h-3" /> {topLabel}</span>}
                <div className="flex items-start justify-between gap-2">
                  <span className="w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-sm" style={{ backgroundColor: s.color }}><Icon className="w-6 h-6" /></span>
                  <ScoreRing value={coverage} color={s.color} label={`Addresses ${coverage}% of the issues in your plan`} />
                </div>
                <div className="mt-2.5 font-bold text-[16px] text-[#1f2937] leading-tight">{s.name}</div>
                <div className="text-[12px] text-[#8b8f98]">{s.goal}</div>
                <div className="mt-1 text-[10px] font-semibold text-violet-700">{businessStrategies?.some((x) => x.strategyKey === s.key) ? businessStrategies.find((x) => x.strategyKey === s.key)?.generator === 'rule_based' ? 'Website + report · Rules' : 'Website + report · AI' : 'General strategy · validate business fit'}</div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="text-[11px] font-semibold px-2 py-1 rounded-md bg-[#f3f4f6] text-[#4b5563]">{s.kpiChip}</span>
                  {fixes > 0 && <span className="text-[11px] font-semibold px-2 py-1 rounded-md bg-rose-50 text-rose-600">Fixes {fixes} flaw{fixes > 1 ? 's' : ''}</span>}
                  <a href="#wi-flow" onClick={(e) => { e.stopPropagation(); setStrategyKey(s.key); }} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100"><GitBranch className="w-3 h-3" /> Program</a>
                </div>
              </div>
            );
          })}
        </div>
        {businessStrategy && <div className="mt-4 rounded-xl border border-violet-200 bg-white p-3 text-xs text-[#4d4039]">
          <p><strong>Business rationale:</strong> {businessStrategy.reason}</p>
          <ul className="list-disc pl-4 mt-2 space-y-1">{businessStrategy.actions.map((action) => <li key={action}>{action}</li>)}</ul>
          <details className="mt-2"><summary className="cursor-pointer text-violet-700">Website and report evidence</summary>
            <ul className="mt-2 space-y-1">{brief.data?.facts.filter((f) => businessStrategy.factIds.includes(f.id)).map((f) => <li key={f.id}>{f.text}</li>)}</ul>
          </details>
        </div>}
        {aiPick ? (
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 text-[11px] text-[#4d4039]" id="ai-strategy-pick">
            <span className="font-bold text-violet-900">Why the AI picked {aiPick.name}:</span> {aiPick.reason}
            <span className="ml-1 text-[10px] text-violet-700">· based on {aiPick.factIds.length} fact{aiPick.factIds.length === 1 ? '' : 's'} from {lbl.split(' (')[0]}, checked against the report</span>
          </div>
        ) : (
          <p className="mt-3 text-[10px] text-[#8a7668]" id="ai-strategy-pick">{brief.isLoading ? 'The AI is choosing a strategy from this period’s data…' : businessStrategies?.length ? 'Rule-based ranking: dental plans are prioritized by how many of the measured report issues they address.' : 'Rule-based ranking: the AI pick appears here when the AI Strategy Brief above is written by AI.'}</p>
        )}
        <div className="mt-4 rounded-2xl bg-white border border-[#ece6df] overflow-hidden grid grid-cols-1 lg:grid-cols-[220px_1fr_1fr_1.3fr_auto]">
          <div className="p-3 text-white flex flex-col justify-end min-h-[110px]" style={{ background: `linear-gradient(120deg, ${strategy.color}f2 10%, ${strategy.color}aa 70%)` }}>
            <strategy.icon className="w-5 h-5 mb-1" />
            <div className="text-[10px] uppercase tracking-wider text-white/80 font-bold">Selected plan</div>
            <div className="font-bold leading-tight">{strategy.name}</div>
          </div>
          <div className="p-3 border-b lg:border-b-0 lg:border-r border-[#f0e6dc]">
            <div className="text-[10px] font-bold text-[#8a7668] uppercase tracking-wide mb-1.5 flex items-center gap-1"><Users className="w-3 h-3" /> Audience · {count(audience)}</div>
            <div className="text-[11px] text-[#5f4d42]">{aud === null ? `Messages sent in ${lbl.split(' (')[0]}${excluded > 0 ? ` minus ${count(excluded)} opt-outs` : ''} (${base.label})` : 'Your audience assumption (messages)'}</div>
          </div>
          <div className="p-3 border-b lg:border-b-0 lg:border-r border-[#f0e6dc]">
            <div className="text-[10px] font-bold text-[#8a7668] uppercase tracking-wide mb-1.5 flex items-center gap-1"><GitBranch className="w-3 h-3" /> Responsys program</div>
            <p className="text-[11px] text-[#5f4d42]">{flow.summary}</p>
          </div>
          <div className="p-3 border-b lg:border-b-0 lg:border-r border-[#f0e6dc]">
            <div className="text-[10px] font-bold text-[#8a7668] uppercase tracking-wide mb-1.5 flex items-center gap-1"><LayoutTemplate className="w-3 h-3" /> Campaigns &amp; templates</div>
            <div className="text-[11px] text-[#5f4d42]">{template ? `${template.name} (${template.channel})` : 'Choose a program campaign and template in step 5'}</div>
            <div className="text-[10px] text-[#8a7668]">Baseline: {base.label}</div>
          </div>
          <div className="p-3 flex lg:flex-col items-center lg:items-end justify-between lg:justify-center gap-1">
            <span className="text-[10px] text-[#8a7668]">Est. lift</span>
            <span className="text-lg font-bold font-mono text-emerald-700">{lift === null ? '—' : `${lift >= 0 ? '+' : ''}${fmtM(lift)}`}</span>
            <span className="text-[10px] text-[#8a7668]">KPI: {strategy.kpi}</span>
          </div>
        </div>
      </Stage>

      <Stage id="wi-audience" n={2} title="Recommended Audience" hint={`A message count, not unique people: ${count(base.sent)} messages sent in ${lbl.split(' (')[0]} (${base.label})${excluded > 0 ? `, minus ${count(excluded)} opt-outs` : ''}`} right={<EstimatedBadge />}>
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
          <div className="rounded-xl bg-white border border-[#e8dcc9] p-4 flex flex-col items-center">
            <div className="h-40 w-40">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie isAnimationActive={false} data={[{ v: Math.min(audience, base.sent ?? audience) }, { v: Math.max(0, (base.sent ?? 0) - audience) }]} dataKey="v" innerRadius={48} outerRadius={68} startAngle={90} endAngle={-270}>
                    <Cell fill={strategy.color} />
                    <Cell fill="#eadfd2" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xl font-bold font-mono -mt-24 mb-16">{count(audience)}</div>
            <div className="text-[11px] text-[#6b554d] text-center">messages · {base.sent ? `${Math.round((audience / base.sent) * 100)}% of the ${count(base.sent)} sent (${base.label})` : 'no sends in period'}</div>
            <label className="mt-3 w-full text-[11px] font-semibold text-[#4d4039]">Target audience (messages)
              <input type="number" min={0} step={1} value={audience} onChange={(e) => setAud(Math.max(0, Math.round(Number(e.target.value) || 0)))} className="mt-1 w-full rounded border border-[#e8dcc9] px-2 py-1 font-mono text-xs" />
            </label>
          </div>
          <div className="space-y-3">
            <NotInData need="Segment membership (active, new, at-risk, inactive…) and recipient lists are not connected, so unique people and segment sizes cannot be shown. The audience is a message count: by default the messages sent in the period minus opt-outs, or your own number." />
            <div className="rounded-xl bg-white border border-[#e8dcc9] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold mb-2">
                <span>Excluded audiences ({base.label}, {lbl.split(' (')[0]})</span>
                <label className="inline-flex items-center gap-1.5 font-semibold text-[11px] cursor-pointer">
                  <input type="checkbox" checked={excludeOptOuts} onChange={(e) => { setExcludeOptOuts(e.target.checked); setAud(null); }} className="accent-[#C74634]" />
                  Subtract opt-outs from the target audience
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                {[
                  { name: 'Unsubscribed', v: base.unsubscribes, note: excludeOptOuts ? 'Opted out · subtracted' : 'Opted out · not subtracted', minus: excludeOptOuts },
                  { name: 'Complaints', v: base.complaints, note: excludeOptOuts ? 'Marked as spam · subtracted' : 'Marked as spam · not subtracted', minus: excludeOptOuts },
                  { name: 'Bounced', v: base.bounces, note: `Not subtracted: already in the ${pct(base.deliveredRate)} delivery rate`, minus: false },
                ].map((x) => (
                  <div key={x.name} className="rounded-lg border border-[#efe3d6] p-2">
                    <div className="font-semibold">{x.name}</div>
                    <div className={`font-mono font-bold ${x.minus ? 'text-rose-700' : 'text-[#6b554d]'}`}>{x.v === null ? 'Not in data' : `${x.minus ? '−' : ''}${count(x.v)}`}</div>
                    <div className="text-[10px] text-[#8a7668]">{x.note}</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-[#8a7668]">Counts are events in the data, not people; subtracting them assumes each came from a different contact.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl bg-white border border-[#e8dcc9] p-3">
                <div className="text-xs font-bold mb-2">Mailbox providers</div>
                <p className="text-[11px] text-[#8a7668]">Not in your data.</p>
              </div>
              <div className="rounded-xl bg-white border border-[#e8dcc9] p-3">
                <div className="text-xs font-bold mb-2">Channel reach</div>
                {reachShare.map((x) => (
                  <div key={x.ch} className="flex items-center gap-2 text-[11px] mb-1">
                    <span className="w-16">{x.ch}</span>
                    <div className="flex-1 h-2 rounded bg-[#f1e9df]"><div className="h-2 rounded bg-[#C74634]" style={{ width: `${reachTotal ? (x.d / reachTotal) * 100 : 0}%` }} /></div>
                    <span className="font-mono w-10 text-right">{reachTotal ? `${Math.round((x.d / reachTotal) * 100)}%` : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Stage>

      <Stage id="wi-actions" n={3} title="Audience Actions" hint="What the audience gets in this plan">
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 rounded-xl bg-white border border-[#e8dcc9] p-2.5">
          <div className="flex items-center gap-2 md:w-52 shrink-0">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center text-white" style={{ backgroundColor: strategy.color }}><Users className="w-4 h-4" /></span>
            <div>
              <div className="text-xs font-bold">{strategy.name} audience</div>
              <div className="text-[10px] font-mono text-[#6b554d]">{count(audience)}</div>
            </div>
          </div>
          <ArrowRight className="hidden md:block w-4 h-4 text-[#c9b8a8] shrink-0" />
          <span className="self-start md:self-auto text-[11px] font-bold px-2.5 py-1 rounded-full text-white shrink-0" style={{ backgroundColor: strategy.color }}>{strategy.action}</span>
          <div className="flex flex-wrap gap-1 flex-1">
            {strategy.chips.map((c) => <span key={c} className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#f5eee6] text-[#5f4d42]">{c}</span>)}
          </div>
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-[#e8dcc9] bg-[#fffaf5] shrink-0">
            {base.channel === 'SMS' ? <MessageSquare className="w-3 h-3" /> : base.channel === 'WebPush' ? <Bell className="w-3 h-3" /> : <Mail className="w-3 h-3" />} {base.channel}
          </span>
        </div>
        {strategyRecs.length > 0 && (
          <ul className="mt-3 text-[11px] text-[#5f4d42] space-y-1">
            {strategyRecs.map((x) => <li key={x.id}>• Addresses: {x.evidence}</li>)}
          </ul>
        )}
      </Stage>

      <Stage id="wi-flow" n={4} title="Responsys Program Flow" hint={`${strategy.name.toUpperCase().replace(/[^A-Z]+/g, '_')}_PROGRAM · proposed, not deployed`}>
        <ProgramFlowDiagram flow={flow} selectedNodeId={selectedCampaign?.role === 'initial' ? 'first' : selectedCampaign?.role === 'follow_up' ? 'follow' : undefined} />
      </Stage>

      <Stage id="wi-campaigns" n={5} title="Recommended Campaigns & Templates" hint="Review the journey conditions, choose one of two campaigns, then select its business email template">
        <JourneyCampaigns flow={flow} journey={journey} account={account} pack={pack} campaign={selectedCampaign} templates={templates} template={template} onCampaign={(id) => { setCampaignId(id); setTemplateId(null); setOfferChoice({ campaignId: id, id: '', confirmed: false }); }} onTemplate={setTemplateId}
          offerControl={selectedCampaign && ['welcome', 'reengage'].includes(strategyKey) ? <WebsiteOfferPicker offers={websiteOffers} strategy={strategyKey} selectedId={offerChoice.campaignId === selectedCampaign.id ? offerChoice.id : ''} confirmed={!!selectedOffer} loading={brief.isPending} onSelect={(id) => setOfferChoice({ campaignId: selectedCampaign.id, id, confirmed: false })} onConfirm={(confirmed) => setOfferChoice((choice) => ({ ...choice, confirmed }))} /> : undefined} />
      </Stage>

      <Stage id="wi-simulation" n={6} title="Campaign Simulation" right={<EstimatedBadge />}>
        <div className="flex flex-wrap gap-1.5 text-[11px] mb-2">
          {[`Strategy ${strategy.name}`, `Baseline ${base.label}`, `Channel ${base.channel}`, `Template ${template?.name ?? '—'}`].map((x) => <span key={x} className="px-2 py-0.5 rounded-full bg-white border border-[#e8dcc9]">{x}</span>)}
        </div>
        <p className="text-[11px] text-[#6b554d] mb-4">Choose your audience and planned launch window. Expected opens and clicks use comparable launch history where available, blended with baseline rates. These estimates do not guarantee future performance.</p>
        <details className="mb-4 rounded-lg border border-[#e8dcc9] bg-white p-3 text-xs">
          <summary className="cursor-pointer font-semibold">Historical baseline for estimates · {base.label}</summary>
          <label className="block mt-2 text-[#6b554d]">Historical baseline
            <select aria-label="Historical baseline" className="block mt-1 w-full rounded border border-[#e8dcc9] bg-white p-2" value={baseId ?? ''} onChange={(e) => { setBaseId(e.target.value || null); setAud(null); }}>
              <option value="">All campaigns in the period</option>
              {similar.map((c) => <option key={c.campaignId} value={c.campaignId}>{c.name}</option>)}
            </select>
          </label>
          <p className="mt-1 text-[11px] text-[#8a7668]">This is historical performance for the simulation, separate from the two proposed journey campaigns. It does not establish recipient eligibility.</p>
        </details>
          <div className="space-y-4">
            <div className="rounded-xl bg-white border border-[#e8dcc9] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="text-sm font-bold text-[#C74634]">Plan audience and launch time</div>
                <button onClick={reset} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6b554d] hover:text-[#2d241d]"><RotateCcw className="w-3.5 h-3.5" /> Reset to data baseline</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <ParamCard icon={Users} label="Target Audience" display={count(audience)} caption="Messages to send" baseLabel={count(defaultAudience)} min={0} max={Math.max(1000, defaultAudience * 2)} step={Math.max(1, Math.round(defaultAudience / 200))} value={audience} onChange={(v) => setAud(Math.round(v))} />
                <label className="block rounded-xl bg-[#faf6f1] border border-[#eadfd2] p-3 text-sm font-semibold">Launch weekday
                  <select aria-label="Launch weekday" className="block w-full rounded border border-[#e8dcc9] bg-white p-2 mt-3" value={launchWeekday ?? ''} onChange={(e) => { setLaunchWeekday(e.target.value ? Number(e.target.value) : null); if (!e.target.value) setLaunchTime(''); }}>
                    <option value="">Best observed window</option>
                    {WEEKDAYS.map((day, i) => <option key={day} value={i + 1}>{day}</option>)}
                  </select>
                  <span className="block mt-2 text-[10px] font-normal">Ranks eligible windows by historical open rate; click rate breaks ties.</span>
                </label>
                <label className="block rounded-xl bg-[#faf6f1] border border-[#eadfd2] p-3 text-sm font-semibold">Launch time
                  <input type="time" aria-label="Launch time" value={launchTime || (estimate.hour === null ? '' : `${String(estimate.hour).padStart(2, '0')}:00`)} onChange={(e) => { setLaunchTime(e.target.value); if (launchWeekday === null) setLaunchWeekday(estimate.weekday ?? 1); }} className="block w-full rounded border border-[#e8dcc9] bg-white p-2 mt-3" />
                  <span className="block mt-2 text-[10px] font-normal">Account timezone: {account.timezone}. History is compared in hour-long windows.</span>
                </label>
              </div>
              <div className="mt-3 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-900" role="status" id="send-time-estimate">
                <p><strong>Planned launch:</strong> {scheduleLabel}</p>
                <p className="mt-1">{estimate.explanation}</p>
                <p className="mt-2 font-semibold">Expected open rate: {pct(estimate.open)} · Expected click rate: {pct(estimate.click)}</p>
                {!r.sendTime?.some((row) => row.hour !== null) && <p className="mt-1">To compare hours, import a campaign export with Launch Date, Launch Time (HH:mm), channel, delivered, and open/click counts. Summary exports cannot identify the best hour.</p>}
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl bg-white border border-[#e8dcc9] p-4">
                <div className="text-xs font-bold mb-2">Rates: current vs projected</div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={[{ k: 'Open rate', c: base.openRate, p: projected.open }, { k: 'Click rate', c: base.clickRate, p: projected.click }, { k: 'Bounce rate', c: base.bounceRate, p: projected.bounce }]}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="k" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} unit="%" />
                      <Tooltip formatter={(v) => (v === null ? 'Unavailable' : `${Number(v).toFixed(2)}%`)} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Bar isAnimationActive={false} dataKey="c" name="Current (data)" fill="#c9b8a8" />
                      <Bar isAnimationActive={false} dataKey="p" name="Expected (historical estimate)" fill="#3b5bdb" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="rounded-xl bg-white border border-[#e8dcc9] p-4">
                <div className="text-xs font-bold mb-2">Expected activity for this send</div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funnel} layout="vertical" margin={{ left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis type="number" scale="log" domain={[1, 'auto']} allowDataOverflow tick={{ fontSize: 10 }} />
                      <YAxis type="category" dataKey="stage" tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v) => (v === null ? 'Unavailable' : count(Number(v)))} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Bar isAnimationActive={false} dataKey="current" name="Current (data)" fill="#c9b8a8" />
                      <Bar isAnimationActive={false} dataKey="projected" name="Expected (historical estimate)" fill="#3b5bdb" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-[10px] text-[#8a7668]">Log scale</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              <span className="font-bold">Assumptions:</span>
              {[`Baseline: ${lbl.split(' (')[0]} rates`, `Delivery ${pct(base.deliveredRate)}`, `Conversion ${pct(base.convRate, 3)} (held constant)`, `${base.ordersPerConverter === 1 ? '1 order per converter (assumed)' : `${base.ordersPerConverter.toFixed(2)} orders per conversion (data)`}`, 'Launch-time engagement does not establish revenue uplift'].map((x) => <span key={x} className="px-2 py-0.5 rounded-full bg-white border border-[#e8dcc9]">{x}</span>)}
            </div>
          </div>
      </Stage>

      <Stage id="wi-outcomes" n={7} title="Expected Outcomes" hint={`One send to ${count(audience)} messages at ${lbl.split(' (')[0]} rates — not a forecast over the period or any number of days`} right={<EstimatedBadge />}>
        {!sim ? (
          <p className="text-xs text-[#8a7668]">Expected opens and clicks are shown in step 6. Revenue estimates need baseline {missing.join(', ') || 'audience volume'}; no order value needs to be guessed.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              {[
                { l: 'Audience reach', v: count(Number(sim.cases.base.expectedDelivered)), s: `delivered of ${count(audience)}` },
                { l: 'Open rate', v: pct(projected.open), s: `was ${pct(base.openRate)}` },
                { l: 'Click rate', v: pct(projected.click), s: `was ${pct(base.clickRate)}` },
                { l: 'Bounce rate', v: pct(projected.bounce), s: 'unchanged in this model' },
                { l: 'Conversions', v: count(Number(sim.cases.base.expectedConverters)), s: 'baseline conversion rate, held constant' },
                { l: 'Revenue', v: fmtM(Number(sim.cases.base.expectedRevenue)), s: currentRevenue === null ? '' : `was ${fmtM(currentRevenue)} at baseline` },
              ].map((x) => (
                <div key={x.l} className="rounded-xl bg-white border border-[#e8dcc9] p-3">
                  <div className="text-[10px] text-[#8a7668]">{x.l}</div>
                  <div className="text-base font-bold font-mono">{x.v}</div>
                  <div className="text-[10px] text-[#6b554d]">{x.s}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
              <div className="rounded-xl bg-white border border-[#e8dcc9] p-4">
                <div className="flex items-center justify-between text-xs font-bold mb-2">
                  <span>Revenue for this send</span>
                  <span className="font-mono text-emerald-700">{lift === null ? '' : `${lift >= 0 ? '+' : ''}${fmtM(lift)} vs baseline`}</span>
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={[
                      { n: 'Current', v: currentRevenue, f: '#c9b8a8' },
                      { n: 'Expected', v: Number(sim.cases.base.expectedRevenue), f: '#059669' },
                    ]}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="n" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v) => fmtM(Number(v))} />
                      <Bar isAnimationActive={false} dataKey="v" name="Revenue">
                        {['#c9b8a8', '#059669'].map((c) => <Cell key={c} fill={c} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-[10px] text-[#8a7668]">Revenue uses recorded baseline conversion and order value. Changing launch time affects engagement estimates only; no revenue uplift is assumed.</p>
              </div>
              <div className="space-y-3">
                <div className="rounded-xl bg-white border border-[#e8dcc9] p-3">
                  <div className="text-xs font-bold mb-2">What drives the lift</div>
                  <ul className="space-y-1 text-[11px]">
                    {sim.sensitivity.map((s) => (
                      <li key={s.input} className="flex justify-between"><span><CheckCircle2 className="w-3 h-3 inline text-emerald-600 mr-1" />{s.input.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span className="font-mono">{fmtM(Number(s.swing))} swing</span></li>
                    ))}
                    {strategyRecs.map((x: Recommendation) => <li key={x.id} className="flex justify-between"><span><CheckCircle2 className="w-3 h-3 inline text-emerald-600 mr-1" />{x.title}</span><span className="text-[#8a7668]">{x.group}</span></li>)}
                  </ul>
                </div>
                <div className="rounded-xl bg-[#faf6f1] border border-[#eadfd2] p-3 text-[11px]">
                  <div className="font-bold mb-1">Data notes</div>
                  <ul className="space-y-0.5 text-[#5f4d42]">{sim.notes.map((n) => <li key={n}>• {n}</li>)}<li>• Segment and mailbox data are not connected.</li></ul>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={save} disabled={!canSave || saveState.busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-[#e8dcc9] hover:border-[#C74634]/50 disabled:opacity-50">
                <Save className="w-3.5 h-3.5 text-[#C74634]" /> {saveState.busy ? 'Saving…' : 'Save scenario'}
              </button>
              {!canSave && <span className="text-[11px] text-[#8a7668]">Your role cannot save scenarios.</span>}
              {saveState.msg && <span className="text-[11px] text-emerald-700 font-semibold">{saveState.msg}</span>}
              {saveState.error && <span className="text-[11px] text-rose-700">{saveState.error}</span>}
            </div>
          </div>
        )}
      </Stage>

      <section id="wi-create" className="scroll-mt-40 rounded-2xl bg-[#2d241d] text-white p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-2 min-w-0">
          <h3 className="text-lg font-bold flex items-center gap-2"><Rocket className="w-5 h-5 text-[#f0a08f]" /> Create this campaign</h3>
          <p className="text-xs text-[#d9c6b4]">Email, SMS and WebPush versions, ready to edit and preview on desktop and mobile. Saved as a draft — nothing is sent.</p>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {[strategy.name, `${count(audience)} messages`, base.label, template?.name ?? 'No template', `${strategyRecs.length} fixes addressed`].map((x) => <span key={x} className="px-2 py-0.5 rounded-full bg-white/10 border border-white/15">{x}</span>)}
          </div>
          <div className="grid sm:grid-cols-2 gap-2 text-[11px] text-[#d9c6b4]" id="wi-handoff">
            <div><span className="font-bold text-white">Goes into the draft:</span> {selectedCampaign?.name ?? 'choose a campaign in step 5'}, its selected email template, and the criteria for the objects shown in the program flow.</div>
            <div><span className="font-bold text-white">Not applied:</span> no Responsys audience, list or program is created or changed, and the simulation is not attached — use Save scenario above to keep it.</div>
          </div>
        </div>
        <button
          onClick={() =>
            onCreate({
              draftId: null,
              version: null,
              name: (selectedCampaign?.name ?? strategy.name).slice(0, 160),
              primaryChannel: 'Email',
              content: null,
              topic: template?.topic ?? strategy.topic,
              templateId: template?.id ?? null,
              emailOverride: template?.email,
              sourceNote: `From AI Simulator: ${strategy.name}, ${selectedCampaign?.name ?? ''}, ${count(audience)} messages, baseline ${base.label}, ${lbl}`,
              plan: {
                reportId: r.meta.reportId,
                strategy: strategy.name,
                period: lbl.slice(0, 160),
                baseline: base.label.slice(0, 200),
                audience: `${count(audience)} messages (${audienceBasis})`.slice(0, 200),
                program: programText.slice(0, 300),
                assumptions: `Planned launch ${scheduleLabel}; expected open ${pct(estimate.open)}, click ${pct(estimate.click)} (${estimate.basis} history); conversion held at baseline${sim ? `; estimated revenue ${fmtM(Number(sim.cases.base.expectedRevenue))} for one send` : ''}`.slice(0, 400),
                ...(selectedCampaign && template ? { journey: { ...journey, selectedCampaignId: selectedCampaign.id, selectedTemplateId: template.id, ...(selectedOffer ? { websiteOffer: selectedOffer } : {}), program: { summary: flow.summary, nodes: programObjects(flow).map(({ branches: _branches, tone: _tone, ...node }) => node), edges: programEdges(flow) } } } : {}),
              },
            })
          }
          disabled={!selectedCampaign || !template}
          title={!selectedCampaign ? 'Select a campaign and email template in step 5 first' : 'Create a draft for the selected journey campaign'}
          className="shrink-0 inline-flex items-center justify-center gap-2 bg-[#C74634] hover:bg-[#b03d2d] text-white px-6 py-3.5 rounded-xl text-sm font-bold shadow-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Rocket className="w-4 h-4" /> Create campaign
        </button>
      </section>
    </div>
  );
};
