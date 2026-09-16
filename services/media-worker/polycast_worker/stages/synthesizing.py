"""SYNTHESIZING: MockSpeechProvider measures a duration per translation; no audio is produced."""

from __future__ import annotations

from ..models import SpeechRender, SynthesizingOutput, WorkerTask
from ..providers.mock import MOCK_PROVIDER_VERSION, MockSpeechProvider
from ..storage import Storage
from ..tools import Tools
from .common import provider_context


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    ctx = provider_context(task)
    provider = MockSpeechProvider()
    voice_id = f"mock-{params.targetLocale}-1"
    renders: list[SpeechRender] = []
    for t in params.translations:
        measured = provider.synthesize(t.adaptedText, voice_id, t.timingBudgetUs, ctx)
        duration = measured.get("durationUs")
        renders.append(
            SpeechRender(
                segmentId=t.segmentId,
                translationVersionId=t.translationVersionId,
                voiceId=voice_id,
                measuredDurationUs=int(duration) if isinstance(duration, int) else 0,
                audio=None,
            )
        )
    return SynthesizingOutput(
        provider="mock-speech", providerVersion=MOCK_PROVIDER_VERSION, renders=renders
    ).model_dump()
