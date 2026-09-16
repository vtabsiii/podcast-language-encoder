import { z } from 'zod';
import { JOB_STATES } from '@polycast/domain';

/**
 * Domain event envelope (EventBridge detail). Names are in docs/architecture.md event catalog.
 * Payloads carry ids only; never media, transcripts, or signed URLs.
 */
export const EVENT_NAMES = [
  'project.created',
  'upload.completed',
  'asset.validated',
  'analysis.completed',
  'job.created',
  'target.stage.changed',
  'target.review.required',
  'target.ready',
  'deliverable.packaged',
  'consent.revoked',
  'audit.recorded',
] as const;

const base = {
  eventId: z.string().uuid(),
  name: z.enum(EVENT_NAMES),
  occurredAt: z.string().datetime(),
  organizationId: z.string().uuid(),
  correlationId: z.string(),
  /** Schema version of the payload. Bump on breaking change; consumers must tolerate additive change. */
  schemaVersion: z.literal(1),
};

export const TargetStageChangedSchema = z.object({
  ...base,
  name: z.literal('target.stage.changed'),
  payload: z.object({
    jobId: z.string().uuid(),
    targetJobId: z.string().uuid(),
    locale: z.string(),
    from: z.enum(JOB_STATES),
    to: z.enum(JOB_STATES),
    attempt: z.number().int().nonnegative(),
    /** Weighted progress in [0,1] for honest UI rendering. */
    progress: z.number().min(0).max(1),
  }),
});

export const GenericEventSchema = z.object({
  ...base,
  payload: z.record(z.unknown()),
});

export const DomainEventSchema = z.union([TargetStageChangedSchema, GenericEventSchema]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type TargetStageChanged = z.infer<typeof TargetStageChangedSchema>;
