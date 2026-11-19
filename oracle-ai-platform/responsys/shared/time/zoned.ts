/**
 * Calendar-date and IANA-timezone helpers built on Intl (no implicit server timezone).
 * Local calendar dates are 'YYYY-MM-DD' strings; instants are Date objects in UTC.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function parts(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m || !isIsoDate(date)) throw new Error(`Invalid calendar date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return fmt(new Date(Date.UTC(y, m - 1, d + n)));
}

export function diffDays(start: string, endExclusive: string): number {
  const [y1, m1, d1] = parts(start);
  const [y2, m2, d2] = parts(endExclusive);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export function startOfMonth(date: string): string {
  const [y, m] = parts(date);
  return fmt(new Date(Date.UTC(y, m - 1, 1)));
}

export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date);
  // Clamp to the last valid day of the target month.
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))));
}

export function startOfYear(date: string): string {
  return `${parts(date)[0]}-01-01`;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function zonedFields(instant: Date, tz: string) {
  const out: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** The local calendar date of an instant in a timezone. */
export function localDate(instant: Date, tz: string): string {
  const f = zonedFields(instant, tz);
  return `${String(f.year).padStart(4, '0')}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
}

/** Offset (ms) of the timezone from UTC at an instant: local wall time minus UTC. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const f = zonedFields(instant, tz);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of local midnight at the start of `date` in `tz`. Handles DST: on a day
 * where midnight does not exist, returns the first valid instant of that local date.
 */
export function zonedStartOfDay(date: string, tz: string): Date {
  const [y, m, d] = parts(date);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - tzOffsetMs(new Date(wall), tz);
  // Two refinement passes settle offsets that change around the guess.
  for (let i = 0; i < 2; i++) guess = wall - tzOffsetMs(new Date(guess), tz);
  if (localDate(new Date(guess), tz) !== date) {
    // Midnight skipped by a DST jump: step forward to the first instant on that date.
    let t = guess;
    while (localDate(new Date(t), tz) < date) t += 15 * 60_000;
    return new Date(t);
  }
  return new Date(guess);
}
