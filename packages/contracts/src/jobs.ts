import { z } from 'zod';
import { JOB_STATES } from '@polycast/domain';
import { IdSchema, IsoTimestampSchema, LocaleTagSchema, MicrosecondsSchema } from './common.js';
import { CapabilityTierSchema } from './capabilities.js';
import { TargetSummarySchema } from './projects.js';

export const TargetOptionsSchema = z.object({
  locale: LocaleTagSchema,
  /** Lip sync only applies to video sources with visible speakers. Ignored for audio. */
  lipSync: z.boolean().default(false),
});

export const EstimateRequestSchema = z.object({
  targets: z.array(TargetOptionsSchema).min(1).max(22),
});

export const EstimateResponseSchema = z.object({
  rateCardVersion: z.string(),
  durationUs: MicrosecondsSchema,
  sourceLowCents: z.number().int().nonnegative(),
  sourceHighCents: z.number().int().nonnegative(),
  targets: z.array(
    z.object({
      locale: LocaleTagSchema,
      tier: CapabilityTierSchema,
      lipSync: z.boolean(),
      lowCents: z.number().int().nonnegative(),
      highCents: z.number().int().nonnegative(),
    }),
  ),
  totalLowCents: z.number().int().nonnegative(),
  totalHighCents: z.number().int().nonnegative(),
  budget: z.object({
    enabled: z.boolean(),
    remainingCents: z.number().int().nullable(),
    ok: z.boolean(),
  }),
});

export const CreateJobRequestSchema = z.object({
  projectId: IdSchema,
  targets: z.array(TargetOptionsSchema).min(1).max(22),
  /** Producer acknowledges beta-tier targets are excluded from quality SLAs (BR-05). */
  acceptBetaTerms: z.boolean().default(false),
});

export const LocalizationJobSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  state: z.enum(JOB_STATES),
  sourceLocale: LocaleTagSchema,
  targetLocales: z.array(LocaleTagSchema),
  estimatedCostCents: z.object({ low: z.number().int(), high: z.number().int() }),
  reservedBudgetCents: z.number().int(),
  rateCardVersion: z.string(),
  startedAt: IsoTimestampSchema.nullable(),
  completedAt: IsoTimestampSchema.nullable(),
  version: z.number().int(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const TargetJobSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  projectId: IdSchema,
  locale: LocaleTagSchema,
  state: z.enum(JOB_STATES),
  approvalState: z.enum(['not-required', 'pending', 'approved', 'rejected']),
  lipSync: z.boolean(),
  attempt: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  lastError: z.string().nullable(),
  openIssues: z.number().int().nonnegative(),
  version: z.number().int(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const JobResponseSchema = z.object({
  job: LocalizationJobSchema,
  targets: z.array(TargetJobSchema),
});

export const JobListResponseSchema = z.object({
  jobs: z.array(JobResponseSchema),
});

export const StageHistoryEntrySchema = z.object({
  eventId: IdSchema,
  occurredAt: IsoTimestampSchema,
  targetJobId: IdSchema.nullable(),
  from: z.enum(JOB_STATES).nullable(),
  to: z.enum(JOB_STATES),
  attempt: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  message: z.string().nullable(),
});

export const JobHistoryResponseSchema = z.object({
  job: LocalizationJobSchema,
  targets: z.array(TargetSummarySchema),
  history: z.array(StageHistoryEntrySchema),
});

export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;
export type EstimateResponse = z.infer<typeof EstimateResponseSchema>;
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;
export type LocalizationJobView = z.infer<typeof LocalizationJobSchema>;
export type TargetJobView = z.infer<typeof TargetJobSchema>;
export type JobResponse = z.infer<typeof JobResponseSchema>;
export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type JobHistoryResponse = z.infer<typeof JobHistoryResponseSchema>;
