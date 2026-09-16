"""Drives the worker loop through the M3 stage sequence in PROVIDER_MODE=aws.

Every AWS call is answered by a botocore Stubber loaded from the recorded fixtures under
tests/fixtures/providers/; media work (proxy, atempo, remix, loudnorm, encode) runs on the
real ffmpeg. No network, no credentials.
"""

from __future__ import annotations

import io
import json
import logging
import math
import struct
import wave
from pathlib import Path

import pytest
from botocore.response import StreamingBody

from polycast_worker.client import ApiClient
from polycast_worker.logsafe import FORBIDDEN_KEYS
from polycast_worker.providers.aws.transcribe import TranscribeProvider, job_name_for
from polycast_worker.providers.base import ProviderContext
from polycast_worker.runner import run_loop
from polycast_worker.tools import Tools

from .aws_stubs import (
    SEG_TEXTS,
    MemoryStorage,
    aws_providers,
    recorded,
    stub_client,
    transcribe_output,
)
from .conftest import validate_schema, write_tone_wav
from .fake_api import FakeApi, FakeTransport, Step
from .test_e2e_loop import OUTPUT_SCHEMA

ADAPTED = (
    "Bienvenidos de nuevo al programa, hoy hablamos de cómo se hacen los podcasts.",
    "La mayoría de los productores planean el guion del episodio antes de grabar.",
    "Visita polycast.example.com para 3 episodios gratis.",
)
RENDER_US = (4_000_000, 4_600_000, 2_400_000)  # vs slots 4.16 s / 4.35 s / 2.33 s → all "rate"


def _pcm(duration_us: int, rate: int = 16000) -> bytes:
    frames = duration_us * rate // 1_000_000
    return b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 300 * i / rate))) for i in range(frames)
    )


def _stream(data: bytes) -> StreamingBody:
    return StreamingBody(io.BytesIO(data), len(data))


def test_aws_slice_end_to_end_with_recorded_provider_responses(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    tools = Tools.detect()
    if not (tools.has_ffmpeg and tools.has_ffprobe):
        pytest.skip("ffmpeg/ffprobe not installed")
    storage = MemoryStorage()
    wav = write_tone_wav(tmp_path / "fixture.wav", seconds=12.0, rate=16000)
    quarantine = "s3://quarantine/org1/upload.wav"
    storage.put(quarantine, wav, "audio/wav")
    api = FakeApi(
        token="dev-worker-token",  # noqa: S106 - dev default under test
        quarantine_uri=quarantine,
        source_uri="s3://source/org1/asset.wav",
        derived_prefix="s3://derived/org1/target1/",
        deliverables_prefix="s3://deliverables/org1/target1/v1/",
        declared_byte_size=wav.stat().st_size,
        script=[
            Step("VALIDATING"),
            Step("ANALYZING"),
            Step("TRANSLATING"),
            Step("SYNTHESIZING"),
            Step("TIMING"),
            Step("MIXING"),
            Step("ENCODING"),
            Step("TARGET_QA"),
            Step("PACKAGING"),
        ],
    )

    # --- Transcribe: the job name is derived from the ANALYZING task's idempotency key
    transcribe, transcribe_stub = stub_client("transcribe")
    ctx = ProviderContext(
        organizationId=api.organization_id,
        projectId=api.project_id,
        jobId=api.asset_id,
        region="us-east-1",
        idempotencyKey=f"{api.target_job_id}:ANALYZING:2",
        correlationId="corr-2",
        derivedPrefix=api.stage_prefix("ANALYZING"),
    )
    job_name = job_name_for(ctx)
    output_uri, _, _ = TranscribeProvider.output_uri(ctx, job_name)
    transcribe_stub.add_response(
        "start_transcription_job",
        recorded(
            "transcribe", "start_transcription_job", JOB_NAME=job_name, MEDIA_URI=api.source_uri
        )["response"],
    )
    for variant in ("in_progress", "completed"):
        transcribe_stub.add_response(
            "get_transcription_job",
            recorded("transcribe", "get_transcription_job", variant, JOB_NAME=job_name)["response"],
            {"TranscriptionJobName": job_name},
        )
    storage.put(output_uri, json.dumps(transcribe_output()).encode(), "application/json")

    # --- Translate: one batched request for the three segments
    translate, translate_stub = stub_client("translate")
    translate_stub.add_response(
        "translate_text",
        {
            "TranslatedText": "\n".join(ADAPTED),
            "SourceLanguageCode": "en",
            "TargetLanguageCode": "es-MX",
        },
        {"Text": "\n".join(SEG_TEXTS), "SourceLanguageCode": "en", "TargetLanguageCode": "es-MX"},
    )

    # --- Polly: PCM + word marks per segment, durations chosen to exercise the rate fit
    polly, polly_stub = stub_client("polly")
    marks = recorded("polly", "synthesize_speech", "marks")
    for text, duration in zip(ADAPTED, RENDER_US, strict=True):
        polly_stub.add_response(
            "synthesize_speech",
            {
                "AudioStream": _stream(_pcm(duration)),
                "ContentType": "audio/pcm",
                "RequestCharacters": len(text),
            },
            {
                "Engine": "neural",
                "OutputFormat": "pcm",
                "SampleRate": "16000",
                "Text": text,
                "TextType": "text",
                "VoiceId": "Mia",
            },
        )
        polly_stub.add_response(
            "synthesize_speech",
            recorded("polly", "synthesize_speech", "marks")["response"],
            {**marks["expected_params"], "Text": text},
        )

    providers = aws_providers(
        {"transcribe": transcribe, "translate": translate, "polly": polly}, storage, tools
    )
    client = ApiClient(
        "http://api.test", "dev-worker-token", "worker-aws", transport=FakeTransport(api)
    )
    caplog.set_level(logging.INFO, logger="polycast_worker")
    exit_code = run_loop(
        client,
        storage,
        tools,
        once=True,
        poll_interval_s=0.01,
        max_tasks=20,
        providers=providers,
        sleep=lambda _s: None,
    )
    assert exit_code == 0
    for stub in (transcribe_stub, translate_stub, polly_stub):
        stub.assert_no_pending_responses()

    stages = [stage for stage, _, _ in api.results]
    assert stages == [s.stage for s in api.script]
    by_stage: dict[str, dict[str, object]] = {}
    for stage, _, result in api.results:
        validate_schema("task-result", result)
        assert result["status"] == "succeeded", (stage, result.get("error"))
        validate_schema(OUTPUT_SCHEMA[stage], result["output"])
        by_stage[stage] = result["output"]

    analyzing = by_stage["ANALYZING"]
    assert analyzing["provider"] == "aws-transcribe" and analyzing["detectedLocale"] == "en-US"
    assert [s["text"] for s in analyzing["segments"]] == list(SEG_TEXTS)  # type: ignore[index]
    assert [s["speakerKey"] for s in analyzing["segments"]] == ["A", "B", "A"]  # type: ignore[index]
    analyzing_task_id = api.results[1][1]
    assert analyzing_task_id in api.heartbeats  # the poll loop renewed the lease

    translating = by_stage["TRANSLATING"]
    assert translating["provider"] == "aws-translate" and translating["promptVersion"] is None
    assert [t["adaptedText"] for t in translating["translations"]] == list(ADAPTED)  # type: ignore[index]

    synthesizing = by_stage["SYNTHESIZING"]
    renders = synthesizing["renders"]
    assert isinstance(renders, list)
    assert [r["measuredDurationUs"] for r in renders] == list(RENDER_US)
    for r in renders:
        assert r["voiceId"] == "Mia" and storage.exists(str(r["audio"]))
        assert str(r["audio"]).endswith(f"/synthesizing/speech/{r['segmentId']}.wav")

    timing = by_stage["TIMING"]
    assert [f["strategy"] for f in timing["fits"]] == ["rate", "rate", "rate"]  # type: ignore[index]
    assert all(f["fits"] for f in timing["fits"])  # type: ignore[union-attr]
    for r in renders:
        fitted = f"{api.stage_prefix('TIMING')}speech/{r['segmentId']}.fit.wav"
        assert storage.exists(fitted)

    mixing = by_stage["MIXING"]
    assert abs(float(mixing["integratedLufs"]) + 19.0) <= 1.0  # type: ignore[arg-type]
    assert float(mixing["truePeakDbtp"]) <= -0.9  # type: ignore[arg-type]
    with wave.open(io.BytesIO(storage.get(str(mixing["mix"]))), "rb") as w:
        assert w.getnchannels() == 1 and w.getframerate() == 48000
        assert abs(w.getnframes() / 48000 - 12.0) < 0.05

    encoding = by_stage["ENCODING"]
    assert (
        encoding["container"] == "mp3"
        and storage.size(str(encoding["encode"])) == encoding["byteSize"]
    )

    qa = by_stage["TARGET_QA"]
    assert qa["provider"] == "inhouse-quality"
    checks = {c["metric"]: c for c in qa["checks"]}  # type: ignore[union-attr]
    assert set(checks) == {
        "dialogue-coverage",
        "boundary-drift",
        "loudness-integrated",
        "true-peak",
        "caption-timing",
        "entity-preservation",
    }
    assert all(c["passed"] for c in checks.values()), checks
    assert qa["issues"] == []

    packaging = by_stage["PACKAGING"]
    manifest = packaging["manifest"]
    assert isinstance(manifest, dict)
    validate_schema("provenance-manifest", manifest)
    assert manifest["mock"] is False and manifest["syntheticVoice"] is True
    assert manifest["lipSyncApplied"] is False
    assert {m["tier"] for m in manifest["models"]} == {"beta"}  # type: ignore[union-attr]
    assert "production" not in {m["tier"] for m in manifest["models"]}  # type: ignore[union-attr]
    assert {m["adapterId"] for m in manifest["models"]} == {  # type: ignore[union-attr]
        "aws-transcribe",
        "aws-translate",
        "aws-polly",
        "ffmpeg-encode",
        "inhouse-quality",
    }
    qc = json.loads(storage.get(f"{api.deliverables_prefix}qc-report.json"))
    assert qc["passed"] is True and qc["checks"][0]["provider"] == "inhouse-quality"
    srt = storage.get(f"{api.deliverables_prefix}captions.es-MX.srt").decode()
    assert ADAPTED[2] in srt

    for record in caplog.records:
        msg = record.getMessage().lower()
        assert not any(k in msg for k in FORBIDDEN_KEYS), record.getMessage()
        assert "s3://" not in msg
