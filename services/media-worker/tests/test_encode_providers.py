"""Encode providers: MediaConvert job settings + polling through a Stubber; ffmpeg via the stage."""

from __future__ import annotations

from pathlib import Path

import pytest
from botocore.stub import ANY

from polycast_worker.config import WorkerConfig
from polycast_worker.models import EncodingOutput
from polycast_worker.providers.aws.mediaconvert import (
    MediaConvertProvider,
    build_job_settings,
    output_uri,
)
from polycast_worker.stages import encoding
from polycast_worker.tools import Tools

from .aws_stubs import (
    MemoryStorage,
    aws_providers,
    env_for,
    recorded,
    segment_dicts,
    stub_client,
    target_task,
)
from .conftest import new_id, validate_schema, write_tone_wav

ROLE = "arn:aws:iam::123456789012:role/PolycastMediaConvert"
QUEUE = "arn:aws:mediaconvert:us-east-1:123456789012:queues/Default"


def test_job_settings_for_video_and_audio_only() -> None:
    video, ext = build_job_settings(
        source_uri="s3://source/org/asset.mp4",
        mix_uri="s3://derived/org/targets/t1/mixing/mix.wav",
        output_prefix="s3://derived/org/targets/t1/encoding/",
        has_video=True,
    )
    assert ext == "mp4"
    inp = video["Inputs"][0]
    assert inp["FileInput"] == "s3://source/org/asset.mp4"
    assert inp["AudioSelectors"]["Audio Selector 1"]["ExternalAudioFileInput"].endswith("mix.wav")
    out = video["OutputGroups"][0]["Outputs"][0]
    assert out["VideoDescription"]["CodecSettings"]["Codec"] == "H_264"
    assert out["AudioDescriptions"][0]["CodecSettings"]["Codec"] == "AAC"
    assert out["ContainerSettings"]["Container"] == "MP4"
    dest = video["OutputGroups"][0]["OutputGroupSettings"]["FileGroupSettings"]["Destination"]
    assert dest == "s3://derived/org/targets/t1/encoding/encode"
    audio, ext = build_job_settings(
        source_uri="s3://source/org/asset.wav",
        mix_uri=None,
        output_prefix="s3://derived/org/targets/t1/encoding",
        has_video=False,
    )
    assert ext == "mp3"
    out = audio["OutputGroups"][0]["Outputs"][0]
    assert "VideoDescription" not in out
    assert out["AudioDescriptions"][0]["CodecSettings"]["Codec"] == "MP3"
    assert out["ContainerSettings"]["Container"] == "RAW"
    assert audio["Inputs"][0]["AudioSelectors"]["Audio Selector 1"] == {
        "DefaultSelection": "DEFAULT"
    }
    assert output_uri("s3://derived/x/", "mp3") == "s3://derived/x/encode.mp3"


def test_mediaconvert_config_requires_arns() -> None:
    with pytest.raises(RuntimeError, match="MEDIACONVERT_ROLE_ARN, MEDIACONVERT_QUEUE_ARN"):
        WorkerConfig.from_env({"PROVIDER_MODE": "aws", "ENCODE_PROVIDER": "mediaconvert"})
    cfg = WorkerConfig.from_env(
        {
            "PROVIDER_MODE": "aws",
            "ENCODE_PROVIDER": "mediaconvert",
            "MEDIACONVERT_ROLE_ARN": ROLE,
            "MEDIACONVERT_QUEUE_ARN": QUEUE,
        }
    )
    assert cfg.encode_provider == "mediaconvert"


def test_encoding_stage_with_mediaconvert_polls_until_complete(tmp_path: Path) -> None:
    storage = MemoryStorage()
    client, stubber = stub_client("mediaconvert")
    segments = segment_dicts(new_id())
    task = target_task("ENCODING", segments=segments, source="s3://source/org/asset.wav")
    storage.put("s3://source/org/asset.wav", b"RIFF....WAVE", "audio/wav")
    mix_uri = "s3://derived/org/targets/t1/mixing/mix.wav"
    storage.put(mix_uri, write_tone_wav(tmp_path / "mix.wav", seconds=1.0), "audio/wav")
    settings, _ = build_job_settings(
        source_uri="s3://source/org/asset.wav",
        mix_uri=mix_uri,
        output_prefix=task.storage.derivedPrefix,
        has_video=False,
    )
    create = recorded("mediaconvert", "create_job", ROLE_ARN=ROLE, QUEUE_ARN=QUEUE)
    stubber.add_response(
        "create_job",
        create["response"],
        {
            "Role": ROLE,
            "Queue": QUEUE,
            "ClientRequestToken": task.idempotencyKey[:64],
            "Settings": settings,
            "Tags": ANY,
        },
    )
    for variant in ("progressing", "complete"):
        rec = recorded("mediaconvert", "get_job", variant, ROLE_ARN=ROLE)
        stubber.add_response("get_job", rec["response"], rec["expected_params"])
    # MediaConvert writes the object itself; the recorded run left an 8-byte MP3 stand-in.
    expected_uri = f"{task.storage.derivedPrefix}encode.mp3"
    storage.put(expected_uri, b"ID3\x04\x00\x00\x00\x00", "audio/mpeg")

    providers = aws_providers(
        {"mediaconvert": client},
        storage,
        ENCODE_PROVIDER="mediaconvert",
        MEDIACONVERT_ROLE_ARN=ROLE,
        MEDIACONVERT_QUEUE_ARN=QUEUE,
    )
    assert isinstance(providers.encode, MediaConvertProvider)
    env, lease = env_for(providers)
    out = encoding.run(task, storage, Tools.none(), env)
    validate_schema("output-encoding", out)
    stubber.assert_no_pending_responses()
    parsed = EncodingOutput.model_validate(out)
    assert parsed.encode == expected_uri and parsed.container == "mp3" and parsed.byteSize == 8
    assert lease.beats == 1 and lease.sleeps == [5.0]
    assert providers.encode.capabilities()[0].tier == "beta"


def test_encoding_stage_with_ffmpeg_provider_in_aws_mode(tmp_path: Path) -> None:
    tools = Tools.detect()
    if not tools.has_ffmpeg:
        pytest.skip("ffmpeg not installed")
    storage = MemoryStorage()
    source_uri = "s3://source/org/asset.wav"
    storage.put(source_uri, write_tone_wav(tmp_path / "src.wav", seconds=2.0), "audio/wav")
    task = target_task("ENCODING", segments=segment_dicts(new_id()), source=source_uri)
    providers = aws_providers({}, storage, tools)
    env, _ = env_for(providers)
    out = encoding.run(task, storage, tools, env)
    validate_schema("output-encoding", out)
    parsed = EncodingOutput.model_validate(out)
    assert parsed.container == "mp3" and parsed.encode.endswith("/encoding/encode.mp3")
    assert storage.size(parsed.encode) == parsed.byteSize > 0
    assert providers.encode.capabilities()[0].adapterId == "ffmpeg-encode"
    assert providers.encode.capabilities()[0].tier == "beta"
