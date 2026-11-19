/**
 * Display formatting shared by the server (finding text, exports) and the browser.
 * Formatting happens only after exact computation; unavailable values never render as 0.
 */
import type { MetricChange, MetricValue } from './contracts/reports';

export const UNAVAILABLE = 'Unavailable';

const REASON_TEXT: Record<string, string> = {
  missing_field: 'not in the source',
  unsupported_grain: 'not supported at this data grain',
  missing_permission: 'no permission',
  missing_history: 'outside data coverage',
  ambiguous_definition: 'definition not confirmed',
  source_not_configured: 'source not configured',
  zero_denominator: 'denominator is zero',
  partial_field: 'missing on some rows',
  mixed_currency: 'mixed currencies',
  not_additive: 'not additive across days',
};

export function reasonText(reason: string | null | undefined): string {
  return reason ? REASON_TEXT[reason] ?? reason.replace(/_/g, ' ') : '';
}

export function fmtNumber(value: string, maxFractionDigits = 0): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits, minimumFractionDigits: 0 });
}

export function fmtPercent(value: string, digits = 2): string {
  const n = Number(value);
  return `${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function fmtMoney(value: string, currency: string | null, digits = 2): string {
  const n = Number(value);
  if (!currency) return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch {
    return `${currency} ${n.toFixed(digits)}`;
  }
}

export function fmtMetric(v: MetricValue | null | undefined, opts: { compact?: boolean } = {}): string {
  if (!v || v.value === null) return UNAVAILABLE;
  switch (v.unit) {
    case 'percent':
      return fmtPercent(v.value);
    case 'money':
      return fmtMoney(v.value, v.currency, opts.compact ? 0 : 2);
    case 'money_per_message':
      return fmtMoney(v.value, v.currency, 4);
    case 'ratio':
      return fmtNumber(v.value, 4);
    default:
      return fmtNumber(v.value);
  }
}

export function fmtChange(c: MetricChange): string {
  if (c.absoluteChange === null) return c.note ?? '—';
  const n = Number(c.absoluteChange);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  const abs = Math.abs(n);
  let main: string;
  switch (c.absoluteChangeUnit) {
    case 'pp':
      main = `${sign}${abs.toFixed(2)} pp`;
      break;
    case 'money':
      main = `${sign}${fmtMoney(String(abs), c.current.currency)}`;
      break;
    case 'money_per_message':
      main = `${sign}${fmtMoney(String(abs), c.current.currency, 4)}`;
      break;
    default:
      main = `${sign}${fmtNumber(String(abs))}`;
  }
  const rel = c.relativeChangePct === null ? '' : ` (${Number(c.relativeChangePct) > 0 ? '+' : ''}${Number(c.relativeChangePct).toFixed(1)}%)`;
  return main + rel;
}
