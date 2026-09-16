'use client';

import { useEffect, useState } from 'react';
import type { LanguageCapabilitiesResponse, ProjectDetailResponse } from '@polycast/contracts';
import { Button, Field, StatusBadge } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { formatDuration } from '@/lib/time';
import { useProjectEvents } from '@/lib/use-project-events';
import { isAssetEvent } from '@/lib/sse';
import { JobStateBadge } from '@/components/state-badge';

const SETTLED = new Set(['READY_TO_CONFIGURE', 'FAILED', 'CANCELLED']);

export interface AnalysisStepProps {
  projectId: string;
  detail: ProjectDetailResponse | null;
  locales: LanguageCapabilitiesResponse['locales'];
  refresh: () => Promise<ProjectDetailResponse | null>;
  onBack: () => void;
  onContinue: () => void;
}

export function AnalysisStep({
  projectId,
  detail,
  locales,
  refresh,
  onBack,
  onContinue,
}: AnalysisStepProps) {
  const asset = detail?.asset ?? null;
  const analysis = detail?.analysis ?? null;
  const settled = asset ? SETTLED.has(asset.status) : false;
  const [locale, setLocale] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocale(
      analysis?.confirmedLocale ?? detail?.project.sourceLocale ?? analysis?.detectedLocale ?? '',
    );
  }, [analysis, detail?.project.sourceLocale]);

  // Live: asset events refresh the detail; fallback: poll every 3 s until settled.
  useProjectEvents(projectId, {
    enabled: !settled,
    onEvent: (e) => {
      if (isAssetEvent(e)) void refresh();
    },
    onPoll: () => void refresh(),
  });
  useEffect(() => {
    if (settled && analysis) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [settled, analysis, refresh]);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/v1/projects/${projectId}/confirm-locale`, {
        method: 'POST',
        body: { sourceLocale: locale },
      });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  const confirmed = analysis?.confirmedLocale ?? detail?.project.sourceLocale ?? null;
  const canContinue =
    Boolean(analysis) && Boolean(confirmed) && asset?.status === 'READY_TO_CONFIGURE';
  const meta = asset?.metadata ?? null;

  return (
    <div className="card" aria-labelledby="analysis-heading">
      <h2 id="analysis-heading">Step 2: Validation &amp; analysis</h2>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {!asset && <p className="muted">Waiting for the upload to register…</p>}
      {asset && (
        <div className="stack" aria-live="polite">
          <dl className="stat-list">
            <dt>File</dt>
            <dd>
              {asset.fileName} <span className="muted">({formatBytes(asset.byteSize)})</span>
            </dd>
            <dt>Status</dt>
            <dd>
              <JobStateBadge state={asset.status} />
              {!settled && <span className="muted small"> · checking…</span>}
            </dd>
            {asset.rejection && (
              <>
                <dt>Rejected</dt>
                <dd>
                  <StatusBadge tone="error" label={`Rejected: ${asset.rejection.code}`}>
                    {asset.rejection.code}
                  </StatusBadge>{' '}
                  {asset.rejection.message}
                </dd>
              </>
            )}
            {meta && (
              <>
                <dt>Duration</dt>
                <dd>{formatDuration(meta.durationUs)}</dd>
                <dt>Container</dt>
                <dd>{meta.container}</dd>
                <dt>Video</dt>
                <dd>
                  {meta.video
                    ? `${meta.video.codec} ${meta.video.width}×${meta.video.height}${meta.video.hdr ? ' HDR' : ''}`
                    : 'None (audio only; lip sync not applicable)'}
                </dd>
                {meta.audio && (
                  <>
                    <dt>Audio</dt>
                    <dd>
                      {meta.audio.codec} {meta.audio.sampleRate} Hz {meta.audio.channelLayout}
                    </dd>
                  </>
                )}
              </>
            )}
            {analysis && (
              <>
                <dt>Speakers</dt>
                <dd>
                  {analysis.speakers.length} ({analysis.speakers.filter((s) => s.onCamera).length}{' '}
                  on camera)
                </dd>
                <dt>Segments</dt>
                <dd>{analysis.segmentCount}</dd>
                <dt>Detected language</dt>
                <dd>
                  <code>{analysis.detectedLocale}</code>{' '}
                  <span className="muted">
                    ({Math.round(analysis.detectionConfidence * 100)}% confidence,{' '}
                    {analysis.provider})
                  </span>
                </dd>
              </>
            )}
          </dl>

          {analysis && (
            <div>
              <Field
                id="source-locale"
                label="Source language"
                description={
                  confirmed
                    ? `Confirmed as ${confirmed}. Change and confirm again to override.`
                    : 'Confirm the detected language or pick the correct one.'
                }
              >
                <select
                  id="source-locale"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  aria-describedby="source-locale-description"
                  disabled={saving}
                >
                  {locales.map((l) => (
                    <option key={l.locale} value={l.locale}>
                      {l.displayName} ({l.locale})
                      {l.locale === analysis.detectedLocale ? ' — detected' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                type="button"
                variant="secondary"
                onClick={confirm}
                disabled={saving || !locale}
              >
                {confirmed === locale ? 'Confirmed' : 'Confirm language'}
              </Button>
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
