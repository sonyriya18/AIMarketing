/**
 * React Query hooks. Query keys include the account, dataset, and scope so a revision change
 * (from live events) invalidates exactly the affected data. Server data lives only here.
 */
import type { StrategyKey } from '../../shared/scenario/strategies';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, setCsrfToken, ApiError } from './api';
import type { Account, CampaignListItem, Connection, Dataset, ImportRecord, Session, OverviewResult, CampaignReportResult, ComparisonResult } from './types';

export const qk = {
  session: ['session'] as const,
  accounts: ['accounts'] as const,
  datasets: (accountId: string) => ['datasets', accountId] as const,
  imports: (accountId: string) => ['imports', accountId] as const,
  campaigns: (datasetId: string) => ['campaigns', datasetId] as const,
  report: (kind: string, body: unknown) => ['report', kind, body] as const,
  connections: (accountId: string) => ['connections', accountId] as const,
  connect: (accountId: string) => ['connect-summary', accountId] as const,
  drafts: (accountId: string) => ['drafts', accountId] as const,
  draft: (id: string) => ['draft', id] as const,
  approvals: (accountId: string) => ['approvals', accountId] as const,
  scenarios: (accountId: string) => ['scenarios', accountId] as const,
  members: ['members'] as const,
};

export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: async () => {
      try {
        const s = await apiGet<Session>('/session');
        setCsrfToken(s.csrfToken);
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

export const useAuthConfig = () => useQuery({ queryKey: ['auth-config'], queryFn: () => apiGet<{ mode: 'dev' | 'oidc'; providerName?: string | null }>('/auth/config'), staleTime: Infinity });

export const useAccounts = (enabled: boolean) => useQuery({ queryKey: qk.accounts, queryFn: () => apiGet<Account[]>('/accounts'), enabled });

export const useDatasets = (accountId: string | null) =>
  useQuery({ queryKey: qk.datasets(accountId ?? ''), queryFn: () => apiGet<Dataset[]>(`/accounts/${accountId}/datasets`), enabled: Boolean(accountId) });

export const useImports = (accountId: string | null) =>
  useQuery({ queryKey: qk.imports(accountId ?? ''), queryFn: () => apiGet<ImportRecord[]>(`/accounts/${accountId}/imports`), enabled: Boolean(accountId) });

export const useCampaignList = (datasetId: string | null, enabled = true) =>
  useQuery({ queryKey: qk.campaigns(datasetId ?? ''), queryFn: () => apiGet<CampaignListItem[]>(`/datasets/${datasetId}/campaigns`), enabled: Boolean(datasetId) && enabled });

export const useConnections = (accountId: string | null) =>
  useQuery({ queryKey: qk.connections(accountId ?? ''), queryFn: () => apiGet<Connection[]>(`/accounts/${accountId}/connections`), enabled: Boolean(accountId) });

/** Connect diagnostics for a report period: `from` inclusive, `toExclusive` = the period's endDateExclusive. */
export const useConnectSummary = (accountId: string | null, from?: string, toExclusive?: string) =>
  useQuery({
    queryKey: [...qk.connect(accountId ?? ''), from, toExclusive],
    queryFn: () => apiGet<any>(`/accounts/${accountId}/connect-summary${from && toExclusive ? `?from=${from}&toExclusive=${toExclusive}` : ''}`),
    enabled: Boolean(accountId),
  });

/** Report snapshots are POSTed (validated scope in the body) and cached by that scope. */
export function useReport<T = OverviewResult | CampaignReportResult | ComparisonResult>(kind: 'overview' | 'campaign' | 'comparison', body: Record<string, unknown> | null) {
  return useQuery({
    queryKey: qk.report(kind, body),
    queryFn: () => apiSend<T>('POST', `/reports/${kind}`, body),
    enabled: Boolean(body),
    placeholderData: (prev) => prev && (prev as unknown as OverviewResult).meta.accountId === body?.accountId ? prev : undefined,
    retry: (n, e) => e instanceof ApiError && e.retryable && n < 2,
  });
}

export interface SummaryFact {
  id: string;
  section: string;
  text: string;
}
export interface SummarySection {
  key: string;
  title: string;
  headline: string;
  points: { kind: 'observation' | 'recommendation' | 'limitation'; text: string; factIds: string[] }[];
  generator: 'ai' | 'rule_based';
  unavailable: string | null;
}
export interface PageSummary {
  reportId: string;
  focus: 'page' | 'simulator';
  sections: SummarySection[];
  facts: SummaryFact[];
  aiStatus: 'completed' | 'partial' | 'disabled' | 'not_permitted' | 'failed' | 'rate_limited' | 'rejected';
  model: string | null;
  rejectedPoints: number;
  aiError?: string | null;
  /** Simulator only: the AI's strategy pick for this period, checked against the facts. */
  strategyPick?: { strategyKey: StrategyKey; name: string; reason: string; factIds: string[] } | null;
  businessContext?: { status: 'ready' | 'unavailable' | 'not_configured'; website: string | null; checkedAt: string; message: string; sources: { url: string; text: string }[]; offers?: import('../../shared/business/offers').WebsiteOffer[] };
  businessStrategies?: { strategyKey: StrategyKey; name: string; reason: string; goal: string; actions: string[]; factIds: string[]; generator?: 'ai' | 'rule_based' }[];
  cached?: boolean;
}

export interface AiStatus {
  provider: string;
  model: string | null;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
}

/** Real AI check (one tiny model call on the server); nothing is claimed before it answers. */
export function useAiStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['ai-status'],
    queryFn: () => apiGet<AiStatus>('/ai/status'),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Report evidence is immutable; website context is periodically refreshed. */
export function usePageSummary(reportId: string | null | undefined, focus: 'page' | 'simulator' = 'page') {
  return useQuery({
    queryKey: ['summary', reportId, focus],
    queryFn: () => apiSend<PageSummary>('POST', `/reports/${reportId}/summary`, { focus }),
    enabled: Boolean(reportId),
    staleTime: 5 * 60_000,
    retry: (n, e) => e instanceof ApiError && e.retryable && n < 1,
  });
}

export function invalidateAccountData(qc: QueryClient, accountId: string) {
  void qc.invalidateQueries({ queryKey: ['report'] });
  void qc.invalidateQueries({ queryKey: qk.datasets(accountId) });
  void qc.invalidateQueries({ queryKey: qk.imports(accountId) });
  void qc.invalidateQueries({ queryKey: ['campaigns'] });
  void qc.invalidateQueries({ queryKey: qk.accounts });
}

export function useApiMutation<TVars, TOut>(fn: (v: TVars) => Promise<TOut>, onSuccess?: (out: TOut, v: TVars, qc: QueryClient) => void) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (out, v) => onSuccess?.(out, v, qc) });
}
