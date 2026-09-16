"""TARGET_QA: quality checks through the registry's QualityProvider (FR-040).

local mode  MockQualityProvider: flags exactly one `entity-preservation` issue while the
            lowest-seq segment's translation is generation 1 (the M1 review fixture)
aws mode    InHouseQualityProvider over the real artefacts: coverage, boundary drift,
            loudness, true peak, caption timing, entity preservation and (video only)
            frame preservation
"""

from __future__ import annotations

from dataclasses import dataclass

from ..audio import measure_loudness
from ..models import QaCheck, QaIssue, TargetQaOutput, TimeRange, WorkerTask
from ..providers.ffmpeg import wav_duration_us
from ..providers.mock import MockQualityProvider
from ..providers.quality import AWS_METRICS
from ..storage import Storage
from ..timing_fit import fitted_duration_us
from ..tools import Tools
from .common import (
    StageEnv,
    find_artifact,
    provider_context,
    resolve_env,
    segments_by_seq,
    speech_wav_name,
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


def _run_mock(task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv) -> dict[str, object]:
    params = task.target_params()
    ctx = provider_context(task, env.providers.region)
    provider = env.providers.quality
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


@dataclass(frozen=True)
class _SpeechRef:
    segment_id: str
    segment_start_us: int
    measured_us: int
    ratio: float


def _speech_placements(
    task: WorkerTask, storage: Storage, refs: list[_SpeechRef]
) -> list[dict[str, object]]:
    """Fitted speech range per segment: real WAV duration when TIMING wrote one, else the
    measured duration divided by the stored stretch ratio."""
    out: list[dict[str, object]] = []
    with workdir() as wd:
        for ref in refs:
            uri = find_artifact(
                task, storage, "TIMING", speech_wav_name(ref.segment_id, fitted=True)
            )
            if uri is not None:
                local = wd / f"{ref.segment_id}.wav"
                storage.download(uri, local)
                duration = wav_duration_us(local)
            else:
                duration = fitted_duration_us(ref.measured_us, ref.ratio)
            out.append(
                {
                    "segmentId": ref.segment_id,
                    "start": ref.segment_start_us,
                    "end": ref.segment_start_us + duration,
                }
            )
    return out


def _run_real(task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv) -> dict[str, object]:
    params = task.target_params()
    ctx = provider_context(task, env.providers.region)
    provider = env.providers.quality
    segments = segments_by_seq(params)
    current = translations_by_segment(params)
    by_id = {s.id: s for s in segments}
    lufs, peak = _mix_measurement(task, storage, tools)
    channels = params.metadata.audio.channels if params.metadata.audio is not None else 2
    has_video = params.metadata.video is not None

    refs = [
        _SpeechRef(
            sp.segmentId,
            by_id[sp.segmentId].range.start,
            sp.measuredDurationUs,
            sp.timeStretchRatio,
        )
        for sp in params.speech
        if sp.segmentId in by_id
    ]
    inputs: dict[str, object] = {
        "segments": [
            {"id": s.id, "start": s.range.start, "end": s.range.end, "text": s.text}
            for s in segments
        ],
        "translations": {sid: t.adaptedText for sid, t in current.items()},
        "speech": _speech_placements(task, storage, refs),
        "channels": channels,
        "hasVideo": has_video,
        "glossary": [],
    }
    metrics = list(AWS_METRICS) + (["frame-preservation"] if has_video else [])
    checks: list[QaCheck] = []
    issues: list[QaIssue] = []
    for metric in metrics:
        metric_inputs = dict(inputs)
        if metric == "loudness-integrated":
            metric_inputs["value"] = lufs
        elif metric == "true-peak":
            metric_inputs["value"] = peak
        result = provider.check(metric, metric_inputs, ctx)
        checks.append(
            QaCheck(
                metric=metric,
                threshold=_num(result.get("threshold")),
                value=_num(result.get("value")),
                passed=bool(result.get("passed")),
            )
        )
        raw_issues = result.get("issues")
        for raw in raw_issues if isinstance(raw_issues, list) else []:
            if not isinstance(raw, dict):
                continue
            seg = by_id.get(str(raw.get("segmentId")))
            severity = raw.get("severity")
            issues.append(
                QaIssue(
                    metric=metric,
                    segmentId=seg.id if seg else None,
                    severity="critical" if severity == "critical" else "warning",
                    range=TimeRange(start=seg.range.start, end=seg.range.end) if seg else None,
                    recommendation=str(raw.get("recommendation", "")),
                )
            )
    record = provider.capabilities()[0]
    return TargetQaOutput(provider=record.adapterId, checks=checks, issues=issues).model_dump()


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    if env.providers.is_mock:
        return _run_mock(task, storage, tools, env)
    return _run_real(task, storage, tools, env)
