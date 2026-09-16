import { StatusBadge, toneForJobState, toneForProjectState } from '@polycast/ui';
import { humanizeState } from '@/lib/format';

export function JobStateBadge({ state }: { state: string }) {
  return <StatusBadge tone={toneForJobState(state)}>{humanizeState(state)}</StatusBadge>;
}

export function ProjectStateBadge({ state }: { state: string }) {
  return <StatusBadge tone={toneForProjectState(state)}>{humanizeState(state)}</StatusBadge>;
}
