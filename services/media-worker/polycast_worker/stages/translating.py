"""TRANSLATING: MockTranslationProvider over the segments in scope."""

from __future__ import annotations

from ..models import TranslatingOutput, Translation, WorkerTask
from ..providers.mock import (
    MOCK_PROMPT_VERSION,
    MOCK_PROVIDER_VERSION,
    MockTranslationProvider,
)
from ..storage import Storage
from ..tools import Tools
from .common import provider_context, segments_by_seq, translations_by_segment

TRANSLATION_CONFIDENCE = 0.8


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    segments = segments_by_seq(params)
    current = translations_by_segment(params)
    inputs: list[dict[str, object]] = [
        {
            "segmentId": s.id,
            "text": s.text,
            "generation": current[s.id].generation if s.id in current else None,
        }
        for s in segments
    ]
    provider = MockTranslationProvider()
    results = provider.translate(inputs, params.targetLocale, provider_context(task), params.hint)
    translations = [
        Translation(
            segmentId=seg.id,
            adaptedText=str(res["adaptedText"]),
            literalText=None,
            confidence=TRANSLATION_CONFIDENCE,
            timingBudgetUs=seg.range.duration_us,
        )
        for seg, res in zip(segments, results, strict=True)
    ]
    return TranslatingOutput(
        provider="mock-translation",
        providerVersion=MOCK_PROVIDER_VERSION,
        promptVersion=MOCK_PROMPT_VERSION,
        translations=translations,
    ).model_dump()
