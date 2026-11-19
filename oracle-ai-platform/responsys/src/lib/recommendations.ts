/**
 * Recommendations & next best actions, derived deterministically from a report snapshot.
 * Each recommendation is triggered by a measured fact (a metric that moved the wrong way, a
 * campaign below the account rate, failed Connect runs). The "how to" text is general
 * Responsys practice; it is guidance, not a measured effect, and no revenue is promised.
 */
import type { MetricChange, OverviewResult } from './types';
import { changeOf, clickRate, num, openRate, showChange } from './metrics';
import { fmtMetric } from '../../shared/format';

export const RECOMMENDATION_RULES_VERSION = 'recs-2026-10-16.1';

export type RecGroup = 'Email' | 'Data jobs (Connect)' | 'SMS' | 'WebPush';
import type { StrategyKey } from '../../shared/scenario/strategies';
export type { StrategyKey };

export interface Recommendation {
  id: string;
  group: RecGroup;
  priority: 'Fix first' | 'This month' | 'Plan next';
  title: string;
  /** The measured fact that triggered it. */
  evidence: string;
  metricLabel: string | null;
  current: string | null;
  previous: string | null;
  change: string | null;
  howTo: string[];
  strategy: StrategyKey;
  campaignId?: string;
}

const GUIDE: Record<string, { title: string; howTo: string[]; strategy: StrategyKey }> = {
  open: {
    title: 'Send emails at the time people read them',
    strategy: 'engagement',
    howTo: ['Turn on Send Time Optimization for the next launches', 'Test two subject lines with a 10% split before the full send', 'Keep the preheader short and specific'],
  },
  click: {
    title: 'Make the main button easy to find',
    strategy: 'engagement',
    howTo: ['Place one primary call to action above the fold', 'Use dynamic content blocks for the product grid', 'Reduce competing links in the header and footer'],
  },
  ctor: {
    title: 'Match the email body to the subject line',
    strategy: 'engagement',
    howTo: ['Repeat the subject-line promise in the first screen of the email', 'Use RPL to personalise the hero offer', 'A/B test the hero image against a text-led layout'],
  },
  conversion: {
    title: 'Follow up with people who clicked but did not convert',
    strategy: 'cart',
    howTo: ['Add a Program Designer branch for clickers without a conversion', 'Wait 24 hours, then send a reminder with the viewed items', 'Exclude recent converters with a filter rule'],
  },
  revenue: {
    title: 'Lift revenue per message with targeted offers',
    strategy: 'revenue',
    howTo: ['Recommend related products using purchase history', 'Reserve discounts for high-intent segments', 'Measure revenue per delivered message per program'],
  },
  delivery: {
    title: 'Clean the list to protect delivery',
    strategy: 'hygiene',
    howTo: ['Suppress hard bounces and long-inactive contacts', 'Check SPF, DKIM and DMARC alignment', 'Warm up volume gradually after a pause'],
  },
  bounce: {
    title: 'Stop sending to addresses that do not work',
    strategy: 'hygiene',
    howTo: ['Suppress hard-bounced addresses before the next launch', 'Validate new addresses at sign-up', 'Review the source of recently added contacts'],
  },
  unsub: {
    title: 'Send fewer emails to the same person',
    strategy: 'retention',
    howTo: ['Set a frequency cap (for example 3 messages per 72 hours)', 'Offer a preference centre instead of a full unsubscribe', 'Pause low-engagement contacts and re-engage them separately'],
  },
  complaint: {
    title: 'Reduce spam complaints',
    strategy: 'retention',
    howTo: ['Make the unsubscribe link easy to find', 'Remove contacts who have not opened in a long time', 'Check that every audience gave consent'],
  },
};

const METRIC_RULES: { key: keyof typeof GUIDE; ids: string[] }[] = [
  { key: 'open', ids: ['unique_open_rate', 'total_open_rate'] },
  { key: 'click', ids: ['unique_click_rate', 'total_click_rate'] },
  { key: 'ctor', ids: ['unique_click_to_open_rate'] },
  { key: 'conversion', ids: ['conversion_event_rate'] },
  { key: 'revenue', ids: ['revenue_per_delivered'] },
  { key: 'delivery', ids: ['delivered_rate'] },
  { key: 'bounce', ids: ['bounce_rate'] },
  { key: 'unsub', ids: ['unsubscribe_rate'] },
  { key: 'complaint', ids: ['complaint_rate'] },
];

const channelGroup = (channel: string): RecGroup => (/sms/i.test(channel) ? 'SMS' : /push|app/i.test(channel) ? 'WebPush' : 'Email');

/** The channel carrying most delivered volume: where account-level issues are grouped. */
function mainGroup(r: OverviewResult): RecGroup {
  let best = { ch: 'Email', d: -1 };
  for (const c of r.byChannel) {
    const d = num(c.metrics.find((m) => m.metricId === 'delivered')) ?? -1;
    if (d > best.d) best = { ch: c.channel, d };
  }
  return channelGroup(best.ch);
}

function fromChange(c: MetricChange, key: keyof typeof GUIDE, group: RecGroup): Recommendation {
  const g = GUIDE[key]!;
  const rel = c.relativeChangePct !== null ? Math.abs(Number(c.relativeChangePct)) : 0;
  return {
    id: `metric:${c.metricId}`,
    group,
    priority: rel >= 10 ? 'Fix first' : rel >= 3 ? 'This month' : 'Plan next',
    title: g.title,
    evidence: `${c.label} was ${fmtMetric(c.current)} compared with ${c.previous ? fmtMetric(c.previous) : '—'} in the comparison period.`,
    metricLabel: c.label,
    current: fmtMetric(c.current),
    previous: c.previous ? fmtMetric(c.previous) : null,
    change: showChange(c),
    howTo: g.howTo,
    strategy: g.strategy,
  };
}

export function buildRecommendations(r: OverviewResult, connect?: { state: string; totals?: { failed: number; runs: number } } | null): Recommendation[] {
  const out: Recommendation[] = [];
  const group = mainGroup(r);
  for (const rule of METRIC_RULES) {
    const c = rule.ids.map((id) => changeOf(r.totals, id)).find((x) => x && x.current.value !== null);
    if (c && c.interpretation === 'worse') out.push(fromChange(c, rule.key, group));
  }

  // Campaigns clearly below the account click rate in the same period.
  const acctClick = num(clickRate(Object.fromEntries(r.totals.map((t) => [t.metricId, t.current]))));
  if (acctClick !== null && acctClick > 0) {
    const weak = r.campaigns
      .map((c) => ({ c, v: num(clickRate(c.metrics)), d: num(c.metrics.delivered ?? null) ?? 0 }))
      .filter((x) => x.v !== null && x.v < acctClick * 0.75 && x.d > 0)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3);
    for (const { c, v } of weak) {
      out.push({
        id: `campaign:${c.campaignId}`,
        group: channelGroup(c.channel),
        priority: 'This month',
        title: `Rework "${c.name}"`,
        evidence: `Click rate ${v!.toFixed(2)}% vs ${acctClick.toFixed(2)}% across all campaigns in this period.`,
        metricLabel: 'Click rate',
        current: `${v!.toFixed(2)}%`,
        previous: `${acctClick.toFixed(2)}% (account)`,
        change: `${(v! - acctClick).toFixed(2)} pp`,
        howTo: GUIDE.click!.howTo,
        strategy: 'engagement',
        campaignId: c.campaignId,
      });
    }
  }

  if (connect?.state === 'available' && connect.totals && connect.totals.failed > 0) {
    out.push({
      id: 'connect:failed',
      group: 'Data jobs (Connect)',
      priority: 'Fix first',
      title: 'Make sure the file arrives before the job runs',
      evidence: `${connect.totals.failed} of ${connect.totals.runs} Connect job runs failed in this period.`,
      metricLabel: 'Failed runs',
      current: String(connect.totals.failed),
      previous: null,
      change: null,
      howTo: ['Schedule the upstream export to finish before the Connect run', 'Upload as .tmp and rename when complete', 'Turn on failure notifications for each job'],
      strategy: 'hygiene',
    });
  }

  // Engagement improved but nothing is wrong: still offer the next step, clearly labelled.
  if (!out.length && openRate(Object.fromEntries(r.totals.map((t) => [t.metricId, t.current])))?.value) {
    out.push({
      id: 'plan:grow',
      group,
      priority: 'Plan next',
      title: 'Build on what is working',
      evidence: 'No metric got worse against the comparison period.',
      metricLabel: null,
      current: null,
      previous: null,
      change: null,
      howTo: GUIDE.revenue!.howTo,
      strategy: 'revenue',
    });
  }
  const order = { 'Fix first': 0, 'This month': 1, 'Plan next': 2 } as const;
  return out.sort((a, b) => order[a.priority] - order[b.priority]);
}
