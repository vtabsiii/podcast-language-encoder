"""Typed models mirroring packages/contracts (validated against its JSON Schema in tests).

Field names are camelCase on purpose: they are the wire format shared with the API
(`packages/contracts/src/worker.ts`, `provenance.ts`, `projects.ts`, `media.ts`).
Media time is integer microseconds. Never floats.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

Microseconds = int

STORAGE_URI_PATTERN = r"^(s3|local)://[a-z0-9.-]+/.+$"
LOCALE_TAG_PATTERN = r"^[a-z]{2}-[A-Z0-9]{2,3}$"
SHA256_PATTERN = r"^[0-9a-f]{64}$"

WORKER_STAGES = (
    "VALIDATING",
    "ANALYZING",
    "TRANSLATING",
    "SYNTHESIZING",
    "TIMING",
    "LIP_SYNCING",
    "MIXING",
    "ENCODING",
    "TARGET_QA",
    "PACKAGING",
)
Stage = Literal[
    "VALIDATING",
    "ANALYZING",
    "TRANSLATING",
    "SYNTHESIZING",
    "TIMING",
    "LIP_SYNCING",
    "MIXING",
    "ENCODING",
    "TARGET_QA",
    "PACKAGING",
]

CapabilityKind = Literal["transcription", "translation", "speech", "lipSync", "encode", "quality"]
CapabilityTier = Literal["production", "beta", "unavailable"]


class ContractModel(BaseModel):
    """Every contract object is immutable and rejects unknown keys (additionalProperties: false)."""

    model_config = ConfigDict(frozen=True, extra="forbid")


# ---------- media ----------


class Rational(ContractModel):
    num: int = Field(gt=0)
    den: int = Field(gt=0)


class VideoMetadata(ContractModel):
    codec: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frameRate: Rational
    variableFrameRate: bool
    colorPrimaries: str | None = None
    transferCharacteristics: str | None = None
    hdr: bool

    @model_serializer(mode="wrap")
    def _omit_unset_optionals(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        # The contract marks these as optional (absent), not nullable.
        data: dict[str, Any] = handler(self)
        for key in ("colorPrimaries", "transferCharacteristics"):
            if data.get(key) is None:
                data.pop(key, None)
        return data


class AudioMetadata(ContractModel):
    codec: str
    sampleRate: int = Field(gt=0)
    channels: int = Field(gt=0)
    channelLayout: str


class MediaMetadata(ContractModel):
    """Output of the probe step (contracts/schema/media-metadata.schema.json)."""

    container: str
    durationUs: Microseconds = Field(ge=0)
    video: VideoMetadata | None = None
    audio: AudioMetadata | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_streams(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        for key in ("video", "audio"):
            if data.get(key) is None:
                data.pop(key, None)
        return data

    def dump_contract(self) -> dict[str, Any]:
        return self.model_dump()


class TimeRange(ContractModel):
    start: Microseconds = Field(ge=0)
    end: Microseconds = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> TimeRange:
        if self.end < self.start:
            raise ValueError("end must be >= start")
        return self

    @property
    def duration_us(self) -> Microseconds:
        return self.end - self.start


# ---------- project entities used by tasks ----------

VoicePolicy = Literal["matched-synthetic", "verified-replica", "stock", "keep-original"]


class Speaker(ContractModel):
    id: str
    label: str
    onCamera: bool
    voicePolicy: VoicePolicy
    sampleRanges: list[TimeRange]


class Word(ContractModel):
    text: str
    range: TimeRange
    confidence: float = Field(ge=0, le=1)


class Segment(ContractModel):
    id: str
    seq: int = Field(ge=0)
    speakerId: str
    range: TimeRange
    text: str
    language: str
    confidence: float = Field(ge=0, le=1)
    words: list[Word]
    version: int


# ---------- provenance / QC ----------


class ProvenanceModel(ContractModel):
    capability: CapabilityKind
    adapterId: str
    version: str
    tier: CapabilityTier
    dataPolicy: Literal["no-training"] = "no-training"


class ManifestFile(ContractModel):
    fileName: str
    sha256: str = Field(pattern=SHA256_PATTERN)
    byteSize: int


class ProvenanceManifest(ContractModel):
    schemaVersion: Literal[1] = 1
    generator: str
    generatedAt: str
    jobId: str
    targetJobId: str
    projectId: str
    sourceLocale: str = Field(pattern=LOCALE_TAG_PATTERN)
    targetLocale: str = Field(pattern=LOCALE_TAG_PATTERN)
    sourceSha256: str = Field(pattern=SHA256_PATTERN)
    syntheticVoice: bool
    lipSyncApplied: bool
    mock: bool
    models: list[ProvenanceModel]
    segmentCount: int = Field(ge=0)
    translationVersionIds: list[str]
    files: list[ManifestFile]
    disclosure: str


Severity = Literal["info", "warning", "critical"]


class QcReportCheck(ContractModel):
    metric: str
    threshold: float | None
    value: float | None
    passed: bool
    provider: str


class QcReportIssue(ContractModel):
    id: str
    segmentId: str | None
    metric: str
    severity: Severity
    recommendation: str
    resolution: Literal["open", "accepted", "regenerated", "dismissed"]


class QcReport(ContractModel):
    schemaVersion: Literal[1] = 1
    generatedAt: str
    targetJobId: str
    locale: str = Field(pattern=LOCALE_TAG_PATTERN)
    passed: bool
    checks: list[QcReportCheck]
    issues: list[QcReportIssue]
    summary: str


# ---------- task parameters ----------


class StorageLocations(ContractModel):
    source: str | None = Field(pattern=STORAGE_URI_PATTERN)
    derivedPrefix: str = Field(pattern=STORAGE_URI_PATTERN)
    deliverablesPrefix: str | None = Field(pattern=STORAGE_URI_PATTERN)


class TranslationInput(ContractModel):
    translationVersionId: str
    segmentId: str
    adaptedText: str
    timingBudgetUs: Microseconds = Field(ge=0)
    generation: int = Field(gt=0)


class SpeechInput(ContractModel):
    renderId: str
    translationVersionId: str
    segmentId: str
    measuredDurationUs: Microseconds = Field(ge=0)
    timeStretchRatio: float = Field(gt=0)
    voiceId: str


class ValidatingParams(ContractModel):
    assetId: str
    projectId: str
    quarantine: str = Field(pattern=STORAGE_URI_PATTERN)
    declaredContentType: str
    declaredByteSize: int = Field(gt=0)
    maxDurationUs: Microseconds = Field(ge=0)


class AnalyzingParams(ContractModel):
    assetId: str
    projectId: str
    metadata: MediaMetadata
    declaredLocale: str | None = Field(pattern=LOCALE_TAG_PATTERN)


class ProvenanceInput(ContractModel):
    translationVersionIds: list[str]
    qcReport: QcReport | None


class TargetParams(ContractModel):
    targetJobId: str
    projectId: str
    jobId: str
    sourceLocale: str = Field(pattern=LOCALE_TAG_PATTERN)
    targetLocale: str = Field(pattern=LOCALE_TAG_PATTERN)
    direction: Literal["ltr", "rtl"]
    lipSync: bool
    metadata: MediaMetadata
    sourceSha256: str = Field(pattern=SHA256_PATTERN)
    speakers: list[Speaker]
    segments: list[Segment]
    translations: list[TranslationInput]
    speech: list[SpeechInput]
    hint: str | None
    packageVersion: int | None = Field(gt=0)
    provenance: ProvenanceInput | None


TaskParams = ValidatingParams | AnalyzingParams | TargetParams


class WorkerTask(ContractModel):
    """Claimed task from the control plane. References only, never media bytes."""

    taskId: str
    organizationId: str
    jobId: str | None
    targetJobId: str | None
    assetId: str | None
    stage: Stage
    attempt: int = Field(gt=0)
    idempotencyKey: str = Field(min_length=8)
    correlationId: str
    storage: StorageLocations
    parameters: TaskParams
    taskToken: str | None
    leaseSeconds: int = Field(gt=0)

    def validating_params(self) -> ValidatingParams:
        if not isinstance(self.parameters, ValidatingParams):
            raise ValueError(f"stage {self.stage} expects validating parameters")
        return self.parameters

    def analyzing_params(self) -> AnalyzingParams:
        if not isinstance(self.parameters, AnalyzingParams):
            raise ValueError(f"stage {self.stage} expects analyzing parameters")
        return self.parameters

    def target_params(self) -> TargetParams:
        if not isinstance(self.parameters, TargetParams):
            raise ValueError(f"stage {self.stage} expects target parameters")
        return self.parameters


class ClaimTaskRequest(ContractModel):
    workerId: str = Field(min_length=1, max_length=120)
    stages: list[Stage] | None = None

    @model_serializer(mode="wrap")
    def _omit_absent_stages(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if data.get("stages") is None:
            data.pop("stages", None)
        return data


# ---------- stage outputs ----------


class ValidatingOutput(ContractModel):
    metadata: MediaMetadata
    sha256: str = Field(pattern=SHA256_PATTERN)
    byteSize: int = Field(gt=0)
    source: str = Field(pattern=STORAGE_URI_PATTERN)


class AnalyzedSpeaker(ContractModel):
    key: str
    label: str
    onCamera: bool
    voicePolicy: VoicePolicy
    sampleRanges: list[TimeRange]


class AnalyzedSegment(ContractModel):
    seq: int = Field(ge=0)
    speakerKey: str
    range: TimeRange
    text: str
    language: str
    confidence: float = Field(ge=0, le=1)
    words: list[Word]


class AnalyzingOutput(ContractModel):
    detectedLocale: str = Field(pattern=LOCALE_TAG_PATTERN)
    detectionConfidence: float = Field(ge=0, le=1)
    provider: str
    providerVersion: str
    hasVideo: bool
    proxy: str = Field(pattern=STORAGE_URI_PATTERN)
    waveform: str = Field(pattern=STORAGE_URI_PATTERN)
    speakers: list[AnalyzedSpeaker]
    segments: list[AnalyzedSegment]


class Translation(ContractModel):
    segmentId: str
    adaptedText: str
    literalText: str | None
    confidence: float = Field(ge=0, le=1)
    timingBudgetUs: Microseconds = Field(ge=0)


class TranslatingOutput(ContractModel):
    provider: str
    providerVersion: str
    promptVersion: str | None
    translations: list[Translation]


class SpeechRender(ContractModel):
    segmentId: str
    translationVersionId: str
    voiceId: str
    measuredDurationUs: Microseconds = Field(ge=0)
    audio: str | None = Field(pattern=STORAGE_URI_PATTERN)


class SynthesizingOutput(ContractModel):
    provider: str
    providerVersion: str
    renders: list[SpeechRender]


TimingStrategy = Literal["none", "rate", "boundary-shift", "retranslate"]


class TimingFit(ContractModel):
    segmentId: str
    strategy: TimingStrategy
    timeStretchRatio: float = Field(gt=0)
    boundaryShiftUs: int
    fits: bool


class TimingOutput(ContractModel):
    fits: list[TimingFit]


class LipSyncRender(ContractModel):
    segmentId: str
    syncConfidence: float = Field(ge=0, le=1)
    video: str | None = Field(pattern=STORAGE_URI_PATTERN)


class LipSyncOutput(ContractModel):
    provider: str
    providerVersion: str
    applied: bool
    renders: list[LipSyncRender]


class MixingOutput(ContractModel):
    mix: str = Field(pattern=STORAGE_URI_PATTERN)
    integratedLufs: float
    truePeakDbtp: float


class EncodingOutput(ContractModel):
    encode: str = Field(pattern=STORAGE_URI_PATTERN)
    container: str
    byteSize: int = Field(gt=0)


class QaCheck(ContractModel):
    metric: str
    threshold: float | None
    value: float | None
    passed: bool


class QaIssue(ContractModel):
    metric: str
    segmentId: str | None
    severity: Severity
    range: TimeRange | None
    recommendation: str


class TargetQaOutput(ContractModel):
    provider: str
    checks: list[QaCheck]
    issues: list[QaIssue]


DeliverableKind = Literal[
    "media",
    "captions-srt",
    "captions-vtt",
    "transcript-json",
    "qc-report",
    "provenance-manifest",
    "checksums",
]


class Deliverable(ContractModel):
    kind: DeliverableKind
    fileName: str
    contentType: str
    byteSize: int = Field(ge=0)
    sha256: str = Field(pattern=SHA256_PATTERN)
    uri: str = Field(pattern=STORAGE_URI_PATTERN)


class PackagingOutput(ContractModel):
    deliverables: list[Deliverable]
    manifest: ProvenanceManifest


StageOutput = (
    ValidatingOutput
    | AnalyzingOutput
    | TranslatingOutput
    | SynthesizingOutput
    | TimingOutput
    | LipSyncOutput
    | MixingOutput
    | EncodingOutput
    | TargetQaOutput
    | PackagingOutput
)

OUTPUT_MODELS: dict[str, type[ContractModel]] = {
    "VALIDATING": ValidatingOutput,
    "ANALYZING": AnalyzingOutput,
    "TRANSLATING": TranslatingOutput,
    "SYNTHESIZING": SynthesizingOutput,
    "TIMING": TimingOutput,
    "LIP_SYNCING": LipSyncOutput,
    "MIXING": MixingOutput,
    "ENCODING": EncodingOutput,
    "TARGET_QA": TargetQaOutput,
    "PACKAGING": PackagingOutput,
}


# ---------- result ----------


class TaskError(ContractModel):
    code: str
    message: str


class TaskResult(ContractModel):
    status: Literal["succeeded", "failed"]
    retryable: bool = False
    error: TaskError | None = None
    output: dict[str, Any] | None = None
    workerId: str = Field(min_length=1)
