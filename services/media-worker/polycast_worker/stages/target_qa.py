"""TARGET_QA: MockQualityProvider. Flags exactly one issue on a first-generation translation
of the lowest-seq segment in scope; none once that segment has been regenerated."""

from __future__ import annotations

from ..audio import measure_loudness
from ..models import QaCheck, QaIssue, TargetQaOutput, WorkerTask
from ..providers.mock import MockQualityProvider
from ..storage import Storage
from ..tools import Tools
from .common import (
    find_artifact,
    provider_context,
    segments_by_seq,
    translations_by_segment,
    workdir,
)
from .mixing import FIXTURE_LUFS, FIXTURE_TRUE_PEAK, MIX_FILE

CHECK_METRICS: tuple[str, ...] = (
    "dialogue-coverage",
    "loudness-integrated",
    "true-peak",
    "caption-timing",
    "entity-preservation",
)


def _num(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _mix_measurement(task: WorkerTask, storage: Storage, tools: Tools) -> tuple[float, float]:
    mix_uri = find_artifact(task, storage, "MIXING", MIX_FILE)
    if tools.has_ffmpeg and mix_uri is not None:
        with workdir() as wd:
            local = wd / MIX_FILE
            storage.download(mix_uri, local)
            measured = measure_loudness(tools, local)
        if measured is not None:
            return measured
    return FIXTURE_LUFS, FIXTURE_TRUE_PEAK


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    ctx = provider_context(task)
    provider = MockQualityProvider()
    segments = segments_by_seq(params)
    current = translations_by_segment(params)
    first = segments[0] if segments else None
    generation = current[first.id].generation if first and first.id in current else None
    lufs, peak = _mix_measurement(task, storage, tools)

    checks: list[QaCheck] = []
    issues: list[QaIssue] = []
    for metric in CHECK_METRICS:
        inputs: dict[str, object] = {}
        if metric == "entity-preservation":
            inputs = {"generation": generation}
        elif metric == "loudness-integrated":
            inputs = {"value": lufs}
        elif metric == "true-peak":
            inputs = {"value": peak}
        result = provider.check(metric, inputs, ctx)
        passed = bool(result.get("passed"))
        checks.append(
            QaCheck(
                metric=metric,
                threshold=_num(result.get("threshold")),
                value=_num(result.get("value")),
                passed=passed,
            )
        )
        if metric == "entity-preservation" and not passed and first is not None:
            issues.append(
                QaIssue(
                    metric=metric,
                    segmentId=first.id,
                    severity="warning",
                    range=first.range,
                    recommendation=MockQualityProvider.ENTITY_RECOMMENDATION,
                )
            )
    return TargetQaOutput(provider="mock-quality", checks=checks, issues=issues).model_dump()
