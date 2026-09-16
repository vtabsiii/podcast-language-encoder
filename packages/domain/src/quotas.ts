/**
 * Concurrency and size limits (FR-051, NFR-007). Values are conservative M1 defaults;
 * per-organization overrides arrive with the billing work in M5.
 */

import { DomainError } from './errors/domain-error.js';

export interface Quotas {
  /** TargetJobs an organization may have in a working state at once. */
  readonly maxConcurrentTargetJobs: number;
  /** Locales per LocalizationJob. */
  readonly maxTargetsPerJob: number;
  readonly maxSourceBytes: number;
  readonly maxSourceDurationUs: number;
  /** Multipart upload part size the API hands out. */
  readonly uploadPartSizeBytes: number;
}

export const DEFAULT_QUOTAS: Quotas = {
  maxConcurrentTargetJobs: 8,
  maxTargetsPerJob: 22,
  maxSourceBytes: 100 * 1024 * 1024 * 1024, // 100 GB (NFR-007)
  maxSourceDurationUs: 4 * 60 * 60 * 1_000_000, // 4 h (NFR-007)
  uploadPartSizeBytes: 8 * 1024 * 1024, // 8 MiB; S3 minimum is 5 MiB
};

export class QuotaExceededError extends DomainError {
  override readonly name = 'QuotaExceededError';
  constructor(quota: keyof Quotas, limit: number, requested: number) {
    super('VALIDATION_FAILED', `Quota ${quota} exceeded`, {
      details: { quota, limit, requested },
      fieldErrors: [{ path: quota, message: `limit ${limit}, requested ${requested}` }],
    });
  }
}

export function assertTargetsPerJob(count: number, quotas: Quotas = DEFAULT_QUOTAS): void {
  if (count < 1) throw new QuotaExceededError('maxTargetsPerJob', quotas.maxTargetsPerJob, count);
  if (count > quotas.maxTargetsPerJob)
    throw new QuotaExceededError('maxTargetsPerJob', quotas.maxTargetsPerJob, count);
}

export function assertSourceSize(bytes: number, quotas: Quotas = DEFAULT_QUOTAS): void {
  if (bytes <= 0 || bytes > quotas.maxSourceBytes)
    throw new QuotaExceededError('maxSourceBytes', quotas.maxSourceBytes, bytes);
}

export function assertSourceDuration(durationUs: number, quotas: Quotas = DEFAULT_QUOTAS): void {
  if (durationUs > quotas.maxSourceDurationUs)
    throw new QuotaExceededError('maxSourceDurationUs', quotas.maxSourceDurationUs, durationUs);
}

/** Number of parts for a multipart upload. */
export function partCount(
  byteSize: number,
  partSize: number = DEFAULT_QUOTAS.uploadPartSizeBytes,
): number {
  return Math.max(1, Math.ceil(byteSize / partSize));
}
