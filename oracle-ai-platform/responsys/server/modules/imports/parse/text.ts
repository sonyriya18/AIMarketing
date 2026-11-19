/**
 * Decoding and tabular parsing for uploaded CSV/TSV files.
 *
 * - UTF-8 is decoded strictly; invalid bytes require an explicit encoding choice.
 * - A UTF-8 BOM is removed.
 * - Delimiters are inferred from the header line (outside quotes), and an ambiguous
 *   result is returned as a decision for the user, not guessed.
 * - Parsing uses csv-parse (quotes, escaped quotes, embedded newlines, CRLF/LF).
 */
import { parse as parseCsv } from 'csv-parse/sync';

export const ENCODINGS = ['utf-8', 'windows-1252', 'iso-8859-1'] as const;
export type Encoding = (typeof ENCODINGS)[number];
export const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export class ParseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function decode(bytes: Buffer, encoding?: Encoding): { text: string; encoding: Encoding } {
  const enc = encoding ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(enc, { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError(
      'The file is not valid UTF-8. Choose the file encoding (for example Windows-1252) and try again.',
      'encoding_required'
    );
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) throw new ParseError('The file contains binary data and is not a text CSV/TSV file.', 'binary_content');
  return { text, encoding: enc };
}

/** Counts each delimiter in the first non-empty line, ignoring quoted sections. */
export function detectDelimiter(text: string): { delimiter: Delimiter | null; candidates: Delimiter[] } {
  const firstLine = firstNonEmptyLine(text);
  const counts = new Map<Delimiter, number>();
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (DELIMITERS as readonly string[]).includes(ch)) counts.set(ch as Delimiter, (counts.get(ch as Delimiter) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { delimiter: null, candidates: [] };
  const top = ranked[0]![1];
  const candidates = ranked.filter(([, n]) => n === top).map(([d]) => d);
  // A clear winner is accepted only when the runner-up is far behind.
  const runnerUp = ranked[1]?.[1] ?? 0;
  if (candidates.length === 1 && runnerUp * 2 < top) return { delimiter: candidates[0]!, candidates: ranked.map(([d]) => d) };
  return { delimiter: null, candidates: ranked.map(([d]) => d) };
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/, 50)) if (line.trim()) return line;
  return '';
}

export const MAX_ROWS = 200_000;
export const MAX_COLUMNS = 200;

export function parseRows(text: string, delimiter: Delimiter): string[][] {
  let rows: string[][];
  try {
    rows = parseCsv(text, {
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      bom: true,
      trim: false,
      max_record_size: 1_000_000,
    }) as string[][];
  } catch (err) {
    throw new ParseError(`The file could not be parsed as delimited text: ${(err as Error).message}`, 'malformed_csv');
  }
  if (rows.length > MAX_ROWS) throw new ParseError(`The file has more than ${MAX_ROWS.toLocaleString('en-US')} rows`, 'too_many_rows');
  if (rows.some((r) => r.length > MAX_COLUMNS)) throw new ParseError(`A row has more than ${MAX_COLUMNS} columns`, 'too_many_columns');
  return rows;
}

/** Header normalisation used for alias matching. */
export const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Neutralises spreadsheet formula prefixes when echoing raw cell text back to users. */
export function inertText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
