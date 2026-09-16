"""Mock adapters for local development and tests.

They are named Mock on purpose and register with tier "unavailable" so the capability
registry can never present them as Production. They do no real transcription, translation,
speech, or lip sync.
"""

from __future__ import annotations

from typing import Literal

from .base import AsyncHandle, CapabilityRecord, ProviderContext

_MOCK = "mock"


Kind = Literal["transcription", "translation", "speech", "lipSync", "encode", "quality"]


def _cap(kind: Kind) -> CapabilityRecord:
    return CapabilityRecord(
        adapterId=f"{_MOCK}-{kind}",
        kind=kind,
        locale=None,
        region="local",
        tier="unavailable",
        version="0",
        dataPolicy="no-training",
        priceUnit="second",
    )


class MockTranscriptionProvider:
    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("transcription")]

    def transcribe(
        self, input_s3_uri: str, locale_hint: str | None, ctx: ProviderContext
    ) -> AsyncHandle:
        return AsyncHandle(adapterId=f"{_MOCK}-transcription", externalId=ctx.idempotencyKey)

    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        return {"status": "COMPLETED", "fixture": True, "segments": []}


class MockSpeechProvider:
    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("speech")]

    def list_voices(self, locale: str) -> list[dict[str, object]]:
        return [
            {
                "voiceId": f"mock-{locale}-1",
                "displayName": "Mock voice (not for production)",
                "locale": locale,
            }
        ]

    def synthesize(
        self, text: str, voice_id: str, target_duration_us: int | None, ctx: ProviderContext
    ) -> dict[str, object]:
        # Approximates 150 words/min so timing logic can be exercised without audio.
        words = max(1, len(text.split()))
        return {"durationUs": int(words * 400_000), "assetRef": None, "mock": True}
