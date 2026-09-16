import { describe, expect, test } from 'vitest';
import {
  ErrorEnvelopeSchema,
  LanguageCapabilitiesResponseSchema,
  MediaMetadataSchema,
  TargetStageChangedSchema,
  WorkerTaskSchema,
} from '../src/index.js';
import { SEED_LOCALES, uuidv7 } from '@polycast/domain';

describe('contracts', () => {
  test('error envelope requires code/message/correlationId and defaults fieldErrors', () => {
    const parsed = ErrorEnvelopeSchema.parse({
      code: 'NOT_FOUND',
      message: 'Project not found',
      correlationId: 'abc',
      retryable: false,
    });
    expect(parsed.fieldErrors).toEqual([]);
    expect(() =>
      ErrorEnvelopeSchema.parse({
        code: 'BOGUS',
        message: '',
        correlationId: '',
        retryable: false,
      }),
    ).toThrow();
  });

  test('seed registry serialises through the capabilities response schema', () => {
    const res = LanguageCapabilitiesResponseSchema.parse({
      region: 'us-east-1',
      priorityScoreVersion: '2026-Q3',
      locales: SEED_LOCALES,
    });
    expect(res.locales).toHaveLength(SEED_LOCALES.length);
  });

  test('stage-changed event validates and rejects unknown states', () => {
    const ok = TargetStageChangedSchema.parse({
      eventId: uuidv7(),
      name: 'target.stage.changed',
      occurredAt: new Date().toISOString(),
      organizationId: uuidv7(),
      correlationId: 'c',
      schemaVersion: 1,
      payload: {
        jobId: uuidv7(),
        targetJobId: uuidv7(),
        locale: 'de-DE',
        from: 'TRANSLATING',
        to: 'SYNTHESIZING',
        attempt: 0,
        progress: 0.3,
      },
    });
    expect(ok.payload.to).toBe('SYNTHESIZING');
    expect(() =>
      TargetStageChangedSchema.parse({ ...ok, payload: { ...ok.payload, to: 'DONE' } }),
    ).toThrow();
  });

  test('media metadata uses integer microseconds and rational frame rates', () => {
    expect(() => MediaMetadataSchema.parse({ container: 'mov', durationUs: 1.5 })).toThrow();
    const m = MediaMetadataSchema.parse({
      container: 'mov',
      durationUs: 60_000_000,
      video: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: { num: 30000, den: 1001 },
        variableFrameRate: false,
        hdr: false,
      },
    });
    expect(m.video?.frameRate.den).toBe(1001);
  });

  test('worker task never carries media, only references', () => {
    const task = WorkerTaskSchema.parse({
      taskId: uuidv7(),
      organizationId: uuidv7(),
      jobId: uuidv7(),
      targetJobId: null,
      stage: 'VALIDATING',
      idempotencyKey: 'validate:asset:1',
      correlationId: 'c',
      inputAssetIds: [uuidv7()],
      parameters: {},
      taskToken: null,
    });
    expect(Object.keys(task)).not.toContain('bytes');
  });
});
