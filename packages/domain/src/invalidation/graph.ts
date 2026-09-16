/**
 * Invalidation graph (docs/architecture.md §6).
 *
 * Regenerating an artefact at a stage invalidates everything downstream for the affected
 * scope only. This module is pure: it decides *what* becomes stale and *where* the target
 * job restarts; the API persists the result and the orchestrator re-runs the stages.
 */

import type { JobState } from '../state-machine/job-state.js';

/** Artefact kinds in stage order. Later kinds depend on earlier ones. */
export const ARTEFACT_ORDER = [
  'translation',
  'speech',
  'timing',
  'lipsync',
  'mix',
  'encode',
  'qc',
  'approval',
] as const;
export type ArtefactKind = (typeof ARTEFACT_ORDER)[number];

/** Stages a reviewer may regenerate from (FR-053). */
export const REGENERATE_STAGES = ['translation', 'voice', 'timing', 'lipsync'] as const;
export type RegenerateStage = (typeof REGENERATE_STAGES)[number];

/** Scope of a regeneration request. */
export type InvalidationScope =
  | { readonly kind: 'segment'; readonly segmentIds: readonly string[] }
  | { readonly kind: 'speaker'; readonly speakerId: string }
  | { readonly kind: 'visibleSpeech'; readonly visibleSpeechSegmentIds: readonly string[] };

const FIRST_STALE: Readonly<Record<RegenerateStage, ArtefactKind>> = {
  translation: 'translation',
  voice: 'speech',
  timing: 'timing',
  lipsync: 'lipsync',
};

const RESTART_STATE: Readonly<Record<RegenerateStage, JobState>> = {
  translation: 'TRANSLATING',
  voice: 'SYNTHESIZING',
  timing: 'TIMING',
  lipsync: 'LIP_SYNCING',
};

export interface RegenerationPlan {
  readonly stage: RegenerateStage;
  readonly scope: InvalidationScope;
  /** The state the target job re-enters. */
  readonly restartAt: JobState;
  /** Artefact kinds that become stale for the scope, in stage order. */
  readonly invalidates: readonly ArtefactKind[];
  /** Artefact kinds that survive for the scope. */
  readonly preserves: readonly ArtefactKind[];
}

/** Every artefact kind at or after `kind` in stage order. Transitive by construction. */
export function downstreamOf(kind: ArtefactKind): readonly ArtefactKind[] {
  const i = ARTEFACT_ORDER.indexOf(kind);
  return ARTEFACT_ORDER.slice(i);
}

export function planRegeneration(
  stage: RegenerateStage,
  scope: InvalidationScope,
): RegenerationPlan {
  if (stage === 'voice' && scope.kind !== 'speaker') {
    throw new RangeError('voice regeneration is scoped per speaker');
  }
  if (stage === 'lipsync' && scope.kind === 'speaker') {
    throw new RangeError('lip-sync regeneration is scoped per segment or visible-speech segment');
  }
  const first = FIRST_STALE[stage];
  const invalidates = downstreamOf(first);
  const preserves = ARTEFACT_ORDER.filter((k) => !invalidates.includes(k));
  return { stage, scope, restartAt: RESTART_STATE[stage], invalidates, preserves };
}

/** True if artefacts of `kind` must be discarded under `plan`. */
export function isInvalidated(plan: RegenerationPlan, kind: ArtefactKind): boolean {
  return plan.invalidates.includes(kind);
}
