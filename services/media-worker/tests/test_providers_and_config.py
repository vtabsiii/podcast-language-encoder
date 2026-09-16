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
from polycast_worker.providers.mock import (
    MockLipSyncProvider,
    MockQualityProvider,
    MockSpeechProvider,
    MockTranscriptionProvider,
    MockTranslationProvider,
)

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
        }
    )
    assert cfg.region == "us-east-1"
    assert cfg.storage_driver == "s3"


def test_development_config_defaults():
    cfg = WorkerConfig.from_env({})
    assert cfg.worker_token == DEFAULT_WORKER_TOKEN
    assert cfg.storage_driver == "local"
    assert str(cfg.local_storage_dir) == ".polycast-data/storage"
    with pytest.raises(RuntimeError, match="STORAGE_DRIVER"):
        WorkerConfig.from_env({"STORAGE_DRIVER": "gcs"})
