import {
  DomainEventSchema,
  EVENT_NAMES,
  type AssetEvent,
  type DomainEvent,
  type JobEvent,
  type TargetStageChanged,
} from '@polycast/contracts';

/** Parse one SSE `data:` payload into a DomainEvent, or null when it does not validate. */
export function parseDomainEvent(data: string): DomainEvent | null {
  try {
    const parsed = DomainEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const DOMAIN_EVENT_NAMES: readonly string[] = EVENT_NAMES;

export function eventsUrl(projectId: string): string {
  return `/api/v1/events?projectId=${encodeURIComponent(projectId)}`;
}

/**
 * Type guards. `DomainEventSchema` is a union that ends in a generic fallback whose `name`
 * enum overlaps the typed variants, so narrowing on `name` alone is not enough for TS.
 */
export function isStageChanged(e: DomainEvent): e is TargetStageChanged {
  return (
    e.name === 'target.stage.changed' &&
    typeof e.payload === 'object' &&
    'targetJobId' in e.payload &&
    'to' in e.payload
  );
}

export function isAssetEvent(e: DomainEvent): e is AssetEvent {
  return (
    (e.name === 'upload.completed' ||
      e.name === 'asset.validated' ||
      e.name === 'asset.rejected' ||
      e.name === 'analysis.completed') &&
    'assetId' in e.payload
  );
}

export function isJobEvent(e: DomainEvent): e is JobEvent {
  return (
    (e.name === 'job.created' ||
      e.name === 'target.review.required' ||
      e.name === 'target.ready' ||
      e.name === 'deliverable.packaged') &&
    'jobId' in e.payload
  );
}
