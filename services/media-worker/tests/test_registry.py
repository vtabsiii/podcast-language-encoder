"""Provider registry: local = mocks (M1 behaviour), aws = beta adapters, never production."""

from __future__ import annotations

from pathlib import Path

import pytest

from polycast_worker.config import WorkerConfig
from polycast_worker.providers import (
    LipSyncProvider,
    MediaEncodeProvider,
    QualityProvider,
    SpeechProvider,
    TranscriptionProvider,
    TranslationProvider,
)
from polycast_worker.providers.aws.bedrock import BedrockTranslationProvider
from polycast_worker.providers.aws.clients import ClientFactory
from polycast_worker.providers.aws.locales import SEED_LOCALES
from polycast_worker.providers.aws.mediaconvert import MediaConvertProvider
from polycast_worker.providers.aws.polly import PollyProvider
from polycast_worker.providers.aws.ses import SesNotifier
from polycast_worker.providers.aws.transcribe import TranscribeProvider
from polycast_worker.providers.aws.translate import TranslateProvider
from polycast_worker.providers.base import Mixer, Notifier, TimingFitter
from polycast_worker.providers.ffmpeg import DubMixer, FfmpegEncodeProvider, PassthroughMixer
from polycast_worker.providers.inapp import InAppNotifier
from polycast_worker.providers.mock import MockLipSyncProvider, MockTranslationProvider
from polycast_worker.providers.quality import InHouseQualityProvider
from polycast_worker.providers.registry import build_providers
from polycast_worker.providers.synclabs import SyncLabsLipSyncProvider
from polycast_worker.stages import packaging
from polycast_worker.stages.common import StageError, sibling_uri
from polycast_worker.tools import Tools

from .aws_stubs import MemoryStorage, aws_config, aws_providers, segment_dicts, target_task
from .conftest import new_id


def test_local_mode_is_the_mock_set(tmp_path: Path) -> None:
    cfg = WorkerConfig.from_env({"LOCAL_STORAGE_DIR": str(tmp_path)})
    providers = build_providers(cfg, tools=Tools.none())
    assert providers.mode == "local" and providers.is_mock and providers.region == "local"
    assert isinstance(providers.translation, MockTranslationProvider)
    assert isinstance(providers.lip_sync, MockLipSyncProvider)
    assert isinstance(providers.encode, FfmpegEncodeProvider)
    assert isinstance(providers.mixer, PassthroughMixer)
    assert isinstance(providers.notifier, InAppNotifier)
    assert {r.tier for r in providers.capabilities()} == {"unavailable"}
    assert [r.adapterId for r in providers.capabilities(locale="es-MX", lip_sync=False)] == [
        "mock-transcription",
        "mock-translation",
        "mock-speech",
        "ffmpeg-encode",
        "mock-quality",
    ]


def test_aws_mode_registers_beta_adapters_and_never_production() -> None:
    storage = MemoryStorage()
    providers = aws_providers({}, storage)
    assert providers.mode == "aws" and not providers.is_mock and providers.region == "us-east-1"
    assert isinstance(providers.transcription, TranscribeProvider)
    assert isinstance(providers.translation, TranslateProvider)
    assert isinstance(providers.speech, PollyProvider)
    assert isinstance(providers.encode, FfmpegEncodeProvider)
    assert isinstance(providers.quality, InHouseQualityProvider)
    assert isinstance(providers.notifier, InAppNotifier)  # no SES sender configured
    assert isinstance(providers.mixer, DubMixer) and isinstance(providers.mixer, Mixer)
    assert isinstance(providers.timing, TimingFitter) and isinstance(providers.notifier, Notifier)
    for p, proto in (
        (providers.transcription, TranscriptionProvider),
        (providers.translation, TranslationProvider),
        (providers.speech, SpeechProvider),
        (providers.lip_sync, LipSyncProvider),
        (providers.encode, MediaEncodeProvider),
        (providers.quality, QualityProvider),
    ):
        assert isinstance(p, proto)
    records = providers.capabilities()
    assert records and all(r.tier != "production" for r in records)
    assert all(r.dataPolicy == "no-training" for r in records)
    assert {r.tier for r in records} == {"beta", "unavailable"}
    for kind in ("transcription", "translation", "speech"):
        locales = {r.locale for r in records if r.kind == kind}
        assert locales == set(SEED_LOCALES), kind
    assert {r.adapterId for r in records if r.tier == "beta"} >= {
        "aws-transcribe",
        "aws-translate",
        "aws-polly",
        "ffmpeg-encode",
        "inhouse-quality",
    }
    narrowed = providers.capabilities(locale="pt-BR")
    assert {r.locale for r in narrowed} == {None, "pt-BR"}


def test_aws_mode_selects_bedrock_mediaconvert_and_ses() -> None:
    providers = aws_providers(
        {},
        MemoryStorage(),
        TRANSLATION_PROVIDER="bedrock",
        BEDROCK_MODEL_ID="anthropic.claude-3-5-haiku-20241022-v1:0",
        ENCODE_PROVIDER="mediaconvert",
        MEDIACONVERT_ROLE_ARN="arn:aws:iam::1:role/mc",
        MEDIACONVERT_QUEUE_ARN="arn:aws:mediaconvert:us-east-1:1:queues/Default",
        SES_FROM_ADDRESS="noreply@polycast.test",
        POLLY_ENGINE="long-form",
    )
    assert isinstance(providers.translation, BedrockTranslationProvider)
    assert isinstance(providers.encode, MediaConvertProvider)
    assert isinstance(providers.notifier, SesNotifier)
    assert isinstance(providers.speech, PollyProvider) and providers.speech.engine == "long-form"
    assert all(r.tier != "production" for r in providers.capabilities())
    with pytest.raises(RuntimeError, match="TRANSLATION_PROVIDER"):
        aws_config(TRANSLATION_PROVIDER="gpt")
    with pytest.raises(RuntimeError, match="POLLY_ENGINE"):
        aws_config(POLLY_ENGINE="standard")
    with pytest.raises(RuntimeError, match="PROVIDER_MODE"):
        WorkerConfig.from_env({"PROVIDER_MODE": "azure"})


def test_client_factory_is_lazy_and_cached() -> None:
    factory = ClientFactory("us-east-1")
    assert factory.client("polly") is factory.client("polly")
    assert factory.client("polly").meta.region_name == "us-east-1"
    injected = ClientFactory.with_clients({"ses": object()})
    assert isinstance(injected.client("ses"), object)


def test_packaging_manifest_in_aws_mode_is_honest(tmp_path: Path) -> None:
    from .conftest import validate_schema, write_tone_wav

    storage = MemoryStorage()
    segments = segment_dicts(new_id())
    source = "s3://source/org/asset.wav"
    storage.put(source, write_tone_wav(tmp_path / "s.wav", seconds=1.0), "audio/wav")
    tv = new_id()
    task = target_task(
        "PACKAGING",
        segments=segments,
        translations=[
            {
                "translationVersionId": tv,
                "segmentId": segments[0]["id"],
                "adaptedText": "Hola",
                "timingBudgetUs": 4_160_000,
                "generation": 1,
            }
        ],
        speech=[
            {
                "renderId": new_id(),
                "translationVersionId": tv,
                "segmentId": segments[0]["id"],
                "measuredDurationUs": 4_000_000,
                "timeStretchRatio": 1.0,
                "voiceId": "Mia",
            }
        ],
        source=source,
        package_version=1,
        deliverables_prefix="s3://deliverables/org/t1/v1/",
    )
    providers = aws_providers({}, storage)
    from .aws_stubs import env_for

    env, _ = env_for(providers)
    # With real providers the untouched source is never packaged in place of the encode.
    with pytest.raises(StageError) as info:
        packaging.run(task, storage, Tools.none(), env)
    assert info.value.code == "ENCODE_MISSING"
    storage.put(sibling_uri(task, "ENCODING", "encode.mp3"), b"ID3fake-mp3-bytes", "audio/mpeg")
    out = packaging.run(task, storage, Tools.none(), env)
    validate_schema("output-packaging", out)
    manifest = out["manifest"]
    assert isinstance(manifest, dict)
    assert manifest["mock"] is False and manifest["syntheticVoice"] is True
    assert manifest["lipSyncApplied"] is False
    assert "synthetic" in str(manifest["disclosure"]).lower()
    models = manifest["models"]
    assert isinstance(models, list)
    assert {m["tier"] for m in models} == {"beta"}
    assert {m["adapterId"] for m in models} == {
        "aws-transcribe",
        "aws-translate",
        "aws-polly",
        "ffmpeg-encode",
        "inhouse-quality",
    }


def test_aws_mode_wires_synclabs_only_when_selected(tmp_path: Path) -> None:
    storage = MemoryStorage()
    default = aws_providers({}, storage, SYNCLABS_API_KEY="sk-unused")
    assert isinstance(default.lip_sync, MockLipSyncProvider)
    assert [r.adapterId for r in default.capabilities(lip_sync=True) if r.kind == "lipSync"] == [
        "mock-lipSync"
    ]
    providers = aws_providers(
        {},
        storage,
        LIP_SYNC_PROVIDER="synclabs",
        SYNCLABS_API_KEY="sk-test",
        SYNCLABS_MODEL="lipsync-2",
        SYNCLABS_SYNC_MODE="bounce",
    )
    assert isinstance(providers.lip_sync, SyncLabsLipSyncProvider)
    assert isinstance(providers.lip_sync, LipSyncProvider)
    lip = [r for r in providers.capabilities(lip_sync=True) if r.kind == "lipSync"]
    assert [(r.adapterId, r.tier, r.version) for r in lip] == [
        ("synclabs-lipsync", "beta", "lipsync-2")
    ]
    assert all(r.kind != "lipSync" for r in providers.capabilities())
    assert all(r.tier != "production" for r in providers.capabilities(lip_sync=True))
    # Local mode never talks to a vendor, whatever the selection says.
    cfg = WorkerConfig.from_env(
        {
            "LIP_SYNC_PROVIDER": "synclabs",
            "SYNCLABS_API_KEY": "sk-test",
            "LOCAL_STORAGE_DIR": str(tmp_path),
        }
    )
    assert isinstance(build_providers(cfg, tools=Tools.none()).lip_sync, MockLipSyncProvider)
    with pytest.raises(RuntimeError, match="SYNCLABS_API_KEY"):
        aws_config(LIP_SYNC_PROVIDER="synclabs")
