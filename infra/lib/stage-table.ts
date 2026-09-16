/**
 * Stage table for the Polycast Step Functions definitions (ADR-0004, assumption A-08).
 *
 * `TARGET_STAGES` is a deliberate copy of `TARGET_STAGE_ORDER` in
 * `apps/api/src/orchestrator/local.ts`. This package is CommonJS and cannot import the ESM API
 * workspace, so the two arrays are kept in sync by `test/polycast-stage-table.test.ts`, which
 * reads the API source as text and fails when a stage is missing or out of order.
 *
 * The child state machine (`PolycastOrchestration`) has one task-token state per entry, named
 * exactly like the job state (`packages/domain` job state machine), plus `<STAGE>_FAILED` Fail
 * states and the two Choice states (`LipSyncEnabled`, `ReadyGate`) documented in the stack.
 */
export const TARGET_STAGES = [
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'PACKAGING',
] as const;

export type TargetStage = (typeof TARGET_STAGES)[number];

/** Parent (LocalizationJob) states in order; Pass states in M2 because analysis already ran. */
export const PARENT_STAGES = ['TRANSCRIBING', 'SOURCE_QA', 'TARGETS_FAN_OUT'] as const;
