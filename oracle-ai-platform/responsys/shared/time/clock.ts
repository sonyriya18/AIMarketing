/** Injected clock so period logic is deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (iso: string): Clock => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new Error(`Invalid clock time: ${iso}`);
  return { now: () => new Date(t.getTime()) };
};
