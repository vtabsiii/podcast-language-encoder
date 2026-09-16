import { NotFoundError, createRegistry, uuidv7 } from '@polycast/domain';
import type {
  ProjectDetailResponse,
  ProjectListResponse,
  SegmentsResponse,
} from '@polycast/contracts';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/principal.js';
import type { Db, Queryable } from '../db/pool.js';
import { emitEvent } from '../events/outbox.js';
import {
  OPEN_ISSUES_SQL,
  assetView,
  projectView,
  segmentView,
  speakerView,
  targetSummary,
  type AssetRow,
  type ProjectRow,
  type SegmentRow,
  type SpeakerRow,
  type TargetRow,
} from './views.js';

const registry = createRegistry();

interface TranscriptRow {
  id: string;
  asset_id: string;
  detected_locale: string;
  detection_confidence: number;
  confirmed_locale: string | null;
  provider: string;
  provider_version: string;
  has_video: boolean;
}

export class ProjectService {
  constructor(private readonly db: Db) {}

  async create(
    p: Principal,
    input: { title: string; sourceLocale?: string | undefined },
    correlationId: string,
    ip: string,
  ) {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const id = uuidv7();
        const row = (
          await tx.query<ProjectRow>(
            `INSERT INTO projects (id, organization_id, title, source_locale, owner_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [id, p.organizationId, input.title, input.sourceLocale ?? null, p.userId],
          )
        ).rows[0] as ProjectRow;
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'project.created',
          objectType: 'Project',
          objectId: id,
          after: { title: input.title },
          correlationId,
          ipAddress: ip,
        });
        await emitEvent(tx, {
          name: 'project.created',
          organizationId: p.organizationId,
          correlationId,
          subject: { type: 'Project', id },
          projectId: id,
          payload: { projectId: id },
        });
        return projectView(row);
      },
    );
  }

  async list(p: Principal): Promise<ProjectListResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const projects = (
          await tx.query<ProjectRow>(
            'SELECT * FROM projects WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200',
            [p.organizationId],
          )
        ).rows;
        const ids = projects.map((r) => r.id);
        const assets = ids.length
          ? (
              await tx.query<AssetRow>(
                `SELECT * FROM assets WHERE kind = 'source' AND project_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
                [ids],
              )
            ).rows
          : [];
        const targets = ids.length
          ? (
              await tx.query<TargetRow>(
                `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.project_id = ANY($1::uuid[]) ORDER BY t.created_at`,
                [ids],
              )
            ).rows
          : [];
        const org = (
          await tx.query<{ monthly_budget_cents: number | null }>(
            'SELECT monthly_budget_cents FROM organizations WHERE id = $1',
            [p.organizationId],
          )
        ).rows[0];
        const reserved = (
          await tx.query<{ reserved: string | null }>(
            `SELECT sum(reserved_budget_cents) AS reserved FROM localization_jobs WHERE organization_id = $1 AND created_at >= date_trunc('month', now())`,
            [p.organizationId],
          )
        ).rows[0];
        const assetByProject = new Map<string, AssetRow>();
        for (const a of assets)
          if (!assetByProject.has(a.project_id)) assetByProject.set(a.project_id, a);
        return {
          projects: projects.map((r) => {
            const ts = targets.filter((t) => t.project_id === r.id);
            const asset = assetByProject.get(r.id);
            return {
              ...projectView(r),
              asset: asset ? assetView(asset) : null,
              targets: ts.map(targetSummary),
              needsReviewCount: ts.filter((t) => t.state === 'NEEDS_REVIEW').length,
            };
          }),
          budget: {
            enabled: (org?.monthly_budget_cents ?? null) !== null,
            monthlyBudgetCents: org?.monthly_budget_cents ?? null,
            reservedCents: Number(reserved?.reserved ?? 0),
          },
        };
      },
    );
  }

  async detail(p: Principal, projectId: string): Promise<ProjectDetailResponse> {
    return this.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, (tx) =>
      this.detailIn(tx, projectId),
    );
  }

  async detailIn(tx: Queryable, projectId: string): Promise<ProjectDetailResponse> {
    const project = (
      await tx.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])
    ).rows[0];
    if (!project) throw new NotFoundError('Project', projectId);
    const asset = (
      await tx.query<AssetRow>(
        `SELECT * FROM assets WHERE project_id = $1 AND kind = 'source' ORDER BY created_at DESC LIMIT 1`,
        [projectId],
      )
    ).rows[0];
    const transcript = (
      await tx.query<TranscriptRow>(
        'SELECT id, asset_id, detected_locale, detection_confidence, confirmed_locale, provider, provider_version, has_video FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
        [projectId],
      )
    ).rows[0];
    const targets = (
      await tx.query<TargetRow>(
        `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.project_id = $1 ORDER BY t.created_at`,
        [projectId],
      )
    ).rows;
    let analysis: ProjectDetailResponse['analysis'] = null;
    if (transcript && asset?.metadata) {
      const speakers = (
        await tx.query<SpeakerRow>(
          'SELECT id, speaker_key, label, on_camera, voice_policy, sample_ranges FROM speakers WHERE project_id = $1 ORDER BY speaker_key',
          [projectId],
        )
      ).rows;
      const count = (
        await tx.query<{ n: string }>(
          'SELECT count(*) AS n FROM segments WHERE transcript_id = $1',
          [transcript.id],
        )
      ).rows[0];
      analysis = {
        transcriptId: transcript.id,
        detectedLocale: transcript.detected_locale,
        detectionConfidence: transcript.detection_confidence,
        confirmedLocale: transcript.confirmed_locale,
        provider: transcript.provider,
        providerVersion: transcript.provider_version,
        durationUs: asset.metadata.durationUs,
        hasVideo: transcript.has_video,
        speakers: speakers.map(speakerView),
        segmentCount: Number(count?.n ?? 0),
      };
    }
    return {
      project: projectView(project),
      asset: asset ? assetView(asset) : null,
      analysis,
      targets: targets.map(targetSummary),
    };
  }

  async confirmLocale(
    p: Principal,
    projectId: string,
    sourceLocale: string,
    correlationId: string,
    ip: string,
  ): Promise<ProjectDetailResponse> {
    if (!registry.get(sourceLocale)) throw new NotFoundError('Locale', sourceLocale);
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const project = (
          await tx.query<ProjectRow>('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId])
        ).rows[0];
        if (!project) throw new NotFoundError('Project', projectId);
        await tx.query('UPDATE projects SET source_locale = $2 WHERE id = $1', [
          projectId,
          sourceLocale,
        ]);
        await tx.query(
          'UPDATE source_transcripts SET confirmed_locale = $2 WHERE project_id = $1',
          [projectId, sourceLocale],
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'project.locale_confirmed',
          objectType: 'Project',
          objectId: projectId,
          before: { sourceLocale: project.source_locale },
          after: { sourceLocale },
          correlationId,
          ipAddress: ip,
        });
        return this.detailIn(tx, projectId);
      },
    );
  }

  async segments(
    p: Principal,
    projectId: string,
    correlationId: string,
    ip: string,
  ): Promise<SegmentsResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const project = (
          await tx.query<{ id: string }>('SELECT id FROM projects WHERE id = $1', [projectId])
        ).rows[0];
        if (!project) throw new NotFoundError('Project', projectId);
        const transcript = (
          await tx.query<{ id: string }>(
            'SELECT id FROM source_transcripts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
            [projectId],
          )
        ).rows[0];
        if (!transcript) throw new NotFoundError('Transcript', projectId);
        const rows = (
          await tx.query<SegmentRow>(
            'SELECT * FROM segments WHERE transcript_id = $1 ORDER BY seq',
            [transcript.id],
          )
        ).rows;
        // Reading a transcript is an access to customer content (FR-061).
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'transcript.read',
          objectType: 'SourceTranscript',
          objectId: transcript.id,
          correlationId,
          ipAddress: ip,
        });
        return { transcriptId: transcript.id, segments: rows.map(segmentView) };
      },
    );
  }
}
