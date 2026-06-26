/**
 * Time helpers for "today", "yesterday", time-of-day, and ISO parsing.
 */

export function nowUtc(): Date {
  return new Date();
}

export function isToday(ts: Date, ref: Date = new Date()): boolean {
  return sameDay(ts, ref);
}

export function isYesterday(ts: Date, ref: Date = new Date()): boolean {
  const y = new Date(ref);
  y.setUTCDate(y.getUTCDate() - 1);
  return sameDay(ts, y);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Parse an ISO 8601 timestamp string. Returns null on failure.
 */
export function parseIso(s: string): Date | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Hours between two dates (absolute). Negative-safe.
 */
export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

/**
 * Seconds between two dates (signed).
 */
export function secondsBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 1000;
}
