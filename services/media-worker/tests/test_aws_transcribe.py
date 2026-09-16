"""Amazon Transcribe adapter: recorded job output → AnalyzingOutput, driven through a Stubber."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from polycast_worker.mediatime import from_seconds_str
from polycast_worker.models import AnalyzedSegment, AnalyzingOutput, WorkerTask
from polycast_worker.providers.aws.transcribe import (
    SEGMENT_MAX_US,
    SILENCE_SPLIT_US,
    TranscribeProvider,
    _Word,
    job_name_for,
    parse_transcript,
    segment_words,
)
from polycast_worker.providers.base import ProviderError
from polycast_worker.runner import run_task
from polycast_worker.stages import analyzing
from polycast_worker.stages.common import provider_context
from polycast_worker.tools import Tools

from .aws_stubs import (
    SEG_TEXTS,
    MemoryStorage,
    aws_providers,
    env_for,
    recorded,
    stub_client,
    transcribe_output,
)
from .conftest import new_id, validate_schema, write_tone_wav

SOURCE = "s3://source/org1/asset.wav"
PREFIX = "s3://derived/org1/assets/a1/analyzing/"


def _analyzing_task(declared_locale: str | None = None) -> WorkerTask:
    return WorkerTask.model_validate(
        {
            "taskId": new_id(),
            "organizationId": new_id(),
            "jobId": None,
            "targetJobId": None,
            "assetId": new_id(),
            "stage": "ANALYZING",
            "attempt": 1,
            "idempotencyKey": f"idem-analyzing-{new_id()}",
            "correlationId": "corr-1",
            "storage": {"source": SOURCE, "derivedPrefix": PREFIX, "deliverablesPrefix": None},
            "parameters": {
                "assetId": new_id(),
                "projectId": new_id(),
                "metadata": {
                    "container": "wav",
                    "durationUs": 12_000_000,
                    "audio": {
                        "codec": "pcm_s16le",
                        "sampleRate": 16000,
                        "channels": 1,
                        "channelLayout": "mono",
                    },
                },
                "declaredLocale": declared_locale,
            },
            "taskToken": None,
            "leaseSeconds": 30,
        }
    )


def test_parse_transcript_is_exact_and_follows_segmentation_rules() -> None:
    parsed = parse_transcript(transcribe_output(), locale_hint=None)
    assert parsed["detectedLocale"] == "en-US"
    assert parsed["detectionConfidence"] == 0.9834
    segments: list[dict[str, Any]] = parsed["segments"]  # type: ignore[assignment]
    assert [s["text"] for s in segments] == list(SEG_TEXTS)
    assert [s["speakerKey"] for s in segments] == ["A", "B", "A"]
    assert [s["seq"] for s in segments] == [0, 1, 2]
    # timestamps come from the decimal strings, never floats
    items = transcribe_output()["results"]["items"]
    words = [i for i in items if i["type"] == "pronunciation"]
    assert segments[0]["range"] == {
        "start": from_seconds_str(words[0]["start_time"]),
        "end": from_seconds_str(words[13]["end_time"]),
    }
    assert segments[0]["words"][0]["range"] == {"start": 0, "end": 250_000}
    assert segments[1]["range"]["start"] - segments[0]["range"]["end"] >= SILENCE_SPLIT_US
    assert all(s["range"]["end"] - s["range"]["start"] <= SEGMENT_MAX_US for s in segments)
    assert segments[0]["words"][4]["text"] == "show,"  # punctuation attached to the word
    for s in segments:
        AnalyzedSegment.model_validate(s)
        assert 0 <= s["confidence"] <= 1
    speakers: list[dict[str, Any]] = parsed["speakers"]  # type: ignore[assignment]
    assert [sp["key"] for sp in speakers] == ["A", "B"]
    assert speakers[0]["sampleRanges"] == [segments[0]["range"], segments[2]["range"]]


def test_segment_words_splits_on_silence_length_and_speaker() -> None:
    def w(start_s: float, end_s: float, speaker: str = "spk_0") -> _Word:
        return _Word("x", int(start_s * 1e6), int(end_s * 1e6), 0.9, speaker)

    groups = segment_words([w(0, 1), w(1.1, 2), w(2.7, 3)])  # 700 ms silence
    assert [len(g) for g in groups] == [2, 1]
    groups = segment_words([w(0, 1), w(1, 2, "spk_1"), w(2, 3, "spk_1")])
    assert [g[0].speaker for g in groups] == ["spk_0", "spk_1"]
    long_run = [w(i, i + 0.9) for i in range(0, 20)]
    groups = segment_words(long_run)
    assert all(g[-1].end_us - g[0].start_us <= SEGMENT_MAX_US for g in groups)
    assert sum(len(g) for g in groups) == 20


@pytest.mark.parametrize("mode", ["ffmpeg", "no-ffmpeg"])
def test_analyzing_stage_in_aws_mode_polls_with_heartbeats(tmp_path: Path, mode: str) -> None:
    tools = Tools.detect() if mode == "ffmpeg" else Tools.none()
    if mode == "ffmpeg" and not tools.has_ffmpeg:
        pytest.skip("ffmpeg not installed")
    storage = MemoryStorage()
    storage.put(SOURCE, write_tone_wav(tmp_path / "tone.wav"), "audio/wav")
    task = _analyzing_task()
    client, stubber = stub_client("transcribe")
    providers = aws_providers({"transcribe": client}, storage, tools)
    ctx = provider_context(task, "us-east-1")
    job_name = job_name_for(ctx)
    output_uri, bucket, key = TranscribeProvider.output_uri(ctx, job_name)
    assert output_uri == f"s3://derived/{key}" and bucket == "derived"
    assert key == f"org1/assets/a1/analyzing/transcribe/{job_name}.json"

    start = recorded("transcribe", "start_transcription_job", JOB_NAME=job_name, MEDIA_URI=SOURCE)
    stubber.add_response(
        "start_transcription_job",
        start["response"],
        {
            "TranscriptionJobName": job_name,
            "Media": {"MediaFileUri": SOURCE},
            "OutputBucketName": bucket,
            "OutputKey": key,
            "IdentifyLanguage": True,
            "Settings": {"ShowSpeakerLabels": True, "MaxSpeakerLabels": 10},
        },
    )
    for variant in ("in_progress", "completed"):
        rec = recorded("transcribe", "get_transcription_job", variant, JOB_NAME=job_name)
        stubber.add_response(
            "get_transcription_job", rec["response"], {"TranscriptionJobName": job_name}
        )
    import json

    storage.put(output_uri, json.dumps(transcribe_output()).encode(), "application/json")

    env, lease = env_for(providers)
    out = analyzing.run(task, storage, tools, env)
    validate_schema("output-analyzing", out)
    stubber.assert_no_pending_responses()
    parsed = AnalyzingOutput.model_validate(out)
    assert parsed.provider == "aws-transcribe" and parsed.providerVersion == "1"
    assert parsed.detectedLocale == "en-US" and parsed.detectionConfidence == 0.9834
    assert [s.text for s in parsed.segments] == list(SEG_TEXTS)
    assert lease.beats == 1 and lease.sleeps == [5.0]
    assert storage.exists(str(parsed.proxy)) and storage.exists(str(parsed.waveform))
    assert parsed.hasVideo is False and all(not sp.onCamera for sp in parsed.speakers)


def test_declared_locale_uses_language_code_and_conflict_is_idempotent() -> None:
    storage = MemoryStorage()
    client, stubber = stub_client("transcribe")
    providers = aws_providers({"transcribe": client}, storage)
    task = _analyzing_task("es-MX")
    ctx = provider_context(task, "us-east-1")
    job_name = job_name_for(ctx)
    _, bucket, key = TranscribeProvider.output_uri(ctx, job_name)
    stubber.add_client_error(
        "start_transcription_job",
        "ConflictException",
        expected_params={
            "TranscriptionJobName": job_name,
            "Media": {"MediaFileUri": SOURCE},
            "OutputBucketName": bucket,
            "OutputKey": key,
            "LanguageCode": "es-US",
            "Settings": {"ShowSpeakerLabels": True, "MaxSpeakerLabels": 10},
        },
    )
    handle = providers.transcription.transcribe(SOURCE, "es-MX", ctx)
    assert handle.externalId == job_name
    stubber.assert_no_pending_responses()


def test_failed_job_and_throttling_are_typed(tmp_path: Path) -> None:
    storage = MemoryStorage()
    storage.put(SOURCE, write_tone_wav(tmp_path / "tone.wav"), "audio/wav")
    client, stubber = stub_client("transcribe")
    providers = aws_providers({"transcribe": client}, storage)
    task = _analyzing_task()
    job_name = job_name_for(provider_context(task, "us-east-1"))
    stubber.add_response(
        "start_transcription_job",
        recorded("transcribe", "start_transcription_job", JOB_NAME=job_name, MEDIA_URI=SOURCE)[
            "response"
        ],
    )
    stubber.add_response(
        "get_transcription_job",
        recorded("transcribe", "get_transcription_job", "failed", JOB_NAME=job_name)["response"],
    )
    env, _ = env_for(providers)
    result = run_task(task, storage, Tools.none(), "w", env)
    assert result.status == "failed" and result.error is not None
    assert result.error.code == "TRANSCRIPTION_FAILED" and result.retryable is False
    assert "s3://" not in result.error.message

    stubber.add_client_error("start_transcription_job", "ThrottlingException")
    with pytest.raises(ProviderError) as info:
        providers.transcription.transcribe(SOURCE, None, provider_context(task, "us-east-1"))
    assert info.value.retryable is True and info.value.code == "PROVIDER_THROTTLED"
