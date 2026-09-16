"""Mock adapters for local development and tests.

They are named Mock on purpose and register with tier "unavailable" so the capability
registry can never present them as Production. They do no real transcription, translation,
speech, lip sync or quality inference; their outputs are deterministic fixtures that let
the M1 review flow (flag → regenerate → approve → package) be exercised end to end.
"""

from __future__ import annotations

from typing import Literal

from .base import AsyncHandle, CapabilityRecord, ProviderContext

_MOCK = "mock"
MOCK_PROVIDER_VERSION = "0"
MOCK_PROMPT_VERSION = "mock-v1"


Kind = Literal["transcription", "translation", "speech", "lipSync", "encode", "quality"]


def _cap(kind: Kind) -> CapabilityRecord:
    return CapabilityRecord(
        adapterId=f"{_MOCK}-{kind}",
        kind=kind,
        locale=None,
        region="local",
        tier="unavailable",
        version=MOCK_PROVIDER_VERSION,
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


class MockTranslationProvider:
    """Pseudo-translation: tags the source text with the target locale and generation."""

    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("translation")]

    def prompt_version(self) -> str:
        return MOCK_PROMPT_VERSION

    def translate(
        self,
        segments: list[dict[str, object]],
        target_locale: str,
        ctx: ProviderContext,
        hint: str | None = None,
        source_locale: str | None = None,
    ) -> list[dict[str, object]]:
        shorter = bool(hint) and "shorter" in str(hint).lower()
        out: list[dict[str, object]] = []
        for seg in segments:
            text = str(seg.get("text", ""))
            generation = seg.get("generation")
            words = text.split()
            if shorter and len(words) > 1:
                words = words[:-1]
            body = " ".join(words)
            tag = (
                f"[{target_locale}]"
                if not isinstance(generation, int) or generation < 1
                else f"[{target_locale} v{generation + 1}]"
            )
            out.append(
                {
                    "segmentId": seg.get("segmentId"),
                    "adaptedText": f"{tag} {body}".rstrip(),
                    "literalText": None,
                    "confidence": 0.8,
                    "mock": True,
                }
            )
        return out


class MockSpeechProvider:
    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("speech")]

    def default_voice(self, locale: str) -> str | None:
        return f"mock-{locale}-1"

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


class MockLipSyncProvider:
    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("lipSync")]

    def render(self, shot: dict[str, object], ctx: ProviderContext) -> AsyncHandle:
        return AsyncHandle(adapterId=f"{_MOCK}-lipSync", externalId=ctx.idempotencyKey)

    def evaluate(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        return {"status": "COMPLETED", "applied": False, "syncConfidence": 0.0, "mock": True}


class MockQualityProvider:
    """Fixture QC. `entity-preservation` fails exactly when the inspected translation is the
    first generation, so the review flow always has one issue to regenerate away."""

    ENTITY_RECOMMENDATION = (
        "Named entities may have been altered; regenerate the translation or accept."
    )

    def capabilities(self) -> list[CapabilityRecord]:
        return [_cap("quality")]

    def check(
        self, metric: str, inputs: dict[str, object], ctx: ProviderContext
    ) -> dict[str, object]:
        if metric == "entity-preservation":
            generation = inputs.get("generation")
            passed = not (isinstance(generation, int) and generation == 1)
            return {"metric": metric, "threshold": None, "value": None, "passed": passed}
        if metric == "loudness-integrated":
            value = inputs.get("value")
            v = float(value) if isinstance(value, int | float) else -16.0
            passed = abs(v + 16.0) <= 2.0
            return {"metric": metric, "threshold": -16.0, "value": v, "passed": passed}
        if metric == "true-peak":
            value = inputs.get("value")
            v = float(value) if isinstance(value, int | float) else -1.0
            return {"metric": metric, "threshold": -1.0, "value": v, "passed": v <= -1.0 + 0.5}
        return {"metric": metric, "threshold": None, "value": None, "passed": True}
