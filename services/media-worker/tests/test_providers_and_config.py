import pytest

from polycast_worker.config import DEFAULT_WORKER_TOKEN, WorkerConfig
from polycast_worker.models import TimeRange, WorkerTask
from polycast_worker.providers import (
    LipSyncProvider,
    ProviderContext,
    QualityProvider,
    SpeechProvider,
    TranscriptionProvider,
    TranslationProvider,
)
from polycast_worker.providers.aws.clients import ClientFactory
from polycast_worker.providers.aws.ses import SesNotifier
from polycast_worker.providers.inapp import InAppNotifier
from polycast_worker.providers.mock import (
    MockLipSyncProvider,
    MockQualityProvider,
    MockSpeechProvider,
    MockTranscriptionProvider,
    MockTranslationProvider,
)
from polycast_worker.providers.registry import build_providers
from polycast_worker.tools import Tools

from .aws_stubs import MemoryStorage
from .conftest import new_id


def test_mock_adapters_satisfy_protocols_and_are_never_production():
    assert isinstance(MockTranscriptionProvider(), TranscriptionProvider)
    assert isinstance(MockTranslationProvider(), TranslationProvider)
    assert isinstance(MockSpeechProvider(), SpeechProvider)
    assert isinstance(MockLipSyncProvider(), LipSyncProvider)
    assert isinstance(MockQualityProvider(), QualityProvider)
    for p in (
        MockTranscriptionProvider(),
        MockTranslationProvider(),
        MockSpeechProvider(),
        MockLipSyncProvider(),
        MockQualityProvider(),
    ):
        for cap in p.capabilities():
            assert cap.tier == "unavailable"
            assert cap.adapterId.startswith("mock-")
            assert cap.dataPolicy == "no-training"


def test_provider_context_data_policy_is_fixed():
    ctx = ProviderContext(
        organizationId="o",
        projectId="p",
        jobId="j",
        region="local",
        idempotencyKey="k" * 8,
        correlationId="c",
    )
    assert ctx.dataPolicy == "no-training"


def test_time_range_rejects_reversed():
    with pytest.raises(ValueError):
        TimeRange(start=10, end=5)
    assert TimeRange(start=5, end=10).duration_us == 5


def _task(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "taskId": new_id(),
        "organizationId": new_id(),
        "jobId": None,
        "targetJobId": None,
        "assetId": new_id(),
        "stage": "VALIDATING",
        "attempt": 1,
        "idempotencyKey": "k" * 12,
        "correlationId": "c",
        "storage": {
            "source": "local://source/a/b.wav",
            "derivedPrefix": "local://derived/a/",
            "deliverablesPrefix": None,
        },
        "parameters": {
            "assetId": new_id(),
            "projectId": new_id(),
            "quarantine": "local://quarantine/a/b.wav",
            "declaredContentType": "audio/wav",
            "declaredByteSize": 10,
            "maxDurationUs": 1000,
        },
        "taskToken": None,
        "leaseSeconds": 30,
    }
    base.update(overrides)
    return base


def test_worker_task_requires_idempotency_key_and_rejects_unknown_fields():
    with pytest.raises(ValueError):
        WorkerTask.model_validate(_task(idempotencyKey="short"))
    with pytest.raises(ValueError):
        WorkerTask.model_validate(_task(extra="nope"))
    with pytest.raises(ValueError):
        WorkerTask.model_validate(
            _task(
                storage={
                    "source": "http://x/y",
                    "derivedPrefix": "local://d/",
                    "deliverablesPrefix": None,
                }
            )
        )
    task = WorkerTask.model_validate(_task())
    assert task.validating_params().declaredByteSize == 10
    with pytest.raises(ValueError):
        task.target_params()


def test_production_config_fails_closed():
    with pytest.raises(RuntimeError, match="Refusing to start"):
        WorkerConfig.from_env({"POLYCAST_ENV": "production"})
    with pytest.raises(RuntimeError, match="WORKER_TOKEN"):
        WorkerConfig.from_env(
            {
                "POLYCAST_ENV": "production",
                "PROVIDER_MODE": "aws",
                "WORKER_QUEUE_URL": "q",
                "MEDIA_BUCKET_SOURCE": "b",
                "STORAGE_DRIVER": "s3",
                "WORKER_TOKEN": DEFAULT_WORKER_TOKEN,
            }
        )
    cfg = WorkerConfig.from_env(
        {
            "POLYCAST_ENV": "production",
            "PROVIDER_MODE": "aws",
            "WORKER_QUEUE_URL": "q",
            "MEDIA_BUCKET_SOURCE": "b",
            "STORAGE_DRIVER": "s3",
            "WORKER_TOKEN": "real-secret",
            "SES_FROM_ADDRESS": "noreply@example.test",
        }
    )
    assert cfg.region == "us-east-1"
    assert cfg.storage_driver == "s3"
    assert cfg.ses_from_address == "noreply@example.test"


def test_production_config_allows_missing_ses_sender():
    # Email is optional in production: without SES_FROM_ADDRESS notifications stay in-app.
    cfg = WorkerConfig.from_env(
        {
            "POLYCAST_ENV": "production",
            "PROVIDER_MODE": "aws",
            "WORKER_QUEUE_URL": "q",
            "MEDIA_BUCKET_SOURCE": "b",
            "STORAGE_DRIVER": "s3",
            "WORKER_TOKEN": "real-secret",
        }
    )
    assert cfg.env == "production" and cfg.ses_from_address is None
    providers = build_providers(
        cfg, ClientFactory.with_clients({}, cfg.region), storage=MemoryStorage(), tools=Tools.none()
    )
    assert providers.mode == "aws"
    assert isinstance(providers.notifier, InAppNotifier)
    assert not isinstance(providers.notifier, SesNotifier)
    # Everything else still fails closed.
    with pytest.raises(RuntimeError, match="STORAGE_DRIVER=s3"):
        WorkerConfig.from_env(
            {
                "POLYCAST_ENV": "production",
                "PROVIDER_MODE": "aws",
                "WORKER_QUEUE_URL": "q",
                "MEDIA_BUCKET_SOURCE": "b",
                "WORKER_TOKEN": "real-secret",
            }
        )


def test_development_config_defaults():
    cfg = WorkerConfig.from_env({})
    assert cfg.worker_token == DEFAULT_WORKER_TOKEN
    assert cfg.storage_driver == "local"
    assert str(cfg.local_storage_dir) == ".polycast-data/storage"
    with pytest.raises(RuntimeError, match="STORAGE_DRIVER"):
        WorkerConfig.from_env({"STORAGE_DRIVER": "gcs"})


PRODUCTION_ENV = {
    "POLYCAST_ENV": "production",
    "PROVIDER_MODE": "aws",
    "WORKER_QUEUE_URL": "q",
    "MEDIA_BUCKET_SOURCE": "b",
    "STORAGE_DRIVER": "s3",
    "WORKER_TOKEN": "real-secret",
}


def test_lip_sync_config_defaults_to_mock_and_fails_closed_for_synclabs():
    cfg = WorkerConfig.from_env({})
    assert cfg.lip_sync_provider == "mock" and cfg.synclabs_api_key is None
    assert cfg.synclabs_api_url == "https://api.sync.so"
    assert cfg.synclabs_model == "lipsync-2" and cfg.synclabs_sync_mode == "bounce"
    assert cfg.provider_url_ttl_s == 3600
    # The deployed default: mock provider with an empty key variable is fine, even in production.
    cfg = WorkerConfig.from_env({**PRODUCTION_ENV, "SYNCLABS_API_KEY": ""})
    assert cfg.lip_sync_provider == "mock" and cfg.synclabs_api_key is None
    # Selecting the vendor without a key refuses to start, with the variable named.
    with pytest.raises(RuntimeError, match="LIP_SYNC_PROVIDER=synclabs requires SYNCLABS_API_KEY"):
        WorkerConfig.from_env({**PRODUCTION_ENV, "LIP_SYNC_PROVIDER": "synclabs"})
    with pytest.raises(RuntimeError, match="SYNCLABS_API_KEY"):
        WorkerConfig.from_env({"LIP_SYNC_PROVIDER": "synclabs", "SYNCLABS_API_KEY": ""})
    with pytest.raises(RuntimeError, match="LIP_SYNC_PROVIDER"):
        WorkerConfig.from_env({"LIP_SYNC_PROVIDER": "wav2lip"})
    with pytest.raises(RuntimeError, match="https"):
        WorkerConfig.from_env(
            {
                "LIP_SYNC_PROVIDER": "synclabs",
                "SYNCLABS_API_KEY": "k",
                "SYNCLABS_API_URL": "http://x",
            }
        )
    with pytest.raises(RuntimeError, match="PROVIDER_URL_TTL_SECONDS"):
        WorkerConfig.from_env({"PROVIDER_URL_TTL_SECONDS": "soon"})
    with pytest.raises(RuntimeError, match="PROVIDER_URL_TTL_SECONDS"):
        WorkerConfig.from_env({"PROVIDER_URL_TTL_SECONDS": "0"})
    cfg = WorkerConfig.from_env(
        {
            **PRODUCTION_ENV,
            "LIP_SYNC_PROVIDER": "synclabs",
            "SYNCLABS_API_KEY": "sk-live",
            "SYNCLABS_API_URL": "https://api.sync.example/",
            "SYNCLABS_MODEL": "lipsync-2-pro",
            "SYNCLABS_SYNC_MODE": "loop",
            "PROVIDER_URL_TTL_SECONDS": "900",
        }
    )
    assert cfg.lip_sync_provider == "synclabs" and cfg.synclabs_api_key == "sk-live"
    assert cfg.synclabs_api_url == "https://api.sync.example"
    assert cfg.synclabs_model == "lipsync-2-pro" and cfg.synclabs_sync_mode == "loop"
    assert cfg.provider_url_ttl_s == 900
