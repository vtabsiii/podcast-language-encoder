'use client';

import { useState } from 'react';
import type {
  CreateJobRequest,
  EstimateResponse,
  ProjectDetailResponse,
} from '@polycast/contracts';
import { Button } from '@polycast/ui';
import { describeError } from '@/lib/errors';
import { formatCentsRange } from '@/lib/format';

export interface SubmitStepProps {
  detail: ProjectDetailResponse | null;
  request: CreateJobRequest | null;
  estimate: EstimateResponse | null;
  idempotencyKey: string;
  onBack: () => void;
  onSubmit: () => Promise<void>;
}

export function SubmitStep({
  detail,
  request,
  estimate,
  idempotencyKey,
  onBack,
  onSubmit,
}: SubmitStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (submitting) return; // the idempotency key also protects against a double-click reaching the API
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      setError(describeError(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="card" aria-labelledby="submit-heading">
      <h2 id="submit-heading">Step 5: Review configuration and submit</h2>
      {error && (
        <div className="alert" role="alert">
          {error} — retrying reuses the same request key, so the job is never created twice.
        </div>
      )}
      <dl className="stat-list">
        <dt>Project</dt>
        <dd>{detail?.project.title ?? '—'}</dd>
        <dt>Source</dt>
        <dd>
          {detail?.asset?.fileName ?? '—'}{' '}
          <span className="muted">
            (
            {detail?.analysis?.confirmedLocale ??
              detail?.project.sourceLocale ??
              'language unconfirmed'}
            )
          </span>
        </dd>
        <dt>Targets</dt>
        <dd>
          {request ? (
            <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
              {request.targets.map((t) => (
                <li key={t.locale}>
                  <code>{t.locale}</code>
                  {t.lipSync ? ' · lip sync' : ''}
                </li>
              ))}
            </ul>
          ) : (
            'None selected'
          )}
        </dd>
        <dt>Estimate</dt>
        <dd>
          {estimate
            ? formatCentsRange(estimate.totalLowCents, estimate.totalHighCents)
            : 'Not calculated'}
        </dd>
        <dt>Beta terms</dt>
        <dd>{request?.acceptBetaTerms ? 'Accepted' : 'Not accepted'}</dd>
        <dt>Request key</dt>
        <dd>
          <code className="mono">{idempotencyKey}</code>
        </dd>
      </dl>
      <div className="actions">
        <Button type="button" variant="secondary" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={!request || !estimate || submitting}
          aria-busy={submitting}
        >
          {submitting ? 'Submitting…' : 'Submit localization job'}
        </Button>
      </div>
    </div>
  );
}
