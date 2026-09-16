/**
 * Cost estimate (FR-057 subset for M1). The rate card is a fixture: cents per source minute
 * per capability. Real rate cards arrive with the cost ledger (M5). Beta-tier targets are
 * billed but carry no accuracy guarantee (BR-05), which the `high` bound reflects.
 */

import type { CapabilityTier } from './capabilities/registry.js';
import type { Microseconds } from './time/media-time.js';

export interface RateCard {
  readonly version: string;
  /** Cents per source minute. */
  readonly perMinuteCents: {
    readonly transcription: number;
    readonly translation: number;
    readonly speech: number;
    readonly lipSync: number;
    readonly encode: number;
    readonly qc: number;
  };
  /** Multiplier applied to the high bound for tiers without an SLA. */
  readonly betaUncertainty: number;
}

export const RATE_CARD_FIXTURE: RateCard = {
  version: '2026-09-fixture',
  perMinuteCents: {
    transcription: 2,
    translation: 3,
    speech: 8,
    lipSync: 40,
    encode: 1,
    qc: 1,
  },
  betaUncertainty: 1.5,
};

export interface TargetEstimate {
  readonly locale: string;
  readonly tier: CapabilityTier;
  readonly lipSync: boolean;
  readonly lowCents: number;
  readonly highCents: number;
}

export interface JobEstimate {
  readonly rateCardVersion: string;
  readonly durationUs: Microseconds;
  readonly sourceLowCents: number;
  readonly sourceHighCents: number;
  readonly targets: readonly TargetEstimate[];
  readonly totalLowCents: number;
  readonly totalHighCents: number;
}

const minutes = (durationUs: number): number => Math.max(1, Math.ceil(durationUs / 60_000_000));

export function estimateJob(
  durationUs: Microseconds,
  targets: readonly { locale: string; tier: CapabilityTier; lipSync: boolean }[],
  card: RateCard = RATE_CARD_FIXTURE,
): JobEstimate {
  const m = minutes(durationUs);
  const c = card.perMinuteCents;
  const sourceLow = m * (c.transcription + c.qc);
  const sourceHigh = sourceLow;
  const targetEstimates = targets.map((t): TargetEstimate => {
    const base = m * (c.translation + c.speech + c.encode + c.qc + (t.lipSync ? c.lipSync : 0));
    const uncertainty = t.tier === 'production' ? 1.15 : card.betaUncertainty;
    return {
      locale: t.locale,
      tier: t.tier,
      lipSync: t.lipSync,
      lowCents: base,
      highCents: Math.ceil(base * uncertainty),
    };
  });
  const totalLow = sourceLow + targetEstimates.reduce((a, t) => a + t.lowCents, 0);
  const totalHigh = sourceHigh + targetEstimates.reduce((a, t) => a + t.highCents, 0);
  return {
    rateCardVersion: card.version,
    durationUs,
    sourceLowCents: sourceLow,
    sourceHighCents: sourceHigh,
    targets: targetEstimates,
    totalLowCents: totalLow,
    totalHighCents: totalHigh,
  };
}

/**
 * BR-01: a job may be queued only when the organization has headroom ≥ estimate, or budgets
 * are disabled (`monthlyBudgetCents` null). Returns the reservation to record.
 */
export function checkBudget(
  monthlyBudgetCents: number | null,
  reservedThisMonthCents: number,
  estimate: JobEstimate,
): { readonly ok: boolean; readonly remainingCents: number | null; readonly reserveCents: number } {
  if (monthlyBudgetCents === null) {
    return { ok: true, remainingCents: null, reserveCents: estimate.totalHighCents };
  }
  const remaining = monthlyBudgetCents - reservedThisMonthCents;
  return {
    ok: remaining >= estimate.totalHighCents,
    remainingCents: remaining,
    reserveCents: estimate.totalHighCents,
  };
}
