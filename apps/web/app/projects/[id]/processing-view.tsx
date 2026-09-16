'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobHistoryResponse, ProjectDetailResponse, TargetJobView } from '@polycast/contracts';
import type { JobListResponse } from '@/lib/contract-types';
import { isTerminal, weightedProgress, type JobState } from '@polycast/domain';
import { Button, Dialog, ProgressBar, Table } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatBytes, formatDateTime, formatClock, humanizeState } from '@/lib/format';
import { formatDuration } from '@/lib/time';
import { isStageChanged } from '@/lib/sse';
import { useProjectEvents } from '@/lib/use-project-events';
import { EventLog } from '@/components/event-log';
import { StageTimeline } from '@/components/stage-timeline';
import { JobStateBadge, ProjectStateBadge } from '@/components/state-badge';

export interface ProcessingViewProps {
  initialDetail: ProjectDetailResponse;
  initialJobs: JobListResponse;
}

export function ProcessingView({ initialDetail, initialJobs }: ProcessingViewProps) {
  const projectId = initialDetail.project.id;
  const [detail, setDetail] = useState(initialDetail);
  const [jobs, setJobs] = useState<JobListResponse>(initialJobs);
  const [history, setHistory] = useState<JobHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const latestJob = jobs.jobs[0] ?? null;
  const audioOnly = !(detail.analysis?.hasVideo ?? Boolean(detail.asset?.metadata?.video));

  const refresh = useCallback(async () => {
    try {
      const [d, j] = await Promise.all([
        api<ProjectDetailResponse>(`/api/v1/projects/${projectId}`),
        api<JobListResponse>(`/api/v1/projects/${projectId}/jobs`),
      ]);
      setDetail(d);
      setJobs(j);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [projectId]);

  const refreshHistory = useCallback(async () => {
    if (!latestJob) return;
    try {
      setHistory(await api<JobHistoryResponse>(`/api/v1/localization-jobs/${latestJob.job.id}`));
    } catch {
      /* history is supplementary */
    }
  }, [latestJob]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const { events, connection } = useProjectEvents(projectId, {
    onEvent: (e) => {
      if (isStageChanged(e)) {
        // Optimistic patch so the row moves within the event latency, then reconcile.
        setJobs((prev) => ({
          jobs: prev.jobs.map((j) => ({
            ...j,
            targets: j.targets.map((t) =>
              t.id === e.payload.targetJobId
                ? {
                    ...t,
                    state: e.payload.to,
                    attempt: e.payload.attempt,
                    progress: e.payload.progress,
                  }
                : t,
            ),
          })),
        }));
        void refresh();
        void refreshHistory();
      } else {
        void refresh();
      }
    },
    onPoll: () => {
      void refresh();
      void refreshHistory();
    },
  });

  const targets = useMemo(() => latestJob?.targets ?? [], [latestJob]);

  async function cancelJob(jobId: string) {
    setBusy(jobId);
    try {
      await api(`/api/v1/localization-jobs/${jobId}/cancel`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setConfirmCancel(null);
    }
  }

  async function retryTarget(targetId: string) {
    setBusy(targetId);
    try {
      await api(`/api/v1/target-jobs/${targetId}/retry`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  const asset = detail.asset;
  const meta = asset?.metadata ?? null;

  return (
    <section aria-labelledby="project-heading" className="stack">
      <header>
        <p className="muted small">
          <Link href="/">Projects</Link> / {detail.project.title}
        </p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 id="project-heading" style={{ margin: 0 }}>
            {detail.project.title}
          </h1>
          <ProjectStateBadge state={detail.project.state} />
        </div>
        <dl className="stat-list" style={{ marginTop: 'var(--pc-space-3)' }}>
          <dt>Source</dt>
          <dd>
            {asset ? (
              <>
                {asset.fileName} <span className="muted">({formatBytes(asset.byteSize)})</span> ·{' '}
                <JobStateBadge state={asset.status} />
              </>
            ) : (
              <span className="muted">No source uploaded</span>
            )}
          </dd>
          {meta && (
            <>
              <dt>Duration</dt>
              <dd>
                {formatDuration(meta.durationUs)} ·{' '}
                {meta.video ? `${meta.video.width}×${meta.video.height} video` : 'audio only'}
              </dd>
            </>
          )}
          <dt>Language</dt>
          <dd>{detail.analysis?.confirmedLocale ?? detail.project.sourceLocale ?? '—'}</dd>
          {latestJob && (
            <>
              <dt>Job</dt>
              <dd>
                <JobStateBadge state={latestJob.job.state} /> · started{' '}
                {latestJob.job.startedAt ? formatDateTime(latestJob.job.startedAt) : '—'} · reserved{' '}
                {(latestJob.job.reservedBudgetCents / 100).toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </dd>
            </>
          )}
        </dl>
      </header>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {!latestJob && (
        <div className="card">
          <p>No localization job yet.</p>
          <Link href={`/projects/new?project=${projectId}&step=${detail.analysis ? 3 : 2}`}>
            Configure targets
          </Link>
        </div>
      )}

      {latestJob && (
        <section className="card" aria-labelledby="targets-heading">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="targets-heading" style={{ margin: 0 }}>
              Targets
            </h2>
            {!isTerminal(latestJob.job.state) && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirmCancel(latestJob.job.id)}
                disabled={busy !== null}
              >
                Cancel job
              </Button>
            )}
          </div>
          <div aria-live="polite" className="stack" style={{ marginTop: 'var(--pc-space-4)' }}>
            {targets.map((t) => (
              <TargetRow
                key={t.id}
                target={t}
                projectId={projectId}
                audioOnly={audioOnly}
                busy={busy === t.id}
                onRetry={() => retryTarget(t.id)}
              />
            ))}
          </div>
        </section>
      )}

      <div className="split">
        <section className="card">
          <EventLog events={events} connection={connection} />
        </section>
        <section className="card" aria-labelledby="history-heading">
          <h2 id="history-heading">Job history</h2>
          {!history || history.history.length === 0 ? (
            <p className="muted">No transitions recorded yet.</p>
          ) : (
            <Table caption="Stage transitions for the current job" hideCaption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Target</th>
                  <th scope="col">Transition</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {[...history.history].reverse().map((h) => {
                  const locale =
                    history.targets.find((t) => t.targetJobId === h.targetJobId)?.locale ?? 'job';
                  return (
                    <tr key={h.eventId}>
                      <td>
                        <time dateTime={h.occurredAt} className="mono">
                          {formatClock(h.occurredAt)}
                        </time>
                      </td>
                      <td>{locale}</td>
                      <td>
                        {h.from ? humanizeState(h.from) : 'start'} → {humanizeState(h.to)}
                        {h.attempt > 1 && <span className="muted"> (attempt {h.attempt})</span>}
                      </td>
                      <td className="muted">{h.message ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
      </div>

      <Dialog
        open={confirmCancel !== null}
        title="Cancel this job?"
        onClose={() => setConfirmCancel(null)}
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmCancel(null)}>
              Keep running
            </Button>
            <Button
              type="button"
              onClick={() => confirmCancel && cancelJob(confirmCancel)}
              disabled={busy !== null}
            >
              Cancel job
            </Button>
          </>
        }
      >
        <p>
          In-flight targets stop at their next checkpoint. Reserved budget is released; work already
          billed is not refunded.
        </p>
      </Dialog>
    </section>
  );
}

function TargetRow({
  target,
  projectId,
  audioOnly,
  busy,
  onRetry,
}: {
  target: TargetJobView;
  projectId: string;
  audioOnly: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const state = target.state as JobState;
  const progress = Math.max(
    target.progress,
    weightedProgress(state, { audioOnly: audioOnly || !target.lipSync }),
  );
  const failed = state === 'FAILED';
  return (
    <article aria-labelledby={`target-${target.id}-heading`} className="notice">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 id={`target-${target.id}-heading`} style={{ margin: 0 }}>
          <span lang={target.locale}>{target.locale}</span>{' '}
          <span className="muted small">{target.lipSync ? '· lip sync' : ''}</span>
        </h3>
        <div className="row">
          <JobStateBadge state={state} />
          {target.attempt > 1 && <span className="muted small">attempt {target.attempt}</span>}
        </div>
      </div>
      <div style={{ margin: 'var(--pc-space-2) 0' }}>
        <StageTimeline
          state={state}
          lipSync={target.lipSync && !audioOnly}
          label={`Stages for ${target.locale}`}
        />
      </div>
      <ProgressBar value={progress} label={`Progress for ${target.locale}`} />
      {target.lastError && (
        <p className="small" style={{ color: 'var(--pc-color-status-error)' }}>
          Last error: {target.lastError}
        </p>
      )}
      <div className="actions">
        {state === 'NEEDS_REVIEW' && (
          <Link href={`/projects/${projectId}/targets/${target.id}/review`}>
            Open review
            {target.openIssues > 0
              ? ` (${target.openIssues} open issue${target.openIssues === 1 ? '' : 's'})`
              : ''}
          </Link>
        )}
        {(state === 'READY' || state === 'PACKAGING') && (
          <Link href={`/projects/${projectId}/targets/${target.id}/review`}>Review</Link>
        )}
        {state === 'COMPLETE' && (
          <Link href={`/projects/${projectId}/targets/${target.id}/deliverables`}>
            Deliverables
          </Link>
        )}
        {failed && (
          <Button type="button" variant="secondary" onClick={onRetry} disabled={busy}>
            Retry
          </Button>
        )}
      </div>
    </article>
  );
}
