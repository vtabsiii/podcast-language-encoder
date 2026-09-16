/**
 * Core entities (docs/architecture.md ER diagram). These are persistence-agnostic shapes;
 * the API and workers map them to PostgreSQL rows. Every mutable entity carries
 * `version` for optimistic concurrency. All timestamps are ISO-8601 UTC strings;
 * all media times are integer microseconds.
 */

import type { CapabilityTier } from './capabilities/registry.js';
import type { JobState } from './state-machine/job-state.js';
import type { Microseconds, TimeRange } from './time/media-time.js';
import type { Role } from './roles.js';

export type Id = string; // UUID v7
export type IsoTimestamp = string;

export interface Timestamps {
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface Versioned extends Timestamps {
  /** Optimistic concurrency version, incremented on every write. */
  readonly version: number;
}

/** Every tenant-scoped row carries organizationId; queries must always filter on it. */
export interface TenantScoped {
  readonly organizationId: Id;
}

export type OrganizationStatus = 'active' | 'suspended' | 'deleting';

export interface Organization extends Versioned {
  readonly id: Id;
  readonly name: string;
  readonly plan: string;
  /** AWS region used for storage and processing, e.g. "us-east-1". */
  readonly region: string;
  readonly retentionDays: number;
  readonly monthlyBudgetCents: number | null;
  readonly status: OrganizationStatus;
}

export interface User extends Timestamps {
  readonly id: Id;
  readonly email: string;
  readonly displayName: string;
  /** Identity provider subject (Cognito `sub`). */
  readonly identitySubject: string;
}

export interface Membership extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly userId: Id;
  readonly role: Role;
}

export type ProjectState = 'draft' | 'analyzing' | 'ready' | 'processing' | 'complete' | 'archived';

export interface Project extends Versioned, TenantScoped {
  readonly id: Id;
  readonly title: string;
  readonly sourceAssetId: Id | null;
  readonly sourceLocale: string | null;
  readonly glossaryVersionId: Id | null;
  readonly state: ProjectState;
  readonly ownerUserId: Id;
}

export type AssetKind =
  | 'source'
  | 'proxy'
  | 'thumbnail'
  | 'waveform'
  | 'audio-extract'
  | 'stem'
  | 'speech-render'
  | 'lipsync-render'
  | 'mix'
  | 'encode'
  | 'caption'
  | 'transcript'
  | 'qc-report'
  | 'manifest'
  | 'package';

export interface MediaMetadata {
  readonly container: string;
  readonly durationUs: Microseconds;
  readonly video?: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    /** Rational frame rate, e.g. { num: 30000, den: 1001 }. */
    readonly frameRate: { readonly num: number; readonly den: number };
    readonly variableFrameRate: boolean;
    readonly colorPrimaries?: string;
    readonly transferCharacteristics?: string;
    readonly hdr: boolean;
  };
  readonly audio?: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly channelLayout: string;
  };
}

export interface Asset extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly kind: AssetKind;
  /** Private S3 URI. Never returned to clients; download links are minted per request. */
  readonly s3Uri: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly metadata: MediaMetadata | null;
  readonly kmsKeyArn: string | null;
  /** Asset this one was derived from (null for source). */
  readonly derivedFromAssetId: Id | null;
  readonly retainUntil: IsoTimestamp | null;
}

export type VoicePolicy = 'matched-synthetic' | 'verified-replica' | 'stock' | 'keep-original';

export interface Speaker extends Versioned, TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly label: string;
  readonly onCamera: boolean;
  readonly sampleRanges: readonly TimeRange[];
  readonly voicePolicy: VoicePolicy;
  readonly consentRecordId: Id | null;
}

export type ConsentStatus = 'pending' | 'active' | 'expired' | 'revoked';

export interface ConsentRecord extends Versioned, TenantScoped {
  readonly id: Id;
  readonly subjectName: string;
  readonly subjectContact: string;
  readonly verifiedByUserId: Id;
  /** Free text describing the signer's authority to consent (self, guardian, agent). */
  readonly authority: string;
  readonly allowedPurposes: readonly string[];
  readonly allowedLocales: readonly string[];
  readonly allowedProjectIds: readonly Id[] | null; // null = whole organization
  readonly validFrom: IsoTimestamp;
  readonly validUntil: IsoTimestamp | null;
  readonly evidenceAssetId: Id;
  readonly status: ConsentStatus;
  readonly revokedAt: IsoTimestamp | null;
  readonly revocationReason: string | null;
}

export interface Word {
  readonly text: string;
  readonly range: TimeRange;
  readonly confidence: number;
}

export interface Segment extends Versioned, TenantScoped {
  readonly id: Id;
  readonly transcriptId: Id;
  readonly speakerId: Id;
  readonly range: TimeRange;
  readonly text: string;
  readonly language: string;
  readonly confidence: number;
  readonly words: readonly Word[];
}

export interface SourceTranscript extends Versioned, TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly sourceLocale: string;
  readonly provider: string;
  readonly providerVersion: string;
}

export interface OutputPreset {
  readonly name:
    | 'source-match'
    | 'youtube-4k'
    | 'youtube-1080p'
    | 'social-1080p'
    | 'audio-podcast'
    | 'archive-master'
    | 'custom';
  readonly container: string;
  readonly captions: 'sidecar' | 'embedded' | 'burn-in' | 'none';
  readonly loudnessLufs: number;
  readonly truePeakDbtp: number;
}

/** Immutable configuration captured when a job starts. Later project edits never affect it. */
export interface JobSnapshot {
  readonly sourceAssetId: Id;
  readonly sourceLocale: string;
  readonly targetLocales: readonly string[];
  readonly speakers: readonly Pick<Speaker, 'id' | 'voicePolicy' | 'consentRecordId'>[];
  readonly presets: readonly OutputPreset[];
  readonly glossaryVersionId: Id | null;
  readonly rateCardVersion: string;
  readonly capabilitySnapshot: Readonly<Record<string, Readonly<Record<string, CapabilityTier>>>>;
}

export interface LocalizationJob extends Versioned, TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly idempotencyKey: string;
  readonly snapshot: JobSnapshot;
  readonly state: JobState;
  readonly estimatedCostCents: { readonly low: number; readonly high: number };
  readonly reservedBudgetCents: number;
  readonly actualCostCents: number;
  readonly startedAt: IsoTimestamp | null;
  readonly completedAt: IsoTimestamp | null;
}

export type ApprovalState = 'not-required' | 'pending' | 'approved' | 'rejected';

export interface TargetJob extends Versioned, TenantScoped {
  readonly id: Id;
  readonly jobId: Id;
  readonly locale: string;
  readonly state: JobState;
  readonly approvalState: ApprovalState;
  readonly providerRoutes: Readonly<Record<string, string>>; // capability → adapter id
  readonly attempt: number;
  readonly lastError: string | null;
}

export interface TranslationVersion extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly segmentId: Id;
  readonly sourceSegmentVersion: number;
  readonly literalText: string | null;
  readonly adaptedText: string;
  readonly timingBudgetUs: Microseconds;
  readonly provider: string;
  readonly providerVersion: string;
  readonly promptVersion: string | null;
  readonly confidence: number;
  readonly editedByUserId: Id | null;
  readonly supersedesId: Id | null;
}

export interface VoiceAssignment extends Versioned, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly speakerId: Id;
  readonly voiceId: string;
  readonly provider: string;
  readonly policy: VoicePolicy;
}

export interface Render extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly kind: 'speech' | 'lipsync' | 'mix' | 'encode';
  readonly provider: string;
  readonly providerVersion: string;
  /** Container image digest or model checkpoint hash. */
  readonly modelDigest: string | null;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly seed: number | null;
  readonly inputAssetIds: readonly Id[];
  readonly outputAssetId: Id | null;
  readonly range: TimeRange | null;
}

export interface SpeechRender extends Render {
  readonly kind: 'speech';
  readonly translationVersionId: Id;
  readonly measuredDurationUs: Microseconds;
  readonly timeStretchRatio: number;
}

export interface Shot extends TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly range: TimeRange;
}

export interface FaceTrack extends TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly shotId: Id;
  readonly speakerId: Id | null;
  readonly range: TimeRange;
  readonly meanFaceHeightPx: number;
  readonly meanYawDeg: number;
  readonly occlusionRatio: number;
  readonly confidence: number;
}

export interface VisibleSpeechSegment extends TenantScoped {
  readonly id: Id;
  readonly projectId: Id;
  readonly faceTrackId: Id;
  readonly segmentId: Id;
  readonly range: TimeRange;
  readonly flags: readonly (
    'profile' | 'occluded' | 'tiny-face' | 'multi-speaker' | 'rapid-motion' | 'off-screen'
  )[];
}

export type QcSeverity = 'info' | 'warning' | 'critical';

export interface QCCheck extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly metric: string;
  readonly threshold: number | null;
  readonly value: number | null;
  readonly passed: boolean;
  readonly provider: string;
}

export interface QCIssue extends Versioned, TenantScoped {
  readonly id: Id;
  readonly qcCheckId: Id;
  readonly severity: QcSeverity;
  readonly range: TimeRange | null;
  readonly evidenceAssetId: Id | null;
  readonly recommendation: string;
  readonly resolution: 'open' | 'accepted' | 'regenerated' | 'dismissed';
}

export interface Review extends Versioned, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly reviewerUserId: Id;
  readonly scope: 'segment' | 'target';
  readonly segmentId: Id | null;
}

export interface Comment extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly reviewId: Id;
  readonly authorUserId: Id;
  readonly body: string;
  readonly range: TimeRange | null;
}

export interface Approval extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly reviewId: Id;
  readonly actorUserId: Id;
  readonly decision: 'approved' | 'rejected';
  readonly artifactVersion: number;
}

export interface Deliverable extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly targetJobId: Id;
  readonly preset: OutputPreset['name'];
  readonly assetId: Id;
  readonly manifestAssetId: Id;
  readonly sha256: string;
  readonly ready: boolean;
}

export interface UsageEvent extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly jobId: Id;
  readonly targetJobId: Id | null;
  readonly stage: JobState;
  readonly provider: string;
  readonly unit: 'second' | 'character' | 'frame' | 'gpu-second' | 'gb';
  readonly quantity: number;
  /** Idempotency key so platform retries never double-bill. */
  readonly idempotencyKey: string;
}

export interface CostLedgerEntry extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly usageEventId: Id;
  readonly rateCardVersion: string;
  readonly amountCents: number;
  readonly currency: 'USD';
}

export interface AuditEvent extends TenantScoped {
  readonly id: Id;
  readonly occurredAt: IsoTimestamp;
  readonly actorUserId: Id | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: Id;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly correlationId: string;
  readonly ipAddress: string | null;
}

export interface ProviderCapability {
  readonly adapterId: string;
  readonly kind: 'transcription' | 'translation' | 'speech' | 'lipSync' | 'encode' | 'quality';
  readonly locale: string | null;
  readonly region: string;
  readonly tier: CapabilityTier;
  readonly version: string;
  readonly dataPolicy: 'no-training';
  readonly priceUnit: UsageEvent['unit'];
}

export interface GlossaryVersion extends Timestamps, TenantScoped {
  readonly id: Id;
  readonly glossaryId: Id;
  readonly version: number;
  readonly entries: readonly {
    readonly term: string;
    readonly translations: Readonly<Record<string, string>>;
    readonly doNotTranslate: boolean;
  }[];
}
