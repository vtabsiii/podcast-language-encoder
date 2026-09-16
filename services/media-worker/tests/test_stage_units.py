from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from polycast_worker.audio import compute_peaks, parse_ebur128_summary, probe_wav
from polycast_worker.mediatime import from_frames, to_srt_timestamp, to_vtt_timestamp
from polycast_worker.models import WorkerTask
from polycast_worker.runner import run_task
from polycast_worker.stages import HANDLERS, analyzing, timing, translating, validating
from polycast_worker.storage import LocalFsStorage, StorageError
from polycast_worker.tools import Tools

from .conftest import new_id, validate_schema, write_tone_wav


def test_timing_fit_strategies():
    assert timing.fit_segment(3_000_000, 4_000_000) == ("none", 1.0, 0, True)
    assert timing.fit_segment(4_200_000, 4_000_000) == ("rate", 1.05, 0, True)
    assert timing.fit_segment(3_600_000, 4_000_000) == ("rate", 0.9, 0, True)
    strategy, ratio, shift, fits = timing.fit_segment(4_580_000, 4_000_000)
    assert strategy == "boundary-shift" and fits is True
    assert 0 < shift <= timing.MAX_BOUNDARY_SHIFT_US and ratio <= timing.RATE_MAX
    strategy, ratio, shift, fits = timing.fit_segment(6_000_000, 4_000_000)
    assert (strategy, shift, fits) == ("retranslate", 0, False) and ratio == 1.5
    assert timing.fit_segment(0, 0) == ("none", 1.0, 0, True)


def test_mediatime_caption_timestamps():
    assert to_srt_timestamp(3_723_456_789) == "01:02:03,456"
    assert to_vtt_timestamp(3_723_456_789) == "01:02:03.456"
    assert to_srt_timestamp(0) == "00:00:00,000"
    assert from_frames(16000 * 12, 16000) == 12_000_000
    assert from_frames(1, 48000) == 21


def test_ebur128_summary_parsing():
    text = (
        "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:   -16.2 LUFS\n"
        "    Threshold: -26.0 LUFS\n\n  True peak:\n    Peak:   -1.4 dBFS\n"
    )
    assert parse_ebur128_summary(text) == (-16.2, -1.4)
    assert parse_ebur128_summary("no summary here") is None
    assert parse_ebur128_summary(text.replace("-16.2", "-inf")) is None


def test_compute_peaks_count_and_range():
    from array import array

    rate = 1000
    samples = array("h", [0, 100, -32768, 5] * 250)  # 1 s
    peaks = compute_peaks(rate, iter([samples]), 1_000_000, 50)
    assert len(peaks) == 50 and all(0.0 <= p <= 1.0 for p in peaks)
    assert max(peaks) == 1.0
    padded = compute_peaks(rate, iter([samples]), 2_000_000, 50)
    assert len(padded) == 100 and padded[-1] == 0.0


def test_probe_wav_is_exact(tmp_path: Path):
    meta = probe_wav(write_tone_wav(tmp_path / "t.wav", seconds=1.5, rate=44100))
    assert meta.container == "wav" and meta.durationUs == 1_500_000
    assert meta.audio is not None and meta.audio.codec == "pcm_s16le"
    assert meta.audio.channelLayout == "mono" and meta.video is None
    validate_schema("media-metadata", meta.dump_contract())


def test_analysis_fixture_is_deterministic_and_covers_duration():
    a = analyzing.fixture_segments("asset-1", 60_000_000)
    b = analyzing.fixture_segments("asset-1", 60_000_000)
    assert [s.model_dump() for s in a] == [s.model_dump() for s in b]
    assert a[0].range.start == 0 and a[-1].range.end == 60_000_000
    for i, seg in enumerate(a):
        assert seg.speakerKey == ("A" if i % 2 == 0 else "B")
        assert seg.range.duration_us <= analyzing.SEGMENT_MAX_US + analyzing._MIN_TAIL_US
        assert seg.words and seg.words[0].range.start == seg.range.start
        assert seg.words[-1].range.end == seg.range.end
        assert seg.text in analyzing.SENTENCES and "lorem" not in seg.text.lower()
        if i:
            assert seg.range.start - a[i - 1].range.end == analyzing.SEGMENT_GAP_US
    assert analyzing.fixture_segments("asset-2", 60_000_000)[0].text != a[0].text or len(a) > 1
    speakers = analyzing.fixture_speakers(a, has_video=True)
    assert [s.key for s in speakers] == ["A", "B"] and all(s.onCamera for s in speakers)
    assert len(speakers[0].sampleRanges) == 2


def _target_task(
    segments: list[dict[str, Any]], translations: list[dict[str, Any]], hint: str | None
):
    speaker = new_id()
    return WorkerTask.model_validate(
        {
            "taskId": new_id(),
            "organizationId": new_id(),
            "jobId": new_id(),
            "targetJobId": new_id(),
            "assetId": None,
            "stage": "TRANSLATING",
            "attempt": 1,
            "idempotencyKey": "k" * 10,
            "correlationId": "c",
            "storage": {
                "source": None,
                "derivedPrefix": "local://d/x/",
                "deliverablesPrefix": None,
            },
            "parameters": {
                "targetJobId": new_id(),
                "projectId": new_id(),
                "jobId": new_id(),
                "sourceLocale": "en-US",
                "targetLocale": "es-MX",
                "direction": "ltr",
                "lipSync": False,
                "metadata": {"container": "wav", "durationUs": 10_000_000},
                "sourceSha256": "0" * 64,
                "speakers": [
                    {
                        "id": speaker,
                        "label": "A",
                        "onCamera": False,
                        "voicePolicy": "stock",
                        "sampleRanges": [],
                    }
                ],
                "segments": [
                    {
                        "id": s["id"],
                        "seq": s["seq"],
                        "speakerId": speaker,
                        "range": s["range"],
                        "text": s["text"],
                        "language": "en",
                        "confidence": 0.9,
                        "words": [],
                        "version": 1,
                    }
                    for s in segments
                ],
                "translations": translations,
                "speech": [],
                "hint": hint,
                "packageVersion": None,
                "provenance": None,
            },
            "taskToken": None,
            "leaseSeconds": 30,
        }
    )


def test_mock_translation_tags_generation_and_honours_shorter_hint(storage: LocalFsStorage):
    seg_a = {
        "id": new_id(),
        "seq": 1,
        "range": {"start": 5_000_000, "end": 9_000_000},
        "text": "b c d",
    }
    seg_b = {
        "id": new_id(),
        "seq": 0,
        "range": {"start": 0, "end": 4_000_000},
        "text": "hello there world",
    }
    task = _target_task([seg_a, seg_b], [], None)
    out = translating.run(task, storage, Tools.none())
    validate_schema("output-translating", out)
    by_id = {t["segmentId"]: t for t in out["translations"]}
    assert by_id[seg_b["id"]]["adaptedText"] == "[es-MX] hello there world"
    assert by_id[seg_b["id"]]["timingBudgetUs"] == 4_000_000
    assert [t["segmentId"] for t in out["translations"]] == [seg_b["id"], seg_a["id"]]

    current = [
        {
            "translationVersionId": new_id(),
            "segmentId": seg_b["id"],
            "adaptedText": "[es-MX] hello there world",
            "timingBudgetUs": 4_000_000,
            "generation": 1,
        }
    ]
    out2 = translating.run(
        _target_task([seg_b], current, "please make it shorter"), storage, Tools.none()
    )
    assert out2["translations"][0]["adaptedText"] == "[es-MX v2] hello there"
    assert out2["promptVersion"] == "mock-v1" and out2["provider"] == "mock-translation"


def _validating_task(
    quarantine: str, source: str, size: int, max_us: int = 3_600_000_000
) -> WorkerTask:
    return WorkerTask.model_validate(
        {
            "taskId": new_id(),
            "organizationId": new_id(),
            "jobId": None,
            "targetJobId": None,
            "assetId": new_id(),
            "stage": "VALIDATING",
            "attempt": 1,
            "idempotencyKey": "k" * 10,
            "correlationId": "c",
            "storage": {
                "source": source,
                "derivedPrefix": "local://derived/x/",
                "deliverablesPrefix": None,
            },
            "parameters": {
                "assetId": new_id(),
                "projectId": new_id(),
                "quarantine": quarantine,
                "declaredContentType": "audio/wav",
                "declaredByteSize": size,
                "maxDurationUs": max_us,
            },
            "taskToken": None,
            "leaseSeconds": 30,
        }
    )


@pytest.mark.parametrize("mode", ["no-ffprobe", "ffprobe"])
def test_validating_rejections_are_typed_and_never_leak_paths(
    storage: LocalFsStorage, tone_wav: Path, mode: str
):
    tools = Tools.none() if mode == "no-ffprobe" else Tools.detect()
    if mode == "ffprobe" and not tools.has_ffprobe:
        pytest.skip("ffprobe not installed")
    q = "local://quarantine/org/upload.wav"
    storage.put(q, tone_wav, "audio/wav")
    size = tone_wav.stat().st_size
    src = "local://source/org/asset.wav"

    r = run_task(_validating_task(q, src, size + 1), storage, tools, "w")
    assert r.status == "failed" and r.error and r.error.code == "SIZE_MISMATCH"
    assert r.retryable is False

    r = run_task(_validating_task(q, src, size, max_us=5_000_000), storage, tools, "w")
    assert r.error and r.error.code == "DURATION_EXCEEDED"

    junk = "local://quarantine/org/junk.bin"
    storage.put(junk, b"RIFF\x00\x00\x00\x00WAVEjunkjunkjunk", "audio/wav")
    r = run_task(_validating_task(junk, src, 24), storage, tools, "w")
    assert r.error and r.error.code == "MALFORMED_MEDIA"

    text = "local://quarantine/org/notes.txt"
    storage.put(text, b"just some text, definitely not media" * 4, "text/plain")
    r = run_task(_validating_task(text, src, 36 * 4), storage, tools, "w")
    assert r.error and r.error.code in ("UNSUPPORTED_CONTAINER", "MALFORMED_MEDIA")
    for res in (r,):
        assert res.error and "/" not in res.error.message and "quarantine" not in res.error.message
    assert not storage.exists(src)

    ok = run_task(_validating_task(q, src, size), storage, tools, "w")
    assert ok.status == "succeeded" and ok.output is not None
    validate_schema("output-validating", ok.output)
    assert ok.output["metadata"]["durationUs"] == 12_000_000
    assert storage.exists(src) and storage.sha256(src) == ok.output["sha256"]
    # idempotent re-run keeps the immutable source
    again = run_task(_validating_task(q, src, size), storage, tools, "w")
    assert again.status == "succeeded"


def test_validating_message_table_has_every_code():
    for code in (
        "UNSUPPORTED_CONTAINER",
        "NO_AUDIO_STREAM",
        "DURATION_EXCEEDED",
        "SIZE_MISMATCH",
        "MALFORMED_MEDIA",
    ):
        assert code in validating._MESSAGES


def test_run_task_classifies_unexpected_errors(
    monkeypatch: pytest.MonkeyPatch, storage: LocalFsStorage
):
    task = _target_task([], [], None)

    def explode(*_: object) -> dict[str, object]:
        raise KeyError("secret-path")

    monkeypatch.setitem(HANDLERS, "TRANSLATING", explode)
    r = run_task(task, storage, Tools.none(), "w")
    assert r.status == "failed" and r.error and r.error.code == "INTERNAL_ERROR"
    assert r.retryable is False and "secret-path" not in r.error.message

    def io_fail(*_: object) -> dict[str, object]:
        raise StorageError("failed to read object")

    monkeypatch.setitem(HANDLERS, "TRANSLATING", io_fail)
    r = run_task(task, storage, Tools.none(), "w")
    assert r.error and r.error.code == "STORAGE_IO" and r.retryable is True

    monkeypatch.setitem(HANDLERS, "TRANSLATING", lambda *_: {"provider": "x"})
    r = run_task(task, storage, Tools.none(), "w")
    assert r.error and r.error.code == "INVALID_TASK" and r.retryable is False


def test_sibling_uri_swaps_the_stage_segment(storage: LocalFsStorage):
    from polycast_worker.stages.common import find_artifact, sibling_uri

    task = WorkerTask.model_validate(
        {
            **_target_task([], [], None).model_dump(),
            "stage": "ENCODING",
            "storage": {
                "source": None,
                "derivedPrefix": "local://derived/org/targets/t1/encoding/",
                "deliverablesPrefix": None,
            },
        }
    )
    assert sibling_uri(task, "MIXING", "mix.wav") == "local://derived/org/targets/t1/mixing/mix.wav"
    assert find_artifact(task, storage, "MIXING", "mix.wav") is None
    storage.put("local://derived/org/targets/t1/mixing/mix.wav", b"x", "audio/wav")
    assert (
        find_artifact(task, storage, "MIXING", "mix.wav")
        == "local://derived/org/targets/t1/mixing/mix.wav"
    )
    storage.put("local://derived/org/targets/t1/encoding/mix.wav", b"y", "audio/wav")
    assert (
        find_artifact(task, storage, "MIXING", "mix.wav")
        == "local://derived/org/targets/t1/encoding/mix.wav"
    )
    shared = WorkerTask.model_validate(
        {
            **task.model_dump(),
            "storage": {
                "source": None,
                "derivedPrefix": "local://d/x/",
                "deliverablesPrefix": None,
            },
        }
    )
    assert sibling_uri(shared, "MIXING", "mix.wav") == "local://d/x/mix.wav"
