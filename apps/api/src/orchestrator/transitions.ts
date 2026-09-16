import { transition, type JobState } from '@polycast/domain';
import type { Queryable } from '../db/pool.js';
import { emitEvent } from '../events/outbox.js';
import { targetProgress, type AssetRow, type TargetRow } from '../services/views.js';

export interface TxContext {
  readonly organizationId: string;
  readonly correlationId: string;
}

/**
 * The only two functions that write `state`. Both go through the domain transition table
 * (IllegalTransitionError otherwise) and emit the matching event in the same transaction.
 */
export async function transitionTarget(
  tx: Queryable,
  ctx: TxContext,
  target: TargetRow,
  to: JobState,
  opts: {
    message?: string | null;
    attempt?: number;
    lastError?: string | null;
    scope?: string[] | null;
  } = {},
): Promise<TargetRow> {
  const next = transition(target.state, to);
  const attempt = opts.attempt ?? target.attempt;
  const updated: TargetRow = {
    ...target,
    state: next,
    attempt,
    last_error: opts.lastError === undefined ? target.last_error : opts.lastError,
    scope_segment_ids: opts.scope === undefined ? target.scope_segment_ids : opts.scope,
  };
  updated.progress = targetProgress(updated);
  const res = await tx.query<{ version: number }>(
    `UPDATE target_jobs SET state = $2, attempt = $3, progress = $4, last_error = $5, scope_segment_ids = $6 WHERE id = $1 RETURNING version`,
    [
      target.id,
      next,
      attempt,
      updated.progress,
      updated.last_error,
      updated.scope_segment_ids ? JSON.stringify(updated.scope_segment_ids) : null,
    ],
  );
  updated.version = res.rows[0]?.version ?? target.version + 1;
  await emitEvent(tx, {
    name: 'target.stage.changed',
    organizationId: ctx.organizationId,
    correlationId: ctx.correlationId,
    subject: { type: 'TargetJob', id: target.id },
    projectId: target.project_id,
    payload: {
      projectId: target.project_id,
      jobId: target.job_id,
      targetJobId: target.id,
      locale: target.locale,
      from: target.state,
      to: next,
      attempt,
      progress: updated.progress,
      message: opts.message ?? null,
    },
  });
  return updated;
}

export async function transitionAsset(
  tx: Queryable,
  ctx: TxContext,
  asset: AssetRow,
  to: JobState,
  opts: {
    rejection?: { code: string; message: string } | null;
    event?: 'upload.completed' | 'asset.validated' | 'asset.rejected' | 'analysis.completed' | null;
  } = {},
): Promise<AssetRow> {
  const next = transition(asset.status, to);
  const res = await tx.query<{ version: number }>(
    'UPDATE assets SET status = $2, rejection = $3 WHERE id = $1 RETURNING version',
    [asset.id, next, opts.rejection ? JSON.stringify(opts.rejection) : null],
  );
  const updated: AssetRow = {
    ...asset,
    status: next,
    rejection: opts.rejection ?? null,
    version: res.rows[0]?.version ?? asset.version + 1,
  };
  if (opts.event) {
    await emitEvent(tx, {
      name: opts.event,
      organizationId: ctx.organizationId,
      correlationId: ctx.correlationId,
      subject: { type: 'Asset', id: asset.id },
      projectId: asset.project_id,
      payload: {
        projectId: asset.project_id,
        assetId: asset.id,
        status: next,
        reason: opts.rejection ?? null,
      },
    });
  }
  return updated;
}

export async function loadTarget(tx: Queryable, targetJobId: string): Promise<TargetRow | null> {
  const res = await tx.query<TargetRow>(
    `SELECT t.*, (SELECT count(*) FROM qc_issues q WHERE q.target_job_id = t.id AND q.resolution = 'open') AS open_issues
     FROM target_jobs t WHERE t.id = $1 FOR UPDATE OF t`,
    [targetJobId],
  );
  return res.rows[0] ?? null;
}

export async function loadAsset(tx: Queryable, assetId: string): Promise<AssetRow | null> {
  const res = await tx.query<AssetRow>('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
  return res.rows[0] ?? null;
}
