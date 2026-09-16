import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  HAPPY_PATH,
  JOB_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  WORKING_STATES,
  IllegalTransitionError,
  canTransition,
  isTerminal,
  nextHappyPathState,
  transition,
  weightedProgress,
  type JobState,
} from '../src/index.js';

const anyState = fc.constantFrom(...JOB_STATES);

describe('job state machine', () => {
  test('every state has a transition entry', () => {
    for (const s of JOB_STATES) expect(TRANSITIONS[s]).toBeInstanceOf(Set);
  });

  test('the happy path is walkable end to end', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      const from = HAPPY_PATH[i] as JobState;
      const to = HAPPY_PATH[i + 1] as JobState;
      expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
      expect(nextHappyPathState(from)).toBe(to);
    }
    expect(nextHappyPathState('COMPLETE')).toBeUndefined();
  });

  test('audio-only sources may skip lip sync', () => {
    expect(canTransition('TIMING', 'MIXING')).toBe(true);
  });

  test('property: terminal states (except COMPLETE re-export) have no outgoing transitions', () => {
    fc.assert(
      fc.property(anyState, (s) => {
        if (s === 'FAILED' || s === 'CANCELLED') expect(TRANSITIONS[s].size).toBe(0);
      }),
    );
  });

  test('property: every working state can fail, wait for retry, and be cancelled', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORKING_STATES), (s) => {
        expect(canTransition(s, 'FAILED')).toBe(true);
        expect(canTransition(s, 'RETRY_WAIT')).toBe(true);
        expect(canTransition(s, 'CANCEL_REQUESTED')).toBe(true);
      }),
    );
  });

  test('property: RETRY_WAIT can only resume into a working state', () => {
    fc.assert(
      fc.property(anyState, (to) => {
        if (canTransition('RETRY_WAIT', to)) {
          expect(WORKING_STATES.has(to) || to === 'FAILED' || to === 'CANCEL_REQUESTED').toBe(true);
        }
      }),
    );
  });

  test('property: transition() agrees with canTransition() and never returns a different state', () => {
    fc.assert(
      fc.property(anyState, anyState, (from, to) => {
        if (canTransition(from, to)) {
          expect(transition(from, to)).toBe(to);
        } else {
          expect(() => transition(from, to)).toThrow(IllegalTransitionError);
        }
      }),
    );
  });

  test('property: no state can jump forward more than one happy-path stage', () => {
    fc.assert(
      fc.property(fc.constantFrom(...HAPPY_PATH), fc.constantFrom(...HAPPY_PATH), (from, to) => {
        const i = HAPPY_PATH.indexOf(from);
        const j = HAPPY_PATH.indexOf(to);
        // Forward jumps of >1 are only legal for the audio-only skip (TIMING → MIXING).
        if (j > i + 1 && canTransition(from, to)) {
          expect([from, to]).toEqual(['TIMING', 'MIXING']);
        }
      }),
    );
  });

  test('property: every non-terminal state has a path to COMPLETE, FAILED or CANCELLED', () => {
    const reach = (start: JobState): Set<JobState> => {
      const seen = new Set<JobState>();
      const stack = [start];
      while (stack.length) {
        const s = stack.pop() as JobState;
        for (const n of TRANSITIONS[s]) {
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      return seen;
    };
    fc.assert(
      fc.property(anyState, (s) => {
        if (isTerminal(s)) return;
        const r = reach(s);
        expect([...TERMINAL_STATES].some((t) => r.has(t))).toBe(true);
      }),
    );
  });

  test('weighted progress is monotonic along the happy path and honest about waiting', () => {
    let last = -1;
    for (const s of HAPPY_PATH) {
      const p = weightedProgress(s);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(weightedProgress('UPLOADING')).toBe(0);
    expect(weightedProgress('COMPLETE')).toBe(1);
    // Before lip sync, an audio-only job is further along (same work done, smaller total).
    expect(weightedProgress('TIMING', { audioOnly: true })).toBeGreaterThan(
      weightedProgress('TIMING'),
    );
    // Both reach 1 at COMPLETE.
    expect(weightedProgress('COMPLETE', { audioOnly: true })).toBe(1);
    // Exception states carry no progress of their own.
    expect(weightedProgress('RETRY_WAIT')).toBe(0);
  });
});
