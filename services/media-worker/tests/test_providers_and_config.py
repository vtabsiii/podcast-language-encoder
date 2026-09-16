import pytest

from polycast_worker.config import WorkerConfig
from polycast_worker.models import TimeRange, WorkerTask
from polycast_worker.providers import ProviderContext, SpeechProvider, TranscriptionProvider
from polycast_worker.providers.mock import MockSpeechProvider, MockTranscriptionProvider


def test_mock_adapters_satisfy_protocols_and_are_never_production():
    assert isinstance(MockTranscriptionProvider(), TranscriptionProvider)
    assert isinstance(MockSpeechProvider(), SpeechProvider)
    for p in (MockTranscriptionProvider(), MockSpeechProvider()):
        for cap in p.capabilities():
            assert cap.tier == "unavailable"
            assert cap.adapterId.startswith("mock-")


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


def test_worker_task_requires_idempotency_key():
    with pytest.raises(ValueError):
        WorkerTask(
            taskId="t",
            organizationId="o",
            jobId="j",
            targetJobId=None,
            stage="VALIDATING",
            idempotencyKey="short",
            correlationId="c",
            inputAssetIds=[],
            parameters={},
            taskToken=None,
        )


def test_production_config_fails_closed():
    with pytest.raises(RuntimeError, match="Refusing to start"):
        WorkerConfig.from_env({"POLYCAST_ENV": "production"})
    cfg = WorkerConfig.from_env(
        {
            "POLYCAST_ENV": "production",
            "PROVIDER_MODE": "aws",
            "WORKER_QUEUE_URL": "q",
            "MEDIA_BUCKET_SOURCE": "b",
        }
    )
    assert cfg.region == "us-east-1"
