/**
 * Strict value parsers. Nothing is "best effort": a value either parses exactly under the
 * declared format or produces a cell error. Blank cells are null; zero is zero.
 */
import Decimal from 'decimal.js';
import { isIsoDate } from '../../../../shared/time/zoned';

export interface NumberFormat {
  decimal: '.' | ',';
  thousands: ',' | '.' | ' ' | '';
}

export type CellResult<T> = { ok: true; value: T | null } | { ok: false; code: string; message: string };

const ok = <T>(value: T | null): CellResult<T> => ({ ok: true, value });
const fail = (code: string, message: string): CellResult<never> => ({ ok: false, code, message });

const CURRENCY_MARKS = /^(?:[A-Z]{3}\s*|[$€£¥₹]\s*|R\$\s*)|(?:\s*[A-Z]{3}|\s*[$€£¥₹])$/;

/** Parses a decimal string under an explicit number format. Returns a canonical string. */
export function parseDecimal(raw: string, fmt: NumberFormat, opts: { allowPercentSign?: boolean; allowCurrency?: boolean } = {}): CellResult<string> {
  let s = raw.trim();
  if (s === '') return ok(null);
  if (/^(n\/?a|null|none|-|—)$/i.test(s)) return ok(null);
  if (opts.allowPercentSign && s.endsWith('%')) s = s.slice(0, -1).trim();
  if (opts.allowCurrency) s = s.replace(CURRENCY_MARKS, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);

  const { decimal, thousands } = fmt;
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const intPart = thousands ? `\\d{1,3}(?:${esc(thousands)}\\d{3})*|\\d+` : '\\d+';
  const re = new RegExp(`^(?:${intPart})(?:${esc(decimal)}\\d+)?$`);
  if (!re.test(s)) return fail('invalid_number', `"${raw}" is not a valid number in the chosen format (decimal "${decimal}", thousands "${thousands || 'none'}")`);
  const normalized = (thousands ? s.split(thousands).join('') : s).replace(decimal, '.');
  const d = new Decimal(normalized);
  if (!d.isFinite()) return fail('invalid_number', `"${raw}" is not a finite number`);
  if (d.abs().gt('1e18')) return fail('number_out_of_range', `"${raw}" is too large`);
  return ok((negative ? d.neg() : d).toFixed());
}

export function parseCount(raw: string, fmt: NumberFormat): CellResult<string> {
  const r = parseDecimal(raw, fmt);
  if (!r.ok || r.value === null) return r;
  const d = new Decimal(r.value);
  if (d.isNeg()) return fail('negative_count', `Counts cannot be negative ("${raw}")`);
  if (!d.isInteger()) return fail('fractional_count', `Counts must be whole numbers ("${raw}")`);
  return r;
}

export function parseMoney(raw: string, fmt: NumberFormat): CellResult<string> {
  const r = parseDecimal(raw, fmt, { allowCurrency: true });
  if (!r.ok || r.value === null) return r;
  if (new Decimal(r.value).isNeg()) return fail('negative_amount', `Negative amounts are only valid in an adjustments format ("${raw}")`);
  if ((r.value.split('.')[1]?.length ?? 0) > 4) return fail('money_precision', `Amounts may have at most 4 decimal places ("${raw}")`);
  return r;
}

/** Percent values; `scale` says whether the file stores 25 (percent) or 0.25 (fraction). */
export function parseRate(raw: string, fmt: NumberFormat, scale: 'percent' | 'fraction'): CellResult<string> {
  const hasSign = raw.trim().endsWith('%');
  const r = parseDecimal(raw, fmt, { allowPercentSign: true });
  if (!r.ok || r.value === null) return r;
  let d = new Decimal(r.value);
  if (d.isNeg()) return fail('negative_rate', `Rates cannot be negative ("${raw}")`);
  if (scale === 'fraction' && !hasSign) d = d.mul(100);
  return ok(d.toFixed());
}

export const DATE_FORMATS = ['YYYY-MM-DD', 'YYYY/MM/DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM-DD-YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function parseDate(raw: string, format: DateFormat): CellResult<string> {
  const s = raw.trim();
  if (s === '') return ok(null);
  // Accept a full ISO timestamp only for the ISO date format, keeping its date part as written.
  const iso = format === 'YYYY-MM-DD' ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s) : null;
  let y: string | undefined, m: string | undefined, d: string | undefined;
  if (iso) [, y, m, d] = iso;
  else {
    const sep = format.includes('/') ? '/' : format.includes('.') ? '.' : '-';
    const parts = s.split(sep);
    const order = format.split(/[/.-]/);
    if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return fail('invalid_date', `"${raw}" does not match ${format}`);
    order.forEach((k, i) => {
      if (k === 'YYYY') y = parts[i];
      else if (k === 'MM') m = parts[i];
      else d = parts[i];
    });
  }
  if (!y || y.length !== 4 || !m || !d || m.length > 2 || d.length > 2) return fail('invalid_date', `"${raw}" does not match ${format}`);
  const out = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  if (!isIsoDate(out)) return fail('invalid_date', `"${raw}" is not a real calendar date`);
  return ok(out);
}

/** Date formats consistent with every non-empty sample value. */
export function candidateDateFormats(values: string[]): DateFormat[] {
  const vs = values.map((v) => v.trim()).filter(Boolean).slice(0, 500);
  if (!vs.length) return [];
  return DATE_FORMATS.filter((f) => vs.every((v) => parseDate(v, f).ok));
}

/** Number formats consistent with sample values; more than one means the user must choose. */
export function candidateNumberFormats(values: string[]): NumberFormat[] {
  const vs = values.map((v) => v.trim()).filter(Boolean).slice(0, 500);
  const all: NumberFormat[] = [
    { decimal: '.', thousands: ',' },
    { decimal: '.', thousands: '' },
    { decimal: ',', thousands: '.' },
    { decimal: ',', thousands: '' },
    { decimal: ',', thousands: ' ' },
    { decimal: '.', thousands: ' ' },
  ];
  const fits = all.filter((f) => vs.every((v) => parseDecimal(v, f, { allowPercentSign: true, allowCurrency: true }).ok));
  // Formats that parse the same values to the same numbers are equivalent; keep one of each.
  const seen = new Map<string, NumberFormat>();
  for (const f of fits) {
    const sig = vs.map((v) => {
      const r = parseDecimal(v, f, { allowPercentSign: true, allowCurrency: true });
      return r.ok ? r.value : 'x';
    }).join('|');
    if (!seen.has(sig)) seen.set(sig, f);
  }
  return [...seen.values()];
}
