from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

import pytest

from polycast_worker.client import ApiClient, ApiError, Response, Transport
from polycast_worker.models import TaskError, TaskResult
from polycast_worker.runner import Heartbeat

from .conftest import validate_schema


@dataclass
class ScriptedTransport:
    """Returns queued responses in order; records every request."""

    responses: list[Response]
    requests: list[tuple[str, str, dict[str, str], bytes | None]] = field(default_factory=list)

    def request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Response:
        self.requests.append((method, url, headers, body))
        return self.responses.pop(0)


def _client(transport: Transport) -> ApiClient:
    return ApiClient("http://api.test:4000/", "tok-123", "worker-a", transport=transport)


def test_claim_sends_token_header_and_parses_204_and_200():
    t = ScriptedTransport(
        [Response(204, b""), Response(200, b'{"taskId": "x", "stage": "MIXING"}')]
    )
    c = _client(t)
    assert c.claim_raw() is None
    assert c.claim_raw(["MIXING"]) == {"taskId": "x", "stage": "MIXING"}
    method, url, headers, body = t.requests[0]
    assert (method, url) == ("POST", "http://api.test:4000/internal/v1/tasks/claim")
    assert headers["X-Worker-Token"] == "tok-123"
    assert json.loads(body or b"{}") == {"workerId": "worker-a"}
    assert json.loads(t.requests[1][3] or b"{}") == {"workerId": "worker-a", "stages": ["MIXING"]}


def test_error_classification():
    t = ScriptedTransport([Response(401, b""), Response(503, b""), Response(400, b"")])
    c = _client(t)
    with pytest.raises(ApiError) as e1:
        c.claim_raw()
    assert e1.value.retryable is False and "token" not in str(e1.value).lower()
    with pytest.raises(ApiError) as e2:
        c.claim_raw()
    assert e2.value.retryable is True
    with pytest.raises(ApiError) as e3:
        c.claim_raw()
    assert e3.value.retryable is False


def test_heartbeat_and_result_paths_and_contract():
    t = ScriptedTransport([Response(200, b'{"ok":true}'), Response(200, b'{"accepted":true}')])
    c = _client(t)
    c.heartbeat("task-1")
    assert t.requests[0][1] == "http://api.test:4000/internal/v1/tasks/task-1/heartbeat"
    result = TaskResult(
        status="failed",
        retryable=True,
        error=TaskError(code="STORAGE_IO", message="failed to read object"),
        output=None,
        workerId="worker-a",
    )
    assert c.post_result("task-1", result) == {"accepted": True}
    assert t.requests[1][1] == "http://api.test:4000/internal/v1/tasks/task-1/result"
    posted = json.loads(t.requests[1][3] or b"{}")
    validate_schema("task-result", posted)
    assert posted["error"] == {"code": "STORAGE_IO", "message": "failed to read object"}


def test_heartbeat_thread_beats_while_task_runs():
    beats: list[float] = []
    with Heartbeat(lambda: beats.append(time.monotonic()), 0.05) as hb:
        time.sleep(0.3)
    assert hb.beats >= 3
    assert len(beats) == hb.beats


def test_heartbeat_swallows_api_errors():
    def boom() -> None:
        raise ApiError("api error", status=503, retryable=True)

    with Heartbeat(boom, 0.05) as hb:
        time.sleep(0.15)
    assert hb.beats == 0
