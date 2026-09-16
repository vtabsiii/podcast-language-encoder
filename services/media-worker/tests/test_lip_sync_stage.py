"""LIP_SYNCING with a real (fake) adapter, the dubbed speech track, and the downstream stages
(ENCODING takes the lip-synced picture, PACKAGING records `lipSyncApplied`)."""

from __future__ import annotations

import array
import json
import wave
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from polycast_worker.models import LipSyncOutput, WorkerTask
from polycast_worker.providers.base import (
    AsyncHandle,
    CapabilityRecord,
    ProviderContext,
    SpeechPlacement,
)
from polycast_worker.providers.ffmpeg import build_speech_track, wav_duration_us
from polycast_worker.providers.mock import MockLipSyncProvider
from polycast_worker.stages import encoding, lip_syncing, packaging
from polycast_worker.stages.common import StageError
from polycast_worker.stages.lip_syncing import (
    LIP_SYNC_OUTPUT_FILE,
    SPEECH_TRACK_FILE,
    find_lip_sync_video,
)
from polycast_worker.tools import ToolError, Tools

from .aws_stubs import MemoryStorage, aws_providers, env_for, segment_dicts, target_task
from .conftest import new_id, validate_schema, write_tone_wav

PREFIX = "s3://derived/org/targets/t1/"
SOURCE = "s3://source/org/asset.mp4"
VIDEO_META: dict[str, Any] = {
    "container": "mp4",
    "durationUs": 12_000_000,
    "video": {
        "codec": "h264",
        "width": 640,
        "height": 360,
        "frameRate": {"num": 30, "den": 1},
        "variableFrameRate": False,
        "hdr": False,
    },
    "audio": {"codec": "aac", "sampleRate": 48000, "channels": 2, "channelLayout": "stereo"},
}


class FakeLipSyncProvider:
    """A real-adapter stand-in: whole-episode shot in, video written to storage on completion."""

    def __init__(self, storage: MemoryStorage, *, polls_before_done: int = 2) -> None:
        self.storage = storage
        self.shots: list[dict[str, object]] = []
        self.evaluations = 0
        self.polls_before_done = polls_before_done

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId="fake-lipsync",
                kind="lipSync",
                locale=None,
                region="vendor",
                tier="beta",
                version="v9",
                dataPolicy="no-training",
                priceUnit="second",
            )
        ]

    def render(self, shot: dict[str, object], ctx: ProviderContext) -> AsyncHandle:
        assert ctx.derivedPrefix is not None
        self.shots.append(shot)
        return AsyncHandle(adapterId="fake-lipsync", externalId="job-1")

    def evaluate(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        self.evaluations += 1
        if self.evaluations <= self.polls_before_done:
            return None
        uri = f"{ctx.derivedPrefix}lip-sync/{handle.externalId}.mp4"
        self.storage.put(uri, b"lip-synced-video", "video/mp4")
        return {"status": "COMPLETED", "applied": True, "syncConfidence": 0.9, "video": uri}


def _read_mono_samples(path: Path) -> tuple[array.array[int], int]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2
        samples = array.array("h")
        samples.frombytes(w.readframes(w.getnframes()))
        return samples, w.getframerate()


@pytest.mark.skipif(not Tools.detect().has_ffmpeg, reason="ffmpeg required")
def test_speech_track_places_renders_over_silence(tmp_path: Path) -> None:
    tone = write_tone_wav(tmp_path / "tone.wav", seconds=2.0)
    out = tmp_path / "track.wav"
    placements = [SpeechPlacement("s1", tone, 1_000_000, 3_000_000)]
    written = build_speech_track(Tools.detect(), placements, out, duration_us=5_000_000)
    assert written == 5_000_000 == wav_duration_us(out)
    samples, rate = _read_mono_samples(out)
    assert rate == 48000 and len(samples) == 5 * rate
    silence_before = samples[: int(0.9 * rate)]
    speech = samples[int(1.5 * rate) : int(1.6 * rate)]
    silence_after = samples[int(4.0 * rate) :]
    assert max(abs(s) for s in silence_before) == 0
    assert max(abs(s) for s in speech) > 1000
    assert max(abs(s) for s in silence_after) == 0
    with pytest.raises(ToolError):
        build_speech_track(Tools.none(), placements, out, duration_us=5_000_000)
    with pytest.raises(ValueError):
        build_speech_track(Tools.detect(), placements, out, duration_us=0)


def _speech_inputs(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "renderId": new_id(),
            "translationVersionId": new_id(),
            "segmentId": seg["id"],
            "measuredDurationUs": 2_000_000,
            "timeStretchRatio": 1.0,
            "voiceId": "Mia",
        }
        for seg in segments
    ]


def _lip_sync_task(segments: list[dict[str, Any]], *, lip_sync: bool = True) -> WorkerTask:
    def make(payload: dict[str, Any]) -> WorkerTask:
        payload["parameters"]["lipSync"] = lip_sync
        return WorkerTask.model_validate(payload)

    return target_task(
        "LIP_SYNCING",
        segments=segments,
        speech=_speech_inputs(segments),
        source=SOURCE,
        metadata=VIDEO_META,
        prefix=PREFIX,
        make=make,
    )


def _seed_storage(tmp_path: Path, segments: list[dict[str, Any]]) -> MemoryStorage:
    storage = MemoryStorage()
    storage.put(SOURCE, b"original-video", "video/mp4")
    tone = write_tone_wav(tmp_path / "render.wav", seconds=2.0)
    for seg in segments:
        storage.put(f"{PREFIX}timing/speech/{seg['id']}.fit.wav", tone, "audio/wav")
    return storage


@pytest.mark.skipif(not Tools.detect().has_ffmpeg, reason="ffmpeg required")
def test_lip_syncing_stage_renders_the_whole_episode(tmp_path: Path) -> None:
    segments = segment_dicts(new_id())
    storage = _seed_storage(tmp_path, segments)
    tools = Tools.detect()
    fake = FakeLipSyncProvider(storage)
    providers = replace(aws_providers({}, storage, tools), lip_sync=fake)
    env, lease = env_for(providers)
    task = _lip_sync_task(segments)

    out = lip_syncing.run(task, storage, tools, env)
    validate_schema("output-lipsync", out)
    parsed = LipSyncOutput.model_validate(out)
    video = f"{PREFIX}lip_syncing/lip-sync/job-1.mp4"
    assert parsed.applied is True and parsed.video == video
    assert parsed.provider == "fake-lipsync" and parsed.providerVersion == "v9"
    assert [r.segmentId for r in parsed.renders] == [s["id"] for s in segments]
    assert all(r.video == video and r.syncConfidence == 0.9 for r in parsed.renders)
    # One whole-episode shot with the source video and the uploaded speech track.
    [shot] = fake.shots
    track_uri = f"{PREFIX}lip_syncing/{SPEECH_TRACK_FILE}"
    assert shot == {"videoUri": SOURCE, "audioUri": track_uri, "durationUs": 12_000_000}
    assert storage.content_types[track_uri] == "audio/wav"
    track = tmp_path / "track.wav"
    storage.download(track_uri, track)
    assert wav_duration_us(track) == 12_000_000
    samples, rate = _read_mono_samples(track)
    assert max(abs(s) for s in samples[: int(0.1 * rate)]) > 1000  # segment 0 starts at 0 s
    assert max(abs(s) for s in samples[int(2.5 * rate) : int(4.0 * rate)]) == 0  # gap
    # The lease was heartbeaten while the vendor job ran.
    assert lease.beats == 2 and lease.sleeps == [env.poll_interval_s] * 2
    # The output is persisted for the downstream stages.
    persisted = json.loads(storage.get(f"{PREFIX}lip_syncing/{LIP_SYNC_OUTPUT_FILE}"))
    assert persisted == out
    assert find_lip_sync_video(task, storage) == video


def test_lip_syncing_stage_keeps_the_mock_path(tmp_path: Path) -> None:
    segments = segment_dicts(new_id())
    storage = _seed_storage(tmp_path, segments)
    fake = FakeLipSyncProvider(storage)
    # Lip sync not requested: a real adapter is never called, nothing is persisted.
    providers = replace(aws_providers({}, storage), lip_sync=fake)
    env, _ = env_for(providers)
    out = lip_syncing.run(_lip_sync_task(segments, lip_sync=False), storage, Tools.none(), env)
    validate_schema("output-lipsync", out)
    assert out["applied"] is False and out["video"] is None and fake.shots == []
    assert all(r["video"] is None and r["syncConfidence"] == 0.0 for r in out["renders"])
    assert not any(k.endswith(LIP_SYNC_OUTPUT_FILE) for k in storage.objects)
    # Mock adapter with lip sync requested on a video asset: M1 behaviour.
    providers = replace(aws_providers({}, storage), lip_sync=MockLipSyncProvider())
    env, _ = env_for(providers)
    out = lip_syncing.run(_lip_sync_task(segments), storage, Tools.none(), env)
    assert out["provider"] == "mock-lipSync" and out["applied"] is False
    assert len(out["renders"]) == len(segments)


@pytest.mark.skipif(not Tools.detect().has_ffmpeg, reason="ffmpeg required")
def test_lip_syncing_stage_without_speech_renders_is_terminal(tmp_path: Path) -> None:
    segments = segment_dicts(new_id())
    storage = MemoryStorage()
    storage.put(SOURCE, b"original-video", "video/mp4")
    fake = FakeLipSyncProvider(storage)
    providers = replace(aws_providers({}, storage), lip_sync=fake)
    env, _ = env_for(providers)
    with pytest.raises(StageError) as info:
        lip_syncing.run(_lip_sync_task(segments), storage, Tools.detect(), env)
    assert info.value.code == "LIP_SYNC_NO_SPEECH" and not info.value.retryable
    assert fake.shots == []


def _persist_lip_sync(storage: MemoryStorage, segments: list[dict[str, Any]]) -> str:
    video = f"{PREFIX}lip_syncing/lip-sync/job-1.mp4"
    storage.put(video, b"lip-synced-video", "video/mp4")
    output = LipSyncOutput(
        provider="fake-lipsync",
        providerVersion="v9",
        applied=True,
        renders=[
            {"segmentId": s["id"], "syncConfidence": 0.9, "video": video}  # type: ignore[list-item]
            for s in segments
        ],
        video=video,
    )
    storage.put(
        f"{PREFIX}lip_syncing/{LIP_SYNC_OUTPUT_FILE}",
        json.dumps(output.model_dump()).encode(),
        "application/json",
    )
    return video


def test_encoding_uses_the_lip_synced_video_when_present() -> None:
    segments = segment_dicts(new_id())
    storage = MemoryStorage()
    storage.put(SOURCE, b"original-video", "video/mp4")
    providers = aws_providers({}, storage)  # ffmpeg encoder without ffmpeg: bytes pass through
    env, _ = env_for(providers)
    task = target_task("ENCODING", segments=segments, source=SOURCE, metadata=VIDEO_META)

    out = encoding.run(task, storage, Tools.none(), env)
    validate_schema("output-encoding", out)
    assert storage.get(str(out["encode"])) == b"original-video"

    video = _persist_lip_sync(storage, segments)
    assert find_lip_sync_video(task, storage) == video
    out = encoding.run(task, storage, Tools.none(), env)
    assert out["container"] == "mp4"
    assert storage.get(str(out["encode"])) == b"lip-synced-video"

    # A recorded but missing video, or a not-applied record, falls back to the source.
    storage.objects.pop(video)
    assert find_lip_sync_video(task, storage) is None
    out = encoding.run(task, storage, Tools.none(), env)
    assert storage.get(str(out["encode"])) == b"original-video"


def test_packaging_manifest_records_lip_sync(tmp_path: Path) -> None:
    segments = segment_dicts(new_id())
    storage = MemoryStorage()
    storage.put(SOURCE, b"original-video", "video/mp4")
    _persist_lip_sync(storage, segments)
    # PACKAGING ships the ENCODING artefact, which ENCODING built from the lip-synced video.
    storage.put(f"{PREFIX}encoding/encode.mp4", b"encoded-lip-synced", "video/mp4")
    providers = aws_providers({}, storage)
    env, _ = env_for(providers)

    def make(payload: dict[str, Any]) -> WorkerTask:
        payload["parameters"]["lipSync"] = True
        return WorkerTask.model_validate(payload)

    task = target_task(
        "PACKAGING",
        segments=segments,
        speech=_speech_inputs(segments),
        source=SOURCE,
        metadata=VIDEO_META,
        package_version=1,
        deliverables_prefix="s3://deliverables/org/t1/v1/",
        make=make,
    )
    out = packaging.run(task, storage, Tools.none(), env)
    validate_schema("output-packaging", out)
    manifest = out["manifest"]
    assert isinstance(manifest, dict)
    assert manifest["lipSyncApplied"] is True and manifest["mock"] is False
    assert "mouth" in str(manifest["disclosure"]).lower()
    media = next(d for d in out["deliverables"] if d["kind"] == "media")  # type: ignore[union-attr]
    assert storage.get(media["uri"]) == b"encoded-lip-synced"
