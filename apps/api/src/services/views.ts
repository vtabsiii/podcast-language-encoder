import { weightedProgress, type JobState } from '@polycast/domain';
import type {
  AssetSummary,
  Deliverable,
  LocalizationJobView,
  Project,
  QcIssue,
  Segment,
  Speaker,
  TargetJobView,
  TargetSummary,
  TranslationVersionSchema,
} from '@polycast/contracts';
import type { z } from 'zod';

/** Row shapes as returned by pg (snake_case) and their contract views (camelCase). */
export interface ProjectRow {
  id: string;
  organization_id: string;
  title: string;
  state: Project['state'];
  source_asset_id: string | null;
  source_locale: string | null;
  owner_user_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface AssetRow {
  id: string;
  organization_id: string;
  project_id: string;
  kind: string;
  status: JobState;
  storage_uri: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  sha256: string | null;
  metadata: AssetSummary['metadata'];
  rejection: { code: string; message: string } | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface TargetRow {
  id: string;
  organization_id: string;
  job_id: string;
  project_id: string;
  locale: string;
  state: JobState;
  approval_state: TargetJobView['approvalState'];
  lip_sync: boolean;
  attempt: number;
  progress: number;
  last_error: string | null;
  scope_segment_ids: string[] | null;
  package_version: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  open_issues?: number | string;
}

export interface JobRow {
  id: string;
  organization_id: string;
  project_id: string;
  idempotency_key: string;
  snapshot: {
    sourceLocale: string;
    targetLocales: string[];
    sourceAssetId: string;
    lipSync: Record<string, boolean>;
  };
  state: JobState;
  estimated_low_cents: number;
  estimated_high_cents: number;
  reserved_budget_cents: number;
  rate_card_version: string;
  started_at: Date | null;
  completed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SegmentRow {
  id: string;
  transcript_id: string;
  speaker_id: string;
  seq: number;
  start_us: number;
  end_us: number;
  text: string;
  language: string;
  confidence: number;
  words: Segment['words'];
  version: number;
}

export interface SpeakerRow {
  id: string;
  speaker_key: string;
  label: string;
  on_camera: boolean;
  voice_policy: Speaker['voicePolicy'];
  sample_ranges: Speaker['sampleRanges'];
}

export interface TranslationRow {
  id: string;
  segment_id: string;
  source_segment_version: number;
  adapted_text: string;
  literal_text: string | null;
  timing_budget_us: number;
  provider: string;
  provider_version: string;
  prompt_version: string | null;
  confidence: number;
  edited_by_user_id: string | null;
  supersedes_id: string | null;
  generation: number;
  is_current: boolean;
  created_at: Date;
}

export interface IssueRow {
  id: string;
  qc_check_id: string;
  segment_id: string | null;
  metric: string;
  severity: QcIssue['severity'];
  start_us: number | null;
  end_us: number | null;
  recommendation: string;
  resolution: QcIssue['resolution'];
  created_at: Date;
  updated_at: Date;
}

export interface DeliverableRow {
  id: string;
  kind: Deliverable['kind'];
  file_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  package_version: number;
  storage_uri: string;
  created_at: Date;
}

const iso = (d: Date): string => d.toISOString();

export const projectView = (r: ProjectRow): Project => ({
  id: r.id,
  title: r.title,
  state: r.state,
  sourceLocale: r.source_locale,
  sourceAssetId: r.source_asset_id,
  ownerUserId: r.owner_user_id,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const assetView = (r: AssetRow): AssetSummary => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  fileName: r.file_name,
  contentType: r.content_type,
  byteSize: Number(r.byte_size),
  sha256: r.sha256,
  metadata: r.metadata,
  rejection: r.rejection,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const targetProgress = (r: Pick<TargetRow, 'state' | 'lip_sync'>): number =>
  r.state === 'RETRY_WAIT' || r.state === 'CANCEL_REQUESTED'
    ? 0
    : weightedProgress(r.state, { audioOnly: !r.lip_sync });

export const targetView = (r: TargetRow): TargetJobView => ({
  id: r.id,
  jobId: r.job_id,
  projectId: r.project_id,
  locale: r.locale,
  state: r.state,
  approvalState: r.approval_state,
  lipSync: r.lip_sync,
  attempt: r.attempt,
  progress: targetProgress(r),
  lastError: r.last_error,
  openIssues: Number(r.open_issues ?? 0),
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const targetSummary = (r: TargetRow): TargetSummary => ({
  targetJobId: r.id,
  jobId: r.job_id,
  locale: r.locale,
  state: r.state,
  approvalState: r.approval_state,
  progress: targetProgress(r),
  openIssues: Number(r.open_issues ?? 0),
});

/** The parent job's visible state is derived from its targets once fan-out has happened. */
export function deriveJobState(
  stored: JobState,
  targets: readonly Pick<TargetRow, 'state'>[],
): JobState {
  if (stored !== 'TARGETS_FAN_OUT' || targets.length === 0) return stored;
  const states = targets.map((t) => t.state);
  if (states.every((s) => s === 'COMPLETE')) return 'COMPLETE';
  if (states.every((s) => s === 'CANCELLED' || s === 'COMPLETE' || s === 'FAILED')) {
    return states.some((s) => s === 'FAILED') ? 'FAILED' : 'CANCELLED';
  }
  return stored;
}

export const jobView = (
  r: JobRow,
  targets: readonly Pick<TargetRow, 'state'>[],
): LocalizationJobView => ({
  id: r.id,
  projectId: r.project_id,
  state: deriveJobState(r.state, targets),
  sourceLocale: r.snapshot.sourceLocale,
  targetLocales: r.snapshot.targetLocales,
  estimatedCostCents: { low: r.estimated_low_cents, high: r.estimated_high_cents },
  reservedBudgetCents: r.reserved_budget_cents,
  rateCardVersion: r.rate_card_version,
  startedAt: r.started_at ? iso(r.started_at) : null,
  completedAt: r.completed_at ? iso(r.completed_at) : null,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const segmentView = (r: SegmentRow): Segment => ({
  id: r.id,
  seq: r.seq,
  speakerId: r.speaker_id,
  range: { start: Number(r.start_us), end: Number(r.end_us) },
  text: r.text,
  language: r.language,
  confidence: r.confidence,
  words: r.words,
  version: r.version,
});

export const speakerView = (r: SpeakerRow): Speaker => ({
  id: r.id,
  label: r.label,
  onCamera: r.on_camera,
  voicePolicy: r.voice_policy,
  sampleRanges: r.sample_ranges,
});

export const translationView = (r: TranslationRow): z.infer<typeof TranslationVersionSchema> => ({
  id: r.id,
  segmentId: r.segment_id,
  adaptedText: r.adapted_text,
  literalText: r.literal_text,
  timingBudgetUs: Number(r.timing_budget_us),
  provider: r.provider,
  providerVersion: r.provider_version,
  promptVersion: r.prompt_version,
  confidence: r.confidence,
  editedByUserId: r.edited_by_user_id,
  supersedesId: r.supersedes_id,
  generation: r.generation,
  createdAt: iso(r.created_at),
});

export const issueView = (r: IssueRow): QcIssue => ({
  id: r.id,
  qcCheckId: r.qc_check_id,
  segmentId: r.segment_id,
  metric: r.metric,
  severity: r.severity,
  range:
    r.start_us !== null && r.end_us !== null
      ? { start: Number(r.start_us), end: Number(r.end_us) }
      : null,
  recommendation: r.recommendation,
  resolution: r.resolution,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const deliverableView = (r: DeliverableRow): Deliverable => ({
  id: r.id,
  kind: r.kind,
  fileName: r.file_name,
  contentType: r.content_type,
  byteSize: Number(r.byte_size),
  sha256: r.sha256,
  packageVersion: r.package_version,
  createdAt: iso(r.created_at),
});

/** Subquery fragment counting open issues per target; use with `t` as the target_jobs alias. */
export const OPEN_ISSUES_SQL = `(SELECT count(*) FROM qc_issues q WHERE q.target_job_id = t.id AND q.resolution = 'open') AS open_issues`;
