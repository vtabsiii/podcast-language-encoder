"""HTTP client for the API's internal worker endpoints (urllib only, no extra dependency).

    POST {api}/internal/v1/tasks/claim               → 200 WorkerTask | 204 nothing queued
    POST {api}/internal/v1/tasks/{taskId}/heartbeat  → {"ok": true}
    POST {api}/internal/v1/tasks/{taskId}/result     → {"accepted": bool, "nextState": ...}

Every request carries `X-Worker-Token`. The token is never logged.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .models import ClaimTaskRequest, Stage, TaskResult, WorkerTask


class ApiError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes

    def json(self) -> Any:
        if not self.body:
            return None
        return json.loads(self.body.decode("utf-8"))


class Transport(Protocol):
    def request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Response: ...


class UrllibTransport:
    def request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Response:
        if not url.startswith(("http://", "https://")):
            raise ApiError("api url must be http(s)", retryable=False)
        req = urllib.request.Request(url, data=body, headers=headers, method=method)  # noqa: S310
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                return Response(status=int(resp.status), body=resp.read())
        except urllib.error.HTTPError as e:
            return Response(status=int(e.code), body=e.read())
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ApiError("api unreachable", retryable=True) from e


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        worker_id: str,
        *,
        transport: Transport | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.worker_id = worker_id
        self._token = token
        self._transport: Transport = transport or UrllibTransport()
        self._timeout = timeout_s

    def _post(self, path: str, payload: dict[str, Any]) -> Response:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Worker-Token": self._token,
        }
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        resp = self._transport.request("POST", self.base_url + path, headers, body, self._timeout)
        if resp.status in (401, 403):
            raise ApiError("worker credentials rejected", status=resp.status, retryable=False)
        if resp.status >= 500 or resp.status == 429:
            raise ApiError("api error", status=resp.status, retryable=True)
        if resp.status >= 400:
            raise ApiError("api rejected request", status=resp.status, retryable=False)
        return resp

    def claim_raw(self, stages: list[Stage] | None = None) -> dict[str, Any] | None:
        """Claim the next task as a raw dict (None on 204). Parsing is the caller's job so a
        malformed task can still be failed by id instead of crashing the loop."""
        req = ClaimTaskRequest(workerId=self.worker_id, stages=stages)
        resp = self._post("/internal/v1/tasks/claim", req.model_dump())
        if resp.status == 204 or not resp.body:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            raise ApiError("claim response is not an object", status=resp.status, retryable=False)
        return data

    def claim(self, stages: list[Stage] | None = None) -> WorkerTask | None:
        data = self.claim_raw(stages)
        return None if data is None else WorkerTask.model_validate(data)

    def heartbeat(self, task_id: str) -> None:
        self._post(f"/internal/v1/tasks/{task_id}/heartbeat", {"workerId": self.worker_id})

    def post_result(self, task_id: str, result: TaskResult) -> dict[str, Any]:
        resp = self._post(f"/internal/v1/tasks/{task_id}/result", result.model_dump())
        data = resp.json()
        return data if isinstance(data, dict) else {}
