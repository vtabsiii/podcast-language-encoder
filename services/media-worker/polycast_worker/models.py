"""Typed models mirroring packages/contracts (validated against its JSON Schema in tests).

Media time is integer microseconds. Never floats.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Microseconds = int


class Rational(BaseModel):
    model_config = ConfigDict(frozen=True)
    num: int = Field(gt=0)
    den: int = Field(gt=0)


class VideoMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)
    codec: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frameRate: Rational  # noqa: N815 - matches the shared JSON contract
    variableFrameRate: bool  # noqa: N815
    colorPrimaries: str | None = None  # noqa: N815
    transferCharacteristics: str | None = None  # noqa: N815
    hdr: bool


class AudioMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)
    codec: str
    sampleRate: int = Field(gt=0)  # noqa: N815
    channels: int = Field(gt=0)
    channelLayout: str  # noqa: N815


class MediaMetadata(BaseModel):
    """Output of the probe step (contracts/schema/media-metadata.schema.json)."""

    model_config = ConfigDict(frozen=True)
    container: str
    durationUs: Microseconds = Field(ge=0)  # noqa: N815
    video: VideoMetadata | None = None
    audio: AudioMetadata | None = None

    def dump_contract(self) -> dict[str, object]:
        return self.model_dump(exclude_none=True)


class TimeRange(BaseModel):
    model_config = ConfigDict(frozen=True)
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


Stage = Literal["VALIDATING", "ANALYZING", "MIXING", "ENCODING", "TARGET_QA", "PACKAGING"]


class WorkerTask(BaseModel):
    """Queue message from the control plane. References only, never media bytes."""

    model_config = ConfigDict(frozen=True)
    taskId: str  # noqa: N815
    organizationId: str  # noqa: N815
    jobId: str  # noqa: N815
    targetJobId: str | None  # noqa: N815
    stage: Stage
    idempotencyKey: str = Field(min_length=8)  # noqa: N815
    correlationId: str  # noqa: N815
    inputAssetIds: list[str]  # noqa: N815
    parameters: dict[str, object]
    taskToken: str | None  # noqa: N815
