'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApproveResponse,
  QcIssue,
  RegenerateRequest,
  ReviewResponse,
  ReviewSegment,
} from '@polycast/contracts';
import type { Comment, CommentsResponse, RegenerateResponse } from '@/lib/contract-types';
import { Button, Field, StatusBadge, toneForResolution, toneForSeverity } from '@polycast/ui';
import { api } from '@/lib/client-api';
import { describeError } from '@/lib/errors';
import { formatDateTime, humanizeState } from '@/lib/format';
import { budgetUsePercent, formatMediaTime, formatRange, toPlayerSeconds } from '@/lib/time';
import {
  describeOpenIssueProgress,
  nextOpenIssueIndex,
  openIssueProgress,
} from '@/lib/review-issues';
import { isStageChanged } from '@/lib/sse';
import { useProjectEvents } from '@/lib/use-project-events';
import { JobStateBadge } from '@/components/state-badge';
import { Waveform } from '@/components/waveform';

export interface ReviewStudioProps {
  projectId: string;
  targetId: string;
  initialReview: ReviewResponse;
  initialComments: Comment[];
}

const SHORTCUTS: Array<[string, string]> = [
  ['j / ↓', 'Next segment'],
  ['k / ↑', 'Previous segment'],
  ['n', 'Next segment with an open issue'],
  ['Enter', 'Focus segment detail'],
  ['r', 'Regenerate translation for the selected segment'],
  ['a', 'Approve the selected segment'],
  ['Space', 'Play / pause'],
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Mirrors the `.studio` breakpoint in globals.css, below which the studio is a single column. */
const NARROW_STUDIO = '(max-width: 960px)';
function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_STUDIO).matches;
}

const compactButton = { padding: 'var(--pc-space-2) var(--pc-space-3)', fontSize: 13 } as const;

export function ReviewStudio({
  projectId,
  targetId,
  initialReview,
  initialComments,
}: ReviewStudioProps) {
  const [review, setReview] = useState(initialReview);
  const [comments, setComments] = useState(initialComments);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialReview.segments.find((s) => s.issues.some((i) => i.resolution === 'open'))?.segment.id ??
      initialReview.segments[0]?.segment.id ??
      null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [currentUs, setCurrentUs] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const segments = review.segments;
  const selectedIndex = Math.max(
    0,
    segments.findIndex((s) => s.segment.id === selectedId),
  );
  const selected: ReviewSegment | null = segments[selectedIndex] ?? null;
  const speakers = useMemo(() => new Map<string, string>(), []);

  useEffect(() => {
    setDraft(selected?.translation?.adaptedText ?? '');
  }, [selected?.segment.id, selected?.translation?.id, selected?.translation?.adaptedText]);

  const refetch = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        api<ReviewResponse>(`/api/v1/target-jobs/${targetId}/review`),
        api<CommentsResponse>(`/api/v1/target-jobs/${targetId}/comments`).catch(() => ({
          comments: [],
        })),
      ]);
      setReview(r);
      setComments(c.comments);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [targetId]);

  useProjectEvents(projectId, {
    onEvent: (e) => {
      if (isStageChanged(e)) {
        if (e.payload.targetJobId !== targetId) return;
        setReview((prev) => ({
          ...prev,
          target: {
            ...prev.target,
            state: e.payload.to,
            attempt: e.payload.attempt,
            progress: e.payload.progress,
          },
        }));
        if (e.payload.to === 'NEEDS_REVIEW' || e.payload.to === 'READY') void refetch();
      }
    },
    onPoll: () => void refetch(),
  });

  const select = useCallback(
    (index: number, { seek = true, focusDetail = false } = {}) => {
      const seg = segments[index];
      if (!seg) return;
      setSelectedId(seg.segment.id);
      if (seek && audioRef.current)
        audioRef.current.currentTime = toPlayerSeconds(seg.segment.range.start);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-segment-id="${seg.segment.id}"] > button`)
        ?.scrollIntoView({ block: 'nearest' });
      if (focusDetail) {
        // Focusing also scrolls the panel into view (it sits above the list on narrow screens).
        detailRef.current?.focus();
      } else if (isNarrowViewport()) {
        // Single-column layout: the editor is out of sight behind a tall list, so bring it back.
        detailRef.current?.scrollIntoView({ block: 'start' });
      }
    },
    [segments],
  );

  const issueProgress = openIssueProgress(segments, selectedIndex);
  const goToNextOpenIssue = useCallback(() => {
    const idx = nextOpenIssueIndex(segments, selectedIndex);
    if (idx >= 0) select(idx, { focusDetail: true });
  }, [segments, selectedIndex, select]);

  const regenerate = useCallback(
    async (seg: ReviewSegment | null, stage: RegenerateRequest['stage'] = 'translation') => {
      if (!seg) return;
      setBusy(`regen-${seg.segment.id}`);
      setError(null);
      try {
        const res = await api<RegenerateResponse>(
          `/api/v1/target-jobs/${targetId}/segments/${seg.segment.id}/regenerate`,
          { method: 'POST', body: { stage } satisfies RegenerateRequest },
        );
        setNotice(
          `Regeneration queued from ${humanizeState(res.restartAt)}; invalidated: ${res.invalidated.join(', ') || 'nothing'}.`,
        );
        await refetch();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    },
    [targetId, refetch],
  );

  const approve = useCallback(
    async (segmentIds: string[]) => {
      setBusy(segmentIds.length ? `approve-${segmentIds[0]}` : 'approve-target');
      setError(null);
      try {
        const res = await api<ApproveResponse>(`/api/v1/target-jobs/${targetId}/approve`, {
          method: 'POST',
          body: { segmentIds },
        });
        setNotice(
          segmentIds.length
            ? `Segment approved. ${res.remainingSegments} remaining.`
            : `Target approved: ${res.approvedSegments} segments, now ${humanizeState(res.target.state)}.`,
        );
        await refetch();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    },
    [targetId, refetch],
  );

  async function resolveIssue(issue: QcIssue, resolution: 'accepted' | 'dismissed') {
    setBusy(`issue-${issue.id}`);
    setError(null);
    try {
      await api(`/api/v1/target-jobs/${targetId}/issues/${issue.id}/resolve`, {
        method: 'POST',
        body: { resolution },
      });
      await refetch();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveTranslation() {
    if (!selected) return;
    setBusy(`edit-${selected.segment.id}`);
    setError(null);
    try {
      await api(`/api/v1/target-jobs/${targetId}/segments/${selected.segment.id}/translation`, {
        method: 'PUT',
        body: { adaptedText: draft },
      });
      setNotice('Translation saved as a new version; speech for this segment will be re-rendered.');
      await refetch();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function addComment() {
    if (!commentDraft.trim()) return;
    setBusy('comment');
    setError(null);
    try {
      await api(`/api/v1/target-jobs/${targetId}/comments`, {
        method: 'POST',
        body: {
          body: commentDraft.trim(),
          ...(selected ? { segmentId: selected.segment.id } : {}),
        },
      });
      setCommentDraft('');
      await refetch();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          select(Math.min(segments.length - 1, selectedIndex + 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          select(Math.max(0, selectedIndex - 1));
          break;
        case 'n':
          e.preventDefault();
          goToNextOpenIssue();
          break;
        case 'Enter':
          if (e.target instanceof HTMLElement && e.target.closest('.segment-list')) {
            e.preventDefault();
            detailRef.current?.focus();
          }
          break;
        case 'r':
          e.preventDefault();
          void regenerate(selected);
          break;
        case 'a':
          e.preventDefault();
          if (selected) void approve([selected.segment.id]);
          break;
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        default:
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [segments.length, selectedIndex, selected, select, regenerate, approve, goToNextOpenIssue]);

  const reviewable = review.target.state === 'NEEDS_REVIEW' || review.target.state === 'READY';
  const canApproveTarget = review.openIssues === 0 && busy === null && reviewable;
  const dir = review.direction;
  const segmentComments = comments.filter((c) => c.segmentId === selected?.segment.id);

  return (
    <section aria-labelledby="review-heading" className="stack page-wide">
      <header className="stack">
        <p className="muted small">
          <Link href="/">Projects</Link> / <Link href={`/projects/${projectId}`}>Processing</Link> /
          Review
        </p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 id="review-heading" style={{ margin: 0 }}>
            Review <span lang={review.target.locale}>{review.target.locale}</span>
            <span className="muted small"> from {review.sourceLocale}</span>
          </h1>
          <div className="stack" style={{ gap: 'var(--pc-space-1)' }}>
            <div className="row" aria-live="polite">
              <JobStateBadge state={review.target.state} />
              <StatusBadge tone={review.openIssues === 0 ? 'ok' : 'warn'}>
                {review.openIssues} open issue{review.openIssues === 1 ? '' : 's'}
              </StatusBadge>
              <Button
                type="button"
                onClick={() => approve([])}
                disabled={!canApproveTarget}
                aria-busy={busy === 'approve-target'}
                aria-describedby={review.openIssues > 0 ? 'approve-target-hint' : undefined}
              >
                Approve target
              </Button>
            </div>
            {review.openIssues > 0 && (
              <p id="approve-target-hint" className="muted small" style={{ margin: 0 }}>
                Resolve the {review.openIssues} remaining open issue
                {review.openIssues === 1 ? '' : 's'} first (accept, dismiss, edit or regenerate each
                flagged segment).
              </p>
            )}
          </div>
        </div>

        <div className="player-bar card">
          {review.proxyUrl ? (
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={review.proxyUrl}
              aria-label="Proxy audio player"
              onTimeUpdate={(e) =>
                setCurrentUs(Math.round(e.currentTarget.currentTime * 1_000_000))
              }
            />
          ) : (
            <p className="muted">No proxy audio is available for this target yet.</p>
          )}
          <Waveform
            url={review.waveformUrl}
            durationUs={segments.at(-1)?.segment.range.end ?? 0}
            positionUs={currentUs}
            selection={selected?.segment.range ?? null}
            onSeek={(us) => {
              if (audioRef.current) audioRef.current.currentTime = toPlayerSeconds(us);
            }}
          />
          <details className="shortcuts">
            <summary>Keyboard shortcuts</summary>
            <dl>
              {SHORTCUTS.map(([key, what]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p className="muted small">Shortcuts are ignored while typing in a field.</p>
          </details>
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="issue-nav" role="group" aria-label="Open issue navigation">
        <Button
          type="button"
          variant="secondary"
          onClick={goToNextOpenIssue}
          disabled={issueProgress.total === 0}
          aria-keyshortcuts="n"
        >
          Next open issue
        </Button>
        <span className="muted small">
          {issueProgress.total === 0
            ? reviewable
              ? 'No open issues remain — the target can be approved.'
              : 'No open issues remain.'
            : describeOpenIssueProgress(issueProgress)}
        </span>
      </div>

      <div className="studio">
        <section aria-labelledby="segments-heading" className="studio-list">
          <h2 id="segments-heading">Segments ({segments.length})</h2>
          <ol className="segment-list" ref={listRef} aria-label="Segments">
            {segments.map((s, i) => {
              const open = s.issues.filter((iss) => iss.resolution === 'open');
              const isSel = i === selectedIndex;
              return (
                <li
                  key={s.segment.id}
                  data-segment-id={s.segment.id}
                  aria-current={isSel ? 'true' : undefined}
                >
                  <button type="button" onClick={() => select(i)} aria-pressed={isSel}>
                    <div className="segment-meta">
                      <span className="mono">{formatRange(s.segment.range)}</span>
                      <span>
                        {speakers.get(s.segment.speakerId) ??
                          `Speaker ${s.segment.speakerId.slice(0, 4)}`}
                      </span>
                      {s.approved && <StatusBadge tone="ok">Approved</StatusBadge>}
                      {open.map((iss) => (
                        <StatusBadge key={iss.id} tone={toneForSeverity(iss.severity)}>
                          {iss.metric}
                        </StatusBadge>
                      ))}
                      {s.speech?.stale && <StatusBadge tone="queued">Speech stale</StatusBadge>}
                    </div>
                    <p className="segment-text" lang={review.sourceLocale}>
                      {s.segment.text}
                    </p>
                    <p className="segment-translation" dir={dir} lang={review.target.locale}>
                      {s.translation?.adaptedText ?? (
                        <span className="muted">No translation yet</span>
                      )}
                    </p>
                  </button>
                  {isSel && open.length > 0 && (
                    <div
                      className="segment-actions"
                      role="group"
                      aria-label={`Open issues on segment ${s.segment.seq + 1}`}
                    >
                      {open.map((iss) => (
                        <span key={iss.id} className="row">
                          <span className="small">{iss.metric}</span>
                          <Button
                            type="button"
                            variant="secondary"
                            style={compactButton}
                            aria-label={`Accept ${iss.metric} issue`}
                            onClick={() => resolveIssue(iss, 'accepted')}
                            disabled={busy !== null}
                          >
                            Accept
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            style={compactButton}
                            aria-label={`Dismiss ${iss.metric} issue`}
                            onClick={() => resolveIssue(iss, 'dismissed')}
                            disabled={busy !== null}
                          >
                            Dismiss
                          </Button>
                        </span>
                      ))}
                      <Button
                        type="button"
                        style={compactButton}
                        onClick={() => regenerate(s)}
                        disabled={busy !== null}
                        aria-busy={busy === `regen-${s.segment.id}`}
                      >
                        Regenerate translation
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <section
          aria-labelledby="detail-heading"
          ref={detailRef}
          tabIndex={-1}
          className="card studio-detail"
        >
          {!selected ? (
            <p className="muted">No segment selected.</p>
          ) : (
            <div className="stack">
              <h2 id="detail-heading" style={{ margin: 0 }}>
                Segment {selected.segment.seq + 1}{' '}
                <span className="muted small mono">{formatRange(selected.segment.range)}</span>
              </h2>

              <div className="split">
                <div>
                  <h3>Source ({review.sourceLocale})</h3>
                  <p lang={review.sourceLocale}>{selected.segment.text}</p>
                  <p className="muted small">
                    confidence {Math.round(selected.segment.confidence * 100)}%
                  </p>
                </div>
                <div>
                  <h3>Translation ({review.target.locale})</h3>
                  <p dir={dir} lang={review.target.locale}>
                    {selected.translation?.adaptedText ?? <span className="muted">—</span>}
                  </p>
                  {selected.translation?.literalText && (
                    <p className="muted small" dir={dir} lang={review.target.locale}>
                      Literal: {selected.translation.literalText}
                    </p>
                  )}
                  {selected.translation && (
                    <p className="muted small">
                      v{selected.translation.generation} · {selected.translation.provider}{' '}
                      {selected.translation.providerVersion} · confidence{' '}
                      {Math.round(selected.translation.confidence * 100)}%
                      {selected.translation.editedByUserId ? ' · edited by a reviewer' : ''}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <h3>Timing</h3>
                {selected.translation ? (
                  <dl className="stat-list">
                    <dt>Budget</dt>
                    <dd>{formatMediaTime(selected.translation.timingBudgetUs)}</dd>
                    <dt>Speech</dt>
                    <dd>
                      {selected.speech ? (
                        <>
                          {formatMediaTime(selected.speech.measuredDurationUs)} (
                          {budgetUsePercent(
                            selected.speech.measuredDurationUs,
                            selected.translation.timingBudgetUs,
                          )}
                          % of budget, stretch ×{selected.speech.timeStretchRatio.toFixed(2)}, voice{' '}
                          {selected.speech.voiceId})
                          {selected.speech.stale && <StatusBadge tone="queued"> stale</StatusBadge>}
                        </>
                      ) : (
                        <span className="muted">not rendered</span>
                      )}
                    </dd>
                  </dl>
                ) : (
                  <p className="muted">No translation yet.</p>
                )}
              </div>

              <div>
                <h3>QC issues</h3>
                {selected.issues.length === 0 ? (
                  <p className="muted">No issues on this segment.</p>
                ) : (
                  selected.issues.map((iss) => (
                    <div key={iss.id} className="issue">
                      <div className="row">
                        <StatusBadge tone={toneForSeverity(iss.severity)}>
                          {iss.severity}
                        </StatusBadge>
                        <strong>{iss.metric}</strong>
                        <StatusBadge tone={toneForResolution(iss.resolution)}>
                          {iss.resolution}
                        </StatusBadge>
                        {iss.range && (
                          <span className="mono muted small">{formatRange(iss.range)}</span>
                        )}
                      </div>
                      <p>{iss.recommendation}</p>
                      {iss.resolution === 'open' && (
                        <div className="row">
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => resolveIssue(iss, 'accepted')}
                            disabled={busy !== null}
                          >
                            Accept
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => resolveIssue(iss, 'dismissed')}
                            disabled={busy !== null}
                          >
                            Dismiss
                          </Button>
                          <Button
                            type="button"
                            onClick={() => regenerate(selected)}
                            disabled={busy !== null}
                          >
                            Regenerate translation
                          </Button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="row">
                <Button
                  type="button"
                  onClick={() => regenerate(selected)}
                  disabled={busy !== null}
                  aria-busy={busy === `regen-${selected.segment.id}`}
                >
                  Regenerate translation
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => approve([selected.segment.id])}
                  disabled={busy !== null || selected.approved}
                >
                  {selected.approved ? 'Segment approved' : 'Approve segment'}
                </Button>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTranslation();
                }}
              >
                <Field
                  id="edit-translation"
                  label="Edit translation"
                  description="Saving creates a new translation version and re-renders speech for this segment."
                >
                  <textarea
                    id="edit-translation"
                    dir={dir}
                    lang={review.target.locale}
                    value={draft}
                    maxLength={5000}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-describedby="edit-translation-description"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={
                    busy !== null ||
                    draft.trim().length === 0 ||
                    draft === (selected.translation?.adaptedText ?? '')
                  }
                >
                  Save translation
                </Button>
              </form>

              <div>
                <h3>Translation lineage</h3>
                {!selected.translation ? (
                  <p className="muted">—</p>
                ) : (
                  <ol className="lineage" aria-label="Translation versions, newest first">
                    {[selected.translation, ...selected.history].map((v) => (
                      <li key={v.id}>
                        <span className="mono">v{v.generation}</span> ·{' '}
                        {formatDateTime(v.createdAt)} · {v.provider}
                        {v.editedByUserId ? ' · reviewer edit' : ''}
                        <div dir={dir} lang={review.target.locale}>
                          {v.adaptedText}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div>
                <h3>Comments</h3>
                {segmentComments.length === 0 ? (
                  <p className="muted">No comments on this segment.</p>
                ) : (
                  <ul className="comments" aria-label="Comments on this segment">
                    {segmentComments.map((c) => (
                      <li key={c.id}>
                        <strong>{c.authorName}</strong>{' '}
                        <span className="muted small">{formatDateTime(c.createdAt)}</span>
                        <div>{c.body}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addComment();
                  }}
                >
                  <Field id="new-comment" label="Add a comment">
                    <textarea
                      id="new-comment"
                      value={commentDraft}
                      maxLength={4000}
                      onChange={(e) => setCommentDraft(e.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy !== null || commentDraft.trim().length === 0}
                  >
                    Post comment
                  </Button>
                </form>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
