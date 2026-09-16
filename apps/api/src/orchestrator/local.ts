import {
  createRegistry,
  isWorking,
  planRegeneration,
  uuidv7,
  type JobState,
  type RegenerateStage,
} from '@polycast/domain';
import {
  AnalyzingOutputSchema,
  EncodingOutputSchema,
  LipSyncOutputSchema,
  MixingOutputSchema,
  PackagingOutputSchema,
  SynthesizingOutputSchema,
  TargetQaOutputSchema,
  TimingOutputSchema,
  TranslatingOutputSchema,
  ValidatingOutputSchema,
  type QcReport,
  type TaskResult,
  type WorkerStage,
  type WorkerTask,
} from '@polycast/contracts';
import type { AppConfig } from '../config.js';
import type { Db, Queryable } from '../db/pool.js';
import { emitEvent } from '../events/outbox.js';
import type { Buckets, StorageDriver } from '../storage/index.js';
import { tenantKey } from '../storage/index.js';
import {
  issueView,
  segmentView,
  speakerView,
  type AssetRow,
  type IssueRow,
  type SegmentRow,
  type SpeakerRow,
  type TargetRow,
  type TranslationRow,
} from '../services/views.js';
import {
  cancelQueuedTasks,
  enqueueTask,
  hasInFlightTask,
  loadClaimedTask,
  settleTask,
  type TaskRow,
} from './tasks.js';
import {
  loadAsset,
  loadTarget,
  transitionAsset,
  transitionTarget,
  type TxContext,
} from './transitions.js';

/**
 * Local orchestrator (A-08): the same stage table Step Functions will run in AWS, executed by
 * enqueueing one worker task per stage and reacting to each task result. Every transition goes
 * through the domain state machine; every stage task is idempotent on (subject, stage, attempt).
 */
export interface OrchestratorDeps {
  config: AppConfig;
  db: Db;
  storage: StorageDriver;
  buckets: Buckets;
}

export const TARGET_STAGE_ORDER: readonly WorkerStage[] = [
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
  'MIXING',
  'ENCODING',
  'TARGET_QA',
  'PACKAGING',
];

/** Stages that run on the regeneration scope only; later stages always see the whole target. */
const SCOPED_STAGES = new Set<WorkerStage>([
  'TRANSLATING',
  'SYNTHESIZING',
  'TIMING',
  'LIP_SYNCING',
]);

const registry = createRegistry();

interface TranscriptRow {
  id: string;
  project_id: string;
  asset_id: string;
  detected_locale: string;
  confirmed_locale: string | null;
  has_video: boolean;
}

interface SpeechRow {
  id: string;
  segment_id: string;
  translation_version_id: string;
  measured_duration_us: number;
  time_stretch_ratio: number;
  voice_id: string;
}

export class LocalOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private get maxAttempts(): number {
    return this.deps.config.TASK_MAX_ATTEMPTS;
  }

  /* ------------------------------------------------------------------ asset pipeline */

  /** Called when an upload completes: QUARANTINED → queue VALIDATING. */
  async startAssetPipeline(
    tx: Queryable,
    ctx: TxContext,
    asset: AssetRow,
    maxDurationUs: number,
  ): Promise<void> {
    const next = await transitionAsset(tx, ctx, asset, 'VALIDATING');
    await this.enqueueAssetStage(tx, ctx, next, 'VALIDATING', 1, { maxDurationUs });
  }

  private async enqueueAssetStage(
    tx: Queryable,
    ctx: TxContext,
    asset: AssetRow,
    stage: 'VALIDATING' | 'ANALYZING',
    attempt: number,
    extra: { maxDurationUs?: number; declaredLocale?: string | null } = {},
    notBefore?: Date,
  ): Promise<void> {
    const { storage, buckets } = this.deps;
    const derivedPrefix = storage.uri(
      buckets.derived,
      tenantKey(ctx.organizationId, 'assets', asset.id, stage.toLowerCase()) + '/',
    );
    const sourceKey = tenantKey(ctx.organizationId, asset.project_id, asset.id, asset.file_name);
    const parameters: WorkerTask['parameters'] =
      stage === 'VALIDATING'
        ? {
            assetId: asset.id,
            projectId: asset.project_id,
            quarantine: asset.storage_uri,
            declaredContentType: asset.content_type,
            declaredByteSize: Number(asset.byte_size),
            maxDurationUs: extra.maxDurationUs ?? 0,
          }
        : {
            assetId: asset.id,
            projectId: asset.project_id,
            metadata: asset.metadata as NonNullable<AssetRow['metadata']>,
            declaredLocale: extra.declaredLocale ?? null,
          };
    await enqueueTask(tx, {
      organizationId: ctx.organizationId,
      projectId: asset.project_id,
      jobId: null,
      targetJobId: null,
      assetId: asset.id,
      stage,
      attempt,
      correlationId: ctx.correlationId,
      storage: {
        source: stage === 'VALIDATING' ? storage.uri(buckets.source, sourceKey) : asset.storage_uri,
        derivedPrefix,
        deliverablesPrefix: null,
      },
      parameters,
      run: asset.version,
      ...(notBefore ? { notBefore } : {}),
    });
  }

  /* ------------------------------------------------------------------ target pipeline */

  /** Fan-out: put every new target into TRANSLATING and queue its first stage. */
  async startTargets(tx: Queryable, ctx: TxContext, targets: readonly TargetRow[]): Promise<void> {
    for (const t of targets) {
      await this.enqueueTargetStage(tx, ctx, t, 'TRANSLATING', 1);
    }
  }

  private nextStage(
    target: TargetRow,
    current: WorkerStage,
    hasVideo: boolean,
  ): WorkerStage | 'NEEDS_REVIEW_GATE' | 'COMPLETE' {
    const idx = TARGET_STAGE_ORDER.indexOf(current);
    let next = TARGET_STAGE_ORDER[idx + 1];
    if (next === 'LIP_SYNCING' && !(target.lip_sync && hasVideo)) next = 'MIXING';
    if (current === 'TARGET_QA') return 'NEEDS_REVIEW_GATE';
    if (current === 'PACKAGING' || next === undefined) return 'COMPLETE';
    return next;
  }

  private async enqueueTargetStage(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    stage: WorkerStage,
    attempt: number,
    opts: { hint?: string | null; notBefore?: Date } = {},
  ): Promise<void> {
    const { storage, buckets } = this.deps;
    const params = await this.buildTargetParams(tx, target, stage, opts.hint ?? null);
    await enqueueTask(tx, {
      organizationId: ctx.organizationId,
      projectId: target.project_id,
      jobId: target.job_id,
      targetJobId: target.id,
      assetId: null,
      stage,
      attempt,
      correlationId: ctx.correlationId,
      storage: {
        source: params.sourceUri,
        derivedPrefix: storage.uri(
          buckets.derived,
          tenantKey(ctx.organizationId, 'targets', target.id, stage.toLowerCase()) + '/',
        ),
        deliverablesPrefix:
          stage === 'PACKAGING'
            ? storage.uri(
                buckets.deliverables,
                tenantKey(ctx.organizationId, target.id, `v${target.package_version}`) + '/',
              )
            : null,
      },
      parameters: params.parameters,
      run: target.version,
      ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
    });
  }

  private async buildTargetParams(
    tx: Queryable,
    target: TargetRow,
    stage: WorkerStage,
    hint: string | null,
  ): Promise<{ parameters: WorkerTask['parameters']; sourceUri: string }> {
    const transcript = (
      await tx.query<TranscriptRow>(
        'SELECT id, project_id, asset_id, detected_locale, confirmed_locale, has_video FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
        [target.project_id],
      )
    ).rows[0];
    if (!transcript) throw new Error('target has no source transcript');
    const asset = (
      await tx.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [transcript.asset_id])
    ).rows[0];
    if (!asset || !asset.metadata || !asset.sha256)
      throw new Error('source asset is not validated');

    const scoped =
      SCOPED_STAGES.has(stage) && target.scope_segment_ids && target.scope_segment_ids.length > 0;
    const segmentRows = (
      await tx.query<SegmentRow>(
        `SELECT * FROM segments WHERE transcript_id = $1 ${scoped ? 'AND id = ANY($2::uuid[])' : ''} ORDER BY seq`,
        scoped ? [transcript.id, target.scope_segment_ids] : [transcript.id],
      )
    ).rows;
    const speakers = (
      await tx.query<SpeakerRow>(
        'SELECT id, speaker_key, label, on_camera, voice_policy, sample_ranges FROM speakers WHERE project_id = $1 ORDER BY speaker_key',
        [target.project_id],
      )
    ).rows;
    const translations = (
      await tx.query<TranslationRow>(
        `SELECT * FROM translation_versions WHERE target_job_id = $1 AND is_current ${scoped ? 'AND segment_id = ANY($2::uuid[])' : ''}`,
        scoped ? [target.id, target.scope_segment_ids] : [target.id],
      )
    ).rows;
    const speech = (
      await tx.query<SpeechRow>(
        `SELECT id, segment_id, translation_version_id, measured_duration_us, time_stretch_ratio, voice_id
         FROM renders WHERE target_job_id = $1 AND kind = 'speech' AND NOT stale ${scoped ? 'AND segment_id = ANY($2::uuid[])' : ''}`,
        scoped ? [target.id, target.scope_segment_ids] : [target.id],
      )
    ).rows;

    let provenance: { translationVersionIds: string[]; qcReport: QcReport | null } | null = null;
    if (stage === 'PACKAGING') {
      const all = (
        await tx.query<{ id: string }>(
          'SELECT id FROM translation_versions WHERE target_job_id = $1 AND is_current ORDER BY created_at',
          [target.id],
        )
      ).rows.map((r) => r.id);
      provenance = { translationVersionIds: all, qcReport: await this.buildQcReport(tx, target) };
    }

    const locale = registry.get(target.locale);
    const sourceLocale = transcript.confirmed_locale ?? transcript.detected_locale;
    const parameters = {
      targetJobId: target.id,
      projectId: target.project_id,
      jobId: target.job_id,
      sourceLocale,
      targetLocale: target.locale,
      direction: locale?.direction ?? 'ltr',
      lipSync: target.lip_sync && transcript.has_video,
      metadata: asset.metadata,
      sourceSha256: asset.sha256,
      speakers: speakers.map(speakerView),
      segments: segmentRows.map(segmentView),
      translations: translations.map((t) => ({
        translationVersionId: t.id,
        segmentId: t.segment_id,
        adaptedText: t.adapted_text,
        timingBudgetUs: Number(t.timing_budget_us),
        generation: t.generation,
      })),
      speech: speech.map((s) => ({
        renderId: s.id,
        translationVersionId: s.translation_version_id,
        segmentId: s.segment_id,
        measuredDurationUs: Number(s.measured_duration_us),
        timeStretchRatio: Number(s.time_stretch_ratio),
        voiceId: s.voice_id,
      })),
      hint,
      packageVersion: stage === 'PACKAGING' ? target.package_version : null,
      provenance,
    };
    return { parameters, sourceUri: asset.storage_uri };
  }

  async buildQcReport(tx: Queryable, target: TargetRow): Promise<QcReport | null> {
    const run = (
      await tx.query<{ run_no: number }>(
        'SELECT max(run_no) AS run_no FROM qc_checks WHERE target_job_id = $1',
        [target.id],
      )
    ).rows[0];
    if (!run || run.run_no === null) return null;
    const checks = (
      await tx.query<{
        metric: string;
        threshold: number | null;
        value: number | null;
        passed: boolean;
        provider: string;
      }>(
        'SELECT metric, threshold, value, passed, provider FROM qc_checks WHERE target_job_id = $1 AND run_no = $2 ORDER BY metric',
        [target.id, run.run_no],
      )
    ).rows;
    const issues = (
      await tx.query<IssueRow>(
        'SELECT * FROM qc_issues WHERE target_job_id = $1 ORDER BY created_at',
        [target.id],
      )
    ).rows.map(issueView);
    const open = issues.filter((i) => i.resolution === 'open').length;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      targetJobId: target.id,
      locale: target.locale,
      passed: open === 0 && checks.every((c) => c.passed),
      checks,
      issues: issues.map((i) => ({
        id: i.id,
        segmentId: i.segmentId,
        metric: i.metric,
        severity: i.severity,
        recommendation: i.recommendation,
        resolution: i.resolution,
      })),
      summary:
        open === 0
          ? `All ${checks.length} checks passed or were resolved by review (run ${run.run_no}).`
          : `${open} open issue(s) across ${checks.length} checks (run ${run.run_no}).`,
    };
  }

  /* ------------------------------------------------------------------ results */

  /** Entry point for POST /internal/v1/tasks/:id/result. Runs inside the task's tenant scope. */
  async applyResult(
    taskId: string,
    result: TaskResult,
    correlationId: string,
  ): Promise<JobState | null> {
    const head = await this.deps.db.withSystem(async (tx) => {
      const row = (await tx.query<TaskRow>('SELECT * FROM stage_tasks WHERE id = $1', [taskId]))
        .rows[0];
      return row ?? null;
    });
    if (!head) return null;
    return this.deps.db.withTenant(
      { organizationId: head.organization_id, userId: null },
      async (tx) => {
        const task = await loadClaimedTask(tx, taskId);
        if (!task) return null;
        if (task.status !== 'claimed') return null; // duplicate delivery: already settled
        if (task.claimed_by && task.claimed_by !== result.workerId) {
          // Lease was reassigned; the late result from the old worker is discarded (idempotency).
          return null;
        }
        const ctx: TxContext = { organizationId: task.organization_id, correlationId };
        if (task.asset_id) return this.applyAssetResult(tx, ctx, task, result);
        return this.applyTargetResult(tx, ctx, task, result);
      },
    );
  }

  private async applyAssetResult(
    tx: Queryable,
    ctx: TxContext,
    task: TaskRow,
    result: TaskResult,
  ): Promise<JobState | null> {
    const asset = await loadAsset(tx, task.asset_id as string);
    if (!asset) return null;
    if (result.status === 'failed') {
      await settleTask(tx, task.id, 'failed', null, result.error);
      if (result.retryable && task.attempt < this.maxAttempts) {
        const waiting = await transitionAsset(tx, ctx, asset, 'RETRY_WAIT');
        const backoff = new Date(Date.now() + this.retryDelayMs(task.attempt));
        await this.enqueueAssetStage(
          tx,
          ctx,
          waiting,
          task.stage as 'VALIDATING' | 'ANALYZING',
          task.attempt + 1,
          {
            maxDurationUs: (task.parameters as { maxDurationUs?: number }).maxDurationUs ?? 0,
            declaredLocale:
              (task.parameters as { declaredLocale?: string | null }).declaredLocale ?? null,
          },
          backoff,
        );
        return 'RETRY_WAIT';
      }
      const rejection = result.error ?? { code: 'MALFORMED_MEDIA', message: 'Validation failed' };
      await transitionAsset(tx, ctx, asset, 'FAILED', { rejection, event: 'asset.rejected' });
      await tx.query("UPDATE projects SET state = 'draft' WHERE id = $1", [asset.project_id]);
      return 'FAILED';
    }

    if (task.stage === 'VALIDATING') {
      const out = ValidatingOutputSchema.parse(result.output);
      await tx.query(
        'UPDATE assets SET metadata = $2, sha256 = $3, byte_size = $4, storage_uri = $5 WHERE id = $1',
        [asset.id, JSON.stringify(out.metadata), out.sha256, out.byteSize, out.source],
      );
      const validated: AssetRow = {
        ...asset,
        metadata: out.metadata,
        sha256: out.sha256,
        byte_size: out.byteSize,
        storage_uri: out.source,
      };
      const analyzing = await transitionAsset(tx, ctx, validated, 'ANALYZING', {
        event: 'asset.validated',
      });
      const project = (
        await tx.query<{ source_locale: string | null }>(
          'SELECT source_locale FROM projects WHERE id = $1',
          [asset.project_id],
        )
      ).rows[0];
      await tx.query("UPDATE projects SET state = 'analyzing' WHERE id = $1", [asset.project_id]);
      await settleTask(tx, task.id, 'succeeded', out, null);
      await this.enqueueAssetStage(tx, ctx, analyzing, 'ANALYZING', 1, {
        declaredLocale: project?.source_locale ?? null,
      });
      return 'ANALYZING';
    }

    // ANALYZING
    const out = AnalyzingOutputSchema.parse(result.output);
    const transcriptId = uuidv7();
    await tx.query(
      `INSERT INTO source_transcripts (id, organization_id, project_id, asset_id, detected_locale, detection_confidence, confirmed_locale, provider, provider_version, proxy_uri, waveform_uri, has_video)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        transcriptId,
        ctx.organizationId,
        asset.project_id,
        asset.id,
        out.detectedLocale,
        out.detectionConfidence,
        null,
        out.provider,
        out.providerVersion,
        out.proxy,
        out.waveform,
        out.hasVideo,
      ],
    );
    const speakerIds = new Map<string, string>();
    for (const s of out.speakers) {
      const id = uuidv7();
      speakerIds.set(s.key, id);
      await tx.query(
        `INSERT INTO speakers (id, organization_id, project_id, speaker_key, label, on_camera, sample_ranges, voice_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, speaker_key) DO UPDATE SET label = EXCLUDED.label, on_camera = EXCLUDED.on_camera, sample_ranges = EXCLUDED.sample_ranges`,
        [
          id,
          ctx.organizationId,
          asset.project_id,
          s.key,
          s.label,
          s.onCamera,
          JSON.stringify(s.sampleRanges),
          s.voicePolicy,
        ],
      );
    }
    const existing = (
      await tx.query<{ id: string; speaker_key: string }>(
        'SELECT id, speaker_key FROM speakers WHERE project_id = $1',
        [asset.project_id],
      )
    ).rows;
    for (const e of existing) speakerIds.set(e.speaker_key, e.id);
    for (const seg of out.segments) {
      const speakerId = speakerIds.get(seg.speakerKey);
      if (!speakerId) throw new Error(`unknown speaker key ${seg.speakerKey}`);
      await tx.query(
        `INSERT INTO segments (id, organization_id, transcript_id, speaker_id, seq, start_us, end_us, text, language, confidence, words)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          uuidv7(),
          ctx.organizationId,
          transcriptId,
          speakerId,
          seg.seq,
          seg.range.start,
          seg.range.end,
          seg.text,
          seg.language,
          seg.confidence,
          JSON.stringify(seg.words),
        ],
      );
    }
    await transitionAsset(tx, ctx, asset, 'READY_TO_CONFIGURE', { event: 'analysis.completed' });
    await tx.query(
      "UPDATE projects SET state = 'ready', source_asset_id = $2, source_locale = COALESCE(source_locale, $3) WHERE id = $1",
      [asset.project_id, asset.id, out.detectedLocale],
    );
    await settleTask(
      tx,
      task.id,
      'succeeded',
      { segments: out.segments.length, speakers: out.speakers.length },
      null,
    );
    return 'READY_TO_CONFIGURE';
  }

  private async applyTargetResult(
    tx: Queryable,
    ctx: TxContext,
    task: TaskRow,
    result: TaskResult,
  ): Promise<JobState | null> {
    const target = await loadTarget(tx, task.target_job_id as string);
    if (!target) return null;
    const stage = task.stage;

    if (target.state === 'CANCEL_REQUESTED') {
      await settleTask(tx, task.id, 'cancelled', null, null);
      await transitionTarget(tx, ctx, target, 'CANCELLED', { message: 'cancelled by user' });
      return 'CANCELLED';
    }

    if (result.status === 'failed') {
      await settleTask(tx, task.id, 'failed', null, result.error);
      const message = result.error?.message ?? 'stage failed';
      if (result.retryable && task.attempt < this.maxAttempts) {
        const waiting = await transitionTarget(tx, ctx, target, 'RETRY_WAIT', {
          message: `retrying ${stage} (attempt ${task.attempt + 1})`,
          attempt: task.attempt + 1,
          lastError: message,
        });
        await this.enqueueTargetStage(tx, ctx, waiting, stage, task.attempt + 1, {
          notBefore: new Date(Date.now() + this.retryDelayMs(task.attempt)),
        });
        return 'RETRY_WAIT';
      }
      await transitionTarget(tx, ctx, target, 'FAILED', { message, lastError: message });
      return 'FAILED';
    }

    const transcript = (
      await tx.query<{ has_video: boolean }>(
        'SELECT has_video FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
        [target.project_id],
      )
    ).rows[0];
    const hasVideo = transcript?.has_video ?? false;

    switch (stage) {
      case 'TRANSLATING':
        await this.persistTranslations(
          tx,
          ctx,
          target,
          TranslatingOutputSchema.parse(result.output),
        );
        break;
      case 'SYNTHESIZING':
        await this.persistSpeech(tx, ctx, target, SynthesizingOutputSchema.parse(result.output));
        break;
      case 'TIMING': {
        const out = TimingOutputSchema.parse(result.output);
        for (const f of out.fits) {
          await tx.query(
            `UPDATE renders SET time_stretch_ratio = $3, parameters = parameters || $4::jsonb WHERE target_job_id = $1 AND segment_id = $2 AND kind = 'speech' AND NOT stale`,
            [target.id, f.segmentId, f.timeStretchRatio, JSON.stringify({ timing: f })],
          );
        }
        break;
      }
      case 'LIP_SYNCING': {
        const out = LipSyncOutputSchema.parse(result.output);
        await tx.query(
          `UPDATE renders SET stale = true WHERE target_job_id = $1 AND kind = 'lipsync' AND NOT stale`,
          [target.id],
        );
        for (const r of out.renders) {
          await tx.query(
            `INSERT INTO renders (id, organization_id, target_job_id, kind, provider, provider_version, parameters, segment_id, output_uri)
             VALUES ($1,$2,$3,'lipsync',$4,$5,$6,$7,$8)`,
            [
              uuidv7(),
              ctx.organizationId,
              target.id,
              out.provider,
              out.providerVersion,
              JSON.stringify({ applied: out.applied, syncConfidence: r.syncConfidence }),
              r.segmentId,
              r.video,
            ],
          );
        }
        break;
      }
      case 'MIXING': {
        const out = MixingOutputSchema.parse(result.output);
        await tx.query(
          `UPDATE renders SET stale = true WHERE target_job_id = $1 AND kind = 'mix' AND NOT stale`,
          [target.id],
        );
        await tx.query(
          `INSERT INTO renders (id, organization_id, target_job_id, kind, provider, provider_version, parameters, output_uri)
           VALUES ($1,$2,$3,'mix','ffmpeg-mix','1',$4,$5)`,
          [
            uuidv7(),
            ctx.organizationId,
            target.id,
            JSON.stringify({ integratedLufs: out.integratedLufs, truePeakDbtp: out.truePeakDbtp }),
            out.mix,
          ],
        );
        break;
      }
      case 'ENCODING': {
        const out = EncodingOutputSchema.parse(result.output);
        await tx.query(
          `UPDATE renders SET stale = true WHERE target_job_id = $1 AND kind = 'encode' AND NOT stale`,
          [target.id],
        );
        await tx.query(
          `INSERT INTO renders (id, organization_id, target_job_id, kind, provider, provider_version, parameters, output_uri)
           VALUES ($1,$2,$3,'encode','ffmpeg-encode','1',$4,$5)`,
          [
            uuidv7(),
            ctx.organizationId,
            target.id,
            JSON.stringify({ container: out.container, byteSize: out.byteSize }),
            out.encode,
          ],
        );
        break;
      }
      case 'TARGET_QA':
        await this.persistQa(tx, ctx, target, TargetQaOutputSchema.parse(result.output));
        break;
      case 'PACKAGING':
        await this.persistPackage(tx, ctx, target, PackagingOutputSchema.parse(result.output));
        break;
      default:
        throw new Error(`unexpected stage ${stage}`);
    }
    await settleTask(tx, task.id, 'succeeded', { ok: true }, null);

    const next = this.nextStage(target, stage, hasVideo);
    if (next === 'COMPLETE') {
      const done = await transitionTarget(tx, ctx, target, 'COMPLETE', {
        message: 'deliverables packaged',
      });
      await emitEvent(tx, {
        name: 'deliverable.packaged',
        organizationId: ctx.organizationId,
        correlationId: ctx.correlationId,
        subject: { type: 'TargetJob', id: target.id },
        projectId: target.project_id,
        payload: {
          projectId: target.project_id,
          jobId: target.job_id,
          targetJobId: target.id,
          locale: target.locale,
        },
      });
      await this.settleParentJob(tx, target.job_id);
      return done.state;
    }
    if (next === 'NEEDS_REVIEW_GATE') {
      return this.readyGate(tx, ctx, { ...target, state: 'TARGET_QA' });
    }
    const moved = await transitionTarget(tx, ctx, target, next);
    await this.enqueueTargetStage(tx, ctx, moved, next, 1);
    return moved.state;
  }

  /**
   * Ready gate (FR-042): READY only when no P0 issue is open and every segment carries a
   * fresh approval; otherwise NEEDS_REVIEW. Beta targets always need review (spec §5).
   */
  private async readyGate(tx: Queryable, ctx: TxContext, target: TargetRow): Promise<JobState> {
    const fresh = await loadTarget(tx, target.id);
    if (!fresh) throw new Error('target vanished');
    const current: TargetRow = { ...fresh, state: target.state };
    const open = Number(fresh.open_issues ?? 0);
    const allApproved = await this.allSegmentsApproved(tx, target.id);
    if (open === 0 && allApproved) {
      const ready = await transitionTarget(tx, ctx, current, 'READY', {
        message: 'ready gate passed',
        scope: null,
      });
      await tx.query("UPDATE target_jobs SET approval_state = 'approved' WHERE id = $1", [
        target.id,
      ]);
      await emitEvent(tx, {
        name: 'target.ready',
        organizationId: ctx.organizationId,
        correlationId: ctx.correlationId,
        subject: { type: 'TargetJob', id: target.id },
        projectId: target.project_id,
        payload: {
          projectId: target.project_id,
          jobId: target.job_id,
          targetJobId: target.id,
          locale: target.locale,
        },
      });
      return this.startPackaging(tx, ctx, { ...ready, approval_state: 'approved' });
    }
    const review = await transitionTarget(tx, ctx, current, 'NEEDS_REVIEW', {
      message:
        open > 0
          ? `${open} QC issue(s) need review`
          : 'native-speaker approval required (beta tier)',
      scope: null,
    });
    await tx.query("UPDATE target_jobs SET approval_state = 'pending' WHERE id = $1", [target.id]);
    await emitEvent(tx, {
      name: 'target.review.required',
      organizationId: ctx.organizationId,
      correlationId: ctx.correlationId,
      subject: { type: 'TargetJob', id: target.id },
      projectId: target.project_id,
      payload: {
        projectId: target.project_id,
        jobId: target.job_id,
        targetJobId: target.id,
        locale: target.locale,
      },
    });
    return review.state;
  }

  async allSegmentsApproved(tx: Queryable, targetJobId: string): Promise<boolean> {
    const res = await tx.query<{ total: string; approved: string }>(
      `SELECT
         (SELECT count(*) FROM translation_versions v WHERE v.target_job_id = $1 AND v.is_current) AS total,
         (SELECT count(DISTINCT a.segment_id) FROM approvals a
            JOIN translation_versions v ON v.id = a.translation_version_id AND v.is_current
          WHERE a.target_job_id = $1 AND NOT a.stale AND a.decision = 'approved') AS approved`,
      [targetJobId],
    );
    const row = res.rows[0];
    return !!row && Number(row.total) > 0 && Number(row.total) === Number(row.approved);
  }

  /** READY → PACKAGING with a new package version. */
  async startPackaging(tx: Queryable, ctx: TxContext, target: TargetRow): Promise<JobState> {
    const version = target.package_version + 1;
    await tx.query('UPDATE target_jobs SET package_version = $2 WHERE id = $1', [
      target.id,
      version,
    ]);
    const packaging = await transitionTarget(
      tx,
      ctx,
      { ...target, package_version: version },
      'PACKAGING',
    );
    await this.enqueueTargetStage(tx, ctx, packaging, 'PACKAGING', 1);
    return packaging.state;
  }

  /** Approve endpoint hook: NEEDS_REVIEW → READY → PACKAGING when the gate passes. */
  async tryReady(tx: Queryable, ctx: TxContext, target: TargetRow): Promise<JobState> {
    if (target.state !== 'NEEDS_REVIEW') return target.state;
    if (Number(target.open_issues ?? 0) > 0) return target.state;
    if (!(await this.allSegmentsApproved(tx, target.id))) return target.state;
    const ready = await transitionTarget(tx, ctx, target, 'READY', {
      message: 'approved by reviewer',
    });
    await tx.query("UPDATE target_jobs SET approval_state = 'approved' WHERE id = $1", [target.id]);
    await emitEvent(tx, {
      name: 'target.ready',
      organizationId: ctx.organizationId,
      correlationId: ctx.correlationId,
      subject: { type: 'TargetJob', id: target.id },
      projectId: target.project_id,
      payload: {
        projectId: target.project_id,
        jobId: target.job_id,
        targetJobId: target.id,
        locale: target.locale,
      },
    });
    return this.startPackaging(tx, ctx, { ...ready, approval_state: 'approved' });
  }

  /** Regeneration (FR-053): invalidate per the graph and re-enter the pipeline for the segment. */
  async regenerate(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    stage: RegenerateStage,
    segmentId: string,
    speakerId: string,
    hint: string | null,
  ): Promise<{ restartAt: JobState; invalidated: readonly string[] }> {
    const plan = planRegeneration(
      stage,
      stage === 'voice'
        ? { kind: 'speaker', speakerId }
        : { kind: 'segment', segmentIds: [segmentId] },
    );
    const segmentIds =
      stage === 'voice'
        ? (
            await tx.query<{ id: string }>(
              'SELECT s.id FROM segments s JOIN source_transcripts t ON t.id = s.transcript_id WHERE t.project_id = $1 AND s.speaker_id = $2',
              [target.project_id, speakerId],
            )
          ).rows.map((r) => r.id)
        : [segmentId];
    // Invalidate downstream artefacts for the scope (kept until replaced; deleted per retention later).
    if (plan.invalidates.includes('speech')) {
      await tx.query(
        `UPDATE renders SET stale = true WHERE target_job_id = $1 AND kind IN ('speech','lipsync') AND segment_id = ANY($2::uuid[])`,
        [target.id, segmentIds],
      );
    }
    await tx.query(
      `UPDATE renders SET stale = true WHERE target_job_id = $1 AND kind IN ('mix','encode')`,
      [target.id],
    );
    await tx.query(
      `UPDATE approvals SET stale = true WHERE target_job_id = $1 AND segment_id = ANY($2::uuid[])`,
      [target.id, segmentIds],
    );
    await tx.query(
      `UPDATE qc_issues SET resolution = 'regenerated' WHERE target_job_id = $1 AND resolution = 'open' AND segment_id = ANY($2::uuid[])`,
      [target.id, segmentIds],
    );
    await tx.query("UPDATE target_jobs SET approval_state = 'pending' WHERE id = $1", [target.id]);
    const moved = await transitionTarget(
      tx,
      ctx,
      { ...target, approval_state: 'pending' },
      plan.restartAt,
      {
        message: `regenerating ${stage} for ${segmentIds.length} segment(s)`,
        scope: segmentIds,
      },
    );
    await this.enqueueTargetStage(tx, ctx, moved, plan.restartAt as WorkerStage, 1, { hint });
    return { restartAt: plan.restartAt, invalidated: plan.invalidates };
  }

  async cancelTarget(tx: Queryable, ctx: TxContext, target: TargetRow): Promise<TargetRow> {
    await cancelQueuedTasks(tx, target.id);
    if (isWorking(target.state) || target.state === 'RETRY_WAIT') {
      const requested = await transitionTarget(tx, ctx, target, 'CANCEL_REQUESTED', {
        message: 'cancel requested',
      });
      if (!(await hasInFlightTask(tx, target.id))) {
        return transitionTarget(tx, ctx, requested, 'CANCELLED', { message: 'cancelled' });
      }
      return requested;
    }
    if (
      target.state === 'QUEUED' ||
      target.state === 'NEEDS_REVIEW' ||
      target.state === 'READY' ||
      target.state === 'READY_TO_CONFIGURE'
    ) {
      return transitionTarget(tx, ctx, target, 'CANCELLED', { message: 'cancelled' });
    }
    return target;
  }

  private async settleParentJob(tx: Queryable, jobId: string): Promise<void> {
    const states = (
      await tx.query<{ state: JobState }>('SELECT state FROM target_jobs WHERE job_id = $1', [
        jobId,
      ])
    ).rows.map((r) => r.state);
    if (
      states.length &&
      states.every((s) => s === 'COMPLETE' || s === 'FAILED' || s === 'CANCELLED')
    ) {
      await tx.query(
        'UPDATE localization_jobs SET completed_at = now() WHERE id = $1 AND completed_at IS NULL',
        [jobId],
      );
    }
  }

  private retryDelayMs(attempt: number): number {
    const base = this.deps.config.NODE_ENV === 'test' ? 50 : 2000;
    return base * 2 ** (attempt - 1);
  }

  /* ------------------------------------------------------------------ persistence per stage */

  private async persistTranslations(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    out: {
      provider: string;
      providerVersion: string;
      promptVersion: string | null;
      translations: {
        segmentId: string;
        adaptedText: string;
        literalText: string | null;
        confidence: number;
        timingBudgetUs: number;
      }[];
    },
  ): Promise<void> {
    for (const t of out.translations) {
      const prev = (
        await tx.query<TranslationRow>(
          'SELECT * FROM translation_versions WHERE target_job_id = $1 AND segment_id = $2 AND is_current',
          [target.id, t.segmentId],
        )
      ).rows[0];
      const seg = (
        await tx.query<{ version: number }>('SELECT version FROM segments WHERE id = $1', [
          t.segmentId,
        ])
      ).rows[0];
      if (prev)
        await tx.query('UPDATE translation_versions SET is_current = false WHERE id = $1', [
          prev.id,
        ]);
      await tx.query(
        `INSERT INTO translation_versions (id, organization_id, target_job_id, segment_id, source_segment_version, literal_text, adapted_text, timing_budget_us,
           provider, provider_version, prompt_version, confidence, supersedes_id, generation, is_current)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
        [
          uuidv7(),
          ctx.organizationId,
          target.id,
          t.segmentId,
          seg?.version ?? 1,
          t.literalText,
          t.adaptedText,
          t.timingBudgetUs,
          out.provider,
          out.providerVersion,
          out.promptVersion,
          t.confidence,
          prev?.id ?? null,
          (prev?.generation ?? 0) + 1,
        ],
      );
      await tx.query(
        `UPDATE renders SET stale = true WHERE target_job_id = $1 AND segment_id = $2 AND kind IN ('speech','lipsync')`,
        [target.id, t.segmentId],
      );
      await tx.query(
        `UPDATE approvals SET stale = true WHERE target_job_id = $1 AND segment_id = $2`,
        [target.id, t.segmentId],
      );
    }
  }

  private async persistSpeech(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    out: {
      provider: string;
      providerVersion: string;
      renders: {
        segmentId: string;
        translationVersionId: string;
        voiceId: string;
        measuredDurationUs: number;
        audio: string | null;
      }[];
    },
  ): Promise<void> {
    for (const r of out.renders) {
      await tx.query(
        `UPDATE renders SET stale = true WHERE target_job_id = $1 AND segment_id = $2 AND kind = 'speech' AND NOT stale`,
        [target.id, r.segmentId],
      );
      await tx.query(
        `INSERT INTO renders (id, organization_id, target_job_id, kind, provider, provider_version, parameters, segment_id, translation_version_id, measured_duration_us, time_stretch_ratio, voice_id, output_uri)
         VALUES ($1,$2,$3,'speech',$4,$5,'{}'::jsonb,$6,$7,$8,1.0,$9,$10)`,
        [
          uuidv7(),
          ctx.organizationId,
          target.id,
          out.provider,
          out.providerVersion,
          r.segmentId,
          r.translationVersionId,
          r.measuredDurationUs,
          r.voiceId,
          r.audio,
        ],
      );
    }
  }

  private async persistQa(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    out: {
      provider: string;
      checks: { metric: string; threshold: number | null; value: number | null; passed: boolean }[];
      issues: {
        metric: string;
        segmentId: string | null;
        severity: 'info' | 'warning' | 'critical';
        range: { start: number; end: number } | null;
        recommendation: string;
      }[];
    },
  ): Promise<void> {
    const runRow = (
      await tx.query<{ run_no: number | null }>(
        'SELECT max(run_no) AS run_no FROM qc_checks WHERE target_job_id = $1',
        [target.id],
      )
    ).rows[0];
    const runNo = (runRow?.run_no ?? 0) + 1;
    const checkIds = new Map<string, string>();
    for (const c of out.checks) {
      const id = uuidv7();
      checkIds.set(c.metric, id);
      await tx.query(
        `INSERT INTO qc_checks (id, organization_id, target_job_id, run_no, metric, threshold, value, passed, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          ctx.organizationId,
          target.id,
          runNo,
          c.metric,
          c.threshold,
          c.value,
          c.passed,
          out.provider,
        ],
      );
    }
    for (const i of out.issues) {
      const checkId = checkIds.get(i.metric) ?? uuidv7();
      if (!checkIds.has(i.metric)) {
        await tx.query(
          `INSERT INTO qc_checks (id, organization_id, target_job_id, run_no, metric, threshold, value, passed, provider) VALUES ($1,$2,$3,$4,$5,NULL,NULL,false,$6)`,
          [checkId, ctx.organizationId, target.id, runNo, i.metric, out.provider],
        );
        checkIds.set(i.metric, checkId);
      }
      await tx.query(
        `INSERT INTO qc_issues (id, organization_id, qc_check_id, target_job_id, segment_id, metric, severity, start_us, end_us, recommendation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv7(),
          ctx.organizationId,
          checkId,
          target.id,
          i.segmentId,
          i.metric,
          i.severity,
          i.range?.start ?? null,
          i.range?.end ?? null,
          i.recommendation,
        ],
      );
    }
  }

  private async persistPackage(
    tx: Queryable,
    ctx: TxContext,
    target: TargetRow,
    out: {
      deliverables: {
        kind: string;
        fileName: string;
        contentType: string;
        byteSize: number;
        sha256: string;
        uri: string;
      }[];
      manifest: unknown;
    },
  ): Promise<void> {
    for (const d of out.deliverables) {
      await tx.query(
        `INSERT INTO deliverables (id, organization_id, target_job_id, package_version, kind, file_name, content_type, byte_size, sha256, storage_uri)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv7(),
          ctx.organizationId,
          target.id,
          target.package_version,
          d.kind,
          d.fileName,
          d.contentType,
          d.byteSize,
          d.sha256,
          d.uri,
        ],
      );
    }
    await tx.query(
      `INSERT INTO provenance_manifests (id, organization_id, target_job_id, package_version, manifest) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (target_job_id, package_version) DO UPDATE SET manifest = EXCLUDED.manifest`,
      [
        uuidv7(),
        ctx.organizationId,
        target.id,
        target.package_version,
        JSON.stringify(out.manifest),
      ],
    );
  }
}
