import { uuidv7 } from '@polycast/domain';
import type { DomainEvent, EventName } from '@polycast/contracts';
import type { Queryable } from '../db/pool.js';

export const EVENT_CHANNEL = 'polycast_events';

export interface EmitInput {
  readonly name: EventName;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly projectId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Transactional outbox (docs/architecture.md §7): the event row commits with the state change,
 * and the NOTIFY fires only if the transaction commits. Payloads carry ids only.
 */
export async function emitEvent(tx: Queryable, input: EmitInput): Promise<DomainEvent> {
  const id = uuidv7();
  const occurredAt = new Date().toISOString();
  const event = {
    eventId: id,
    name: input.name,
    occurredAt,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    schemaVersion: 1 as const,
    subject: input.subject,
    payload: input.payload,
  } as DomainEvent;
  await tx.query(
    `INSERT INTO domain_events (id, organization_id, name, occurred_at, correlation_id, subject_type, subject_id, project_id, payload, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [
      id,
      input.organizationId,
      input.name,
      occurredAt,
      input.correlationId,
      input.subject.type,
      input.subject.id,
      input.projectId,
      JSON.stringify(input.payload),
    ],
  );
  // NOTIFY payload limit is 8000 bytes; events carry ids only so this always fits.
  await tx.query('SELECT pg_notify($1, $2)', [EVENT_CHANNEL, JSON.stringify(event)]);
  return event;
}
