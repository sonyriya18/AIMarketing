/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Application root: session gate → onboarding (empty workspace, no seeded data) → shell.
 * The shell follows the original app: Summary, AI Simulator, Analyze Campaign,
 * Compare Campaigns and Ask AI. Every screen reads server report snapshots.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, KeyRound, LogIn, Upload } from 'lucide-react';
import oracleMark from './assets/oracle-mark.png';
import { Header } from './components/Header';
import { AccountBusinessContext } from './components/AccountBusinessContext';
import { Button, Card, ErrorBox, Loading, Notice, TextInput } from './components/ui';
import { presetFor, useSelection } from './app/selection';
import { apiSend } from './lib/api';
import { useAccounts, useAuthConfig, useCampaignList, useConnections, useDatasets, useReport, useSession, qk } from './lib/queries';
import { useLiveEvents } from './lib/live';
import type { Account, CampaignReportResult, ComparisonResult, Dataset, OverviewResult, Session } from './lib/types';
import { addDays } from '../shared/time/zoned';
import { ExecutiveBriefing } from './components/ExecutiveBriefing';
import { SingleCampaignAnalysis } from './components/SingleCampaignAnalysis';
import { ComparativeBattlecard } from './components/ComparativeBattlecard';
import { WhatIfSimulator } from './components/WhatIfSimulator';
import { AnalystChat } from './components/AnalystChat';
import { AiStatusBadge } from './components/AiSummary';
import { AskAiContext, type AskAi, type SimulatorScenario } from './app/askAi';
import { NewCampaignModal } from './components/NewCampaignModal';
import { ExportModal } from './components/ExportModal';
import { ConnectJobs } from './components/ConnectJobs';
import { UploadExport } from './components/UploadExport';
import type { BuilderInput } from './components/CampaignBuilder';
import type { AnyReport } from './utils/pdfReport';
import { BUSINESS_ACCOUNTS, configuredBusiness, defaultBusinessWebsite } from '../shared/business/accounts';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } } });

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}

/** Shows a readable error instead of a blank page if a screen fails to render. */
class ScreenBoundary extends React.Component<{ resetKey: string; children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
        <div className="font-bold">This page could not be displayed</div>
        <p className="text-xs mt-1">{this.state.error.message}</p>
        <button onClick={() => window.location.reload()} className="mt-3 px-3 py-1.5 rounded-lg bg-white border border-rose-300 text-xs font-semibold">Reload</button>
      </div>
    );
  }
}

function Root() {
  const session = useSession();
  if (session.isLoading) return <FullPage><Loading label="Checking your session…" /></FullPage>;
  if (session.error) return <FullPage><ErrorBox error={session.error} onRetry={() => session.refetch()} title="The server could not be reached" /></FullPage>;
  if (!session.data) return <Login />;
  if (!session.data.workspace) return <WorkspaceSetup session={session.data} />;
  return <AccountEntry key={`${session.data.user.id}:${session.data.workspace.id}`} session={session.data} />;
}

const FullPage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-[#F4F5F7] flex flex-col">
    <header className="bg-[#161616] text-white h-16 flex items-center px-6 gap-3">
      <img src={oracleMark} alt="Oracle" className="h-9 w-9 rounded object-contain" />
      <span className="text-sm font-semibold">Oracle Marketing Cloud Analytics &amp; Recommendation Engine</span>
    </header>
    <main className="flex-1 w-full max-w-xl mx-auto px-4 py-10">{children}</main>
  </div>
);

function Login() {
  const cfg = useAuthConfig();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const signinError = new URLSearchParams(window.location.search).get('signinError');
  const devLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      sessionStorage.removeItem('rci.loginBusiness');
      sessionStorage.setItem('rci.loginPending', '1');
      if (cfg.data?.mode === 'oidc') {
        window.location.href = `/api/v1/auth/oidc/login?returnTo=${encodeURIComponent('/')}`;
        return;
      }
      await apiSend('POST', '/auth/dev-login', { email });
      await qc.invalidateQueries({ queryKey: qk.session });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FullPage>
      <Card title="Sign in" subtitle="Campaign intelligence for your Oracle Responsys accounts">
        {signinError && (
          <div className="mb-3">
            <Notice tone="warn">
              {signinError === 'not_allowed'
                ? 'That account is not on this app’s sign-in list. Ask the app owner to add your email.'
                : 'Sign-in did not complete. Please try again.'}
            </Notice>
          </div>
        )}
        {cfg.error ? <ErrorBox error={cfg.error} onRetry={() => cfg.refetch()} title="Sign-in is not available yet" /> : null}
        {cfg.data && (
          <form onSubmit={devLogin} className="space-y-3">
            {cfg.data.mode === 'dev' && <Notice tone="warn">
              <strong>Local development sign-in.</strong> This identity harness only runs in development and test; production uses your organization's single sign-on (OIDC).
            </Notice>}
            {cfg.data.mode === 'dev' && <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />}
            <Button type="submit" variant="primary" icon={cfg.data.mode === 'dev' ? KeyRound : LogIn} busy={busy}>{cfg.data.mode === 'dev' ? 'Sign in' : cfg.data.providerName ? `Sign in with ${cfg.data.providerName}` : 'Sign in with your organization'}</Button>
            {error ? <ErrorBox error={error} /> : null}
          </form>
        )}
        {cfg.isLoading && <Loading />}
      </Card>
    </FullPage>
  );
}

function WorkspaceSetup({ session }: { session: Session }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiSend('POST', '/workspaces', { name });
      await qc.invalidateQueries({ queryKey: qk.session });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (id: string) => {
    await apiSend('POST', '/session/workspace', { workspaceId: id });
    await qc.invalidateQueries();
  };
  return (
    <FullPage>
      <div className="space-y-4">
        {session.memberships.length > 0 && (
          <Card title="Choose a workspace">
            <div className="space-y-2">
              {session.memberships.map((m) => (
                <Button key={m.workspaceId} onClick={() => choose(m.workspaceId)} className="w-full justify-start" icon={Building2}>
                  {m.name} · {m.role}
                </Button>
              ))}
            </div>
          </Card>
        )}
        {session.features.allowWorkspaceCreation ? (
          <Card title="Create your workspace" subtitle="A workspace holds your team, accounts, data sources and reports. It starts empty — nothing is pre-filled.">
            <form onSubmit={create} className="space-y-3">
              <TextInput label="Workspace name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Marketing" />
              <Button type="submit" variant="primary" busy={busy}>Create workspace</Button>
              {error ? <ErrorBox error={error} /> : null}
            </form>
          </Card>
        ) : (
          session.memberships.length === 0 && (
            <Notice>You are signed in as {session.user.email} but are not a member of any workspace yet. Ask a workspace owner to add you.</Notice>
          )
        )}
        <Button variant="ghost" onClick={() => apiSend('POST', '/auth/logout').then(() => qc.invalidateQueries())}>Sign out</Button>
      </div>
    </FullPage>
  );
}

function AccountSetup({ canManage, onCreated, initialName = '' }: { canManage: boolean; onCreated: (a: Account) => void; initialName?: string }) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [form, setForm] = useState({ name: initialName, timezone: browserTz, currency: 'USD', brand: { officialWebsite: defaultBusinessWebsite(initialName) || '' } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!canManage) return <Notice>No Responsys account has been set up in this workspace yet. A workspace owner needs to add one.</Notice>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await apiSend<Account>('POST', '/accounts', form));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-xl mx-auto">
      <Card title="Add your Responsys account" subtitle="Reports use this account's timezone and currency. Confirm them — they define what 'last 7 days' and revenue mean.">
        <form onSubmit={submit} className="space-y-3">
          <TextInput label="Account name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Main Responsys account" />
          <TextInput label="Official business website" type="url" value={form.brand.officialWebsite} onChange={(e) => setForm({ ...form, brand: { officialWebsite: e.target.value } })} placeholder="https://www.amildental.com.br/" hint="Used with your report data to tailor AI recommendations to the business." />
          <TextInput label="Account timezone (IANA)" required value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} hint="The timezone your Responsys account reports in, e.g. America/New_York or Asia/Kolkata." />
          <TextInput label="Reporting currency (ISO code)" required maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} hint="Revenue is never converted between currencies." />
          <Button type="submit" variant="primary" busy={busy}>Create account</Button>
          {error ? <ErrorBox error={error} /> : null}
        </form>
      </Card>
    </div>
  );
}

/** Account choice belongs to the sign-in/onboarding flow, before any report screen mounts. */
function AccountEntry({ session }: { session: Session }) {
  const qc = useQueryClient();
  const accounts = useAccounts(true);
  const storageKey = `rci.account:${session.user.id}:${session.workspace!.id}`;
  const [activeId, setActiveId] = useState<string | null>(() => sessionStorage.getItem('rci.loginPending') ? null : new URLSearchParams(window.location.search).get('account') || sessionStorage.getItem(storageKey));
  const [selectedId, setSelectedId] = useState<string | null>(activeId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canManage = session.workspace!.permissions.includes('workspace.manage');
  const rows = accounts.data ?? [];
  const active = rows.find((a) => a.id === activeId);
  const selected = rows.find((a) => a.id === selectedId);
  const preset = BUSINESS_ACCOUNTS.find((b) => `business:${b.key}` === selectedId);
  const enter = async (account: Account) => {
    // Drop transient report state and in-flight work before mounting the new account shell.
    const scoped = { predicate: (query: { queryKey: readonly unknown[] }) => !['session', 'accounts', 'auth-config'].includes(String(query.queryKey[0])) };
    await qc.cancelQueries(scoped);
    qc.removeQueries(scoped);
    sessionStorage.setItem(storageKey, account.id);
    sessionStorage.removeItem('rci.loginPending');
    sessionStorage.removeItem('rci.loginBusiness');
    window.history.replaceState(null, '', `${window.location.pathname}?account=${encodeURIComponent(account.id)}&tab=briefing`);
    setSelectedId(account.id); setActiveId(account.id);
  };
  if (accounts.isLoading) return <FullPage><Loading label="Loading your accounts…" /></FullPage>;
  if (accounts.error) return <FullPage><ErrorBox error={accounts.error} onRetry={() => accounts.refetch()} /></FullPage>;
  if (active) return <Shell key={active.id} session={session} account={active} onChooseAccount={() => {
    sessionStorage.removeItem(storageKey);
    sessionStorage.setItem('rci.loginPending', '1');
    setSelectedId(active.id); setActiveId(null);
  }} />;
  const created = (account: Account) => {
    qc.setQueryData<Account[]>(qk.accounts, (items) => [...(items ?? []), account]);
    void enter(account);
  };
  const continueToAccount = async () => {
    setBusy(true); setError(null);
    try {
      if (selected) await enter(selected);
      else if (preset && canManage) {
        // Reuse an existing business account; never copy datasets to a new business.
        const existing = rows.find((a) => configuredBusiness(a.name)?.key === preset.key);
        const account = existing ?? await apiSend<Account>('POST', '/accounts', { name: preset.name, timezone: preset.timezone, currency: preset.currency, brand: { officialWebsite: preset.website } });
        if (!existing) qc.setQueryData<Account[]>(qk.accounts, (items) => [...(items ?? []), account]);
        await enter(account);
      }
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return <FullPage><div className="space-y-4">
    <Card title="Choose your account" subtitle="Select the business to load its uploads, reports and recommendations.">
      <div className="space-y-4">
        <label className="block text-xs font-semibold">Account
          <select aria-label="Account" value={selectedId ?? ''} onChange={(e) => { setSelectedId(e.target.value); setError(null); }} className="mt-1 block w-full rounded-lg border border-gray-300 bg-white p-2.5 text-sm">
            <option value="" disabled>Select an account</option>
            {rows.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {BUSINESS_ACCOUNTS.filter((b) => !rows.some((a) => configuredBusiness(a.name)?.key === b.key)).map((b) => <option key={b.key} value={`business:${b.key}`} disabled={!canManage}>{b.name}</option>)}
            {canManage && <option value="other">Other account</option>}
          </select>
        </label>
        {selected && <AccountBusinessContext hideSelection key={`${selected.id}:${selected.brand.officialWebsite || ''}`} accounts={rows} account={selected} canManage={canManage} onAdd={() => setSelectedId('other')} onSelect={setSelectedId} />}
        {preset && <div className="rounded-xl border border-[#e8dcc9] bg-white p-4 text-xs space-y-2"><p>Official website: <a className="underline break-all" href={preset.website} target="_blank" rel="noreferrer">{preset.website}</a></p><p>Timezone: {preset.timezone} · Currency: {preset.currency}</p><p>Continue to create this business account with an empty data library. Upload a CSV for this account to begin.</p></div>}
        {(selected || preset) && <Button variant="primary" busy={busy} onClick={continueToAccount}>Continue to application</Button>}
        {selected && canManage && <Button variant="ghost" onClick={() => setSelectedId('other')}>Add account</Button>}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </Card>
    {selectedId === 'other' && <AccountSetup canManage={canManage} onCreated={created} />}
    <Button variant="ghost" onClick={async () => { await apiSend('POST', '/auth/logout'); qc.clear(); window.location.href = '/'; }}>Sign out</Button>
  </div></FullPage>;
}

function Shell({ session, account, onChooseAccount }: { session: Session; account: Account; onChooseAccount: () => void }) {
  const qc = useQueryClient();
  const [sel, update] = useSelection();
  const datasets = useDatasets(account?.id ?? null);
  const active = (datasets.data ?? []).filter((d) => d.activeVersionId);
  const dataset: Dataset | null = active.find((d) => d.id === sel.datasetId) ?? active[0] ?? null;
  const connections = useConnections(account?.id ?? null);
  const campaignList = useCampaignList(dataset?.grain === 'account_window' ? null : dataset?.id ?? null);
  const campaigns = campaignList.data ?? [];
  const perms = new Set(session.workspace?.permissions ?? []);
  const [exportOpen, setExportOpen] = useState(false);
  const [newCampaign, setNewCampaign] = useState<{ open: boolean; initial: Omit<BuilderInput, 'account'> | null }>({ open: false, initial: null });
  const [simRecIds, setSimRecIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<{ id: number; question: string } | null>(null);
  // The last AI Simulator scenario, kept for Ask AI while the period (report) stays the same.
  const [simScenario, setSimScenario] = useState<SimulatorScenario | null>(null);

  useEffect(() => {
    if (account && sel.accountId !== account.id) update({ accountId: account.id });
  }, [account, sel.accountId, update]);
  useEffect(() => {
    if (dataset && sel.datasetId !== dataset.id) update({ datasetId: dataset.id });
  }, [dataset, sel.datasetId, update]);
  const campaignId = sel.campaignId && campaigns.some((c) => c.campaignId === sel.campaignId) ? sel.campaignId : campaigns[0]?.campaignId ?? null;
  useEffect(() => {
    if (campaignId && sel.campaignId !== campaignId && (sel.tab === 'analyse' || sel.tab === 'chat')) update({ campaignId });
  }, [campaignId, sel.campaignId, sel.tab, update]);

  const isWindow = dataset?.grain === 'account_window';
  const coverage = dataset?.coverageStart && dataset.coverageEndExclusive ? { start: dataset.coverageStart, endInclusive: addDays(dataset.coverageEndExclusive, -1) } : null;
  const period = useMemo(() => {
    if (!dataset || isWindow) return undefined;
    if (sel.period !== 'custom') return { preset: presetFor(sel.period) };
    const startDate = sel.start || coverage?.start;
    const endDate = sel.end || coverage?.endInclusive;
    return startDate && endDate ? { preset: 'custom', startDate, endDate } : undefined;
  }, [dataset, isWindow, sel.period, sel.start, sel.end, coverage?.start, coverage?.endInclusive]);

  const overviewBody = useMemo(
    () => (account && dataset ? { accountId: account.id, datasetId: dataset.id, period, windowKey: isWindow ? sel.windowKey ?? undefined : undefined, comparison: sel.comparison, channels: sel.channel ? [sel.channel] : [] } : null),
    [account, dataset, period, isWindow, sel.windowKey, sel.comparison, sel.channel]
  );
  const overview = useReport<OverviewResult>('overview', overviewBody);
  const campaignBody = useMemo(
    () => (account && dataset && campaignId && !isWindow && (sel.tab === 'analyse' || (sel.tab === 'chat' && sel.chatScope === 'campaign')) ? { accountId: account.id, datasetId: dataset.id, campaignId, period, comparison: sel.comparison, benchmark: { type: 'account_period' } } : null),
    [account, dataset, campaignId, isWindow, sel.tab, sel.chatScope, period, sel.comparison]
  );
  const campaignReport = useReport<CampaignReportResult>('campaign', campaignBody);
  useEffect(() => {
    if (isWindow && !sel.windowKey && overview.data?.period && 'windowKey' in overview.data.period) update({ windowKey: (overview.data.period as { windowKey: string }).windowKey });
  }, [isWindow, sel.windowKey, overview.data, update]);

  const link = useLiveEvents(account?.id ?? null, session.features.liveUpdates);
  const logout = async () => {
    await apiSend('POST', '/auth/logout');
    sessionStorage.removeItem(`rci.account:${session.user.id}:${session.workspace!.id}`);
    qc.clear();
    window.location.href = '/';
  };
  const conn = connections.data?.[0];
  const showToast = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3500);
  };
  const onReportCompare = useCallback((r: ComparisonResult | null) => setComparison(r), []);
  // Ask AI uses the whole dashboard (the Summary's report for the selected period) unless one
  // campaign is chosen; account summary files have no campaigns.
  const chatOnCampaign = sel.chatScope === 'campaign' && !isWindow && campaigns.length > 0;
  const chatReport = chatOnCampaign ? campaignReport : overview;
  const askAi: AskAi = useCallback(
    (question, scope = 'account') => {
      update({ tab: 'chat', chatScope: scope });
      setPendingAsk({ id: Date.now(), question });
      window.scrollTo({ top: 0 });
    },
    [update]
  );
  const exportable: AnyReport | null =
    sel.tab === 'briefing' ? overview.data ?? null : sel.tab === 'battlecard' ? comparison : sel.tab === 'analyse' ? campaignReport.data ?? null : sel.tab === 'chat' ? chatReport.data ?? null : null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['report'] });
    void qc.invalidateQueries({ queryKey: qk.datasets(account?.id ?? '') });
    void qc.invalidateQueries({ queryKey: ['campaigns'] });
  };
  const useDataset = (id: string | null) => {
    update({ tab: 'briefing', datasetId: id, windowKey: null, start: '', end: '', period: 'custom', campaignId: null, benchmarkId: null, compareIds: [] });
    showToast('Data imported. All pages now use the new data.');
  };

  const needData = (what: string) => (
    <section className="rounded-2xl border border-[#e8dcc9] bg-[#fffaf5] p-8 text-center shadow-sm">
      <Upload className="w-8 h-8 mx-auto text-[#C74634]" />
      <h2 className="mt-2 text-base font-bold text-[#2d241d]">Upload your data first</h2>
      <p className="text-xs text-[#6b554d] mt-1">{what}</p>
      <button onClick={() => update({ tab: 'briefing' })} className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#C74634] text-white">Go to Summary to upload</button>
    </section>
  );
  const reportState = (q: { isLoading: boolean; error: unknown; refetch: () => unknown }) =>
    q.isLoading ? <Loading label="Building the report…" /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null;

  const body = (() => {
    const upload = <UploadExport account={account} session={session} perms={perms} datasets={datasets.data ?? []} active={dataset} onUseDataset={useDataset} compact={Boolean(dataset)} manageOpen={manageOpen} setManageOpen={setManageOpen} />;
    const connectSection = <section id="connect-jobs" aria-label="Connect jobs" className="mt-6"><ConnectJobs key={account.id} account={account} perms={perms} /></section>;
    switch (sel.tab) {
      case 'briefing':
        return (
          <>
            {upload}
            {!dataset && !datasets.isLoading && (
              <section className="rounded-2xl border border-[#e8dcc9] bg-white p-6 text-xs text-[#6b554d]">
                <h2 className="text-base font-bold text-[#2d241d]">No data yet</h2>
                <p className="mt-1">Upload a Responsys Campaign Performance export or a campaign metrics file above (use <strong>Template</strong> for the columns), or connect Responsys under <strong>Data &amp; connections</strong>. Nothing is shown until real data is imported.</p>
              </section>
            )}
            {dataset && (reportState(overview) ?? (overview.data && (
              <ExecutiveBriefing
                report={overview.data}
                account={account}
                onNavigateToSimulator={() => { setSimRecIds([]); update({ tab: 'simulator' }); }}
                onSimulateRecommendations={(ids) => { setSimRecIds(ids); update({ tab: 'simulator' }); window.scrollTo({ top: 0 }); }}
                onNavigateToChat={() => update({ tab: 'chat' })}
                onSelectCampaignForDetail={(id) => { update({ tab: 'analyse', campaignId: id }); window.scrollTo({ top: 0 }); }}
                connectSection={connectSection}
              />
            )))}
            {(!dataset || overview.isLoading || overview.error || !overview.data) ? connectSection : null}
          </>
        );
      case 'simulator':
        if (!dataset) return needData('The AI Simulator starts from your measured results.');
        return reportState(overview) ?? (overview.data && (
          <WhatIfSimulator
            key={`${overview.data.meta.reportId}-${simRecIds.join('|')}`}
            account={account}
            report={overview.data}
            initialRecIds={simRecIds}
            canSave={perms.has('scenario.create')}
            onNavigateToSummary={() => update({ tab: 'briefing' })}
            onCreate={(initial) => setNewCampaign({ open: true, initial })}
            onScenarioChange={setSimScenario}
          />
        ));
      case 'analyse':
        if (!dataset || isWindow) return needData(isWindow ? 'The selected data is an account summary export, which has no campaigns. Upload a campaign metrics file to analyse campaigns.' : 'Analyze Campaign needs campaign data.');
        if (!campaigns.length) return campaignList.isLoading ? <Loading /> : needData('No campaigns found in this data.');
        return reportState(campaignReport) ?? (campaignReport.data && <SingleCampaignAnalysis key={campaignReport.data.meta.reportId} report={campaignReport.data} onNavigateToSimulator={() => update({ tab: 'simulator' })} />);
      case 'battlecard':
        if (!dataset || isWindow) return needData('Compare Campaigns needs campaign data.');
        return <ComparativeBattlecard account={account} datasetId={dataset.id} period={period} campaigns={campaigns} sel={sel} update={update} onReport={onReportCompare} onSave={() => setExportOpen(true)} />;
      case 'chat': {
        if (!dataset) return needData('Ask AI answers from your imported data.');
        const r = chatReport;
        return (
          reportState(r) ??
          (r.data && (
            <AnalystChat
              key={chatOnCampaign ? `campaign:${campaignId}` : `account:${dataset.id}`}
              report={r.data}
              session={session}
              pending={pendingAsk}
              onPendingHandled={() => setPendingAsk(null)}
              onScopeChange={(scope) => update({ chatScope: scope })}
              canPickCampaign={!isWindow && campaigns.length > 0}
              scenario={simScenario}
            />
          ))
        );
      }
    }
  })();

  const linkOk = link === 'live' || link === 'polling';
  return (
    <AskAiContext.Provider value={askAi}>
    <div className="min-h-screen bg-[#F4F5F7] text-[#161616] flex flex-col font-sans selection:bg-[#C74634] selection:text-white">
      {session.features.dataMode === 'demo' && <div className="bg-indigo-700 text-white text-center text-xs font-bold py-1">DEMO — NOT CUSTOMER DATA</div>}
      <Header
        session={session}
        account={account}
        onChooseAccount={onChooseAccount}
        sel={sel}
        update={update}
        datasets={datasets.data ?? []}
        campaigns={campaigns}
        coverage={coverage}
        isLoading={overview.isFetching || campaignReport.isFetching}
        chatCampaignsAvailable={!isWindow && campaigns.length > 0}
        onRefreshData={refresh}
        onExportReport={exportable ? () => setExportOpen(true) : null}
        onLogout={logout}
      />
      <main className="flex-1 max-w-none w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {toast && sel.tab === 'briefing' && (
          <div className="p-3 rounded-xl bg-white border border-gray-200 text-xs text-gray-800 flex items-center justify-between shadow-sm" role="status">
            <div className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /><span>{toast}</span></div>
            <button onClick={() => setToast(null)} className="text-gray-400 hover:text-gray-700 text-xs px-1">✕</button>
          </div>
        )}
        <ScreenBoundary resetKey={`${account?.id}|${sel.tab}|${sel.datasetId}|${sel.period}|${sel.campaignId}`}>{body}</ScreenBoundary>
      </main>
      <footer className="bg-white border-t border-gray-200 py-6 mt-12 text-xs text-gray-500">
        <div className="max-w-none mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <span className="font-bold text-gray-900">Responsys AI Insights</span>
            <span>&bull;</span>
            <span>Oracle Enterprise Analytics Engine</span>
            {dataset && <span className="hidden md:inline text-gray-400">· {dataset.name} v{dataset.activeVersion}</span>}
          </div>
          <div className="flex items-center space-x-4">
            <AiStatusBadge configured={session.features.aiProvider !== 'none'} />
            <span title="Checked by an actual Responsys API call">Responsys: {conn ? conn.status : 'not connected'}</span>
            <span className={`flex items-center gap-1.5 font-bold ${linkOk ? 'text-emerald-600' : link === 'offline' ? 'text-rose-600' : 'text-gray-500'}`} role="status" title="Whether this page can reach the server right now">
              <span className={`w-2 h-2 rounded-full ${linkOk ? 'bg-emerald-500 animate-pulse' : link === 'offline' ? 'bg-rose-500' : 'bg-gray-400'}`} />
              {`System Status: ${linkOk ? 'Connected' : link === 'offline' ? 'Server unreachable' : 'Checking…'}`}
            </span>
          </div>
        </div>
      </footer>
      <ExportModal isOpen={exportOpen} report={exportable} onClose={() => setExportOpen(false)} />
      {account && (
        <NewCampaignModal
          key={newCampaign.initial ? JSON.stringify(newCampaign.initial).length : 0}
          isOpen={newCampaign.open}
          onClose={() => setNewCampaign({ open: false, initial: null })}
          account={account}
          session={session}
          perms={perms}
          initial={newCampaign.initial}
        />
      )}
    </div>
    </AskAiContext.Provider>
  );
}
