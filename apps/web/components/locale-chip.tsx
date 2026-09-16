import type { TargetSummary } from '@polycast/contracts';
import { toneForJobState } from '@polycast/ui';
import { formatPercent, humanizeState } from '@/lib/format';

const ICON = { ok: '✓', warn: '!', error: '×', info: '›', queued: '…' } as const;

/** Compact per-target chip: locale, state (icon + text) and progress. */
export function LocaleChip({ target }: { target: TargetSummary }) {
  const tone = toneForJobState(target.state);
  return (
    <span className="chip" style={{ color: `var(--pc-color-status-${tone})` }}>
      <span aria-hidden="true">{ICON[tone]}</span>
      <span lang={target.locale}>{target.locale}</span>
      <span>{humanizeState(target.state)}</span>
      <span className="pct">{formatPercent(target.progress)}</span>
      {target.openIssues > 0 && (
        <span>
          · {target.openIssues} issue{target.openIssues === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}
