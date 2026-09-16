import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_QUOTAS,
  QuotaExceededError,
  assertSourceDuration,
  assertSourceSize,
  assertTargetsPerJob,
  checkBudget,
  estimateJob,
  micros,
  partCount,
} from '../src/index.js';

describe('quotas', () => {
  test('targets per job bounds', () => {
    expect(() => assertTargetsPerJob(0)).toThrow(QuotaExceededError);
    expect(() => assertTargetsPerJob(DEFAULT_QUOTAS.maxTargetsPerJob + 1)).toThrow(
      QuotaExceededError,
    );
    expect(() => assertTargetsPerJob(1)).not.toThrow();
  });
  test('source limits', () => {
    expect(() => assertSourceSize(0)).toThrow(QuotaExceededError);
    expect(() => assertSourceSize(DEFAULT_QUOTAS.maxSourceBytes + 1)).toThrow();
    expect(() => assertSourceDuration(DEFAULT_QUOTAS.maxSourceDurationUs + 1)).toThrow();
    expect(() => assertSourceDuration(1)).not.toThrow();
  });
  test('part count covers the whole file', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 40 }), (bytes) => {
        const n = partCount(bytes);
        expect(n * DEFAULT_QUOTAS.uploadPartSizeBytes).toBeGreaterThanOrEqual(bytes);
        expect((n - 1) * DEFAULT_QUOTAS.uploadPartSizeBytes).toBeLessThan(bytes);
      }),
    );
  });
});

describe('estimate', () => {
  test('beta targets carry a wider high bound than production', () => {
    const d = micros(10 * 60_000_000);
    const beta = estimateJob(d, [{ locale: 'es-MX', tier: 'beta', lipSync: false }]);
    const prod = estimateJob(d, [{ locale: 'es-MX', tier: 'production', lipSync: false }]);
    expect(beta.targets[0]!.lowCents).toBe(prod.targets[0]!.lowCents);
    expect(beta.targets[0]!.highCents).toBeGreaterThan(prod.targets[0]!.highCents);
    expect(beta.totalHighCents).toBeGreaterThanOrEqual(beta.totalLowCents);
  });
  test('lip sync costs more', () => {
    const d = micros(60_000_000);
    const a = estimateJob(d, [{ locale: 'ja-JP', tier: 'beta', lipSync: false }]);
    const b = estimateJob(d, [{ locale: 'ja-JP', tier: 'beta', lipSync: true }]);
    expect(b.totalLowCents).toBeGreaterThan(a.totalLowCents);
  });
  test('budget check (BR-01)', () => {
    const est = estimateJob(micros(60_000_000), [
      { locale: 'de-DE', tier: 'beta', lipSync: false },
    ]);
    expect(checkBudget(null, 0, est).ok).toBe(true);
    expect(checkBudget(est.totalHighCents, 0, est).ok).toBe(true);
    expect(checkBudget(est.totalHighCents - 1, 0, est).ok).toBe(false);
    expect(checkBudget(1000, 1000, est).remainingCents).toBe(0);
  });
});
