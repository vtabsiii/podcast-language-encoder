const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'medium' });

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return usd.format(cents / 100);
}

export function formatCentsRange(low: number, high: number): string {
  return low === high ? formatCents(low) : `${formatCents(low)} – ${formatCents(high)}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : time.format(d);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function truncateHash(sha256: string, keep = 12): string {
  return sha256.length <= keep ? sha256 : `${sha256.slice(0, keep)}…`;
}

/** Human label for a state constant: NEEDS_REVIEW → "Needs review". */
export function humanizeState(state: string): string {
  const lower = state.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
