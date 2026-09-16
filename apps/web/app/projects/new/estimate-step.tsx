'use client';

import { useEffect, useState } from 'react';
import type { EstimateRequest, EstimateResponse } from '@polycast/contracts';
import { Button, StatusBadge, Table, toneForTier } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatCents, formatCentsRange } from '@/lib/format';
import { formatDuration } from '@/lib/time';
import type { TargetChoice } from './targets-step';

export interface EstimateStepProps {
  projectId: string;
  choices: TargetChoice[];
  hasVideo: boolean;
  estimate: EstimateResponse | null;
  onEstimate: (e: EstimateResponse) => void;
  acceptBetaTerms: boolean;
  onAcceptBetaTerms: (v: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function EstimateStep({
  projectId,
  choices,
  hasVideo,
  estimate,
  onEstimate,
  acceptBetaTerms,
  onAcceptBetaTerms,
  onBack,
  onContinue,
}: EstimateStepProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (estimate || choices.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const body: EstimateRequest = {
      targets: choices.map((c) => ({ locale: c.locale, lipSync: c.lipSync && hasVideo })),
    };
    api<EstimateResponse>(`/api/v1/projects/${projectId}/estimate`, { method: 'POST', body })
      .then((res) => {
        if (!cancelled) onEstimate(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [estimate, choices, hasVideo, projectId, onEstimate]);

  const hasBeta = estimate?.targets.some((t) => t.tier !== 'production') ?? false;
  const canContinue = Boolean(estimate) && estimate!.budget.ok && (!hasBeta || acceptBetaTerms);

  return (
    <div className="card" aria-labelledby="estimate-heading">
      <h2 id="estimate-heading">Step 4: Estimate and budget</h2>
      {error && (
        <div className="alert" role="alert">
          {error}{' '}
          <button type="button" className="link-button" onClick={() => setError(null)}>
            Retry
          </button>
        </div>
      )}
      {loading && (
        <p className="muted" role="status">
          Calculating estimate…
        </p>
      )}
      {estimate && (
        <div className="stack">
          <p className="muted small">
            Rate card {estimate.rateCardVersion} · source duration{' '}
            {formatDuration(estimate.durationUs)} · source processing{' '}
            {formatCentsRange(estimate.sourceLowCents, estimate.sourceHighCents)}
          </p>
          <Table caption="Estimated cost per target">
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Tier</th>
                <th scope="col">Lip sync</th>
                <th scope="col">Low</th>
                <th scope="col">High</th>
              </tr>
            </thead>
            <tbody>
              {estimate.targets.map((t) => (
                <tr key={t.locale}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    <code>{t.locale}</code>
                  </th>
                  <td>
                    <StatusBadge tone={toneForTier(t.tier)}>{t.tier}</StatusBadge>
                  </td>
                  <td>{t.lipSync ? 'Yes' : 'No'}</td>
                  <td>{formatCents(t.lowCents)}</td>
                  <td>{formatCents(t.highCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  Total (including source processing)
                </th>
                <td>
                  <strong>{formatCents(estimate.totalLowCents)}</strong>
                </td>
                <td>
                  <strong>{formatCents(estimate.totalHighCents)}</strong>
                </td>
              </tr>
            </tfoot>
          </Table>
          <p role="status">
            {estimate.budget.enabled ? (
              estimate.budget.ok ? (
                <StatusBadge tone="ok">
                  Within budget · {formatCents(estimate.budget.remainingCents)} remaining
                </StatusBadge>
              ) : (
                <StatusBadge tone="error">
                  Exceeds remaining budget ({formatCents(estimate.budget.remainingCents)}). Remove
                  targets or raise the budget.
                </StatusBadge>
              )
            ) : (
              <StatusBadge tone="info">
                Budgets are not enabled; no reservation will be made.
              </StatusBadge>
            )}
          </p>
          {hasBeta && (
            <div className="checkbox-row">
              <input
                type="checkbox"
                id="accept-beta"
                checked={acceptBetaTerms}
                onChange={(e) => onAcceptBetaTerms(e.target.checked)}
              />
              <label htmlFor="accept-beta">
                I understand beta targets have no quality SLA and require native-speaker review
                before release.
              </label>
            </div>
          )}
        </div>
      )}
      <div className="actions">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onContinue} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
