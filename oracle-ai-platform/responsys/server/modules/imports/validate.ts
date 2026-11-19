/**
 * File inspection (detect format and the decisions a user must confirm) and full validation
 * under a confirmed mapping. Validation is deterministic: the same bytes and mapping always
 * produce the same facts and content signature, so the worker can re-run it safely.
 */
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { addDays, addMonths, diffDays, isIsoDate } from '../../../shared/time/zoned';
import {
  CAMPAIGN_FIELDS,
  LEGACY_FIELDS,
  SUPPORTED_WINDOW_LABELS,
  detectHeader,
  normalizeChannel,
  windowFor,
  type CampaignMapping,
  type HeaderDetection,
  type ImportMapping,
  type LegacyMapping,
} from './formats';
import { ParseError, decode, detectDelimiter, inertText, parseRows, type Delimiter, type Encoding } from './parse/text';
import {
  candidateDateFormats,
  candidateNumberFormats,
  parseCount,
  parseDate,
  parseMoney,
  parseRate,
  type CellResult,
  type DateFormat,
  type NumberFormat,
} from './parse/values';

export interface CellError {
  row: number; // 1-based line number of the record in the file
  column: string | null;
  code: string;
  message: string;
  value: string | null;
}

export interface Inspection {
  ok: boolean;
  error?: { code: string; message: string };
  encoding: Encoding | null;
  delimiter: Delimiter | null;
  delimiterCandidates: Delimiter[];
  detection: HeaderDetection | null;
  numberFormatCandidates: NumberFormat[];
  dateFormatCandidates: DateFormat[];
  rateScaleAmbiguous: boolean;
  requiredDecisions: string[];
  proposal: Partial<ImportMapping> & Record<string, unknown>;
  sampleRows: string[][];
  dataRowCount: number;
  supportedWindowLabels?: string[];
}

const RATE_COLUMNS = ['bounceRate', 'softBounceRate', 'hardBounceRate', 'openRate', 'uniqueOpenRate', 'totalOpenRate', 'clickRate', 'uniqueClickRate', 'totalClickRate', 'unsubscribeRate'];
const NUMERIC_LEGACY = ['sent', 'delivered', 'skipped', 'revenue', 'conversions', ...RATE_COLUMNS];
const NUMERIC_CAMPAIGN = ['sent', 'delivered', 'skipped', 'bounces', 'totalOpens', 'uniqueOpens', 'opensUnspecified', 'totalClicks', 'uniqueClicks', 'clicksUnspecified', 'conversionEvents', 'orders', 'revenue', 'unsubscribes', 'complaints'];

const isBlankRow = (r: string[]) => r.every((c) => c.trim() === '');

export function inspect(bytes: Buffer, opts: { encoding?: Encoding; delimiter?: Delimiter; accountCurrency: string } ): Inspection {
  const base: Inspection = {
    ok: false,
    encoding: null,
    delimiter: null,
    delimiterCandidates: [],
    detection: null,
    numberFormatCandidates: [],
    dateFormatCandidates: [],
    rateScaleAmbiguous: false,
    requiredDecisions: [],
    proposal: {},
    sampleRows: [],
    dataRowCount: 0,
  };
  let text: string;
  try {
    const d = decode(bytes, opts.encoding);
    text = d.text;
    base.encoding = d.encoding;
  } catch (e) {
    const pe = e as ParseError;
    return { ...base, requiredDecisions: ['encoding'], error: { code: pe.code ?? 'unreadable', message: pe.message } };
  }
  if (!text.trim()) return { ...base, error: { code: 'empty_file', message: 'The file is empty.' } };

  const det = detectDelimiter(text);
  base.delimiterCandidates = det.candidates;
  const delimiter = opts.delimiter ?? det.delimiter;
  if (!delimiter) {
    return {
      ...base,
      requiredDecisions: ['delimiter'],
      error: det.candidates.length
        ? { code: 'delimiter_ambiguous', message: `The column separator is ambiguous (${det.candidates.map(showDelim).join(' or ')}). Choose one.` }
        : { code: 'no_columns', message: 'No column separator (comma, semicolon, tab or pipe) was found in the first line.' },
    };
  }
  base.delimiter = delimiter;
  let rows: string[][];
  try {
    rows = parseRows(text, delimiter);
  } catch (e) {
    return { ...base, error: { code: (e as ParseError).code, message: (e as Error).message } };
  }
  const detection = detectHeader(rows);
  base.detection = detection;
  if (detection.format === 'unknown') {
    return {
      ...base,
      sampleRows: rows.slice(0, 6).map((r) => r.map(inertText)),
      error: {
        code: 'unknown_format',
        message:
          'The header row was not recognised. Supported files: the account performance export (needs "Sent Date Range" and "Sent" or "Delivered") or the campaign metrics template (needs "Campaign ID" and "Launch Date").',
      },
    };
  }
  const data = rows.slice(detection.headerRowIndex + 1).filter((r) => !isBlankRow(r));
  base.dataRowCount = data.length;
  base.sampleRows = rows.slice(detection.headerRowIndex, detection.headerRowIndex + 9).map((r) => r.map(inertText));
  const col = (f: string) => detection.columns[f];
  const values = (fields: string[]) => fields.flatMap((f) => (col(f) === undefined ? [] : data.map((r) => r[col(f)!] ?? '')));

  const numericFields = detection.format === 'legacy_summary' ? NUMERIC_LEGACY : NUMERIC_CAMPAIGN;
  base.numberFormatCandidates = candidateNumberFormats(values(numericFields));
  const required: string[] = ['currency', 'timezone', 'datasetName'];
  if (base.numberFormatCandidates.length !== 1) required.push('numberFormat');
  if (opts.delimiter === undefined && det.candidates.length > 1) {
    // Delimiter was inferred with a runner-up present; it is still shown for confirmation.
  }
  const proposal: Record<string, unknown> = {
    format: detection.format,
    encoding: base.encoding,
    delimiter,
    headerRowIndex: detection.headerRowIndex,
    columns: detection.columns,
    numberFormat: base.numberFormatCandidates[0] ?? { decimal: '.', thousands: ',' },
    currency: opts.accountCurrency,
    datasetName: '',
    targetDatasetId: null,
  };

  if (detection.format === 'legacy_summary') {
    required.push('asOfDate', 'windowEnd', 'rateScale');
    const rateVals = values(RATE_COLUMNS).map((v) => v.trim()).filter((v) => v && !v.endsWith('%'));
    const fmt = base.numberFormatCandidates[0] ?? { decimal: '.', thousands: ',' };
    const nums = rateVals.map((v) => parseRate(v, fmt, 'percent')).filter((r): r is { ok: true; value: string } => r.ok && r.value !== null).map((r) => Number(r.value));
    base.rateScaleAmbiguous = nums.length > 0 && nums.every((n) => n <= 1) && nums.some((n) => n > 0);
    proposal.rateScale = base.rateScaleAmbiguous ? undefined : 'percent';
    if (col('openRate') !== undefined) required.push('openRateMeaning');
    if (col('clickRate') !== undefined) required.push('clickRateMeaning');
    if (col('conversions') !== undefined) required.push('conversionsMeaning');
    if (col('channel') === undefined) required.push('defaultChannel');
    base.supportedWindowLabels = SUPPORTED_WINDOW_LABELS;
  } else {
    const dateVals = values(['launchDate', 'activityDate']);
    base.dateFormatCandidates = candidateDateFormats(dateVals);
    if (base.dateFormatCandidates.length !== 1) required.push('dateFormat');
    proposal.dateFormat = base.dateFormatCandidates.length === 1 ? base.dateFormatCandidates[0] : undefined;
    if (col('opensUnspecified') !== undefined) required.push('opensMeaning');
    if (col('clicksUnspecified') !== undefined) required.push('clicksMeaning');
    if (col('channel') === undefined) required.push('defaultChannel');
    required.push('coverage');
    if (proposal.dateFormat) {
      const dates = dateVals.map((v) => parseDate(v, proposal.dateFormat as DateFormat)).filter((r) => r.ok && r.value).map((r) => (r as { value: string }).value).sort();
      if (dates.length) {
        proposal.coverageStart = dates[0];
        proposal.coverageEnd = dates[dates.length - 1];
      }
    }
  }
  return { ...base, ok: true, requiredDecisions: required, proposal: proposal as Inspection['proposal'] };
}

const showDelim = (d: string) => (d === '\t' ? 'tab' : `"${d}"`);

// ---------------------------------------------------------------- full validation
export interface LegacyFact {
  channel: string;
  windowKey: string;
  windowLabel: string;
  windowDays: number;
  windowStart: string;
  windowEndExclusive: string;
  sent: string | null;
  delivered: string | null;
  skipped: string | null;
  bounceRate: string | null;
  softBounceRate: string | null;
  hardBounceRate: string | null;
  openRate: string | null;
  clickRate: string | null;
  unsubscribeRate: string | null;
  revenue: string | null;
  conversions: string | null;
  sourceRow: number;
}

export interface CampaignFact {
  campaignExternalId: string;
  campaignName: string;
  launchExternalId: string | null;
  channel: string;
  launchDate: string;
  launchTime?: string | null;
  factDate: string | null;
  program: string | null;
  subjectLine: string | null;
  creativeType: string | null;
  offer: string | null;
  sent: string | null;
  delivered: string | null;
  skipped: string | null;
  bounces: string | null;
  totalOpens: string | null;
  uniqueOpens: string | null;
  totalClicks: string | null;
  uniqueClicks: string | null;
  conversionEvents: string | null;
  orders: string | null;
  revenue: string | null;
  unsubscribes: string | null;
  complaints: string | null;
  sourceRow: number;
}

export interface ValidationResult {
  format: 'legacy_summary' | 'campaign_metrics';
  ok: boolean;
  rowCount: number;
  acceptedRows: number;
  errorCount: number;
  errors: CellError[];
  warnings: string[];
  conflicts: string[];
  limitations: string[];
  coverage: { start: string; endExclusive: string } | null;
  channels: string[];
  campaignCount: number | null;
  windows: string[] | null;
  grain: 'account_window' | 'campaign_launch' | 'campaign_day';
  timeBasis: 'declared_snapshot' | 'send_cohort' | 'event_time';
  semantics: Record<string, string>;
  sourceAsOf: string | null;
  signature: string;
  preview: Record<string, unknown>[];
}

export interface ValidationOutput {
  result: ValidationResult;
  legacyFacts: LegacyFact[];
  campaignFacts: CampaignFact[];
}

const MAX_REPORTED_ERRORS = 200;

class Collector {
  errors: CellError[] = [];
  count = 0;
  add(e: CellError) {
    this.count++;
    if (this.errors.length < MAX_REPORTED_ERRORS) this.errors.push({ ...e, value: e.value === null ? null : inertText(e.value.slice(0, 120)) });
  }
}

function cell<T>(c: Collector, row: number, column: string, raw: string | undefined, fn: (s: string) => CellResult<T>): T | null {
  if (raw === undefined) return null;
  const r = fn(raw);
  if (!r.ok) {
    c.add({ row, column, code: r.code, message: r.message, value: raw });
    return null;
  }
  return r.value;
}

export function validate(bytes: Buffer, mapping: ImportMapping): ValidationOutput {
  const { text } = decode(bytes, mapping.encoding);
  const rows = parseRows(text, mapping.delimiter);
  const header = rows[mapping.headerRowIndex];
  if (!header) throw new ParseError('The header row is missing', 'missing_header');
  const dataStart = mapping.headerRowIndex + 1;
  const records = rows.slice(dataStart).map((r, i) => ({ r, line: dataStart + i + 1 })).filter(({ r }) => !isBlankRow(r));
  const colName = (f: string) => {
    const idx = mapping.columns[f];
    return idx === null || idx === undefined ? f : header[idx]?.trim() || f;
  };
  return mapping.format === 'legacy_summary' ? validateLegacy(records, mapping, colName, header.length) : validateCampaign(records, mapping, colName, header.length);
}

function getter(mapping: ImportMapping) {
  return (r: string[], field: string): string | undefined => {
    const idx = mapping.columns[field];
    if (idx === null || idx === undefined) return undefined;
    return r[idx] ?? '';
  };
}

function signatureOf(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function validateLegacy(records: { r: string[]; line: number }[], m: LegacyMapping, colName: (f: string) => string, width: number): ValidationOutput {
  const c = new Collector();
  const get = getter(m);
  const warnings: string[] = [];
  const conflicts: string[] = [];
  if (!isIsoDate(m.asOfDate)) c.add({ row: 0, column: null, code: 'invalid_as_of', message: 'The export date is not a valid date', value: m.asOfDate });
  for (const f of ['range'] as const) {
    if (m.columns[f] === undefined || m.columns[f] === null) c.add({ row: 0, column: f, code: 'missing_required_column', message: `Required column "${f}" is not mapped`, value: null });
  }
  if ((m.columns.sent ?? null) === null && (m.columns.delivered ?? null) === null) {
    c.add({ row: 0, column: null, code: 'missing_required_column', message: 'Map "Sent" or "Delivered"', value: null });
  }
  for (const [f, need] of [['openRate', m.openRateMeaning], ['clickRate', m.clickRateMeaning], ['conversions', m.conversionsMeaning]] as const) {
    if ((m.columns[f] ?? null) !== null && !need) c.add({ row: 0, column: f, code: 'meaning_required', message: `Confirm what "${colName(f)}" measures`, value: null });
  }
  const end = m.windowEnd === 'end_of_previous_day' ? m.asOfDate : addDays(m.asOfDate, 1);
  const facts: LegacyFact[] = [];
  const seen = new Set<string>();
  const fmt = m.numberFormat;

  for (const { r, line } of records) {
    if (r.length !== width) {
      c.add({ row: line, column: null, code: 'column_count', message: `Row has ${r.length} columns; the header has ${width}`, value: null });
      continue;
    }
    const label = (get(r, 'range') ?? '').trim();
    if (!label) {
      c.add({ row: line, column: colName('range'), code: 'missing_window', message: 'The date range is empty', value: '' });
      continue;
    }
    if (/^(sent\s*date\s*range|channel)$/i.test(label)) {
      c.add({ row: line, column: colName('range'), code: 'repeated_header', message: 'A repeated header row was found inside the data', value: label });
      continue;
    }
    const w = windowFor(label);
    if (!w) {
      c.add({ row: line, column: colName('range'), code: 'unknown_window', message: `"${label}" is not a supported date range label`, value: label });
      continue;
    }
    const channelRaw = get(r, 'channel');
    const channel = normalizeChannel(channelRaw ?? m.defaultChannel ?? '');
    if (!channel) {
      c.add({ row: line, column: colName('channel'), code: 'missing_channel', message: 'The channel is empty', value: channelRaw ?? '' });
      continue;
    }
    let start: string;
    let endEx: string;
    if (w.kind === 'today') {
      start = m.asOfDate;
      endEx = addDays(m.asOfDate, 1);
    } else if (w.kind === 'yesterday') {
      start = addDays(m.asOfDate, -1);
      endEx = m.asOfDate;
    } else if (w.kind === 'days') {
      start = addDays(end, -w.n);
      endEx = end;
    } else {
      start = addMonths(end, -w.n);
      endEx = end;
    }
    const key = `${channel}|${w.key}`;
    if (seen.has(key)) {
      c.add({ row: line, column: colName('range'), code: 'duplicate_row', message: `${channel} / ${label} appears more than once`, value: label });
      continue;
    }
    seen.add(key);
    const before = c.count;
    const rate = (f: string) => cell(c, line, colName(f), get(r, f), (s) => parseRate(s, fmt, m.rateScale));
    const fact: LegacyFact = {
      channel,
      windowKey: w.key,
      windowLabel: label,
      windowDays: diffDays(start, endEx),
      windowStart: start,
      windowEndExclusive: endEx,
      sent: cell(c, line, colName('sent'), get(r, 'sent'), (s) => parseCount(s, fmt)),
      delivered: cell(c, line, colName('delivered'), get(r, 'delivered'), (s) => parseCount(s, fmt)),
      skipped: cell(c, line, colName('skipped'), get(r, 'skipped'), (s) => parseCount(s, fmt)),
      bounceRate: rate('bounceRate'),
      softBounceRate: rate('softBounceRate'),
      hardBounceRate: rate('hardBounceRate'),
      openRate: rate('uniqueOpenRate') ?? rate('totalOpenRate') ?? rate('openRate'),
      clickRate: rate('uniqueClickRate') ?? rate('totalClickRate') ?? rate('clickRate'),
      unsubscribeRate: rate('unsubscribeRate'),
      revenue: cell(c, line, colName('revenue'), get(r, 'revenue'), (s) => parseMoney(s, fmt)),
      conversions: cell(c, line, colName('conversions'), get(r, 'conversions'), (s) => parseCount(s, fmt)),
      sourceRow: line,
    };
    if (c.count > before) continue;
    if (fact.sent !== null && fact.delivered !== null && new Decimal(fact.delivered).gt(fact.sent)) {
      c.add({ row: line, column: colName('delivered'), code: 'delivered_exceeds_sent', message: 'Delivered is greater than Sent', value: fact.delivered });
      continue;
    }
    if (channel !== 'Email' && (fact.openRate !== null || fact.bounceRate !== null)) {
      warnings.push(`Row ${line}: ${channel} has email-style open/bounce rates; they are kept as reported and not interpreted as email metrics.`);
    }
    facts.push(fact);
  }
  if (!records.length) c.add({ row: 0, column: null, code: 'no_data_rows', message: 'No data rows were found under the header', value: null });

  // Nested cumulative windows must not shrink (T14): record conflicts instead of clamping.
  const byChannel = new Map<string, LegacyFact[]>();
  for (const f of facts) byChannel.set(f.channel, [...(byChannel.get(f.channel) ?? []), f]);
  for (const [ch, list] of byChannel) {
    const nested = list.filter((f) => f.windowEndExclusive === end).sort((a, b) => a.windowDays - b.windowDays);
    for (let i = 1; i < nested.length; i++) {
      const shorter = nested[i - 1]!;
      const longer = nested[i]!;
      for (const k of ['sent', 'delivered', 'skipped', 'revenue', 'conversions'] as const) {
        const a = shorter[k];
        const b = longer[k];
        if (a !== null && b !== null && new Decimal(b).lt(a)) {
          conflicts.push(`${ch}: ${k} for "${longer.windowLabel}" (${b}) is smaller than for "${shorter.windowLabel}" (${a}); the source windows are inconsistent`);
        }
      }
    }
  }

  const semantics: Record<string, string> = {
    open_rate: m.columns.uniqueOpenRate != null ? 'unique' : m.columns.totalOpenRate != null ? 'total' : m.openRateMeaning ?? 'absent',
    click_rate: m.columns.uniqueClickRate != null ? 'unique' : m.columns.totalClickRate != null ? 'total' : m.clickRateMeaning ?? 'absent',
    conversions: m.columns.conversions != null ? m.conversionsMeaning ?? 'not_stated' : 'absent',
    rate_scale: m.rateScale,
    window_end: m.windowEnd,
  };
  const coverage = facts.length
    ? { start: facts.map((f) => f.windowStart).sort()[0]!, endExclusive: facts.map((f) => f.windowEndExclusive).sort().at(-1)! }
    : null;
  const limitations = [
    'Account-period totals only: no campaign, launch, recipient, segment, link, domain, or hourly detail.',
    'Rates are kept as reported; their numerators are not in the file, so counts are not reconstructed.',
    'Windows are alternate views of overlapping activity and are never added together.',
    'Only the date ranges present in the file can be shown; arbitrary custom ranges are not available.',
  ];
  const ok = c.count === 0;
  return {
    result: {
      format: 'legacy_summary',
      ok,
      rowCount: records.length,
      acceptedRows: ok ? facts.length : 0,
      errorCount: c.count,
      errors: c.errors,
      warnings: [...new Set(warnings)].slice(0, 50),
      conflicts,
      limitations,
      coverage,
      channels: [...byChannel.keys()].sort(),
      campaignCount: null,
      windows: [...new Set(facts.map((f) => f.windowLabel))],
      grain: 'account_window',
      timeBasis: 'declared_snapshot',
      semantics,
      sourceAsOf: m.asOfDate,
      signature: signatureOf({ format: 'legacy_summary', end, currency: m.currency, semantics, facts: facts.map(({ sourceRow: _s, ...f }) => f) }),
      preview: facts.slice(0, 12).map((f) => ({ ...f })),
    },
    legacyFacts: ok ? facts : [],
    campaignFacts: [],
  };
}

function validateCampaign(records: { r: string[]; line: number }[], m: CampaignMapping, colName: (f: string) => string, width: number): ValidationOutput {
  const c = new Collector();
  const get = getter(m);
  const warnings: string[] = [];
  const fmt = m.numberFormat;
  if ((m.columns.campaignId ?? null) === null) c.add({ row: 0, column: 'campaignId', code: 'missing_required_column', message: 'Map the Campaign ID column', value: null });
  if ((m.columns.launchDate ?? null) === null) c.add({ row: 0, column: 'launchDate', code: 'missing_required_column', message: 'Map the Launch Date column', value: null });
  if ((m.columns.sent ?? null) === null && (m.columns.delivered ?? null) === null) {
    c.add({ row: 0, column: null, code: 'missing_required_column', message: 'Map "Sent" or "Delivered"', value: null });
  }
  if ((m.columns.opensUnspecified ?? null) !== null && !m.opensMeaning) c.add({ row: 0, column: 'opens', code: 'meaning_required', message: 'Confirm whether "Opens" are total or unique opens', value: null });
  if ((m.columns.clicksUnspecified ?? null) !== null && !m.clicksMeaning) c.add({ row: 0, column: 'clicks', code: 'meaning_required', message: 'Confirm whether "Clicks" are total or unique clicks', value: null });
  for (const f of Object.keys(m.columns)) {
    if (!(f in CAMPAIGN_FIELDS)) c.add({ row: 0, column: f, code: 'unknown_field', message: `Unknown field "${f}"`, value: null });
  }

  const daily = (m.columns.activityDate ?? null) !== null;
  const facts: CampaignFact[] = [];
  const seen = new Set<string>();
  const names = new Map<string, string>();
  const date = (f: string, r: string[], line: number) => cell(c, line, colName(f), get(r, f), (s) => parseDate(s, m.dateFormat));
  const count = (f: string, r: string[], line: number) => cell(c, line, colName(f), get(r, f), (s) => parseCount(s, fmt));

  for (const { r, line } of records) {
    if (r.length !== width) {
      c.add({ row: line, column: null, code: 'column_count', message: `Row has ${r.length} columns; the header has ${width}`, value: null });
      continue;
    }
    const before = c.count;
    const campaignExternalId = (get(r, 'campaignId') ?? '').trim();
    if (!campaignExternalId) c.add({ row: line, column: colName('campaignId'), code: 'missing_campaign_id', message: 'Campaign ID is empty', value: '' });
    else if (campaignExternalId.length > 200) c.add({ row: line, column: colName('campaignId'), code: 'campaign_id_too_long', message: 'Campaign ID is longer than 200 characters', value: campaignExternalId });
    const channel = normalizeChannel(get(r, 'channel') ?? m.defaultChannel ?? '');
    if (!channel) c.add({ row: line, column: colName('channel'), code: 'missing_channel', message: 'The channel is empty', value: '' });
    const launchDate = date('launchDate', r, line);
    if ((m.columns.launchDate ?? null) !== null && launchDate === null && c.count === before) {
      c.add({ row: line, column: colName('launchDate'), code: 'missing_launch_date', message: 'Launch date is empty', value: '' });
    }
    const factDate = daily ? date('activityDate', r, line) : null;
    if (daily && factDate === null && c.count === before) c.add({ row: line, column: colName('activityDate'), code: 'missing_activity_date', message: 'Activity date is empty', value: '' });
    if (launchDate && factDate && factDate < launchDate) {
      c.add({ row: line, column: colName('activityDate'), code: 'activity_before_launch', message: 'Activity date is before the launch date', value: factDate });
    }
    const rowCurrency = (get(r, 'currency') ?? '').trim().toUpperCase();
    if (rowCurrency && rowCurrency !== m.currency) {
      c.add({ row: line, column: colName('currency'), code: 'currency_mismatch', message: `Row currency ${rowCurrency} differs from the dataset currency ${m.currency}; mixed currencies must be imported as separate datasets`, value: rowCurrency });
    }
    const opens = count('opensUnspecified', r, line);
    const clicks = count('clicksUnspecified', r, line);
    const launchTime = (get(r, 'launchTime') ?? '').trim();
    if (launchTime && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(launchTime)) c.add({ row: line, column: colName('launchTime'), code: 'invalid_launch_time', message: 'Launch Time must be HH:mm or HH:mm:ss in the account timezone', value: launchTime });
    const fact: CampaignFact = {
      campaignExternalId,
      campaignName: (get(r, 'campaignName') ?? '').trim().slice(0, 300) || campaignExternalId,
      launchExternalId: (get(r, 'launchId') ?? '').trim().slice(0, 200) || null,
      channel,
      launchDate: launchDate ?? '',
      launchTime: launchTime || null,
      factDate,
      program: (get(r, 'program') ?? '').trim().slice(0, 300) || null,
      subjectLine: (get(r, 'subjectLine') ?? '').trim().slice(0, 500) || null,
      creativeType: (get(r, 'creativeType') ?? '').trim().slice(0, 200) || null,
      offer: (get(r, 'offer') ?? '').trim().slice(0, 200) || null,
      sent: count('sent', r, line),
      delivered: count('delivered', r, line),
      skipped: count('skipped', r, line),
      bounces: count('bounces', r, line),
      totalOpens: count('totalOpens', r, line) ?? (m.opensMeaning === 'total' ? opens : null),
      uniqueOpens: count('uniqueOpens', r, line) ?? (m.opensMeaning === 'unique' ? opens : null),
      totalClicks: count('totalClicks', r, line) ?? (m.clicksMeaning === 'total' ? clicks : null),
      uniqueClicks: count('uniqueClicks', r, line) ?? (m.clicksMeaning === 'unique' ? clicks : null),
      conversionEvents: count('conversionEvents', r, line),
      orders: count('orders', r, line),
      revenue: cell(c, line, colName('revenue'), get(r, 'revenue'), (s) => parseMoney(s, fmt)),
      unsubscribes: count('unsubscribes', r, line),
      complaints: count('complaints', r, line),
      sourceRow: line,
    };
    if (c.count > before) continue;
    if (fact.sent !== null && fact.delivered !== null && new Decimal(fact.delivered).gt(fact.sent)) {
      c.add({ row: line, column: colName('delivered'), code: 'delivered_exceeds_sent', message: 'Delivered is greater than Sent', value: fact.delivered });
      continue;
    }
    if (fact.uniqueOpens !== null && fact.totalOpens !== null && new Decimal(fact.uniqueOpens).gt(fact.totalOpens)) {
      c.add({ row: line, column: colName('uniqueOpens'), code: 'unique_exceeds_total', message: 'Unique opens exceed total opens', value: fact.uniqueOpens });
      continue;
    }
    if (fact.uniqueClicks !== null && fact.totalClicks !== null && new Decimal(fact.uniqueClicks).gt(fact.totalClicks)) {
      c.add({ row: line, column: colName('uniqueClicks'), code: 'unique_exceeds_total', message: 'Unique clicks exceed total clicks', value: fact.uniqueClicks });
      continue;
    }
    const key = `${campaignExternalId}|${fact.launchExternalId ?? ''}|${fact.launchDate}|${fact.factDate ?? ''}`;
    if (seen.has(key)) {
      c.add({ row: line, column: null, code: 'duplicate_row', message: 'This campaign/launch/date combination appears more than once', value: campaignExternalId });
      continue;
    }
    seen.add(key);
    const prevName = names.get(campaignExternalId);
    if (prevName && prevName !== fact.campaignName) warnings.push(`Campaign ${campaignExternalId} has more than one name in the file; the latest launch's name is shown.`);
    names.set(campaignExternalId, fact.campaignName);
    if (channel !== 'Email' && (fact.totalOpens !== null || fact.uniqueOpens !== null)) {
      warnings.push(`Row ${line}: ${channel} rows include open counts; they are kept as reported.`);
    }
    facts.push(fact);
  }
  if (!records.length) c.add({ row: 0, column: null, code: 'no_data_rows', message: 'No data rows were found under the header', value: null });

  const periodDates = facts.map((f) => (daily ? f.factDate! : f.launchDate)).filter(Boolean).sort();
  let coverage: { start: string; endExclusive: string } | null = null;
  const start = m.coverageStart ?? periodDates[0];
  const endInc = m.coverageEnd ?? periodDates.at(-1);
  if (start && endInc) {
    if (!isIsoDate(start) || !isIsoDate(endInc) || endInc < start) {
      c.add({ row: 0, column: null, code: 'invalid_coverage', message: 'The coverage dates are not valid', value: `${start}..${endInc}` });
    } else {
      coverage = { start, endExclusive: addDays(endInc, 1) };
      const outside = periodDates.filter((d) => d < start || d > endInc);
      if (outside.length) {
        c.add({ row: 0, column: null, code: 'rows_outside_coverage', message: `${outside.length} row(s) fall outside the declared coverage ${start} – ${endInc}`, value: null });
      }
    }
  }
  const has = (k: keyof CampaignFact) => facts.some((f) => f[k] !== null);
  const limitations: string[] = [];
  if (!has('uniqueOpens') && !has('totalOpens')) limitations.push('No open counts: open rates are unavailable.');
  if (!has('uniqueClicks') && !has('totalClicks')) limitations.push('No click counts: click rates are unavailable.');
  if (!has('orders')) limitations.push('No orders field: average order value is unavailable (conversion events are not orders).');
  if (daily) limitations.push('Daily rows: unique opens/clicks cannot be summed across days of the same launch.');
  limitations.push('No recipient, segment, link, or domain detail is included in this file.');
  if (!has('launchTime')) limitations.push('No launch clock times: hourly send-time estimates are unavailable.');
  limitations.push('Revenue is provider-attributed as reported, not incremental or reconciled revenue.');

  const ok = c.count === 0;
  const semantics = {
    opens: m.columns.opensUnspecified != null ? m.opensMeaning ?? 'unconfirmed' : 'explicit',
    clicks: m.columns.clicksUnspecified != null ? m.clicksMeaning ?? 'unconfirmed' : 'explicit',
    unique_clicks: 'source-defined (may count distinct links per recipient)',
  };
  return {
    result: {
      format: 'campaign_metrics',
      ok,
      rowCount: records.length,
      acceptedRows: ok ? facts.length : 0,
      errorCount: c.count,
      errors: c.errors,
      warnings: [...new Set(warnings)].slice(0, 50),
      conflicts: [],
      limitations,
      coverage,
      channels: [...new Set(facts.map((f) => f.channel))].sort(),
      campaignCount: names.size,
      windows: null,
      grain: daily ? 'campaign_day' : 'campaign_launch',
      timeBasis: daily ? 'event_time' : 'send_cohort',
      semantics,
      sourceAsOf: null,
      signature: signatureOf({ format: 'campaign_metrics', currency: m.currency, coverage, semantics, facts: facts.map(({ sourceRow: _s, ...f }) => f) }),
      preview: facts.slice(0, 12).map((f) => ({ ...f })),
    },
    legacyFacts: [],
    campaignFacts: ok ? facts : [],
  };
}

export { LEGACY_FIELDS };
