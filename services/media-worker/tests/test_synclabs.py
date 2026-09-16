"""sync.so lip-sync adapter: request shape, polling, download and failure mapping.

`urllib.request.urlopen` is monkeypatched with a scripted vendor; no test opens a socket.
"""

from __future__ import annotations

import io
import json
import logging
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from polycast_worker.providers import LipSyncProvider
from polycast_worker.providers.base import AsyncHandle, ProviderContext, ProviderError
from polycast_worker.providers.synclabs import (
    ADAPTER_ID,
    SyncLabsLipSyncProvider,
    build_generate_request,
    classify_status,
    find_confidence,
    find_output_url,
    output_uri,
    safe_job_id,
)
from polycast_worker.storage import LocalFsStorage
from polycast_worker.tools import Tools

from .aws_stubs import MemoryStorage

API_KEY = "sk-test-not-a-real-key"  # noqa: S105 - fixture value
BASE = "https://api.sync.test"
JOB_ID = "job_42"
OUTPUT_URL = "https://cdn.sync.test/renders/out.mp4"
PREFIX = "s3://derived/org/targets/t1/lip_syncing/"
VIDEO = "s3://source/org/asset.mp4"
AUDIO = PREFIX + "lip-sync/speech-track.wav"


class _Resp(io.BytesIO):
    def __init__(self, data: bytes, status: int = 200) -> None:
        super().__init__(data)
        self.status = status


class FakeVendor:
    """Scripted sync.so: one job, poll statuses consumed in order, output bytes on GET."""

    def __init__(
        self,
        statuses: list[str] | None = None,
        *,
        output: bytes = b"lip-synced-mp4",
        completed_payload: dict[str, Any] | None = None,
        create_payload: dict[str, Any] | None = None,
        fail_with: Exception | None = None,
    ) -> None:
        self.statuses = list(statuses or ["PENDING", "processing", "COMPLETED"])
        self.output = output
        self.completed_payload = completed_payload
        self.create_payload = create_payload
        self.fail_with = fail_with
        self.calls: list[dict[str, Any]] = []

    def __call__(self, req: urllib.request.Request, timeout: float | None = None) -> _Resp:
        headers = {k.lower(): v for k, v in req.header_items()}
        body = json.loads(req.data) if req.data else None
        self.calls.append(
            {
                "method": req.get_method(),
                "url": req.full_url,
                "headers": headers,
                "body": body,
                "timeout": timeout,
            }
        )
        if self.fail_with is not None:
            raise self.fail_with
        if req.get_method() == "POST" and req.full_url == f"{BASE}/v2/generate":
            payload = self.create_payload or {"id": JOB_ID, "status": "PENDING"}
            return _Resp(json.dumps(payload).encode())
        if req.get_method() == "GET" and req.full_url == f"{BASE}/v2/generate/{JOB_ID}":
            status = self.statuses.pop(0)
            payload: dict[str, Any] = {"id": JOB_ID, "status": status}
            if classify_status(status) == "completed":
                payload.update(self.completed_payload or {"outputUrl": OUTPUT_URL})
            if classify_status(status) == "failed":
                payload["error"] = "face not detected https://should-never-leak.test"
            return _Resp(json.dumps(payload).encode())
        if req.get_method() == "GET" and req.full_url == OUTPUT_URL:
            return _Resp(self.output)
        raise AssertionError(f"unexpected vendor call {req.get_method()} {req.full_url}")


def _ctx() -> ProviderContext:
    return ProviderContext(
        organizationId="org",
        projectId="proj",
        jobId="job",
        region="us-east-1",
        idempotencyKey="idem-lip-sync-1",
        correlationId="corr",
        derivedPrefix=PREFIX,
    )


def _provider(storage: Any, **kw: Any) -> SyncLabsLipSyncProvider:
    return SyncLabsLipSyncProvider(
        API_KEY, storage=storage, tools=Tools.none(), api_url=BASE + "/", **kw
    )


def test_pure_helpers_cover_the_documented_shape() -> None:
    body = build_generate_request(
        model="lipsync-2", video_url="https://v", audio_url="https://a", sync_mode="bounce"
    )
    assert body == {
        "model": "lipsync-2",
        "input": [{"type": "video", "url": "https://v"}, {"type": "audio", "url": "https://a"}],
        "options": {"sync_mode": "bounce"},
    }
    assert classify_status("pending") == "running"
    assert classify_status("PROCESSING") == "running"
    assert classify_status("completed") == "completed"
    assert classify_status("Failed") == "failed"
    assert classify_status("REJECTED") == "failed"
    assert classify_status("error") == "failed"
    assert classify_status(None) == "running"
    assert find_output_url({"output_url": "https://x"}) == "https://x"
    assert find_output_url({"outputURL": "https://y"}) == "https://y"
    assert find_output_url({"output": {"url": "https://z"}}) == "https://z"
    assert find_output_url({"status": "COMPLETED"}) is None
    assert find_confidence({}) == 1.0
    assert find_confidence({"syncConfidence": 0.87}) == 0.87
    assert find_confidence({"confidence": 7}) == 1.0
    assert find_confidence({"confidence": True}) == 1.0
    assert safe_job_id("a/b c") == "a-b-c"
    assert output_uri(PREFIX, "job_42") == PREFIX + "lip-sync/job_42.mp4"
    with pytest.raises(ProviderError):
        safe_job_id("..")


def test_capabilities_register_beta_and_never_production() -> None:
    provider = _provider(MemoryStorage(), model="lipsync-2-pro")
    assert isinstance(provider, LipSyncProvider)
    [record] = provider.capabilities()
    assert record.adapterId == ADAPTER_ID and record.kind == "lipSync"
    assert record.tier == "beta" and record.locale is None
    assert record.version == "lipsync-2-pro" and record.dataPolicy == "no-training"
    with pytest.raises(ValueError):
        SyncLabsLipSyncProvider("", storage=MemoryStorage(), tools=Tools.none())
    with pytest.raises(ProviderError):
        SyncLabsLipSyncProvider(
            "k", storage=MemoryStorage(), tools=Tools.none(), api_url="http://x"
        )


def test_render_polls_to_completion_and_stores_the_output(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    storage = MemoryStorage()
    storage.put(VIDEO, b"video", "video/mp4")
    storage.put(AUDIO, b"wav", "audio/wav")
    vendor = FakeVendor()
    monkeypatch.setattr(urllib.request, "urlopen", vendor)
    provider = _provider(storage, sync_mode="cut_off", url_ttl_s=1800)
    ctx = _ctx()

    handle = provider.render({"videoUri": VIDEO, "audioUri": AUDIO, "durationUs": 12}, ctx)
    assert handle == AsyncHandle(adapterId=ADAPTER_ID, externalId=JOB_ID)
    create = vendor.calls[0]
    assert create["method"] == "POST" and create["url"] == f"{BASE}/v2/generate"
    assert create["headers"]["x-api-key"] == API_KEY
    assert create["headers"]["content-type"] == "application/json"
    assert create["timeout"] is not None
    assert create["body"]["model"] == "lipsync-2"
    assert create["body"]["options"] == {"sync_mode": "cut_off"}
    video_in, audio_in = create["body"]["input"]
    assert video_in == {"type": "video", "url": storage.presigned_get_url(VIDEO, 1800)}
    assert audio_in == {"type": "audio", "url": storage.presigned_get_url(AUDIO, 1800)}

    assert provider.evaluate(handle, ctx) is None
    assert provider.evaluate(handle, ctx) is None
    result = provider.evaluate(handle, ctx)
    expected_uri = PREFIX + "lip-sync/job_42.mp4"
    assert result == {
        "status": "COMPLETED",
        "applied": True,
        "syncConfidence": 1.0,
        "video": expected_uri,
    }
    assert storage.get(expected_uri) == b"lip-synced-mp4"
    assert storage.content_types[expected_uri] == "video/mp4"
    polls = [c for c in vendor.calls if c["method"] == "GET" and "/v2/generate/" in c["url"]]
    assert len(polls) == 3 and all(c["headers"]["x-api-key"] == API_KEY for c in polls)
    download = vendor.calls[-1]
    assert download["url"] == OUTPUT_URL and "x-api-key" not in download["headers"]
    # A-17: neither the key nor the signed URLs may reach the log.
    assert API_KEY not in caplog.text and "X-Amz-Expires" not in caplog.text


def test_completion_reads_alternate_fields_and_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = MemoryStorage()
    storage.put(VIDEO, b"v", "video/mp4")
    storage.put(AUDIO, b"a", "audio/wav")
    vendor = FakeVendor(
        ["Completed"],
        completed_payload={"output_url": OUTPUT_URL, "syncConfidence": 0.42},
        create_payload={"jobId": JOB_ID, "status": "QUEUED"},
    )
    monkeypatch.setattr(urllib.request, "urlopen", vendor)
    provider = _provider(storage)
    handle = provider.render({"videoUri": VIDEO, "audioUri": AUDIO}, _ctx())
    assert handle.externalId == JOB_ID
    result = provider.evaluate(handle, _ctx())
    assert result is not None and result["syncConfidence"] == 0.42
    assert storage.exists(PREFIX + "lip-sync/job_42.mp4")


def test_failed_job_is_terminal_and_never_echoes_the_vendor_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = MemoryStorage()
    storage.put(VIDEO, b"v", "video/mp4")
    storage.put(AUDIO, b"a", "audio/wav")
    vendor = FakeVendor(["PENDING", "FAILED"])
    monkeypatch.setattr(urllib.request, "urlopen", vendor)
    provider = _provider(storage)
    handle = provider.render({"videoUri": VIDEO, "audioUri": AUDIO}, _ctx())
    assert provider.evaluate(handle, _ctx()) is None
    with pytest.raises(ProviderError) as info:
        provider.evaluate(handle, _ctx())
    assert info.value.code == "LIP_SYNC_FAILED" and not info.value.retryable
    assert "should-never-leak" not in info.value.message
    assert not storage.exists(PREFIX + "lip-sync/job_42.mp4")


def test_completed_without_output_or_empty_download_is_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = MemoryStorage()
    storage.put(VIDEO, b"v", "video/mp4")
    storage.put(AUDIO, b"a", "audio/wav")
    vendor = FakeVendor(["COMPLETED", "COMPLETED"], completed_payload={"note": "no url"})
    monkeypatch.setattr(urllib.request, "urlopen", vendor)
    provider = _provider(storage)
    handle = provider.render({"videoUri": VIDEO, "audioUri": AUDIO}, _ctx())
    with pytest.raises(ProviderError) as info:
        provider.evaluate(handle, _ctx())
    assert info.value.code == "PROVIDER_BAD_OUTPUT" and info.value.retryable
    vendor.completed_payload = {"outputUrl": OUTPUT_URL}
    vendor.output = b""
    with pytest.raises(ProviderError) as info:
        provider.evaluate(handle, _ctx())
    assert info.value.code == "PROVIDER_BAD_OUTPUT" and info.value.retryable


@pytest.mark.parametrize(
    ("exc", "code", "retryable"),
    [
        (urllib.error.HTTPError(BASE, 401, "Unauthorized", None, None), "PROVIDER_ERROR", False),  # type: ignore[arg-type]
        (urllib.error.HTTPError(BASE, 422, "Unprocessable", None, None), "PROVIDER_ERROR", False),  # type: ignore[arg-type]
        (urllib.error.HTTPError(BASE, 429, "Too Many", None, None), "PROVIDER_THROTTLED", True),  # type: ignore[arg-type]
        (urllib.error.HTTPError(BASE, 503, "Down", None, None), "PROVIDER_THROTTLED", True),  # type: ignore[arg-type]
        (urllib.error.URLError("dns"), "PROVIDER_UNAVAILABLE", True),
        (TimeoutError(), "PROVIDER_UNAVAILABLE", True),
    ],
)
def test_transport_errors_map_to_typed_provider_errors(
    monkeypatch: pytest.MonkeyPatch, exc: Exception, code: str, retryable: bool
) -> None:
    storage = MemoryStorage()
    storage.put(VIDEO, b"v", "video/mp4")
    storage.put(AUDIO, b"a", "audio/wav")
    monkeypatch.setattr(urllib.request, "urlopen", FakeVendor(fail_with=exc))
    provider = _provider(storage)
    with pytest.raises(ProviderError) as info:
        provider.render({"videoUri": VIDEO, "audioUri": AUDIO}, _ctx())
    assert info.value.code == code and info.value.retryable is retryable
    assert API_KEY not in info.value.message


def test_bad_create_responses_are_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    storage = MemoryStorage()
    storage.put(VIDEO, b"v", "video/mp4")
    storage.put(AUDIO, b"a", "audio/wav")
    monkeypatch.setattr(urllib.request, "urlopen", FakeVendor(create_payload={"status": "PENDING"}))
    with pytest.raises(ProviderError) as info:
        _provider(storage).render({"videoUri": VIDEO, "audioUri": AUDIO}, _ctx())
    assert info.value.code == "PROVIDER_BAD_OUTPUT" and info.value.retryable
    with pytest.raises(ValueError):
        _provider(storage).render({"segmentId": "x"}, _ctx())


def test_local_storage_cannot_feed_an_external_vendor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalFsStorage(tmp_path)
    storage.put("local://source/org/asset.mp4", b"v", "video/mp4")
    storage.put("local://derived/org/t/speech-track.wav", b"a", "audio/wav")
    vendor = FakeVendor()
    monkeypatch.setattr(urllib.request, "urlopen", vendor)
    provider = _provider(storage)
    ctx = _ctx().model_copy(update={"derivedPrefix": "local://derived/org/t/"})
    with pytest.raises(ProviderError) as info:
        provider.render(
            {
                "videoUri": "local://source/org/asset.mp4",
                "audioUri": "local://derived/org/t/speech-track.wav",
            },
            ctx,
        )
    assert info.value.code == "PROVIDER_ERROR" and not info.value.retryable
    assert vendor.calls == []  # nothing was sent to the vendor
