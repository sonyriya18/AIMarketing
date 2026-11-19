/**
 * Header in the original layout: dark top bar with the five tabs, then the "Active Analysis
 * Mode" bar whose controls change with the tab. Every control drives a real report request.
 */
import React from 'react';
import { BarChart3, Bookmark, Calendar, FileText, Layers, LogOut, MessageSquare, RefreshCw, Search, Sliders } from 'lucide-react';
import oracleMark from '../assets/oracle-mark.png';
import { AccountLogo } from './AccountLogo';
import { SUMMARY_PERIODS, type Selection, type SummaryPeriod, type Tab } from '../app/selection';
import type { Account, CampaignListItem, Dataset, Session } from '../lib/types';

interface HeaderProps {
  session: Session;
  account: Account;
  onChooseAccount: () => void;
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  datasets: Dataset[];
  campaigns: CampaignListItem[];
  coverage: { start: string; endInclusive: string } | null;
  isLoading: boolean;
  /** Whether Ask AI can focus on one campaign (campaign-level data is loaded). */
  chatCampaignsAvailable?: boolean;
  onRefreshData: () => void;
  onExportReport: (() => void) | null;
  onLogout: () => void;
}

const TAB_DEFS: { id: Tab; label: string; short: string; icon: React.ElementType }[] = [
  { id: 'briefing', label: 'Summary', short: 'Summary', icon: BarChart3 },
  { id: 'simulator', label: 'AI Simulator', short: 'AI Simulator', icon: Sliders },
  { id: 'analyse', label: 'Analyze Campaign', short: 'Analyze Campaign', icon: FileText },
  { id: 'battlecard', label: 'Compare Campaigns', short: 'Compare', icon: Layers },
  { id: 'chat', label: 'Ask AI', short: 'Ask AI', icon: MessageSquare },
];

const MODE_TITLE: Record<Tab, string> = {
  briefing: 'Account Performance Summary',
  analyse: 'Single Campaign Deep-Dive',
  battlecard: 'Comparative Battlecard & Multi-Campaign Performance',
  simulator: 'AI Simulator',
  chat: 'Ask Responsys AI Intelligence Hub',
};

const selectCls = 'bg-white border border-gray-300 text-gray-800 text-xs rounded px-2.5 py-1.5 font-medium focus:outline-none focus:ring-2 focus:ring-[#C74634]';

export const Header: React.FC<HeaderProps> = ({ session, account, onChooseAccount, sel, update, datasets, campaigns, coverage, isLoading, chatCampaignsAvailable = true, onRefreshData, onExportReport, onLogout }) => {
  const setTab = (tab: Tab) => update({ tab });
  const active = datasets.filter((d) => d.activeVersionId);
  const windowData = active.find((d) => d.id === sel.datasetId)?.grain === 'account_window';
  const isCustom = sel.period === 'custom';
  const from = sel.start || coverage?.start || '';
  const to = sel.end || coverage?.endInclusive || '';
  const ModeIcon = TAB_DEFS.find((t) => t.id === sel.tab)!.icon;

  const saveBtn = (id: string) => (
    <button
      id={id}
      onClick={onExportReport ?? undefined}
      disabled={!onExportReport}
      title={onExportReport ? 'Save this report' : 'Nothing to save yet'}
      className="inline-flex items-center space-x-1.5 bg-[#C74634] hover:bg-[#b03d2d] text-white px-3 py-2 rounded-lg text-xs font-semibold shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Bookmark className="w-3.5 h-3.5" />
      <span>Save Report</span>
    </button>
  );

  const campaignSelect = (id: string, label: string, withProgram: boolean) => (
    <div className="flex items-center space-x-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
      <span className="font-semibold text-gray-700 pl-2">{label}</span>
      <select id={id} value={sel.campaignId ?? ''} onChange={(e) => update({ campaignId: e.target.value })} className={`${selectCls} max-w-xs truncate`} disabled={!campaigns.length}>
        {!campaigns.length && <option value="">No campaigns in this data</option>}
        {campaigns.map((c) => (
          <option key={c.campaignId} value={c.campaignId}>
            {withProgram ? `${c.name} (${c.program || c.externalId})` : c.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <header className="w-full min-w-0 bg-[#161616] text-white border-b border-gray-800 sticky top-0 z-40 shadow-md">
        <div className="w-full min-w-0 max-w-none mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
          <div className="flex flex-1 min-w-0 overflow-hidden items-center space-x-3">
            <img src={oracleMark} alt="Oracle" className="h-9 w-9 shrink-0 rounded object-contain" />
            <span className="text-sm font-semibold tracking-wide sm:text-base truncate">Oracle Marketing Cloud Analytics &amp; Recommendation Engine</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <nav className="hidden lg:flex items-center space-x-1 bg-gray-900 p-1 rounded-lg border border-gray-800 text-xs" aria-label="Main">
              {TAB_DEFS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  id={`tab-${id}`}
                  onClick={() => setTab(id)}
                  aria-current={sel.tab === id ? 'page' : undefined}
                  className={`px-3.5 py-1.5 rounded-md font-medium whitespace-nowrap transition-all flex items-center space-x-1.5 ${sel.tab === id ? 'bg-[#C74634] text-white shadow' : 'text-gray-300 hover:text-white hover:bg-gray-800'}`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2 text-[11px] text-gray-300">
              <span className="hidden xl:flex flex-col items-end leading-tight" id="signed-in-as">
                <span className="text-gray-200 max-w-[180px] truncate">{session.user.email}</span>
                {session.workspace?.role && <span className="text-[10px] uppercase tracking-wider text-[#f0a08f]">{session.workspace.role}</span>}
              </span>
              <button onClick={onLogout} className="p-1.5 rounded hover:bg-gray-800" title={`Signed in as ${session.user.email} — sign out`} aria-label="Sign out">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
            <AccountLogo key={account.id} account={account} onClick={onChooseAccount} />
          </div>
        </div>
        <div className="lg:hidden flex w-full min-w-0 overflow-x-auto border-t border-gray-800 bg-gray-900 px-3 py-2 space-x-2">
          {TAB_DEFS.map(({ id, short }) => (
            <button key={id} onClick={() => setTab(id)} className={`px-3 py-1 rounded text-xs whitespace-nowrap font-medium ${sel.tab === id ? 'bg-[#C74634] text-white' : 'text-gray-300'}`}>
              {short}
            </button>
          ))}
        </div>
      </header>

      <div className="bg-white border-b border-gray-200 shadow-xs py-3.5">
        <div className="max-w-none mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-red-50 text-[#C74634] border border-red-100 shrink-0">
              <ModeIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">Active Analysis Mode</div>
              <h1 className="text-base sm:text-lg font-bold text-gray-900 leading-tight">{MODE_TITLE[sel.tab]}</h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {(sel.tab === 'briefing' || sel.tab === 'analyse' || sel.tab === 'battlecard' || sel.tab === 'simulator') && active.length > 1 && (
              <div className="flex items-center space-x-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
                <span className="font-semibold text-gray-700 pl-2">Data:</span>
                <select id="dataset-select" value={sel.datasetId ?? ''} onChange={(e) => update({ datasetId: e.target.value, campaignId: null, benchmarkId: null, compareIds: [], windowKey: null })} className={`${selectCls} max-w-[200px] truncate`}>
                  {active.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}

            {sel.tab === 'briefing' && (
              <div className="flex flex-wrap items-center gap-2">
                {!windowData && (
                  <>
                    <div className="flex items-center space-x-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
                      <span className="font-semibold text-gray-700 pl-2">Period:</span>
                      <select id="period-select" value={sel.period} onChange={(e) => update({ period: e.target.value as SummaryPeriod })} className={selectCls}>
                        {SUMMARY_PERIODS.map((p) => (
                          <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center space-x-1 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
                      <Calendar className="w-3.5 h-3.5 text-[#C74634] ml-1 shrink-0" />
                      <label htmlFor="summary-custom-start-date" className="font-semibold text-gray-600 text-[11px] pl-1">From:</label>
                      <input
                        type="date"
                        id="summary-custom-start-date"
                        value={from}
                        disabled={!isCustom}
                        onChange={(e) => update({ start: e.target.value, end: to })}
                        className={`border text-xs rounded px-2 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-[#C74634] ${!isCustom ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200' : 'bg-white border-gray-300 text-gray-800 cursor-pointer'}`}
                      />
                      <label htmlFor="summary-custom-end-date" className="font-semibold text-gray-600 text-[11px] pl-1">To:</label>
                      <input
                        type="date"
                        id="summary-custom-end-date"
                        value={to}
                        disabled={!isCustom}
                        onChange={(e) => update({ start: from, end: e.target.value })}
                        className={`border text-xs rounded px-2 py-1 font-mono focus:outline-none focus:ring-2 focus:ring-[#C74634] ${!isCustom ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200' : 'bg-white border-gray-300 text-gray-800 cursor-pointer'}`}
                      />
                    </div>
                  </>
                )}
                <button
                  id="btn-check-summary"
                  onClick={onRefreshData}
                  disabled={isLoading}
                  className="inline-flex items-center space-x-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-[#C74634]' : 'text-gray-600'}`} />
                  <span>{isLoading ? 'Updating...' : 'Check Results'}</span>
                </button>
                {saveBtn('btn-export-report-summary')}
              </div>
            )}

            {sel.tab === 'analyse' && (
              <div className="flex flex-wrap items-center gap-2">
                {campaignSelect('single-campaign-select', 'Select Campaign:', true)}
                <button
                  id="btn-run-single-analysis"
                  onClick={onRefreshData}
                  disabled={isLoading || !campaigns.length}
                  className="inline-flex items-center space-x-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 transition-colors disabled:opacity-50"
                >
                  <Search className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-[#C74634]' : 'text-gray-600'}`} />
                  <span>{isLoading ? 'Analyzing...' : 'Analyse Campaign'}</span>
                </button>
                {saveBtn('btn-export-report-analyse')}
              </div>
            )}

            {sel.tab === 'chat' && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center space-x-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
                  <span className="font-semibold text-gray-700 pl-2">Ask about:</span>
                  <select
                    id="chat-campaign-select"
                    value={sel.chatScope === 'campaign' && chatCampaignsAvailable ? sel.campaignId ?? '' : '__all__'}
                    onChange={(e) => (e.target.value === '__all__' ? update({ chatScope: 'account' }) : update({ chatScope: 'campaign', campaignId: e.target.value }))}
                    className={`${selectCls} max-w-xs truncate`}
                  >
                    <option value="__all__">All campaigns (whole dashboard)</option>
                    {chatCampaignsAvailable && campaigns.map((c) => <option key={c.campaignId} value={c.campaignId}>{c.name}</option>)}
                  </select>
                </div>
                {!windowData && (
                  <div className="flex items-center space-x-1.5 bg-gray-50 p-1 rounded-lg border border-gray-200 text-xs">
                    <span className="font-semibold text-gray-700 pl-2">Period:</span>
                    <select id="chat-period-select" value={sel.period} onChange={(e) => update({ period: e.target.value as SummaryPeriod })} className={selectCls}>
                      {SUMMARY_PERIODS.map((p) => (
                        <option key={p.key} value={p.key}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                {saveBtn('btn-export-report-chat')}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
