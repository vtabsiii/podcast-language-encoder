/**
 * Pure helpers for stepping through the open QC issues of a review. Kept free of React so the
 * studio's issue navigation can be unit-tested without rendering it.
 */
export interface IssueLike {
  resolution: string;
}
export interface SegmentIssues {
  issues: readonly IssueLike[];
}

export function openIssueCount(segment: SegmentIssues): number {
  return segment.issues.filter((i) => i.resolution === 'open').length;
}

/**
 * Index of the next segment after `from` (wrapping around the end) that still has an open
 * issue, or -1 when no segment does. When `from` is the only flagged segment it is returned
 * itself, so "next" always lands on something actionable.
 */
export function nextOpenIssueIndex(segments: readonly SegmentIssues[], from: number): number {
  const n = segments.length;
  if (n === 0) return -1;
  const start = Number.isInteger(from) ? from : -1;
  for (let step = 1; step <= n; step++) {
    const idx = (((start + step) % n) + n) % n;
    const seg = segments[idx];
    if (seg && openIssueCount(seg) > 0) return idx;
  }
  return -1;
}

export interface OpenIssueProgress {
  /** Open issues across the whole review. */
  total: number;
  /** 1-based ordinal of the selected segment's first open issue, or null when it has none. */
  position: number | null;
}

export function openIssueProgress(
  segments: readonly SegmentIssues[],
  selectedIndex: number,
): OpenIssueProgress {
  let total = 0;
  let position: number | null = null;
  segments.forEach((seg, i) => {
    const count = openIssueCount(seg);
    if (i === selectedIndex && count > 0) position = total + 1;
    total += count;
  });
  return { total, position };
}

/** Short label shown next to the "Next open issue" control; empty when nothing is open. */
export function describeOpenIssueProgress(progress: OpenIssueProgress): string {
  if (progress.total === 0) return '';
  if (progress.position === null) return `Open issues remaining: ${progress.total}`;
  return `Open issue ${progress.position} of ${progress.total}`;
}
