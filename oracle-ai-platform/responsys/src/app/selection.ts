/**
 * Report selection state kept in the URL (shareable, survives reload). No tokens or customer
 * records are ever placed in the URL — only IDs and scope. Tab names follow the original app:
 * Summary (briefing), AI Simulator (simulator), Analyze Campaign (analyse),
 * Compare Campaigns (battlecard) and Ask AI (chat).
 */
import { useCallback, useEffect, useState } from 'react';
import type { ComparisonPolicy, PeriodPreset } from '../lib/types';

export const TABS = ['briefing', 'simulator', 'analyse', 'battlecard', 'chat'] as const;
export type Tab = (typeof TABS)[number];

/** Period choices exactly as in the original header, mapped to server presets. */
export const SUMMARY_PERIODS = [
  { key: '7d', label: 'Last 7 days', preset: 'last_7_complete_days' },
  { key: '14d', label: 'Last 14 days', preset: 'last_14_complete_days' },
  { key: '30d', label: 'Last 30 days', preset: 'last_30_complete_days' },
  { key: '60d', label: 'Last 60 days', preset: 'last_60_complete_days' },
  { key: '3m', label: 'Last 3 months', preset: 'last_3_complete_calendar_months' },
  { key: '6m', label: 'Last 6 months', preset: 'last_6_complete_calendar_months' },
  { key: '1y', label: 'Last 1 year', preset: 'last_12_complete_calendar_months' },
  { key: '2y', label: 'Last 2 years', preset: 'last_24_complete_calendar_months' },
  { key: '3y', label: 'Last 3 years', preset: 'last_36_complete_calendar_months' },
  { key: 'custom', label: 'Custom Date Range', preset: 'custom' },
] as const satisfies readonly { key: string; label: string; preset: PeriodPreset }[];
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number]['key'];

export interface Selection {
  tab: Tab;
  accountId: string | null;
  datasetId: string | null;
  period: SummaryPeriod;
  /** Custom range; empty means "the whole data coverage of the selected file". */
  start: string;
  end: string;
  windowKey: string | null;
  comparison: ComparisonPolicy;
  channel: string;
  /** Analyze Campaign / Ask AI campaign; Campaign 1 in Compare (VS 2). */
  campaignId: string | null;
  /** Campaign 2 (benchmark) in Compare (VS 2). */
  benchmarkId: string | null;
  compareMode: 'vs2' | 'multi';
  compareIds: string[];
  /** Ask AI context: the whole dashboard (all campaigns in the period) or one campaign. */
  chatScope: 'account' | 'campaign';
}

const DEFAULTS: Selection = {
  tab: 'briefing',
  accountId: null,
  datasetId: null,
  period: 'custom',
  start: '',
  end: '',
  windowKey: null,
  comparison: 'preceding_equal_duration',
  channel: '',
  campaignId: null,
  benchmarkId: null,
  compareMode: 'vs2',
  compareIds: [],
  chatScope: 'account',
};

const isPeriod = (v: string | null): v is SummaryPeriod => SUMMARY_PERIODS.some((p) => p.key === v);

const read = (): Selection => {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get('tab') as Tab | null;
  const period = p.get('period');
  return {
    tab: tab && (TABS as readonly string[]).includes(tab) ? tab : DEFAULTS.tab,
    accountId: p.get('account'),
    datasetId: p.get('dataset'),
    period: isPeriod(period) ? period : DEFAULTS.period,
    start: p.get('from') || '',
    end: p.get('to') || '',
    windowKey: p.get('window'),
    comparison: (p.get('cmp') as ComparisonPolicy) || DEFAULTS.comparison,
    channel: p.get('channel') || '',
    campaignId: p.get('campaign'),
    benchmarkId: p.get('vs'),
    compareMode: p.get('mode') === 'multi' ? 'multi' : 'vs2',
    compareIds: (p.get('compare') || '').split(',').filter(Boolean),
    chatScope: p.get('scope') === 'campaign' ? 'campaign' : 'account',
  };
};

const write = (s: Selection) => {
  const p = new URLSearchParams();
  const set = (k: string, v: string | null | undefined) => v && p.set(k, v);
  set('tab', s.tab);
  set('account', s.accountId);
  set('dataset', s.datasetId);
  set('period', s.period);
  set('from', s.start);
  set('to', s.end);
  set('window', s.windowKey);
  if (s.comparison !== DEFAULTS.comparison) set('cmp', s.comparison);
  set('channel', s.channel);
  set('campaign', s.campaignId);
  set('vs', s.benchmarkId);
  if (s.compareMode === 'multi') set('mode', 'multi');
  if (s.compareIds.length) set('compare', s.compareIds.join(','));
  if (s.chatScope === 'campaign') set('scope', 'campaign');
  window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
};

export function useSelection(): [Selection, (patch: Partial<Selection>) => void] {
  const [sel, setSel] = useState<Selection>(read);
  useEffect(() => {
    write(sel);
  }, [sel]);
  const update = useCallback((patch: Partial<Selection>) => setSel((s) => ({ ...s, ...patch })), []);
  return [sel, update];
}

export const presetFor = (period: SummaryPeriod): PeriodPreset => SUMMARY_PERIODS.find((p) => p.key === period)!.preset;
