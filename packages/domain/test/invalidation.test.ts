import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  ARTEFACT_ORDER,
  REGENERATE_STAGES,
  canTransition,
  downstreamOf,
  isInvalidated,
  planRegeneration,
  type InvalidationScope,
  type RegenerateStage,
} from '../src/index.js';

const scopeFor = (stage: RegenerateStage): InvalidationScope =>
  stage === 'voice'
    ? { kind: 'speaker', speakerId: 'spk' }
    : { kind: 'segment', segmentIds: ['seg'] };

describe('invalidation graph', () => {
  test('translation regeneration invalidates everything downstream and preserves nothing before it', () => {
    const plan = planRegeneration('translation', { kind: 'segment', segmentIds: ['s1'] });
    expect(plan.restartAt).toBe('TRANSLATING');
    expect(plan.invalidates).toEqual([...ARTEFACT_ORDER]);
    expect(plan.preserves).toEqual([]);
  });

  test('voice regeneration preserves translations', () => {
    const plan = planRegeneration('voice', { kind: 'speaker', speakerId: 'spk' });
    expect(plan.restartAt).toBe('SYNTHESIZING');
    expect(plan.preserves).toEqual(['translation']);
    expect(isInvalidated(plan, 'approval')).toBe(true);
  });

  test('timing regeneration preserves translation and speech audio', () => {
    const plan = planRegeneration('timing', { kind: 'segment', segmentIds: ['s1'] });
    expect(plan.preserves).toEqual(['translation', 'speech']);
  });

  test('lip-sync regeneration preserves the audio chain', () => {
    const plan = planRegeneration('lipsync', {
      kind: 'visibleSpeech',
      visibleSpeechSegmentIds: ['v'],
    });
    expect(plan.preserves).toEqual(['translation', 'speech', 'timing']);
    expect(plan.invalidates).toEqual(['lipsync', 'mix', 'encode', 'qc', 'approval']);
  });

  test('scope constraints are enforced', () => {
    expect(() => planRegeneration('voice', { kind: 'segment', segmentIds: ['s'] })).toThrow(
      RangeError,
    );
    expect(() => planRegeneration('lipsync', { kind: 'speaker', speakerId: 'x' })).toThrow(
      RangeError,
    );
  });

  test('property: invalidation is transitive and approvals never survive a regeneration', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REGENERATE_STAGES), (stage) => {
        const plan = planRegeneration(stage, scopeFor(stage));
        // contiguous suffix of the stage order
        const first = ARTEFACT_ORDER.indexOf(plan.invalidates[0]!);
        expect(plan.invalidates).toEqual(ARTEFACT_ORDER.slice(first));
        expect(plan.invalidates).toContain('qc');
        expect(plan.invalidates).toContain('approval');
        expect([...plan.preserves, ...plan.invalidates]).toEqual([...ARTEFACT_ORDER]);
        // the restart state is reachable from NEEDS_REVIEW
        expect(canTransition('NEEDS_REVIEW', plan.restartAt)).toBe(true);
      }),
    );
  });

  test('downstreamOf is a suffix', () => {
    for (const k of ARTEFACT_ORDER) expect(downstreamOf(k)[0]).toBe(k);
  });
});
