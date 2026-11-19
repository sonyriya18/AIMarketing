export type {
  MetricValue,
  MetricChange,
  EvidenceItem,
  Finding,
  Capability,
  OverviewResult,
  CampaignReportResult,
  ComparisonResult,
  CampaignRow,
  ReportMeta,
  DataSourceInfo,
  TrendPoint,
  WindowSummary,
  DimensionRow,
} from '../../shared/contracts/reports';
export type { DraftContent, LocalValidation } from '../../shared/contracts/drafts';
export type { ScenarioOutput, ScenarioInputs } from '../../shared/scenario/engine';
export type { PeriodPreset, ComparisonPolicy } from '../../shared/time/periods';

export interface Session {
  user: { id: string; email: string; displayName: string };
  csrfToken: string;
  authMode: 'dev' | 'oidc';
  workspace: { id: string; name: string; role: string; permissions: string[] } | null;
  memberships: { workspaceId: string; name: string; role: string }[];
  features: {
    aiProvider: 'none' | 'gemini';
    allowWorkspaceCreation: boolean;
    dataMode: string;
    uploadMaxBytes: number;
    liveUpdates: 'sse' | 'poll';
    killSwitches: { providerDraftWrites: boolean; proofSends: boolean; liveCampaignSends: boolean };
  };
}

export interface Account {
  id: string;
  name: string;
  externalAccountId: string | null;
  timezone: string;
  currency: string;
  locale: string;
  brand: { name?: string; senderName?: string; domain?: string; allowedLinkDomains?: string[]; officialWebsite?: string };
  contentPack: 'starter' | 'amil_example';
  dataRevision: string;
}

export interface Dataset {
  id: string;
  accountId: string;
  name: string;
  sourceType: 'upload_legacy_summary' | 'upload_campaign_metrics' | 'responsys_reporting';
  grain: 'account_window' | 'campaign_launch' | 'campaign_day';
  timeBasis: string;
  activeVersionId: string | null;
  archivedAt: string | null;
  activeVersion: number | null;
  currency: string | null;
  timezone: string | null;
  coverageStart: string | null;
  coverageEndExclusive: string | null;
  sourceAsOf: string | null;
  rowCount: number | null;
  quality: { warnings?: string[]; conflicts?: string[]; limitations?: string[]; semantics?: Record<string, string> } | null;
  activatedAt: string | null;
}

export interface ImportRecord {
  id: string;
  accountId: string;
  format: 'legacy_summary' | 'campaign_metrics' | 'unknown';
  status: string;
  detection: any;
  mapping: any;
  validation: any;
  targetDatasetId: string | null;
  datasetVersionId: string | null;
  duplicateOf: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  fileName: string;
  byteSize: string;
  sha256: string;
  createdByEmail: string | null;
}

export interface CampaignListItem {
  campaignId: string;
  externalId: string;
  name: string;
  channel: string;
  program: string | null;
  firstLaunchDate: string;
  lastLaunchDate: string;
  launchCount: number;
}

export interface Connection {
  id: string;
  accountId: string;
  displayName: string;
  loginBaseUrl?: string;
  credentialRef?: string;
  status: string;
  capabilities: Record<string, { status: string; detail: string | null; checkedAt: string }>;
  serviceEndpoint: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  syncEnabled: boolean;
  reportingDatasetId: string | null;
  lastSyncAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
}
