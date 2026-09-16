from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NamedTuple, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

CapabilityTier = Literal["production", "beta", "unavailable"]

NotificationKind = Literal["review-required", "ready", "failed", "budget-threshold"]
NOTIFICATION_KINDS: tuple[NotificationKind, ...] = (
    "review-required",
    "ready",
    "failed",
    "budget-threshold",
)


class ProviderError(RuntimeError):
    """Typed failure raised by an adapter; the runner reports it as a failed TaskResult.

    `retryable` is reserved for throttling / transient provider outages. Messages never carry
    customer content, keys, URLs or raw provider payloads (A-17).
    """

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class ProviderContext(BaseModel):
    """Passed to every provider call. `dataPolicy` is fixed: no customer data trains models.

    `derivedPrefix` is the task's derived-artefact prefix; adapters that must write provider
    output somewhere (Transcribe job output, MediaConvert destination) derive it from here.
    """

    model_config = ConfigDict(frozen=True)
    organizationId: str  # noqa: N815
    projectId: str  # noqa: N815
    jobId: str  # noqa: N815
    region: str
    idempotencyKey: str  # noqa: N815
    correlationId: str  # noqa: N815
    dataPolicy: Literal["no-training"] = "no-training"  # noqa: N815
    derivedPrefix: str | None = None  # noqa: N815


class CapabilityRecord(BaseModel):
    model_config = ConfigDict(frozen=True)
    adapterId: str  # noqa: N815
    kind: Literal["transcription", "translation", "speech", "lipSync", "encode", "quality"]
    locale: str | None
    region: str
    tier: CapabilityTier
    version: str
    dataPolicy: Literal["no-training"]  # noqa: N815
    priceUnit: Literal["second", "character", "frame", "gpu-second", "gb"]  # noqa: N815


class AsyncHandle(BaseModel):
    """Opaque reference to a long-running provider job."""

    model_config = ConfigDict(frozen=True)
    adapterId: str  # noqa: N815
    externalId: str  # noqa: N815


@runtime_checkable
class TranscriptionProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def transcribe(
        self, input_s3_uri: str, locale_hint: str | None, ctx: ProviderContext
    ) -> AsyncHandle: ...
    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None: ...


@runtime_checkable
class TranslationProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def translate(
        self,
        segments: list[dict[str, object]],
        target_locale: str,
        ctx: ProviderContext,
        hint: str | None = None,
        source_locale: str | None = None,
    ) -> list[dict[str, object]]: ...


@runtime_checkable
class SpeechProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def list_voices(self, locale: str) -> list[dict[str, object]]: ...
    def default_voice(self, locale: str) -> str | None: ...
    def synthesize(
        self, text: str, voice_id: str, target_duration_us: int | None, ctx: ProviderContext
    ) -> dict[str, object]: ...


@runtime_checkable
class LipSyncProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def render(self, shot: dict[str, object], ctx: ProviderContext) -> AsyncHandle: ...
    def evaluate(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None: ...


@runtime_checkable
class MediaEncodeProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def encode(
        self, input_s3_uri: str, preset: dict[str, object], ctx: ProviderContext
    ) -> AsyncHandle: ...
    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None: ...


@runtime_checkable
class QualityProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def check(
        self, metric: str, inputs: dict[str, object], ctx: ProviderContext
    ) -> dict[str, object]: ...


@runtime_checkable
class Notifier(Protocol):
    """FR-055. `subject_ref` is an id (target job, project, budget), never content."""

    def notify(
        self, kind: NotificationKind, recipient: str, subject_ref: str, ctx: ProviderContext
    ) -> dict[str, object]: ...


class TimingDecision(NamedTuple):
    """(strategy, timeStretchRatio, boundaryShiftUs, fits); tuple-compatible for tests."""

    strategy: Literal["none", "rate", "boundary-shift", "retranslate"]
    time_stretch_ratio: float
    boundary_shift_us: int
    fits: bool


@runtime_checkable
class TimingFitter(Protocol):
    """FR-022. `fit` is pure integer arithmetic; `stretch` applies the decision to a WAV."""

    def fit(self, measured_us: int, budget_us: int) -> TimingDecision: ...
    def stretch(self, wav_in: Path, wav_out: Path, ratio: float) -> int: ...


@dataclass(frozen=True)
class SpeechPlacement:
    segment_id: str
    wav: Path
    start_us: int
    end_us: int


@runtime_checkable
class Mixer(Protocol):
    """FR-023. Returns (integrated LUFS, true peak dBTP) of the written mix."""

    def mix(
        self, source: Path, placements: list[SpeechPlacement], out: Path, *, channels: int
    ) -> tuple[float, float]: ...
