import { HAPPY_PATH, type JobState, TARGET_STATES } from '@polycast/domain';
import { humanizeState } from '@/lib/format';

export interface StageTimelineProps {
  state: JobState;
  lipSync: boolean;
  label: string;
}

/** Target-side happy-path stages in order, adjusted for the lip-sync option. */
export function targetStages(lipSync: boolean, state: JobState): JobState[] {
  const targetOnly = HAPPY_PATH.filter((s) => (TARGET_STATES as readonly string[]).includes(s));
  const stages = lipSync ? targetOnly : targetOnly.filter((s) => s !== 'LIP_SYNCING');
  // NEEDS_REVIEW is a gate between TARGET_QA and READY; show it only while we are in it.
  if (state === 'NEEDS_REVIEW') {
    const i = stages.indexOf('READY');
    stages.splice(i, 0, 'NEEDS_REVIEW');
  }
  return stages;
}

export function StageTimeline({ state, lipSync, label }: StageTimelineProps) {
  const stages = targetStages(lipSync, state);
  const idx = stages.indexOf(state);
  const exceptional = idx < 0;
  return (
    <ol className="timeline" aria-label={label}>
      {stages.map((s, i) => {
        const status = exceptional
          ? 'pending'
          : i < idx
            ? 'done'
            : i === idx
              ? 'current'
              : 'pending';
        return (
          <li key={s} data-stage={status} aria-current={status === 'current' ? 'step' : undefined}>
            {status === 'done' && <span aria-hidden="true">✓ </span>}
            {humanizeState(s)}
            {status === 'done' && <span className="pc-visually-hidden"> (done)</span>}
          </li>
        );
      })}
      {exceptional && (
        <li data-stage="error" aria-current="step">
          {humanizeState(state)}
        </li>
      )}
    </ol>
  );
}
