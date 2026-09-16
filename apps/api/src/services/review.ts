import {
  DomainError,
  NotFoundError,
  createRegistry,
  uuidv7,
  type RegenerateStage,
} from '@polycast/domain';
import type {
  ApproveResponse,
  CommentsResponse,
  RegenerateResponse,
  ReviewResponse,
} from '@polycast/contracts';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/principal.js';
import type { Db, Queryable } from '../db/pool.js';
import type { LocalOrchestrator } from '../orchestrator/local.js';
import { loadTarget } from '../orchestrator/transitions.js';
import type { StorageDriver } from '../storage/index.js';
import { parseStorageUri } from '../storage/index.js';
import {
  OPEN_ISSUES_SQL,
  issueView,
  segmentView,
  speakerView,
  targetView,
  translationView,
  type IssueRow,
  type SegmentRow,
  type SpeakerRow,
  type TargetRow,
  type TranslationRow,
} from './views.js';

const registry = createRegistry();

interface SpeechRow {
  id: string;
  segment_id: string;
  translation_version_id: string;
  provider: string;
  voice_id: string;
  measured_duration_us: number;
  time_stretch_ratio: number;
  stale: boolean;
}

export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly orchestrator: LocalOrchestrator,
  ) {}

  private async targetOrThrow(
    tx: Queryable,
    targetJobId: string,
    lock = false,
  ): Promise<TargetRow> {
    const t = lock
      ? await loadTarget(tx, targetJobId)
      : (
          await tx.query<TargetRow>(
            `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.id = $1`,
            [targetJobId],
          )
        ).rows[0];
    if (!t) throw new NotFoundError('TargetJob', targetJobId);
    return t;
  }

  private async signed(uri: string | null, fileName: string): Promise<string | null> {
    if (!uri) return null;
    const { bucket, key } = parseStorageUri(uri);
    return (await this.storage.signGetUrl(bucket, key, fileName)).url;
  }

  async review(
    p: Principal,
    targetJobId: string,
    correlationId: string,
    ip: string,
  ): Promise<ReviewResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const target = await this.targetOrThrow(tx, targetJobId);
        const transcript = (
          await tx.query<{
            id: string;
            detected_locale: string;
            confirmed_locale: string | null;
            proxy_uri: string | null;
            waveform_uri: string | null;
          }>(
            'SELECT id, detected_locale, confirmed_locale, proxy_uri, waveform_uri FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
            [target.project_id],
          )
        ).rows[0];
        if (!transcript) throw new NotFoundError('SourceTranscript', target.project_id);
        const segments = (
          await tx.query<SegmentRow>(
            'SELECT * FROM segments WHERE transcript_id = $1 ORDER BY seq',
            [transcript.id],
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
            'SELECT * FROM translation_versions WHERE target_job_id = $1 ORDER BY generation DESC, created_at DESC',
            [target.id],
          )
        ).rows;
        const speech = (
          await tx.query<SpeechRow>(
            `SELECT id, segment_id, translation_version_id, provider, voice_id, measured_duration_us, time_stretch_ratio, stale FROM renders WHERE target_job_id = $1 AND kind = 'speech' AND NOT stale`,
            [target.id],
          )
        ).rows;
        const issues = (
          await tx.query<IssueRow>(
            'SELECT * FROM qc_issues WHERE target_job_id = $1 ORDER BY created_at',
            [target.id],
          )
        ).rows;
        const approvals = (
          await tx.query<{ segment_id: string }>(
            `SELECT DISTINCT a.segment_id FROM approvals a JOIN translation_versions v ON v.id = a.translation_version_id AND v.is_current
           WHERE a.target_job_id = $1 AND NOT a.stale AND a.decision = 'approved'`,
            [target.id],
          )
        ).rows;
        const approved = new Set(approvals.map((a) => a.segment_id));
        const checksRun = (
          await tx.query<{ run_no: number | null }>(
            'SELECT max(run_no) AS run_no FROM qc_checks WHERE target_job_id = $1',
            [target.id],
          )
        ).rows[0];
        const checks =
          checksRun?.run_no !== null && checksRun?.run_no !== undefined
            ? (
                await tx.query<{
                  id: string;
                  metric: string;
                  threshold: number | null;
                  value: number | null;
                  passed: boolean;
                  provider: string;
                  run_no: number;
                  created_at: Date;
                }>(
                  'SELECT * FROM qc_checks WHERE target_job_id = $1 AND run_no = $2 ORDER BY metric',
                  [target.id, checksRun.run_no],
                )
              ).rows
            : [];

        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'review.opened',
          objectType: 'TargetJob',
          objectId: target.id,
          correlationId,
          ipAddress: ip,
        });

        const cap = registry.get(target.locale);
        return {
          target: targetView(target),
          sourceLocale: transcript.confirmed_locale ?? transcript.detected_locale,
          direction: cap?.direction ?? 'ltr',
          speakers: speakers.map(speakerView),
          segments: segments.map((s) => {
            const versions = translations.filter((t) => t.segment_id === s.id);
            const current = versions.find((t) => t.is_current) ?? null;
            const render = speech.find((r) => r.segment_id === s.id) ?? null;
            return {
              segment: segmentView(s),
              translation: current ? translationView(current) : null,
              history: versions.filter((t) => !t.is_current).map(translationView),
              speech: render
                ? {
                    id: render.id,
                    translationVersionId: render.translation_version_id,
                    provider: render.provider,
                    voiceId: render.voice_id,
                    measuredDurationUs: Number(render.measured_duration_us),
                    timeStretchRatio: Number(render.time_stretch_ratio),
                    stale: render.stale,
                  }
                : null,
              issues: issues.filter((i) => i.segment_id === s.id).map(issueView),
              approved: approved.has(s.id),
            };
          }),
          checks: checks.map((c) => ({
            id: c.id,
            metric: c.metric,
            threshold: c.threshold,
            value: c.value,
            passed: c.passed,
            provider: c.provider,
            runNo: c.run_no,
            createdAt: c.created_at.toISOString(),
          })),
          openIssues: Number(target.open_issues ?? 0),
          proxyUrl: await this.signed(transcript.proxy_uri, 'proxy'),
          waveformUrl: await this.signed(transcript.waveform_uri, 'waveform.json'),
        };
      },
    );
  }

  async regenerate(
    p: Principal,
    targetJobId: string,
    segmentId: string,
    stage: RegenerateStage,
    hint: string | null,
    correlationId: string,
    ip: string,
  ): Promise<RegenerateResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const target = await this.targetOrThrow(tx, targetJobId, true);
        if (target.state !== 'NEEDS_REVIEW') {
          throw new DomainError(
            'ILLEGAL_TRANSITION',
            `Segments can be regenerated only while the target is in NEEDS_REVIEW (current: ${target.state})`,
          );
        }
        const seg = (
          await tx.query<{ id: string; speaker_id: string }>(
            `SELECT s.id, s.speaker_id FROM segments s JOIN source_transcripts t ON t.id = s.transcript_id WHERE s.id = $1 AND t.project_id = $2`,
            [segmentId, target.project_id],
          )
        ).rows[0];
        if (!seg) throw new NotFoundError('Segment', segmentId);
        if (stage === 'lipsync' && !target.lip_sync)
          throw new DomainError(
            'CAPABILITY_UNAVAILABLE',
            'Lip sync is not enabled for this target',
          );
        const plan = await this.orchestrator.regenerate(
          tx,
          { organizationId: p.organizationId, correlationId },
          target,
          stage,
          seg.id,
          seg.speaker_id,
          hint,
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: `segment.regenerate.${stage}`,
          objectType: 'Segment',
          objectId: seg.id,
          after: { targetJobId, stage },
          correlationId,
          ipAddress: ip,
        });
        const fresh = await this.targetOrThrow(tx, targetJobId);
        return {
          target: targetView(fresh),
          segmentId: seg.id,
          restartAt: plan.restartAt,
          invalidated: [...plan.invalidated],
        };
      },
    );
  }

  /** Manual edit creates a new TranslationVersion with the editor recorded (FR-012). */
  async editTranslation(
    p: Principal,
    targetJobId: string,
    segmentId: string,
    adaptedText: string,
    correlationId: string,
    ip: string,
  ) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const target = await this.targetOrThrow(tx, targetJobId, true);
        if (target.state !== 'NEEDS_REVIEW')
          throw new DomainError(
            'ILLEGAL_TRANSITION',
            'Translations can be edited only while the target is in NEEDS_REVIEW',
          );
        const prev = (
          await tx.query<TranslationRow>(
            'SELECT * FROM translation_versions WHERE target_job_id = $1 AND segment_id = $2 AND is_current FOR UPDATE',
            [target.id, segmentId],
          )
        ).rows[0];
        if (!prev) throw new NotFoundError('TranslationVersion', segmentId);
        await tx.query('UPDATE translation_versions SET is_current = false WHERE id = $1', [
          prev.id,
        ]);
        const id = uuidv7();
        const row = (
          await tx.query<TranslationRow>(
            `INSERT INTO translation_versions (id, organization_id, target_job_id, segment_id, source_segment_version, literal_text, adapted_text, timing_budget_us, provider, provider_version, prompt_version, confidence, edited_by_user_id, supersedes_id, generation, is_current)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'human-edit','1',NULL,1.0,$9,$10,$11,true) RETURNING *`,
            [
              id,
              p.organizationId,
              target.id,
              segmentId,
              prev.source_segment_version,
              prev.literal_text,
              adaptedText,
              prev.timing_budget_us,
              p.userId,
              prev.id,
              prev.generation + 1,
            ],
          )
        ).rows[0] as TranslationRow;
        await tx.query(
          `UPDATE approvals SET stale = true WHERE target_job_id = $1 AND segment_id = $2`,
          [target.id, segmentId],
        );
        await tx.query(
          `UPDATE renders SET stale = true WHERE target_job_id = $1 AND segment_id = $2 AND kind IN ('speech','lipsync')`,
          [target.id, segmentId],
        );
        await tx.query("UPDATE target_jobs SET approval_state = 'pending' WHERE id = $1", [
          target.id,
        ]);
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'translation.edited',
          objectType: 'TranslationVersion',
          objectId: id,
          before: { id: prev.id, generation: prev.generation },
          after: { generation: prev.generation + 1 },
          correlationId,
          ipAddress: ip,
        });
        return { translation: translationView(row) };
      },
    );
  }

  async resolveIssue(
    p: Principal,
    targetJobId: string,
    issueId: string,
    resolution: 'accepted' | 'dismissed',
    correlationId: string,
    ip: string,
  ) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        await this.targetOrThrow(tx, targetJobId, true);
        const issue = (
          await tx.query<IssueRow>(
            'SELECT * FROM qc_issues WHERE id = $1 AND target_job_id = $2 FOR UPDATE',
            [issueId, targetJobId],
          )
        ).rows[0];
        if (!issue) throw new NotFoundError('QCIssue', issueId);
        if (issue.severity === 'critical' && resolution === 'dismissed') {
          throw new DomainError(
            'FORBIDDEN',
            'Critical issues cannot be dismissed; regenerate or accept with authority',
          );
        }
        if (issue.resolution !== 'open')
          throw new DomainError('CONFLICT', `Issue is already ${issue.resolution}`);
        const row = (
          await tx.query<IssueRow>(
            'UPDATE qc_issues SET resolution = $2 WHERE id = $1 RETURNING *',
            [issueId, resolution],
          )
        ).rows[0] as IssueRow;
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: `qc_issue.${resolution}`,
          objectType: 'QCIssue',
          objectId: issueId,
          before: { resolution: 'open' },
          after: { resolution },
          correlationId,
          ipAddress: ip,
        });
        return { issue: issueView(row) };
      },
    );
  }

  /** Per-segment approvals (BR-04); when every segment is approved and no issue is open, the gate passes. */
  async approve(
    p: Principal,
    targetJobId: string,
    segmentIds: string[],
    correlationId: string,
    ip: string,
  ): Promise<ApproveResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const target = await this.targetOrThrow(tx, targetJobId, true);
        if (target.state !== 'NEEDS_REVIEW')
          throw new DomainError(
            'ILLEGAL_TRANSITION',
            `Approvals are recorded only in NEEDS_REVIEW (current: ${target.state})`,
          );
        const current = (
          await tx.query<TranslationRow>(
            'SELECT * FROM translation_versions WHERE target_job_id = $1 AND is_current',
            [target.id],
          )
        ).rows;
        const wanted = segmentIds.length
          ? current.filter((t) => segmentIds.includes(t.segment_id))
          : current;
        if (segmentIds.length && wanted.length !== segmentIds.length)
          throw new NotFoundError('Segment', segmentIds.join(','));
        const openIssues = (
          await tx.query<{ segment_id: string | null }>(
            `SELECT segment_id FROM qc_issues WHERE target_job_id = $1 AND resolution = 'open'`,
            [target.id],
          )
        ).rows;
        const blocked = wanted.filter((t) => openIssues.some((i) => i.segment_id === t.segment_id));
        if (blocked.length) {
          throw new DomainError(
            'CONFLICT',
            'Resolve or regenerate the open QC issues on these segments before approving',
            {
              details: { segmentIds: blocked.map((b) => b.segment_id) },
            },
          );
        }
        const reviewId = uuidv7();
        await tx.query(
          `INSERT INTO reviews (id, organization_id, target_job_id, reviewer_user_id, scope, segment_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            reviewId,
            p.organizationId,
            target.id,
            p.userId,
            segmentIds.length === 1 ? 'segment' : 'target',
            segmentIds.length === 1 ? segmentIds[0] : null,
          ],
        );
        for (const t of wanted) {
          await tx.query(
            `UPDATE approvals SET stale = true WHERE target_job_id = $1 AND segment_id = $2`,
            [target.id, t.segment_id],
          );
          await tx.query(
            `INSERT INTO approvals (id, organization_id, target_job_id, segment_id, actor_user_id, decision, translation_version_id, artifact_version)
           VALUES ($1,$2,$3,$4,$5,'approved',$6,$7)`,
            [uuidv7(), p.organizationId, target.id, t.segment_id, p.userId, t.id, t.generation],
          );
        }
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'target.approved',
          objectType: 'TargetJob',
          objectId: target.id,
          after: { segments: wanted.length },
          correlationId,
          ipAddress: ip,
        });
        const fresh = await this.targetOrThrow(tx, targetJobId, true);
        await this.orchestrator.tryReady(
          tx,
          { organizationId: p.organizationId, correlationId },
          fresh,
        );
        const after = await this.targetOrThrow(tx, targetJobId);
        const approvedCount = (
          await tx.query<{ n: string }>(
            `SELECT count(DISTINCT a.segment_id) AS n FROM approvals a JOIN translation_versions v ON v.id = a.translation_version_id AND v.is_current WHERE a.target_job_id = $1 AND NOT a.stale`,
            [target.id],
          )
        ).rows[0];
        const approved = Number(approvedCount?.n ?? 0);
        return {
          target: targetView(after),
          approvedSegments: approved,
          remainingSegments: Math.max(0, current.length - approved),
        };
      },
    );
  }

  async comments(p: Principal, targetJobId: string): Promise<CommentsResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        await this.targetOrThrow(tx, targetJobId);
        const rows = (
          await tx.query<{
            id: string;
            author_user_id: string;
            display_name: string;
            body: string;
            segment_id: string | null;
            created_at: Date;
          }>(
            `SELECT c.id, c.author_user_id, u.display_name, c.body, c.segment_id, c.created_at FROM comments c JOIN users u ON u.id = c.author_user_id WHERE c.target_job_id = $1 ORDER BY c.created_at`,
            [targetJobId],
          )
        ).rows;
        return {
          comments: rows.map((r) => ({
            id: r.id,
            authorUserId: r.author_user_id,
            authorName: r.display_name,
            body: r.body,
            segmentId: r.segment_id,
            createdAt: r.created_at.toISOString(),
          })),
        };
      },
    );
  }

  async addComment(
    p: Principal,
    targetJobId: string,
    body: string,
    segmentId: string | null,
    correlationId: string,
    ip: string,
  ) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        await this.targetOrThrow(tx, targetJobId);
        const id = uuidv7();
        await tx.query(
          `INSERT INTO comments (id, organization_id, target_job_id, segment_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, p.organizationId, targetJobId, segmentId, p.userId, body],
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'comment.created',
          objectType: 'Comment',
          objectId: id,
          correlationId,
          ipAddress: ip,
        });
        return {
          comment: {
            id,
            authorUserId: p.userId,
            authorName: p.displayName,
            body,
            segmentId,
            createdAt: new Date().toISOString(),
          },
        };
      },
    );
  }
}
