from __future__ import annotations

from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

CapabilityTier = Literal["production", "beta", "unavailable"]


class ProviderContext(BaseModel):
    """Passed to every provider call. `dataPolicy` is fixed: no customer data trains models."""

    model_config = ConfigDict(frozen=True)
    organizationId: str  # noqa: N815
    projectId: str  # noqa: N815
    jobId: str  # noqa: N815
    region: str
    idempotencyKey: str  # noqa: N815
    correlationId: str  # noqa: N815
    dataPolicy: Literal["no-training"] = "no-training"  # noqa: N815


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
        self, segments: list[dict[str, object]], target_locale: str, ctx: ProviderContext
    ) -> list[dict[str, object]]: ...


@runtime_checkable
class SpeechProvider(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...
    def list_voices(self, locale: str) -> list[dict[str, object]]: ...
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
