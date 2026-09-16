import { createHash } from 'node:crypto';
import { uuidv7 } from '@polycast/domain';
import type { Queryable } from './db/pool.js';

export interface AuditInput {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly correlationId: string;
  readonly ipAddress?: string | null;
}

const hash = (v: unknown): string | null =>
  v === undefined ? null : createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Append-only audit trail (FR-061, BR-07). Records hashes of before/after states, never the
 * content itself, so transcripts and media never land in the audit table either.
 */
export async function recordAudit(tx: Queryable, input: AuditInput): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO audit_events (id, organization_id, actor_user_id, action, object_type, object_id, before_hash, after_hash, correlation_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.organizationId,
      input.actorUserId,
      input.action,
      input.objectType,
      input.objectId,
      hash(input.before),
      hash(input.after),
      input.correlationId,
      input.ipAddress ?? null,
    ],
  );
  return id;
}
