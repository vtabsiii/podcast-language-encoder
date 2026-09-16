"""FR-040: InHouseQualityProvider checks and the TARGET_QA stage in aws mode."""

from __future__ import annotations

from typing import Any

from polycast_worker.models import TargetQaOutput
from polycast_worker.providers.base import ProviderContext
from polycast_worker.providers.quality import AWS_METRICS, InHouseQualityProvider
from polycast_worker.stages import target_qa
from polycast_worker.tools import Tools

from .aws_stubs import (
    SEG_RANGES,
    MemoryStorage,
    aws_providers,
    env_for,
    segment_dicts,
    target_task,
)
from .conftest import new_id, validate_schema

CTX = ProviderContext(
    organizationId="o",
    projectId="p",
    jobId="j",
    region="us-east-1",
    idempotencyKey="k" * 8,
    correlationId="c",
)


def _inputs(**overrides: Any) -> dict[str, object]:
    segs = [
        {"id": "s1", "start": 0, "end": 4_000_000, "text": "Call Acme Corp at 555-0100 today."},
        {"id": "s2", "start": 4_500_000, "end": 8_000_000, "text": "Second line."},
    ]
    base: dict[str, object] = {
        "segments": segs,
        "translations": {"s1": "Llama a Acme Corp al 555-0100 hoy.", "s2": "Segunda línea."},
        "speech": [
            {"segmentId": "s1", "start": 0, "end": 4_050_000},
            {"segmentId": "s2", "start": 4_500_000, "end": 8_000_000},
        ],
        "channels": 2,
        "hasVideo": False,
        "glossary": [],
    }
    base.update(overrides)
    return base


def test_coverage_boundary_drift_and_severities() -> None:
    qc = InHouseQualityProvider()
    ok = qc.check("dialogue-coverage", _inputs(), CTX)
    assert ok["passed"] is True and ok["value"] == 0.0 and ok["issues"] == []
    missing = qc.check("dialogue-coverage", _inputs(translations={"s1": "x"}), CTX)
    assert missing["passed"] is False and missing["value"] == 1.0
    issue = missing["issues"][0]  # type: ignore[index]
    assert issue["segmentId"] == "s2" and issue["severity"] == "critical"
    assert issue["range"] == {"start": 4_500_000, "end": 8_000_000}
    overrun = qc.check(
        "dialogue-coverage",
        _inputs(
            speech=[
                {"segmentId": "s1", "start": 0, "end": 4_400_000},
                {"segmentId": "s2", "start": 4_500_000, "end": 8_000_000},
            ]
        ),
        CTX,
    )
    assert overrun["passed"] is False and overrun["issues"][0]["severity"] == "critical"  # type: ignore[index]
    drift = qc.check(
        "boundary-drift",
        _inputs(
            speech=[
                {"segmentId": "s1", "start": 0, "end": 4_200_000},
                {"segmentId": "s2", "start": 4_500_000, "end": 8_000_000},
            ]
        ),
        CTX,
    )
    assert drift["passed"] is False and drift["value"] == 200.0 and drift["threshold"] == 120.0
    assert drift["issues"][0]["severity"] == "warning"  # type: ignore[index]
    assert qc.check("boundary-drift", _inputs(), CTX)["passed"] is True


def test_loudness_true_peak_captions_entities_frames() -> None:
    qc = InHouseQualityProvider()
    assert qc.check("loudness-integrated", {"value": -16.8, "channels": 2}, CTX)["passed"] is True
    assert qc.check("loudness-integrated", {"value": -16.8, "channels": 1}, CTX)["passed"] is False
    mono = qc.check("loudness-integrated", {"value": -19.4, "channels": 1}, CTX)
    assert mono["passed"] is True and mono["threshold"] == -19.0
    assert qc.check("true-peak", {"value": -1.0}, CTX)["passed"] is True
    assert qc.check("true-peak", {"value": -0.4}, CTX)["passed"] is False
    assert qc.check("true-peak", {}, CTX)["passed"] is False
    long_text = "x" * 85
    captions = qc.check("caption-timing", _inputs(translations={"s1": long_text, "s2": "ok"}), CTX)
    assert captions["passed"] is False and captions["issues"][0]["segmentId"] == "s1"  # type: ignore[index]
    assert captions["threshold"] == 84.0
    entities = qc.check(
        "entity-preservation",
        _inputs(translations={"s1": "Llama a la empresa hoy.", "s2": "Segunda."}),
        CTX,
    )
    assert entities["passed"] is False
    tokens = {i["recommendation"] for i in entities["issues"]}  # type: ignore[union-attr]
    assert any("Acme Corp" in t for t in tokens) and any("555-0100" in t for t in tokens)
    assert all(i["severity"] == "warning" for i in entities["issues"])  # type: ignore[union-attr]
    assert qc.check("entity-preservation", _inputs(), CTX)["passed"] is True
    frames = qc.check("frame-preservation", _inputs(hasVideo=True), CTX)
    assert frames == {
        "metric": "frame-preservation",
        "threshold": None,
        "value": None,
        "passed": True,
        "issues": [],
    }
    assert qc.capabilities()[0].tier == "beta"


def test_target_qa_stage_in_aws_mode_reports_real_issues() -> None:
    storage = MemoryStorage()
    segments = segment_dicts(new_id())
    translations = []
    speech = []
    adapted = [
        "Bienvenidos de nuevo al programa, hoy hablamos de cómo se hacen los podcasts.",
        "La mayoría planea el guion antes de grabar.",
        "Visita nuestro sitio para tres episodios gratis.",  # drops the URL and the number
    ]
    measured = [4_160_000, 4_350_000, 2_330_000]
    for seg, text, dur in zip(segments, adapted, measured, strict=True):
        tv = new_id()
        translations.append(
            {
                "translationVersionId": tv,
                "segmentId": seg["id"],
                "adaptedText": text,
                "timingBudgetUs": seg["range"]["end"] - seg["range"]["start"],
                "generation": 1,
            }
        )
        speech.append(
            {
                "renderId": new_id(),
                "translationVersionId": tv,
                "segmentId": seg["id"],
                "measuredDurationUs": dur,
                "timeStretchRatio": 1.0,
                "voiceId": "Mia",
            }
        )
    stereo = {
        "container": "mp4",
        "durationUs": 12_000_000,
        "video": {
            "codec": "h264",
            "width": 1280,
            "height": 720,
            "frameRate": {"num": 30, "den": 1},
            "variableFrameRate": False,
            "hdr": False,
        },
        "audio": {"codec": "aac", "sampleRate": 48000, "channels": 2, "channelLayout": "stereo"},
    }
    task = target_task(
        "TARGET_QA", segments=segments, translations=translations, speech=speech, metadata=stereo
    )
    providers = aws_providers({}, storage)
    env, _ = env_for(providers)
    out = target_qa.run(task, storage, Tools.none(), env)  # no ffmpeg → fixture −16 / −1 stereo
    validate_schema("output-target-qa", out)
    parsed = TargetQaOutput.model_validate(out)
    assert parsed.provider == "inhouse-quality"
    assert [c.metric for c in parsed.checks] == [*AWS_METRICS, "frame-preservation"]
    by_metric = {c.metric: c for c in parsed.checks}
    assert by_metric["dialogue-coverage"].passed and by_metric["boundary-drift"].passed
    assert by_metric["loudness-integrated"].passed and by_metric["true-peak"].passed
    assert by_metric["frame-preservation"].passed and by_metric["caption-timing"].passed
    assert by_metric["entity-preservation"].passed is False
    assert {i.segmentId for i in parsed.issues} == {segments[2]["id"]}
    assert {i.metric for i in parsed.issues} == {"entity-preservation"}
    assert parsed.issues[0].range is not None and parsed.issues[0].range.start == SEG_RANGES[2][0]
    assert all(i.severity == "warning" for i in parsed.issues)
