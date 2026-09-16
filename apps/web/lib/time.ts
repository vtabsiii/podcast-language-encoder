/**
 * Media time formatting from integer microseconds only. Floating-point seconds are never
 * the source of truth (packages/domain time base); they appear only when talking to the
 * <audio> element, via `toPlayerSeconds`.
 */

const US_PER_MS = 1_000;
const US_PER_S = 1_000_000;

function pad(n: number, w: number): string {
  return n.toString().padStart(w, '0');
}

/** `mm:ss.mmm`, or `h:mm:ss.mmm` past one hour. Rounds to the nearest millisecond. */
export function formatMediaTime(us: number): string {
  if (!Number.isFinite(us) || us < 0) return '00:00.000';
  const totalMs = Math.round(us / US_PER_MS);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  const core = `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
  return h > 0 ? `${h}:${core}` : core;
}

/** `1h 02m 03s` style duration for summaries. Whole seconds. */
export function formatDuration(us: number): string {
  if (!Number.isFinite(us) || us < 0) return '0s';
  const totalS = Math.round(us / US_PER_S);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  if (h > 0) return `${h}h ${pad(m, 2)}m ${pad(s, 2)}s`;
  if (m > 0) return `${m}m ${pad(s, 2)}s`;
  return `${s}s`;
}

/** Range label `mm:ss.mmm – mm:ss.mmm`. */
export function formatRange(range: { start: number; end: number }): string {
  return `${formatMediaTime(range.start)} – ${formatMediaTime(range.end)}`;
}

/** Only for HTMLMediaElement.currentTime, which speaks float seconds. */
export function toPlayerSeconds(us: number): number {
  return us / US_PER_S;
}

/** Ratio of measured speech duration to its timing budget, as a percentage integer. */
export function budgetUsePercent(measuredUs: number, budgetUs: number): number {
  if (budgetUs <= 0) return 0;
  return Math.round((measuredUs * 100) / budgetUs);
}
