import { z } from 'zod';
import { IdSchema, LocaleTagSchema, MicrosecondsSchema, Sha256Schema } from './common.js';
import { MediaMetadataSchema, TimeRangeSchema } from './media.js';
import { ProvenanceManifestSchema, QcReportSchema } from './provenance.js';
import { SegmentSchema, SpeakerSchema } from './projects.js';

/**
 * Worker protocol. The media worker never holds a database connection: it claims tasks from
 * the API's internal endpoint, does the work against object storage, and posts a typed
 * result. Every task is idempotent on (targetJobId | assetId, stage, attempt).
 */
export const WORKER_STAGES = [
  'VALIDATING',
  'ANALYZING',
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'PACKAGING',
] as const;
export const WorkerStageSchema = z.enum(WORKER_STAGES);
export type WorkerStage = z.infer<typeof WorkerStageSchema>;

/** `s3://bucket/key` in AWS and docker-compose (MinIO); `local://bucket/key` with the filesystem driver. */
export const StorageUriSchema = z.string().regex(/^(s3|local):\/\/[a-z0-9.-]+\/.+$/);

export const StorageLocationsSchema = z.object({
  /** Where the worker reads the immutable source from. */
  source: StorageUriSchema.nullable(),
  /** Prefix (ends with '/') the worker writes derived artefacts under for this task. */
  derivedPrefix: StorageUriSchema,
  /** Prefix for deliverables (PACKAGING only). */
  deliverablesPrefix: StorageUriSchema.nullable(),
});

export const TranslationInputSchema = z.object({
  translationVersionId: IdSchema,
  segmentId: IdSchema,
  adaptedText: z.string(),
  timingBudgetUs: MicrosecondsSchema,
  generation: z.number().int().positive(),
});

export const SpeechInputSchema = z.object({
  renderId: IdSchema,
  translationVersionId: IdSchema,
  segmentId: IdSchema,
  measuredDurationUs: MicrosecondsSchema,
  timeStretchRatio: z.number().positive(),
  voiceId: z.string(),
});

export const ValidatingParamsSchema = z.object({
  assetId: IdSchema,
  projectId: IdSchema,
  /** Quarantine object; the worker copies it to `storage.source` after validation. */
  quarantine: StorageUriSchema,
  declaredContentType: z.string(),
  declaredByteSize: z.number().int().positive(),
  maxDurationUs: MicrosecondsSchema,
});

export const AnalyzingParamsSchema = z.object({
  assetId: IdSchema,
  projectId: IdSchema,
  metadata: MediaMetadataSchema,
  declaredLocale: LocaleTagSchema.nullable(),
});

export const TargetParamsSchema = z.object({
  targetJobId: IdSchema,
  projectId: IdSchema,
  jobId: IdSchema,
  sourceLocale: LocaleTagSchema,
  targetLocale: LocaleTagSchema,
  direction: z.enum(['ltr', 'rtl']),
  lipSync: z.boolean(),
  metadata: MediaMetadataSchema,
  sourceSha256: Sha256Schema,
  speakers: z.array(SpeakerSchema),
  /** Segments in scope for this run (all, or the regenerated subset). */
  segments: z.array(SegmentSchema),
  /** Current translations for segments in scope (empty for TRANSLATING). */
  translations: z.array(TranslationInputSchema),
  /** Current speech renders for segments in scope (empty before SYNTHESIZING). */
  speech: z.array(SpeechInputSchema),
  /** Free-text hint from a reviewer for regeneration; never logged. */
  hint: z.string().nullable(),
  /** Deliverable package version to write (PACKAGING only). */
  packageVersion: z.number().int().positive().nullable(),
  provenance: z
    .object({
      translationVersionIds: z.array(IdSchema),
      qcReport: QcReportSchema.nullable(),
    })
    .nullable(),
});

export const WorkerTaskSchema = z.object({
  taskId: IdSchema,
  organizationId: IdSchema,
  jobId: IdSchema.nullable(),
  targetJobId: IdSchema.nullable(),
  assetId: IdSchema.nullable(),
  stage: WorkerStageSchema,
  attempt: z.number().int().positive(),
  idempotencyKey: z.string().min(8),
  correlationId: z.string(),
  storage: StorageLocationsSchema,
  /** Stage-specific parameters; validated by the worker against the matching *ParamsSchema. */
  parameters: z.union([ValidatingParamsSchema, AnalyzingParamsSchema, TargetParamsSchema]),
  /** Step Functions task token when the stage is orchestrated remotely (null locally). */
  taskToken: z.string().nullable(),
  /** Seconds the claim is valid before another worker may take the task. */
  leaseSeconds: z.number().int().positive(),
});
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;

export const ClaimTaskRequestSchema = z.object({
  workerId: z.string().min(1).max(120),
  stages: z.array(WorkerStageSchema).optional(),
});

/* ---------- stage outputs ---------- */

export const ValidatingOutputSchema = z.object({
  metadata: MediaMetadataSchema,
  sha256: Sha256Schema,
  byteSize: z.number().int().positive(),
  /** Immutable source location after the copy out of quarantine. */
  source: StorageUriSchema,
});

export const AnalyzingOutputSchema = z.object({
  detectedLocale: LocaleTagSchema,
  detectionConfidence: z.number().min(0).max(1),
  provider: z.string(),
  providerVersion: z.string(),
  hasVideo: z.boolean(),
  proxy: StorageUriSchema,
  waveform: StorageUriSchema,
  speakers: z.array(SpeakerSchema.omit({ id: true }).extend({ key: z.string() })),
  segments: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      speakerKey: z.string(),
      range: TimeRangeSchema,
      text: z.string(),
      language: z.string(),
      confidence: z.number().min(0).max(1),
      words: z.array(
        z.object({
          text: z.string(),
          range: TimeRangeSchema,
          confidence: z.number().min(0).max(1),
        }),
      ),
    }),
  ),
});

export const TranslatingOutputSchema = z.object({
  provider: z.string(),
  providerVersion: z.string(),
  promptVersion: z.string().nullable(),
  translations: z.array(
    z.object({
      segmentId: IdSchema,
      adaptedText: z.string(),
      literalText: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      timingBudgetUs: MicrosecondsSchema,
    }),
  ),
});

export const SynthesizingOutputSchema = z.object({
  provider: z.string(),
  providerVersion: z.string(),
  renders: z.array(
    z.object({
      segmentId: IdSchema,
      translationVersionId: IdSchema,
      voiceId: z.string(),
      measuredDurationUs: MicrosecondsSchema,
      audio: StorageUriSchema.nullable(),
    }),
  ),
});

export const TimingOutputSchema = z.object({
  fits: z.array(
    z.object({
      segmentId: IdSchema,
      strategy: z.enum(['none', 'rate', 'boundary-shift', 'retranslate']),
      timeStretchRatio: z.number().positive(),
      boundaryShiftUs: z.number().int(),
      fits: z.boolean(),
    }),
  ),
});

export const LipSyncOutputSchema = z.object({
  provider: z.string(),
  providerVersion: z.string(),
  applied: z.boolean(),
  renders: z.array(
    z.object({
      segmentId: IdSchema,
      syncConfidence: z.number().min(0).max(1),
      video: StorageUriSchema.nullable(),
    }),
  ),
});

export const MixingOutputSchema = z.object({
  mix: StorageUriSchema,
  integratedLufs: z.number(),
  truePeakDbtp: z.number(),
});

export const EncodingOutputSchema = z.object({
  encode: StorageUriSchema,
  container: z.string(),
  byteSize: z.number().int().positive(),
});

export const TargetQaOutputSchema = z.object({
  provider: z.string(),
  checks: z.array(
    z.object({
      metric: z.string(),
      threshold: z.number().nullable(),
      value: z.number().nullable(),
      passed: z.boolean(),
    }),
  ),
  issues: z.array(
    z.object({
      metric: z.string(),
      segmentId: IdSchema.nullable(),
      severity: z.enum(['info', 'warning', 'critical']),
      range: TimeRangeSchema.nullable(),
      recommendation: z.string(),
    }),
  ),
});

export const PackagingOutputSchema = z.object({
  deliverables: z.array(
    z.object({
      kind: z.enum([
        'media',
        'captions-srt',
        'captions-vtt',
        'transcript-json',
        'qc-report',
        'provenance-manifest',
        'checksums',
      ]),
      fileName: z.string(),
      contentType: z.string(),
      byteSize: z.number().int().nonnegative(),
      sha256: Sha256Schema,
      uri: StorageUriSchema,
    }),
  ),
  manifest: ProvenanceManifestSchema,
});

export const StageOutputSchema = z.union([
  ValidatingOutputSchema,
  AnalyzingOutputSchema,
  TranslatingOutputSchema,
  SynthesizingOutputSchema,
  TimingOutputSchema,
  LipSyncOutputSchema,
  MixingOutputSchema,
  EncodingOutputSchema,
  TargetQaOutputSchema,
  PackagingOutputSchema,
]);

export const TaskResultSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  /** Failed tasks: whether the orchestrator should retry (RETRY_WAIT) or fail terminally. */
  retryable: z.boolean().default(false),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  output: z.record(z.unknown()).nullable().default(null),
  workerId: z.string().min(1),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const TaskResultResponseSchema = z.object({
  accepted: z.boolean(),
  nextState: z.string().nullable(),
});
