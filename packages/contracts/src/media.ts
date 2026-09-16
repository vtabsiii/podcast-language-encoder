import { z } from 'zod';

const Microseconds = z.number().int().nonnegative();
const Rational = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

/** Output of the media-worker `probe` step; shared with Python via JSON Schema. */
export const MediaMetadataSchema = z.object({
  container: z.string(),
  durationUs: Microseconds,
  video: z
    .object({
      codec: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      frameRate: Rational,
      variableFrameRate: z.boolean(),
      colorPrimaries: z.string().optional(),
      transferCharacteristics: z.string().optional(),
      hdr: z.boolean(),
    })
    .optional(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number().int().positive(),
      channels: z.number().int().positive(),
      channelLayout: z.string(),
    })
    .optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

export const TimeRangeSchema = z
  .object({ start: Microseconds, end: Microseconds })
  .refine((r) => r.end >= r.start, { message: 'end must be >= start' });

/** Message the API places on the worker queue. Contains references only. */
export const WorkerTaskSchema = z.object({
  taskId: z.string().uuid(),
  organizationId: z.string().uuid(),
  jobId: z.string().uuid(),
  targetJobId: z.string().uuid().nullable(),
  stage: z.enum(['VALIDATING', 'ANALYZING', 'MIXING', 'ENCODING', 'TARGET_QA', 'PACKAGING']),
  idempotencyKey: z.string().min(8),
  correlationId: z.string(),
  inputAssetIds: z.array(z.string().uuid()),
  /** Opaque, stage-specific parameters validated by the worker against its own schema. */
  parameters: z.record(z.unknown()),
  /** Step Functions task token when the stage is orchestrated remotely. */
  taskToken: z.string().nullable(),
});
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;
