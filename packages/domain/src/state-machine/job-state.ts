/**
 * Job / target-job state machine.
 *
 * A LocalizationJob owns the source-side states (UPLOADING … TARGETS_FAN_OUT); each
 * TargetJob (one per locale) owns the target-side states (TRANSLATING … COMPLETE).
 * Both share the same vocabulary and transition table so the orchestrator, API, and
 * UI agree on what is legal. Nothing outside this module may decide a transition.
 */

export const SOURCE_STATES = [
  'UPLOADING',
  'QUARANTINED',
  'VALIDATING',
  'ANALYZING',
  'READY_TO_CONFIGURE',
  'QUEUED',
  'TRANSCRIBING',
  'SOURCE_QA',
  'TARGETS_FAN_OUT',
] as const;

export const TARGET_STATES = [
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'NEEDS_REVIEW',
  'READY',
  'PACKAGING',
  'COMPLETE',
] as const;

export const EXCEPTION_STATES = ['RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'] as const;

export const JOB_STATES = [...SOURCE_STATES, ...TARGET_STATES, ...EXCEPTION_STATES] as const;

export type SourceState = (typeof SOURCE_STATES)[number];
export type TargetState = (typeof TARGET_STATES)[number];
export type ExceptionState = (typeof EXCEPTION_STATES)[number];
export type JobState = (typeof JOB_STATES)[number];

/** States from which no further transition is legal. */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'COMPLETE',
  'FAILED',
  'CANCELLED',
]);

/**
 * Stages that perform work and may therefore fail, time out, or be cancelled.
 * Gate/waiting states (READY_TO_CONFIGURE, NEEDS_REVIEW, READY) are not "working".
 */
export const WORKING_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'QUARANTINED',
  'VALIDATING',
  'ANALYZING',
  'TRANSCRIBING',
  'SOURCE_QA',
  'TARGETS_FAN_OUT',
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'PACKAGING',
]);

/** The happy path, in order. Used for progress weighting and rerun-from-stage. */
export const HAPPY_PATH: readonly JobState[] = [
  'UPLOADING',
  'QUARANTINED',
  'VALIDATING',
  'ANALYZING',
  'READY_TO_CONFIGURE',
  'QUEUED',
  'TRANSCRIBING',
  'SOURCE_QA',
  'TARGETS_FAN_OUT',
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'READY',
  'PACKAGING',
  'COMPLETE',
];

const next = (s: JobState): JobState => {
  const i = HAPPY_PATH.indexOf(s);
  const n = HAPPY_PATH[i + 1];
  if (i < 0 || n === undefined) throw new Error(`no successor for ${s}`);
  return n;
};

/**
 * Legal transitions. Keys are "from" states; values are the set of allowed "to" states.
 * Audio-only sources skip LIP_SYNCING: TIMING → MIXING is legal for them.
 */
export const TRANSITIONS: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  UPLOADING: new Set<JobState>(['QUARANTINED', 'FAILED', 'CANCELLED']),
  QUARANTINED: new Set<JobState>(['VALIDATING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  VALIDATING: new Set<JobState>(['ANALYZING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  ANALYZING: new Set<JobState>(['READY_TO_CONFIGURE', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  READY_TO_CONFIGURE: new Set<JobState>(['QUEUED', 'CANCELLED']),
  QUEUED: new Set<JobState>(['TRANSCRIBING', 'CANCELLED']),
  TRANSCRIBING: new Set<JobState>(['SOURCE_QA', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  SOURCE_QA: new Set<JobState>(['TARGETS_FAN_OUT', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  TARGETS_FAN_OUT: new Set<JobState>(['TRANSLATING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  TRANSLATING: new Set<JobState>(['SYNTHESIZING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  SYNTHESIZING: new Set<JobState>(['TIMING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  TIMING: new Set<JobState>([
    'LIP_SYNCING',
    'MIXING', // audio-only sources skip lip sync
    'RETRY_WAIT',
    'FAILED',
    'CANCEL_REQUESTED',
  ]),
  LIP_SYNCING: new Set<JobState>(['MIXING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  MIXING: new Set<JobState>(['ENCODING', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  ENCODING: new Set<JobState>(['TARGET_QA', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  TARGET_QA: new Set<JobState>([
    'NEEDS_REVIEW',
    'READY',
    'RETRY_WAIT',
    'FAILED',
    'CANCEL_REQUESTED',
  ]),
  NEEDS_REVIEW: new Set<JobState>([
    'READY', // all mandatory approvals recorded
    'SYNTHESIZING', // a segment was edited/regenerated: rerun downstream for impacted ranges
    'CANCELLED',
  ]),
  READY: new Set<JobState>(['PACKAGING', 'NEEDS_REVIEW', 'CANCELLED']),
  PACKAGING: new Set<JobState>(['COMPLETE', 'RETRY_WAIT', 'FAILED', 'CANCEL_REQUESTED']),
  COMPLETE: new Set<JobState>(['PACKAGING']), // re-export with a different preset only
  RETRY_WAIT: new Set<JobState>([...WORKING_STATES, 'FAILED', 'CANCEL_REQUESTED']),
  FAILED: new Set<JobState>(),
  CANCEL_REQUESTED: new Set<JobState>(['CANCELLED', 'FAILED']),
  CANCELLED: new Set<JobState>(),
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].has(to);
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(
    public readonly from: JobState,
    public readonly to: JobState,
  ) {
    super(`Illegal job state transition ${from} → ${to}`);
  }
}

/** Returns `to` if legal, otherwise throws. Pure; callers persist the result. */
export function transition(from: JobState, to: JobState): JobState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isWorking(state: JobState): boolean {
  return WORKING_STATES.has(state);
}

export function isSourceState(state: JobState): state is SourceState {
  return (SOURCE_STATES as readonly string[]).includes(state);
}

export function isTargetState(state: JobState): state is TargetState {
  return (TARGET_STATES as readonly string[]).includes(state);
}

/** The next happy-path stage after `state`, or undefined for terminal/exception states. */
export function nextHappyPathState(state: JobState): JobState | undefined {
  if (!HAPPY_PATH.includes(state) || state === 'COMPLETE') return undefined;
  return next(state);
}

/**
 * Relative effort weights per stage, used to render honest (non-linear) progress.
 * Sum is irrelevant; callers normalise. Waiting states carry zero weight.
 */
export const STAGE_WEIGHTS: Readonly<Record<JobState, number>> = {
  UPLOADING: 0,
  QUARANTINED: 1,
  VALIDATING: 1,
  ANALYZING: 6,
  READY_TO_CONFIGURE: 0,
  QUEUED: 0,
  TRANSCRIBING: 8,
  SOURCE_QA: 1,
  TARGETS_FAN_OUT: 0,
  TRANSLATING: 4,
  SYNTHESIZING: 6,
  TIMING: 2,
  LIP_SYNCING: 20,
  MIXING: 3,
  ENCODING: 6,
  TARGET_QA: 3,
  NEEDS_REVIEW: 0,
  READY: 0,
  PACKAGING: 2,
  COMPLETE: 0,
  RETRY_WAIT: 0,
  FAILED: 0,
  CANCEL_REQUESTED: 0,
  CANCELLED: 0,
};

/**
 * Weighted progress in [0, 1] for a job currently in `state`, counting all completed
 * happy-path stages before it. `audioOnly` removes LIP_SYNCING from the denominator.
 */
export function weightedProgress(state: JobState, opts: { audioOnly?: boolean } = {}): number {
  const path = HAPPY_PATH.filter((s) => !(opts.audioOnly && s === 'LIP_SYNCING'));
  const total = path.reduce((acc, s) => acc + STAGE_WEIGHTS[s], 0);
  if (state === 'COMPLETE') return 1;
  const idx = path.indexOf(state);
  if (idx < 0) return 0; // exception states report the progress of their last known stage elsewhere
  const done = path.slice(0, idx).reduce((acc, s) => acc + STAGE_WEIGHTS[s], 0);
  return total === 0 ? 0 : done / total;
}
