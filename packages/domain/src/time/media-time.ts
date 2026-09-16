/**
 * Media time is stored as integer microseconds (µs) in a `bigint`-free representation
 * because 2^53 µs ≈ 285 years, far beyond any media file. Floating-point seconds are never
 * the source of truth; they exist only at the UI boundary.
 */

/** Integer microseconds. Branded so it cannot be confused with ms or seconds. */
export type Microseconds = number & { readonly __brand: 'Microseconds' };

export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MILLISECOND = 1_000;

export function micros(value: number): Microseconds {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`media time must be a safe integer number of microseconds, got ${value}`);
  }
  if (value < 0) throw new RangeError(`media time must be non-negative, got ${value}`);
  return value as Microseconds;
}

export function fromMilliseconds(ms: number): Microseconds {
  return micros(Math.round(ms * MICROS_PER_MILLISECOND));
}

export function fromSeconds(seconds: number): Microseconds {
  return micros(Math.round(seconds * MICROS_PER_SECOND));
}

/**
 * Convert a rational timestamp (pts * timeBaseNum / timeBaseDen seconds) to microseconds
 * without going through floating point. Rounds half away from zero.
 */
export function fromRational(pts: number, timeBaseNum: number, timeBaseDen: number): Microseconds {
  if (!Number.isInteger(pts) || !Number.isInteger(timeBaseNum) || !Number.isInteger(timeBaseDen)) {
    throw new RangeError('rational time components must be integers');
  }
  if (timeBaseDen === 0) throw new RangeError('time base denominator must be non-zero');
  const num = BigInt(pts) * BigInt(timeBaseNum) * BigInt(MICROS_PER_SECOND);
  const den = BigInt(timeBaseDen);
  const q = num / den;
  const r = num % den;
  const rounded = r * 2n >= den ? q + 1n : q;
  return micros(Number(rounded));
}

export function toSeconds(t: Microseconds): number {
  return t / MICROS_PER_SECOND;
}

export function toMilliseconds(t: Microseconds): number {
  return t / MICROS_PER_MILLISECOND;
}

export interface TimeRange {
  readonly start: Microseconds;
  readonly end: Microseconds;
}

export function range(start: Microseconds, end: Microseconds): TimeRange {
  if (end < start) throw new RangeError(`range end ${end} precedes start ${start}`);
  return { start, end };
}

export function duration(r: TimeRange): Microseconds {
  return micros(r.end - r.start);
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Overlap in µs (0 when disjoint). */
export function overlapDuration(a: TimeRange, b: TimeRange): Microseconds {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return micros(Math.max(0, end - start));
}

/**
 * Format as SRT timestamp HH:MM:SS,mmm. Rounds to the nearest millisecond.
 */
export function toSrtTimestamp(t: Microseconds): string {
  const totalMs = Math.round(t / MICROS_PER_MILLISECOND);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  const pad = (n: number, w: number) => n.toString().padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** Format as WebVTT timestamp HH:MM:SS.mmm. */
export function toVttTimestamp(t: Microseconds): string {
  return toSrtTimestamp(t).replace(',', '.');
}
