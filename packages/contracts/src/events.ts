import { z } from 'zod';
import { JOB_STATES } from '@polycast/domain';

/**
 * Domain event envelope (EventBridge detail / SSE message). Names are in docs/architecture.md
 * event catalog. Payloads carry ids only; never media, transcripts, or signed URLs.
 */
export const EVENT_NAMES = [
  'project.created',
  'upload.completed',
  'asset.validated',
  'asset.rejected',
  'analysis.completed',
  'job.created',
  'target.stage.changed',
  'target.review.required',
  'target.ready',
  'deliverable.packaged',
  'consent.revoked',
  'audit.recorded',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const base = {
  eventId: z.string().uuid(),
  name: z.enum(EVENT_NAMES),
  occurredAt: z.string().datetime(),
  organizationId: z.string().uuid(),
  correlationId: z.string(),
  /** Schema version of the payload. Bump on breaking change; consumers must tolerate additive change. */
  schemaVersion: z.literal(1),
  subject: z.object({ type: z.string(), id: z.string().uuid() }),
};

export const TargetStageChangedSchema = z.object({
  ...base,
  name: z.literal('target.stage.changed'),
  payload: z.object({
    projectId: z.string().uuid(),
    jobId: z.string().uuid(),
    targetJobId: z.string().uuid(),
    locale: z.string(),
    from: z.enum(JOB_STATES).nullable(),
    to: z.enum(JOB_STATES),
    attempt: z.number().int().nonnegative(),
    /** Weighted progress in [0,1] for honest UI rendering. */
    progress: z.number().min(0).max(1),
    /** Human-readable, redacted note (e.g. "retrying after transient error"). */
    message: z.string().nullable(),
  }),
});

export const AssetEventSchema = z.object({
  ...base,
  name: z.enum(['upload.completed', 'asset.validated', 'asset.rejected', 'analysis.completed']),
  payload: z.object({
    projectId: z.string().uuid(),
    assetId: z.string().uuid(),
    status: z.enum(JOB_STATES),
    reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});

export const JobEventSchema = z.object({
  ...base,
  name: z.enum(['job.created', 'target.review.required', 'target.ready', 'deliverable.packaged']),
  payload: z.object({
    projectId: z.string().uuid(),
    jobId: z.string().uuid(),
    targetJobId: z.string().uuid().nullable(),
    locale: z.string().nullable(),
  }),
});

export const GenericEventSchema = z.object({
  ...base,
  payload: z.record(z.unknown()),
});

export const DomainEventSchema = z.union([
  TargetStageChangedSchema,
  AssetEventSchema,
  JobEventSchema,
  GenericEventSchema,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type TargetStageChanged = z.infer<typeof TargetStageChangedSchema>;
export type AssetEvent = z.infer<typeof AssetEventSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
