import { describe, expect, test } from 'vitest';
import {
  AnalyzingOutputSchema,
  ErrorEnvelopeSchema,
  LanguageCapabilitiesResponseSchema,
  MediaMetadataSchema,
  PackagingOutputSchema,
  ProvenanceManifestSchema,
  TargetStageChangedSchema,
  TaskResultSchema,
  WorkerTaskSchema,
} from '../src/index.js';
import { SEED_LOCALES, uuidv7 } from '@polycast/domain';

const sha = 'a'.repeat(64);

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
      subject: { type: 'TargetJob', id: uuidv7() },
      payload: {
        projectId: uuidv7(),
        jobId: uuidv7(),
        targetJobId: uuidv7(),
        locale: 'de-DE',
        from: 'TRANSLATING',
        to: 'SYNTHESIZING',
        attempt: 1,
        progress: 0.3,
        message: null,
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

  test('worker task carries storage references only, never media', () => {
    const task = WorkerTaskSchema.parse({
      taskId: uuidv7(),
      organizationId: uuidv7(),
      jobId: null,
      targetJobId: null,
      assetId: uuidv7(),
      stage: 'VALIDATING',
      attempt: 1,
      idempotencyKey: 'validate:asset:1',
      correlationId: 'c',
      storage: {
        source: null,
        derivedPrefix: 'local://derived/org/asset/',
        deliverablesPrefix: null,
      },
      parameters: {
        assetId: uuidv7(),
        projectId: uuidv7(),
        quarantine: 'local://quarantine/org/asset/file.wav',
        declaredContentType: 'audio/wav',
        declaredByteSize: 10,
        maxDurationUs: 1,
      },
      taskToken: null,
      leaseSeconds: 300,
    });
    expect(Object.keys(task)).not.toContain('bytes');
    expect(() =>
      WorkerTaskSchema.parse({
        ...task,
        storage: { ...task.storage, derivedPrefix: 'http://x/y' },
      }),
    ).toThrow();
  });

  test('task result defaults and analysis output shape', () => {
    const r = TaskResultSchema.parse({ status: 'succeeded', workerId: 'w1', output: { ok: true } });
    expect(r.retryable).toBe(false);
    expect(r.error).toBeNull();
    const out = AnalyzingOutputSchema.parse({
      detectedLocale: 'en-US',
      detectionConfidence: 0.9,
      provider: 'mock-transcription',
      providerVersion: '0',
      hasVideo: false,
      proxy: 'local://derived/a/proxy.mp3',
      waveform: 'local://derived/a/waveform.json',
      speakers: [
        { key: 'A', label: 'Speaker A', onCamera: false, voicePolicy: 'stock', sampleRanges: [] },
      ],
      segments: [
        {
          seq: 0,
          speakerKey: 'A',
          range: { start: 0, end: 1_000_000 },
          text: 'Hello',
          language: 'en',
          confidence: 0.9,
          words: [{ text: 'Hello', range: { start: 0, end: 1_000_000 }, confidence: 0.9 }],
        },
      ],
    });
    expect(out.segments[0]?.range.end).toBe(1_000_000);
  });

  test('provenance manifest cannot omit disclosure or the mock flag', () => {
    const manifest = {
      schemaVersion: 1,
      generator: 'polycast-media-worker/0.1.0',
      generatedAt: new Date().toISOString(),
      jobId: uuidv7(),
      targetJobId: uuidv7(),
      projectId: uuidv7(),
      sourceLocale: 'en-US',
      targetLocale: 'es-MX',
      sourceSha256: sha,
      syntheticVoice: false,
      lipSyncApplied: false,
      mock: true,
      models: [
        {
          capability: 'translation',
          adapterId: 'mock-translation',
          version: '0',
          tier: 'unavailable',
          dataPolicy: 'no-training',
        },
      ],
      segmentCount: 3,
      translationVersionIds: [uuidv7()],
      files: [{ fileName: 'episode.es-MX.mp3', sha256: sha, byteSize: 10 }],
      disclosure: 'Mock providers; audio is the untranslated source.',
    };
    expect(ProvenanceManifestSchema.parse(manifest).mock).toBe(true);
    const noDisclosure: Record<string, unknown> = { ...manifest };
    delete noDisclosure['disclosure'];
    expect(() => ProvenanceManifestSchema.parse(noDisclosure)).toThrow();
    expect(
      PackagingOutputSchema.parse({
        deliverables: [
          {
            kind: 'provenance-manifest',
            fileName: 'provenance.json',
            contentType: 'application/json',
            byteSize: 1,
            sha256: sha,
            uri: 'local://deliverables/o/t/1/provenance.json',
          },
        ],
        manifest,
      }).deliverables,
    ).toHaveLength(1);
  });
});
