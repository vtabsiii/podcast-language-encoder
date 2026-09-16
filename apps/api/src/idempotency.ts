import { createHash } from 'node:crypto';
import { DomainError } from '@polycast/domain';
import type { Queryable } from './db/pool.js';

export interface StoredResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

const hashRequest = (body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');

/**
 * Idempotency-Key handling (FR-050). The first request with a key reserves it inside the
 * caller's transaction; a replay with the same body returns the stored response; a replay with
 * a different body is a CONFLICT. Keys are tenant-scoped through RLS.
 */
export async function beginIdempotent(
  tx: Queryable,
  organizationId: string,
  key: string,
  body: unknown,
): Promise<StoredResponse | null> {
  const requestHash = hashRequest(body);
  const existing = (
    await tx.query<{ request_hash: string; status_code: number | null; response: unknown }>(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE organization_id = $1 AND idem_key = $2 FOR UPDATE',
      [organizationId, key],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new DomainError(
        'CONFLICT',
        'Idempotency-Key was already used with a different request body',
      );
    }
    if (existing.status_code === null) {
      throw new DomainError(
        'CONFLICT',
        'A request with this Idempotency-Key is still in progress',
        { retryable: true },
      );
    }
    return { statusCode: existing.status_code, body: existing.response };
  }
  await tx.query(
    'INSERT INTO idempotency_keys (organization_id, idem_key, request_hash) VALUES ($1,$2,$3)',
    [organizationId, key, requestHash],
  );
  return null;
}

export async function finishIdempotent(
  tx: Queryable,
  organizationId: string,
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await tx.query(
    'UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE organization_id = $1 AND idem_key = $2',
    [organizationId, key, statusCode, JSON.stringify(body)],
  );
}
