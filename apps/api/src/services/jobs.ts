import {
  CapabilityUnavailableError,
  DEFAULT_QUOTAS,
  DomainError,
  NotFoundError,
  assertTargetsPerJob,
  checkBudget,
  createRegistry,
  estimateJob,
  isWorking,
  micros,
  uuidv7,
  type JobState,
} from '@polycast/domain';
import type {
  CreateJobRequest,
  EstimateRequest,
  EstimateResponse,
  JobHistoryResponse,
  JobListResponse,
  JobResponse,
} from '@polycast/contracts';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/principal.js';
import type { Db, Queryable } from '../db/pool.js';
import { emitEvent } from '../events/outbox.js';
import { beginIdempotent, finishIdempotent } from '../idempotency.js';
import type { LocalOrchestrator } from '../orchestrator/local.js';
import { loadTarget } from '../orchestrator/transitions.js';
import {
  OPEN_ISSUES_SQL,
  jobView,
  targetSummary,
  targetView,
  type AssetRow,
  type JobRow,
  type TargetRow,
} from './views.js';

const registry = createRegistry();

export class JobService {
  constructor(
    private readonly db: Db,
    private readonly orchestrator: LocalOrchestrator,
  ) {}

  private async sourceOf(
    tx: Queryable,
    projectId: string,
  ): Promise<{ asset: AssetRow; sourceLocale: string; hasVideo: boolean }> {
    const project = (
      await tx.query<{ id: string; source_locale: string | null; source_asset_id: string | null }>(
        'SELECT id, source_locale, source_asset_id FROM projects WHERE id = $1',
        [projectId],
      )
    ).rows[0];
    if (!project) throw new NotFoundError('Project', projectId);
    const asset = project.source_asset_id
      ? (await tx.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [project.source_asset_id]))
          .rows[0]
      : undefined;
    const transcript = (
      await tx.query<{
        detected_locale: string;
        confirmed_locale: string | null;
        has_video: boolean;
      }>(
        'SELECT detected_locale, confirmed_locale, has_video FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
        [projectId],
      )
    ).rows[0];
    if (!asset || !asset.metadata || asset.status !== 'READY_TO_CONFIGURE' || !transcript) {
      throw new DomainError('CONFLICT', 'Project source is not analysed yet');
    }
    return {
      asset,
      sourceLocale:
        transcript.confirmed_locale ?? project.source_locale ?? transcript.detected_locale,
      hasVideo: transcript.has_video,
    };
  }

  private estimateFor(
    p: Principal,
    tx: Queryable,
    asset: AssetRow,
    hasVideo: boolean,
    targets: EstimateRequest['targets'],
  ) {
    const seen = new Set<string>();
    const rows = targets.map((t) => {
      if (seen.has(t.locale))
        throw new DomainError('VALIDATION_FAILED', `Duplicate target ${t.locale}`, {
          fieldErrors: [{ path: 'targets', message: 'duplicate locale' }],
        });
      seen.add(t.locale);
      const cap = registry.get(t.locale);
      if (!cap) throw new CapabilityUnavailableError(t.locale, 'translation');
      for (const kind of ['translation', 'speech'] as const) {
        if (cap.tiers[kind] === 'unavailable') throw new CapabilityUnavailableError(t.locale, kind);
      }
      const lipSync = t.lipSync && hasVideo;
      if (lipSync && cap.tiers.lipSync === 'unavailable')
        throw new CapabilityUnavailableError(t.locale, 'lipSync');
      const tier = lipSync ? cap.tiers.lipSync : cap.tiers.speech;
      return { locale: t.locale, tier, lipSync };
    });
    const durationUs = micros(asset.metadata?.durationUs ?? 0);
    return { rows, estimate: estimateJob(durationUs, rows) };
  }

  private async budgetFor(tx: Queryable, organizationId: string) {
    const org = (
      await tx.query<{ monthly_budget_cents: number | null }>(
        'SELECT monthly_budget_cents FROM organizations WHERE id = $1',
        [organizationId],
      )
    ).rows[0];
    const reserved = (
      await tx.query<{ reserved: string | null }>(
        `SELECT sum(reserved_budget_cents) AS reserved FROM localization_jobs WHERE organization_id = $1 AND created_at >= date_trunc('month', now())`,
        [organizationId],
      )
    ).rows[0];
    return {
      monthly: org?.monthly_budget_cents ?? null,
      reserved: Number(reserved?.reserved ?? 0),
    };
  }

  async estimate(
    p: Principal,
    projectId: string,
    input: EstimateRequest,
  ): Promise<EstimateResponse> {
    assertTargetsPerJob(input.targets.length);
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const { asset, hasVideo } = await this.sourceOf(tx, projectId);
        const { estimate } = this.estimateFor(p, tx, asset, hasVideo, input.targets);
        const budget = await this.budgetFor(tx, p.organizationId);
        const check = checkBudget(budget.monthly, budget.reserved, estimate);
        return {
          rateCardVersion: estimate.rateCardVersion,
          durationUs: estimate.durationUs,
          sourceLowCents: estimate.sourceLowCents,
          sourceHighCents: estimate.sourceHighCents,
          targets: estimate.targets.map((t) => ({
            locale: t.locale,
            tier: t.tier,
            lipSync: t.lipSync,
            lowCents: t.lowCents,
            highCents: t.highCents,
          })),
          totalLowCents: estimate.totalLowCents,
          totalHighCents: estimate.totalHighCents,
          budget: {
            enabled: budget.monthly !== null,
            remainingCents: check.remainingCents,
            ok: check.ok,
          },
        };
      },
    );
  }

  /** Idempotent job creation (FR-050, FR-051, BR-01, BR-05). */
  async create(
    p: Principal,
    idempotencyKey: string,
    input: CreateJobRequest,
    correlationId: string,
    ip: string,
  ): Promise<{ statusCode: number; body: JobResponse }> {
    assertTargetsPerJob(input.targets.length);
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const replay = await beginIdempotent(tx, p.organizationId, idempotencyKey, input);
        if (replay) return { statusCode: replay.statusCode, body: replay.body as JobResponse };

        const { asset, sourceLocale, hasVideo } = await this.sourceOf(tx, input.projectId);
        const { rows, estimate } = this.estimateFor(p, tx, asset, hasVideo, input.targets);
        if (rows.some((r) => r.tier === 'beta') && !input.acceptBetaTerms) {
          throw new DomainError(
            'VALIDATION_FAILED',
            'Beta-tier targets require accepting that no quality SLA applies (BR-05)',
            {
              fieldErrors: [{ path: 'acceptBetaTerms', message: 'must be true for beta targets' }],
            },
          );
        }
        const budget = await this.budgetFor(tx, p.organizationId);
        const check = checkBudget(budget.monthly, budget.reserved, estimate);
        if (!check.ok) {
          throw new DomainError(
            'BUDGET_EXCEEDED',
            'Organization budget headroom is below the estimate (BR-01)',
            {
              details: {
                remainingCents: check.remainingCents,
                estimateHighCents: estimate.totalHighCents,
              },
            },
          );
        }
        const running = (
          await tx.query<{ n: string }>(
            `SELECT count(*) AS n FROM target_jobs WHERE organization_id = $1 AND state NOT IN ('COMPLETE','FAILED','CANCELLED','NEEDS_REVIEW','READY')`,
            [p.organizationId],
          )
        ).rows[0];
        if (Number(running?.n ?? 0) + rows.length > DEFAULT_QUOTAS.maxConcurrentTargetJobs) {
          throw new DomainError(
            'VALIDATION_FAILED',
            'Concurrency quota exceeded; wait for running targets to finish (FR-051)',
            {
              details: { maxConcurrentTargetJobs: DEFAULT_QUOTAS.maxConcurrentTargetJobs },
            },
          );
        }

        const jobId = uuidv7();
        const snapshot = {
          sourceAssetId: asset.id,
          sourceLocale,
          targetLocales: rows.map((r) => r.locale),
          lipSync: Object.fromEntries(rows.map((r) => [r.locale, r.lipSync])),
          rateCardVersion: estimate.rateCardVersion,
          capabilitySnapshot: Object.fromEntries(rows.map((r) => [r.locale, { speech: r.tier }])),
        };
        const ctx = { organizationId: p.organizationId, correlationId };
        const job = (
          await tx.query<JobRow>(
            `INSERT INTO localization_jobs (id, organization_id, project_id, idempotency_key, snapshot, state, estimated_low_cents, estimated_high_cents, reserved_budget_cents, rate_card_version, started_at)
           VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9, now()) RETURNING *`,
            [
              jobId,
              p.organizationId,
              input.projectId,
              idempotencyKey,
              JSON.stringify(snapshot),
              estimate.totalLowCents,
              estimate.totalHighCents,
              check.reserveCents,
              estimate.rateCardVersion,
            ],
          )
        ).rows[0] as JobRow;
        await emitEvent(tx, {
          name: 'job.created',
          organizationId: p.organizationId,
          correlationId,
          subject: { type: 'LocalizationJob', id: jobId },
          projectId: input.projectId,
          payload: { projectId: input.projectId, jobId, targetJobId: null, locale: null },
        });
        // Source-side stages are already satisfied by analysis in M1; walk them so the history is honest.
        let state: JobState = 'QUEUED';
        for (const next of ['TRANSCRIBING', 'SOURCE_QA', 'TARGETS_FAN_OUT'] as const) {
          await tx.query('UPDATE localization_jobs SET state = $2 WHERE id = $1', [jobId, next]);
          await emitEvent(tx, {
            name: 'target.stage.changed',
            organizationId: p.organizationId,
            correlationId,
            subject: { type: 'LocalizationJob', id: jobId },
            projectId: input.projectId,
            payload: {
              projectId: input.projectId,
              jobId,
              targetJobId: jobId,
              locale: sourceLocale,
              from: state,
              to: next,
              attempt: 1,
              progress: 0,
              message: next === 'TRANSCRIBING' ? 'reusing analysis transcript' : null,
            },
          });
          state = next;
        }
        const targets: TargetRow[] = [];
        for (const r of rows) {
          const id = uuidv7();
          const row = (
            await tx.query<TargetRow>(
              `INSERT INTO target_jobs (id, organization_id, job_id, project_id, locale, state, approval_state, lip_sync, provider_routes)
             VALUES ($1,$2,$3,$4,$5,'TRANSLATING','pending',$6,$7) RETURNING *`,
              [
                id,
                p.organizationId,
                jobId,
                input.projectId,
                r.locale,
                r.lipSync,
                JSON.stringify({
                  translation: 'mock-translation',
                  speech: 'mock-speech',
                  quality: 'mock-quality',
                }),
              ],
            )
          ).rows[0] as TargetRow;
          await emitEvent(tx, {
            name: 'target.stage.changed',
            organizationId: p.organizationId,
            correlationId,
            subject: { type: 'TargetJob', id },
            projectId: input.projectId,
            payload: {
              projectId: input.projectId,
              jobId,
              targetJobId: id,
              locale: r.locale,
              from: 'TARGETS_FAN_OUT',
              to: 'TRANSLATING',
              attempt: 1,
              progress: 0,
              message: 'fan-out',
            },
          });
          targets.push(row);
        }
        await this.orchestrator.startTargets(tx, ctx, targets);
        await tx.query("UPDATE projects SET state = 'processing' WHERE id = $1", [input.projectId]);
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'job.created',
          objectType: 'LocalizationJob',
          objectId: jobId,
          after: snapshot,
          correlationId,
          ipAddress: ip,
        });
        const body: JobResponse = {
          job: jobView({ ...job, state }, targets),
          targets: targets.map(targetView),
        };
        await finishIdempotent(tx, p.organizationId, idempotencyKey, 201, body);
        return { statusCode: 201, body };
      },
    );
  }

  async get(p: Principal, jobId: string): Promise<JobHistoryResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const job = (
          await tx.query<JobRow>('SELECT * FROM localization_jobs WHERE id = $1', [jobId])
        ).rows[0];
        if (!job) throw new NotFoundError('LocalizationJob', jobId);
        const targets = (
          await tx.query<TargetRow>(
            `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.job_id = $1 ORDER BY t.created_at`,
            [jobId],
          )
        ).rows;
        const history = (
          await tx.query<{
            id: string;
            occurred_at: Date;
            payload: {
              targetJobId: string | null;
              from: JobState | null;
              to: JobState;
              attempt: number;
              progress: number;
              message: string | null;
            };
          }>(
            `SELECT id, occurred_at, payload FROM domain_events WHERE name = 'target.stage.changed' AND (payload->>'jobId') = $1 ORDER BY id`,
            [jobId],
          )
        ).rows;
        return {
          job: jobView(job, targets),
          targets: targets.map(targetSummary),
          history: history.map((h) => ({
            eventId: h.id,
            occurredAt: h.occurred_at.toISOString(),
            targetJobId: h.payload.targetJobId === jobId ? null : h.payload.targetJobId,
            from: h.payload.from,
            to: h.payload.to,
            attempt: h.payload.attempt,
            progress: h.payload.progress,
            message: h.payload.message,
          })),
        };
      },
    );
  }

  async listForProject(p: Principal, projectId: string): Promise<JobListResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const project = (
          await tx.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [projectId])
        ).rows[0];
        if (!project) throw new NotFoundError('Project', projectId);
        const jobs = (
          await tx.query<JobRow>(
            'SELECT * FROM localization_jobs WHERE project_id = $1 ORDER BY created_at DESC',
            [projectId],
          )
        ).rows;
        const out: JobResponse[] = [];
        for (const j of jobs) {
          const targets = (
            await tx.query<TargetRow>(
              `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.job_id = $1 ORDER BY t.created_at`,
              [j.id],
            )
          ).rows;
          out.push({ job: jobView(j, targets), targets: targets.map(targetView) });
        }
        return { jobs: out };
      },
    );
  }

  async cancel(
    p: Principal,
    jobId: string,
    correlationId: string,
    ip: string,
  ): Promise<JobResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const job = (
          await tx.query<JobRow>('SELECT * FROM localization_jobs WHERE id = $1 FOR UPDATE', [
            jobId,
          ])
        ).rows[0];
        if (!job) throw new NotFoundError('LocalizationJob', jobId);
        const targets = (
          await tx.query<TargetRow>(
            `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.job_id = $1 ORDER BY t.created_at FOR UPDATE OF t`,
            [jobId],
          )
        ).rows;
        const ctx = { organizationId: p.organizationId, correlationId };
        const updated: TargetRow[] = [];
        for (const t of targets) updated.push(await this.orchestrator.cancelTarget(tx, ctx, t));
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'job.cancelled',
          objectType: 'LocalizationJob',
          objectId: jobId,
          correlationId,
          ipAddress: ip,
        });
        return { job: jobView(job, updated), targets: updated.map(targetView) };
      },
    );
  }

  async getTarget(p: Principal, targetJobId: string) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const t = (
          await tx.query<TargetRow>(
            `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.id = $1`,
            [targetJobId],
          )
        ).rows[0];
        if (!t) throw new NotFoundError('TargetJob', targetJobId);
        return { target: targetView(t) };
      },
    );
  }

  /** Kick a RETRY_WAIT target now. FAILED is terminal by design (docs/architecture.md §8). */
  async retryTarget(p: Principal, targetJobId: string, correlationId: string, ip: string) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const t = await loadTarget(tx, targetJobId);
        if (!t) throw new NotFoundError('TargetJob', targetJobId);
        if (t.state !== 'RETRY_WAIT') {
          throw new DomainError(
            'ILLEGAL_TRANSITION',
            `Only targets in RETRY_WAIT can be retried (current: ${t.state})`,
          );
        }
        await tx.query(
          `UPDATE stage_tasks SET not_before = now() WHERE target_job_id = $1 AND status = 'queued'`,
          [targetJobId],
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'target.retry_requested',
          objectType: 'TargetJob',
          objectId: targetJobId,
          correlationId,
          ipAddress: ip,
        });
        return { target: targetView(t) };
      },
    );
  }

  isWorking(state: JobState): boolean {
    return isWorking(state);
  }
}
