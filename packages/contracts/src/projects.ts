import { z } from 'zod';
import { JOB_STATES } from '@polycast/domain';
import { IdSchema, IsoTimestampSchema, LocaleTagSchema, MicrosecondsSchema } from './common.js';
import { MediaMetadataSchema, TimeRangeSchema } from './media.js';

export const ProjectStateSchema = z.enum([
  'draft',
  'analyzing',
  'ready',
  'processing',
  'complete',
  'archived',
]);

export const CreateProjectRequestSchema = z.object({
  title: z.string().min(1).max(200),
  /** Producer-declared source locale; analysis may override with a detection the producer confirms. */
  sourceLocale: LocaleTagSchema.optional(),
});

export const ProjectSchema = z.object({
  id: IdSchema,
  title: z.string(),
  state: ProjectStateSchema,
  sourceLocale: LocaleTagSchema.nullable(),
  sourceAssetId: IdSchema.nullable(),
  ownerUserId: IdSchema,
  version: z.number().int(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const AssetStatusSchema = z.enum(JOB_STATES);

export const AssetSummarySchema = z.object({
  id: IdSchema,
  kind: z.string(),
  status: AssetStatusSchema,
  fileName: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  metadata: MediaMetadataSchema.nullable(),
  /** Typed rejection reason when validation failed. Never a raw provider error. */
  rejection: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const SpeakerSchema = z.object({
  id: IdSchema,
  label: z.string(),
  onCamera: z.boolean(),
  voicePolicy: z.enum(['matched-synthetic', 'verified-replica', 'stock', 'keep-original']),
  sampleRanges: z.array(TimeRangeSchema),
});

export const WordSchema = z.object({
  text: z.string(),
  range: TimeRangeSchema,
  confidence: z.number().min(0).max(1),
});

export const SegmentSchema = z.object({
  id: IdSchema,
  seq: z.number().int().nonnegative(),
  speakerId: IdSchema,
  range: TimeRangeSchema,
  text: z.string(),
  language: z.string(),
  confidence: z.number().min(0).max(1),
  words: z.array(WordSchema),
  version: z.number().int(),
});

export const AnalysisSchema = z.object({
  transcriptId: IdSchema,
  detectedLocale: LocaleTagSchema,
  detectionConfidence: z.number().min(0).max(1),
  confirmedLocale: LocaleTagSchema.nullable(),
  provider: z.string(),
  providerVersion: z.string(),
  durationUs: MicrosecondsSchema,
  hasVideo: z.boolean(),
  speakers: z.array(SpeakerSchema),
  segmentCount: z.number().int().nonnegative(),
});

export const TargetSummarySchema = z.object({
  targetJobId: IdSchema,
  jobId: IdSchema,
  locale: LocaleTagSchema,
  state: z.enum(JOB_STATES),
  approvalState: z.enum(['not-required', 'pending', 'approved', 'rejected']),
  progress: z.number().min(0).max(1),
  openIssues: z.number().int().nonnegative(),
});

export const ProjectListItemSchema = ProjectSchema.extend({
  asset: AssetSummarySchema.nullable(),
  targets: z.array(TargetSummarySchema),
  needsReviewCount: z.number().int().nonnegative(),
});

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectListItemSchema),
  budget: z.object({
    enabled: z.boolean(),
    monthlyBudgetCents: z.number().int().nullable(),
    reservedCents: z.number().int().nonnegative(),
  }),
});

export const ProjectDetailResponseSchema = z.object({
  project: ProjectSchema,
  asset: AssetSummarySchema.nullable(),
  analysis: AnalysisSchema.nullable(),
  targets: z.array(TargetSummarySchema),
});

export const ConfirmLocaleRequestSchema = z.object({ sourceLocale: LocaleTagSchema });

export const SegmentsResponseSchema = z.object({
  transcriptId: IdSchema,
  segments: z.array(SegmentSchema),
});

export type Project = z.infer<typeof ProjectSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;
export type AssetSummary = z.infer<typeof AssetSummarySchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type TargetSummary = z.infer<typeof TargetSummarySchema>;
export type SegmentsResponse = z.infer<typeof SegmentsResponseSchema>;
