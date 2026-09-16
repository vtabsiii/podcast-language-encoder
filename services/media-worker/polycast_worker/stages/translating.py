"""TRANSLATING: the registry's TranslationProvider over the segments in scope (FR-010).

After translation the entity check (FR-011) runs once here so the stage log carries a count
(ids only); TARGET_QA re-runs the same check on the persisted translations, which is where
violations become issues (the output schema has no room for them).
"""

from __future__ import annotations

import logging

from ..models import TranslatingOutput, Translation, WorkerTask
from ..qc.entity_check import check_translations
from ..storage import Storage
from ..tools import Tools
from .common import (
    StageEnv,
    capability_for,
    provider_context,
    resolve_env,
    segments_by_seq,
    translations_by_segment,
)

log = logging.getLogger("polycast_worker.stages.translating")

TRANSLATION_CONFIDENCE = 0.8


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    segments = segments_by_seq(params)
    current = translations_by_segment(params)
    speakers = {s.id: s.label for s in params.speakers}
    inputs: list[dict[str, object]] = [
        {
            "segmentId": s.id,
            "text": s.text,
            "generation": current[s.id].generation if s.id in current else None,
            "timingBudgetUs": s.range.duration_us,
            "speaker": speakers.get(s.speakerId, s.speakerId),
        }
        for s in segments
    ]
    provider = env.providers.translation
    ctx = provider_context(task, env.providers.region)
    results = provider.translate(
        inputs, params.targetLocale, ctx, params.hint, source_locale=params.sourceLocale
    )
    translations: list[Translation] = []
    for seg, res in zip(segments, results, strict=True):
        conf = res.get("confidence")
        literal = res.get("literalText")
        translations.append(
            Translation(
                segmentId=seg.id,
                adaptedText=str(res["adaptedText"]),
                literalText=str(literal) if isinstance(literal, str) else None,
                confidence=float(conf) if isinstance(conf, int | float) else TRANSLATION_CONFIDENCE,
                timingBudgetUs=seg.range.duration_us,
            )
        )
    violations = check_translations(
        [(s.id, s.text) for s in segments], {t.segmentId: t.adaptedText for t in translations}
    )
    if violations:
        log.info(
            "task %s translated %d segments, %d entity mismatches",
            task.taskId,
            len(translations),
            len(violations),
        )

    record = capability_for(provider.capabilities(), params.targetLocale)
    prompt_version = getattr(provider, "prompt_version", None)
    return TranslatingOutput(
        provider=record.adapterId,
        providerVersion=record.version,
        promptVersion=str(prompt_version()) if callable(prompt_version) else None,
        translations=translations,
    ).model_dump()
