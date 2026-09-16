import { uuidv7 } from '@polycast/domain';
import type { WorkerStage, WorkerTask } from '@polycast/contracts';
import type { Queryable } from '../db/pool.js';

export interface TaskRow {
  id: string;
  organization_id: string;
  project_id: string;
  job_id: string | null;
  target_job_id: string | null;
  asset_id: string | null;
  stage: WorkerStage;
  attempt: number;
  idempotency_key: string;
  correlation_id: string;
  status: 'queued' | 'claimed' | 'succeeded' | 'failed' | 'cancelled';
  not_before: Date;
  storage: WorkerTask['storage'];
  parameters: WorkerTask['parameters'];
  claimed_by: string | null;
  lease_until: Date | null;
}

export interface EnqueueInput {
  organizationId: string;
  projectId: string;
  jobId: string | null;
  targetJobId: string | null;
  assetId: string | null;
  stage: WorkerStage;
  attempt: number;
  correlationId: string;
  storage: WorkerTask['storage'];
  parameters: WorkerTask['parameters'];
  notBefore?: Date;
  /** Row version of the subject after its transition; distinguishes re-entries into the same stage. */
  run: number;
}

/** Idempotency key per (subject, stage, run, attempt) so a retried enqueue never duplicates work (FR-050). */
export const taskKey = (
  subjectId: string,
  stage: WorkerStage,
  run: number,
  attempt: number,
): string => `${subjectId}:${stage}:r${run}:a${attempt}`;

export async function enqueueTask(tx: Queryable, input: EnqueueInput): Promise<string> {
  const id = uuidv7();
  const subject = input.targetJobId ?? input.assetId ?? input.projectId;
  const key = taskKey(subject, input.stage, input.run, input.attempt);
  const res = await tx.query<{ id: string }>(
    `INSERT INTO stage_tasks (id, organization_id, project_id, job_id, target_job_id, asset_id, stage, attempt,
       idempotency_key, correlation_id, status, not_before, storage, parameters)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.organizationId,
      input.projectId,
      input.jobId,
      input.targetJobId,
      input.assetId,
      input.stage,
      input.attempt,
      key,
      input.correlationId,
      input.notBefore ?? new Date(),
      JSON.stringify(input.storage),
      JSON.stringify(input.parameters),
    ],
  );
  return res.rows[0]?.id ?? key;
}

/** Atomically claim the oldest runnable task (queued, or claimed with an expired lease). */
export async function claimTask(
  tx: Queryable,
  workerId: string,
  leaseSeconds: number,
  stages?: readonly WorkerStage[],
): Promise<TaskRow | null> {
  const stageFilter = stages && stages.length ? 'AND stage = ANY($3::text[])' : '';
  const params: unknown[] = [workerId, leaseSeconds];
  if (stageFilter) params.push([...(stages ?? [])]);
  const res = await tx.query<TaskRow>(
    `UPDATE stage_tasks SET status = 'claimed', claimed_by = $1, claimed_at = now(),
       lease_until = now() + make_interval(secs => $2)
     WHERE id = (
       SELECT id FROM stage_tasks
       WHERE ((status = 'queued' AND not_before <= now()) OR (status = 'claimed' AND lease_until < now()))
       ${stageFilter}
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function heartbeatTask(
  tx: Queryable,
  taskId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const res = await tx.query(
    `UPDATE stage_tasks SET lease_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND claimed_by = $2 AND status = 'claimed'`,
    [taskId, workerId, leaseSeconds],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function loadClaimedTask(tx: Queryable, taskId: string): Promise<TaskRow | null> {
  const res = await tx.query<TaskRow>('SELECT * FROM stage_tasks WHERE id = $1 FOR UPDATE', [
    taskId,
  ]);
  return res.rows[0] ?? null;
}

export async function settleTask(
  tx: Queryable,
  taskId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  result: unknown,
  error: unknown,
): Promise<void> {
  await tx.query('UPDATE stage_tasks SET status = $2, result = $3, error = $4 WHERE id = $1', [
    taskId,
    status,
    result === undefined ? null : JSON.stringify(result),
    error === undefined ? null : JSON.stringify(error),
  ]);
}

export async function cancelQueuedTasks(tx: Queryable, targetJobId: string): Promise<number> {
  const res = await tx.query(
    `UPDATE stage_tasks SET status = 'cancelled' WHERE target_job_id = $1 AND status = 'queued'`,
    [targetJobId],
  );
  return res.rowCount ?? 0;
}

export async function hasInFlightTask(tx: Queryable, targetJobId: string): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM stage_tasks WHERE target_job_id = $1 AND status = 'claimed' LIMIT 1`,
    [targetJobId],
  );
  return (res.rowCount ?? 0) > 0;
}

export function toWorkerTask(row: TaskRow, leaseSeconds: number): WorkerTask {
  return {
    taskId: row.id,
    organizationId: row.organization_id,
    jobId: row.job_id,
    targetJobId: row.target_job_id,
    assetId: row.asset_id,
    stage: row.stage,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    storage: row.storage,
    parameters: row.parameters,
    taskToken: null,
    leaseSeconds,
  };
}
