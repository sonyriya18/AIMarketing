/**
 * Supported import formats and header detection.
 *
 * A. legacy_summary  — the existing account-period export (one row per channel and
 *    "Sent Date Range"). Treated as a source format to map, not an Oracle standard.
 * B. campaign_metrics — one row per campaign launch (optionally per activity date) with
 *    explicitly named total/unique measures. Template: docs/DATA_DICTIONARY.md.
 */
import { z } from 'zod';
import { DELIMITERS, ENCODINGS, normHeader } from './parse/text';
import { DATE_FORMATS } from './parse/values';

export const LEGACY_FIELDS = {
  channel: ['channel'],
  range: ['sentdaterange', 'senddaterange', 'daterange', 'period', 'timeperiod'],
  sent: ['sent', 'totalsent'],
  delivered: ['delivered', 'totaldelivered'],
  skipped: ['skipped'],
  bounceRate: ['bouncerate'],
  softBounceRate: ['softbouncerate'],
  hardBounceRate: ['hardbouncerate'],
  openRate: ['openrate'],
  uniqueOpenRate: ['uniqueopenrate'],
  totalOpenRate: ['totalopenrate'],
  clickRate: ['clickthroughrate', 'clickrate', 'ctr'],
  uniqueClickRate: ['uniqueclickthroughrate', 'uniqueclickrate'],
  totalClickRate: ['totalclickthroughrate', 'totalclickrate'],
  revenue: ['revenue', 'totalrevenue'],
  unsubscribeRate: ['unsubscriberate', 'optoutrate'],
  conversions: ['conversions'],
} as const;
export type LegacyField = keyof typeof LEGACY_FIELDS;

export const CAMPAIGN_FIELDS = {
  campaignId: ['campaignid', 'campaignexternalid', 'externalcampaignid'],
  campaignName: ['campaignname', 'name'],
  launchId: ['launchid', 'launchexternalid'],
  channel: ['channel'],
  launchDate: ['launchdate', 'senddate', 'sentdate'],
  launchTime: ['launchtime', 'sendtime', 'senttime'],
  activityDate: ['activitydate', 'eventdate', 'reportdate'],
  program: ['program', 'programname'],
  subjectLine: ['subjectline', 'subject'],
  creativeType: ['creativetype', 'contenttype', 'creative', 'creativeformat', 'templatetype', 'layout'],
  offer: ['offer', 'offertype', 'offername', 'incentive', 'promotion', 'promotype', 'discount'],
  currency: ['currency', 'currencycode'],
  sent: ['sent', 'totalsent'],
  delivered: ['delivered', 'totaldelivered'],
  skipped: ['skipped'],
  bounces: ['bounces', 'bounced', 'totalbounces'],
  totalOpens: ['totalopens'],
  uniqueOpens: ['uniqueopens'],
  opensUnspecified: ['opens'],
  totalClicks: ['totalclicks'],
  uniqueClicks: ['uniqueclicks'],
  clicksUnspecified: ['clicks'],
  conversionEvents: ['conversions', 'conversionevents'],
  orders: ['orders', 'purchases'],
  revenue: ['revenue', 'attributedrevenue'],
  unsubscribes: ['unsubscribes', 'optouts'],
  complaints: ['complaints', 'spamcomplaints'],
} as const;
export type CampaignField = keyof typeof CAMPAIGN_FIELDS;

export type ImportFormat = 'legacy_summary' | 'campaign_metrics';

export interface HeaderDetection {
  format: ImportFormat | 'unknown';
  headerRowIndex: number;
  headers: string[];
  columns: Record<string, number>;
  duplicateHeaders: string[];
  unmappedHeaders: string[];
}

function matchColumns(cells: string[], fields: Record<string, readonly string[]>) {
  const normalized = cells.map(normHeader);
  const columns: Record<string, number> = {};
  const used = new Set<number>();
  for (const [field, aliases] of Object.entries(fields)) {
    const idx = normalized.findIndex((c, i) => !used.has(i) && aliases.includes(c));
    if (idx !== -1) {
      columns[field] = idx;
      used.add(idx);
    }
  }
  const seen = new Map<string, number>();
  normalized.forEach((c) => c && seen.set(c, (seen.get(c) ?? 0) + 1));
  return {
    columns,
    duplicateHeaders: [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => cells[normalized.indexOf(c)]!.trim()),
    unmappedHeaders: cells.filter((c, i) => c.trim() && !used.has(i)).map((c) => c.trim()),
  };
}

export function detectHeader(rows: string[][]): HeaderDetection {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i]!;
    const camp = matchColumns(cells, CAMPAIGN_FIELDS);
    if (camp.columns.campaignId !== undefined && (camp.columns.launchDate !== undefined || camp.columns.activityDate !== undefined)) {
      return { format: 'campaign_metrics', headerRowIndex: i, headers: cells.map((c) => c.trim()), ...camp };
    }
    const legacy = matchColumns(cells, LEGACY_FIELDS);
    if (legacy.columns.range !== undefined && (legacy.columns.sent !== undefined || legacy.columns.delivered !== undefined)) {
      return { format: 'legacy_summary', headerRowIndex: i, headers: cells.map((c) => c.trim()), ...legacy };
    }
  }
  return { format: 'unknown', headerRowIndex: -1, headers: rows[0]?.map((c) => c.trim()) ?? [], columns: {}, duplicateHeaders: [], unmappedHeaders: [] };
}

// ---------------------------------------------------------------- legacy window labels
export interface WindowDef {
  key: string;
  kind: 'today' | 'yesterday' | 'days' | 'months';
  n: number;
}

const WINDOW_LABELS: Record<string, WindowDef> = {
  today: { key: 'today', kind: 'today', n: 1 },
  yesterday: { key: 'yesterday', kind: 'yesterday', n: 1 },
  last7days: { key: 'last_7_days', kind: 'days', n: 7 },
  last14days: { key: 'last_14_days', kind: 'days', n: 14 },
  last30days: { key: 'last_30_days', kind: 'days', n: 30 },
  last60days: { key: 'last_60_days', kind: 'days', n: 60 },
  last90days: { key: 'last_90_days', kind: 'days', n: 90 },
  last180days: { key: 'last_180_days', kind: 'days', n: 180 },
  last365days: { key: 'last_365_days', kind: 'days', n: 365 },
  last3months: { key: 'last_3_months', kind: 'months', n: 3 },
  last6months: { key: 'last_6_months', kind: 'months', n: 6 },
  last12months: { key: 'last_12_months', kind: 'months', n: 12 },
  last2years: { key: 'last_2_years', kind: 'months', n: 24 },
};

export function windowFor(label: string): WindowDef | null {
  return WINDOW_LABELS[normHeader(label)] ?? null;
}

export const SUPPORTED_WINDOW_LABELS = ['Today', 'Yesterday', 'Last 7 Days', 'Last 14 Days', 'Last 30 Days', 'Last 60 Days', 'Last 90 Days', 'Last 180 Days', 'Last 365 Days', 'Last 3 Months', 'Last 6 Months', 'Last 12 Months', 'Last 2 Years'];

export function normalizeChannel(raw: string): string {
  const n = normHeader(raw);
  if (!n) return '';
  if (n === 'email' || n === 'mail') return 'Email';
  if (n === 'sms' || n === 'smsblast' || n === 'text') return 'SMS';
  if (n === 'mobileapp' || n === 'mobileapps' || n === 'push' || n === 'pushnotification' || n === 'apppush') return 'Mobile App';
  if (n === 'webpush') return 'Web Push';
  return raw.trim().slice(0, 40);
}

// ---------------------------------------------------------------- mapping confirmation
const NumberFormatSchema = z.object({
  decimal: z.enum(['.', ',']),
  thousands: z.enum([',', '.', ' ', '']),
}).refine((f) => f.decimal !== f.thousands, 'Decimal and thousands separators must differ');

const Common = {
  encoding: z.enum(ENCODINGS),
  delimiter: z.enum(DELIMITERS),
  headerRowIndex: z.number().int().min(0).max(14),
  columns: z.record(z.string(), z.number().int().min(0).max(199).nullable()),
  numberFormat: NumberFormatSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezoneConfirmed: z.literal(true, { error: 'Confirm that the file uses the account timezone' }),
  datasetName: z.string().trim().min(1).max(160),
  targetDatasetId: z.string().uuid().nullable().default(null),
};

export const LegacyMappingSchema = z.object({
  format: z.literal('legacy_summary'),
  ...Common,
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Export date must be YYYY-MM-DD'),
  windowEnd: z.enum(['end_of_previous_day', 'end_of_as_of_day']),
  rateScale: z.enum(['percent', 'fraction']),
  openRateMeaning: z.enum(['unique', 'total', 'not_stated']).optional(),
  clickRateMeaning: z.enum(['unique', 'total', 'not_stated']).optional(),
  conversionsMeaning: z.enum(['events', 'not_stated']).optional(),
  defaultChannel: z.string().trim().min(1).max(40).optional(),
});

export const CampaignMappingSchema = z.object({
  format: z.literal('campaign_metrics'),
  ...Common,
  dateFormat: z.enum(DATE_FORMATS),
  opensMeaning: z.enum(['total', 'unique']).optional(),
  clicksMeaning: z.enum(['total', 'unique']).optional(),
  coverageStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  coverageEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultChannel: z.string().trim().min(1).max(40).optional(),
});

export const MappingSchema = z.discriminatedUnion('format', [LegacyMappingSchema, CampaignMappingSchema]);
export type LegacyMapping = z.infer<typeof LegacyMappingSchema>;
export type CampaignMapping = z.infer<typeof CampaignMappingSchema>;
export type ImportMapping = z.infer<typeof MappingSchema>;
export const MAPPING_VERSION = 1;
