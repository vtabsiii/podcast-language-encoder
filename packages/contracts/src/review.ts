import { z } from 'zod';
import { REGENERATE_STAGES } from '@polycast/domain';
import { IdSchema, IsoTimestampSchema, MicrosecondsSchema } from './common.js';
import { TargetJobSchema } from './jobs.js';
import { SegmentSchema, SpeakerSchema } from './projects.js';
import { TimeRangeSchema } from './media.js';

export const QcSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const IssueResolutionSchema = z.enum(['open', 'accepted', 'regenerated', 'dismissed']);

export const QcIssueSchema = z.object({
  id: IdSchema,
  qcCheckId: IdSchema,
  segmentId: IdSchema.nullable(),
  metric: z.string(),
  severity: QcSeveritySchema,
  range: TimeRangeSchema.nullable(),
  recommendation: z.string(),
  resolution: IssueResolutionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const QcCheckSchema = z.object({
  id: IdSchema,
  metric: z.string(),
  threshold: z.number().nullable(),
  value: z.number().nullable(),
  passed: z.boolean(),
  provider: z.string(),
  runNo: z.number().int().positive(),
  createdAt: IsoTimestampSchema,
});

export const TranslationVersionSchema = z.object({
  id: IdSchema,
  segmentId: IdSchema,
  adaptedText: z.string(),
  literalText: z.string().nullable(),
  timingBudgetUs: MicrosecondsSchema,
  provider: z.string(),
  providerVersion: z.string(),
  promptVersion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  editedByUserId: IdSchema.nullable(),
  supersedesId: IdSchema.nullable(),
  /** Number of versions in this lineage, 1 for the original. */
  generation: z.number().int().positive(),
  createdAt: IsoTimestampSchema,
});

export const SpeechRenderSummarySchema = z.object({
  id: IdSchema,
  translationVersionId: IdSchema,
  provider: z.string(),
  voiceId: z.string(),
  measuredDurationUs: MicrosecondsSchema,
  timeStretchRatio: z.number().positive(),
  stale: z.boolean(),
});

export const ReviewSegmentSchema = z.object({
  segment: SegmentSchema,
  translation: TranslationVersionSchema.nullable(),
  /** Superseded versions, newest first, for lineage display. */
  history: z.array(TranslationVersionSchema),
  speech: SpeechRenderSummarySchema.nullable(),
  issues: z.array(QcIssueSchema),
  approved: z.boolean(),
});

export const ReviewResponseSchema = z.object({
  target: TargetJobSchema,
  sourceLocale: z.string(),
  direction: z.enum(['ltr', 'rtl']),
  speakers: z.array(SpeakerSchema),
  segments: z.array(ReviewSegmentSchema),
  checks: z.array(QcCheckSchema),
  openIssues: z.number().int().nonnegative(),
  /** Short-lived link to the low-bitrate proxy for playback (≤ 15 min). */
  proxyUrl: z.string().url().nullable(),
  waveformUrl: z.string().url().nullable(),
});

export const RegenerateRequestSchema = z.object({
  stage: z.enum(REGENERATE_STAGES),
  /** Free-text hint passed to the adapter ("shorter", "more formal"). Never logged. */
  hint: z.string().max(500).optional(),
});

export const RegenerateResponseSchema = z.object({
  target: TargetJobSchema,
  segmentId: IdSchema,
  restartAt: z.string(),
  invalidated: z.array(z.string()),
});

export const EditTranslationRequestSchema = z.object({
  adaptedText: z.string().min(1).max(5000),
});

export const ResolveIssueRequestSchema = z.object({
  resolution: z.enum(['accepted', 'dismissed']),
});

export const ApproveRequestSchema = z.object({
  /** Segment ids to approve. Empty means the whole target. */
  segmentIds: z.array(IdSchema).default([]),
});

export const ApproveResponseSchema = z.object({
  target: TargetJobSchema,
  approvedSegments: z.number().int().nonnegative(),
  remainingSegments: z.number().int().nonnegative(),
});

export const CommentSchema = z.object({
  id: IdSchema,
  authorUserId: IdSchema,
  authorName: z.string(),
  body: z.string(),
  segmentId: IdSchema.nullable(),
  createdAt: IsoTimestampSchema,
});

export const CreateCommentRequestSchema = z.object({
  body: z.string().min(1).max(4000),
  segmentId: IdSchema.optional(),
});

export const CommentsResponseSchema = z.object({ comments: z.array(CommentSchema) });

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
export type ReviewSegment = z.infer<typeof ReviewSegmentSchema>;
export type QcIssue = z.infer<typeof QcIssueSchema>;
export type RegenerateRequest = z.infer<typeof RegenerateRequestSchema>;
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;
export type RegenerateResponse = z.infer<typeof RegenerateResponseSchema>;
export type CommentsResponse = z.infer<typeof CommentsResponseSchema>;
export type Comment = z.infer<typeof CommentSchema>;
