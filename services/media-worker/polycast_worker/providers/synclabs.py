"""sync.so (Sync Labs) lip-sync adapter (LipSyncProvider) for the `lipsync-2` model family.

The vendor renders one whole episode per job: it fetches the source video and the dubbed
speech track over HTTPS, returns a job id, and exposes the lip-synced MP4 at an output URL
once the job completes. This adapter

    render()    presigns both storage objects (Storage.presigned_get_url), POSTs
                {base}/v2/generate and returns the job id as an AsyncHandle
    evaluate()  GETs {base}/v2/generate/{id}; None while pending, a COMPLETED result with the
                downloaded video stored under `lip-sync/<job id>.mp4` in the task's derived
                prefix, or a ProviderError when the vendor reports failure

The request/response shape was implemented from the published v2 API and has not yet been
exercised against the live service from this repository; every field name, the base URL, the
model and the sync mode are configurable, and the response parsing is deliberately lenient
(status matched case-insensitively, several spellings of the output URL accepted).

Sync confidence: the v2 API does not report one. A completed job is recorded with
`syncConfidence` 1.0 unless the payload carries a numeric `syncConfidence`/`confidence`.

Security (A-17): the API key travels only in the `x-api-key` header, the presigned URLs only
in the request body, and neither is ever logged or placed in an error message. The worker uses
`urllib.request` from the standard library; no new dependency.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from ..storage import Storage, StorageError, StorageUriError, join_uri
from ..tools import Tools
from .base import AsyncHandle, CapabilityRecord, ProviderContext, ProviderError

ADAPTER_ID = "synclabs-lipsync"
DEFAULT_API_URL = "https://api.sync.so"
DEFAULT_MODEL = "lipsync-2"
DEFAULT_SYNC_MODE = "bounce"
DEFAULT_URL_TTL_S = 3600
GENERATE_PATH = "/v2/generate"
OUTPUT_DIR = "lip-sync"
REQUEST_TIMEOUT_S = 60.0
DOWNLOAD_TIMEOUT_S = 900.0
MAX_RESPONSE_BYTES = 1 << 20  # JSON responses only; the video is streamed to disk
_CHUNK = 1 << 20

# Processing happens in the vendor's cloud; it does not publish a region. Provenance records
# the vendor name so the manifest never claims an AWS region it does not run in.
VENDOR_REGION = "sync.so"

RUNNING_STATUSES = frozenset({"PENDING", "PROCESSING", "QUEUED", "RUNNING", "IN_PROGRESS"})
COMPLETED_STATUSES = frozenset({"COMPLETED", "COMPLETE", "SUCCEEDED", "SUCCESS", "DONE"})
FAILURE_MARKERS = ("FAIL", "ERROR", "REJECT", "CANCEL", "TIMEOUT")
OUTPUT_URL_KEYS = ("outputUrl", "output_url", "outputURL", "url")
JOB_ID_KEYS = ("id", "jobId", "job_id")
CONFIDENCE_KEYS = ("syncConfidence", "confidence")

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def safe_job_id(job_id: str) -> str:
    """A vendor job id reduced to a single safe storage key segment."""
    cleaned = _SAFE_ID_RE.sub("-", job_id).strip("-.")
    if not cleaned or cleaned in (".", ".."):
        raise ProviderError("PROVIDER_BAD_OUTPUT", "sync.so returned an unusable job id.")
    return cleaned


def output_uri(derived_prefix: str, job_id: str) -> str:
    return join_uri(join_uri(derived_prefix, OUTPUT_DIR) + "/", f"{safe_job_id(job_id)}.mp4")


def build_generate_request(
    *, model: str, video_url: str, audio_url: str, sync_mode: str
) -> dict[str, Any]:
    return {
        "model": model,
        "input": [
            {"type": "video", "url": video_url},
            {"type": "audio", "url": audio_url},
        ],
        "options": {"sync_mode": sync_mode},
    }


def classify_status(raw: object) -> str:
    """'running' | 'completed' | 'failed' from a vendor status token (case-insensitive)."""
    status = str(raw or "").strip().upper()
    if status in COMPLETED_STATUSES:
        return "completed"
    if any(marker in status for marker in FAILURE_MARKERS):
        return "failed"
    return "running"


def find_output_url(payload: dict[str, Any]) -> str | None:
    for key in OUTPUT_URL_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    output = payload.get("output")
    if isinstance(output, dict):
        return find_output_url(output)
    return None


def find_job_id(payload: dict[str, Any]) -> str | None:
    for key in JOB_ID_KEYS:
        value = payload.get(key)
        if isinstance(value, str | int) and str(value).strip():
            return str(value).strip()
    return None


def find_confidence(payload: dict[str, Any]) -> float:
    for key in CONFIDENCE_KEYS:
        value = payload.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return min(1.0, max(0.0, float(value)))
    return 1.0


def _https_only(url: str, what: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.netloc:
        raise ProviderError("PROVIDER_ERROR", f"sync.so {what} must be an https URL.")
    return url


class SyncLabsLipSyncProvider:
    def __init__(
        self,
        api_key: str,
        *,
        storage: Storage,
        tools: Tools,
        api_url: str = DEFAULT_API_URL,
        model: str = DEFAULT_MODEL,
        sync_mode: str = DEFAULT_SYNC_MODE,
        url_ttl_s: int = DEFAULT_URL_TTL_S,
    ) -> None:
        if not api_key:
            raise ValueError("sync.so adapter needs an API key")
        if url_ttl_s <= 0:
            raise ValueError("presigned url ttl must be positive")
        self._api_key = api_key
        self._storage = storage
        self._tools = tools
        self._api_url = _https_only(api_url.rstrip("/"), "API URL")
        self._model = model
        self._sync_mode = sync_mode
        self._url_ttl_s = int(url_ttl_s)
        self._outputs: dict[str, str] = {}

    @property
    def model(self) -> str:
        return self._model

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="lipSync",
                locale=None,
                region=VENDOR_REGION,
                tier="beta",
                version=self._model,
                dataPolicy="no-training",
                priceUnit="second",
            )
        ]

    # ---------- LipSyncProvider ----------

    def render(self, shot: dict[str, object], ctx: ProviderContext) -> AsyncHandle:
        video_uri = shot.get("videoUri")
        audio_uri = shot.get("audioUri")
        if not isinstance(video_uri, str) or not isinstance(audio_uri, str):
            raise ValueError("sync.so shot needs 'videoUri' and 'audioUri'")
        if not ctx.derivedPrefix:
            raise ValueError("sync.so render needs a derived prefix in the provider context")
        body = build_generate_request(
            model=self._model,
            video_url=self._presign(video_uri),
            audio_url=self._presign(audio_uri),
            sync_mode=self._sync_mode,
        )
        payload = self._json("POST", self._api_url + GENERATE_PATH, body)
        job_id = find_job_id(payload)
        if job_id is None:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "sync.so returned no job id.", retryable=True
            )
        if classify_status(payload.get("status")) == "failed":
            raise ProviderError("LIP_SYNC_FAILED", "sync.so rejected the lip-sync job.")
        self._outputs[job_id] = output_uri(ctx.derivedPrefix, job_id)
        return AsyncHandle(adapterId=ADAPTER_ID, externalId=job_id)

    def evaluate(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        job_id = handle.externalId
        payload = self._json("GET", f"{self._api_url}{GENERATE_PATH}/{safe_job_id(job_id)}")
        state = classify_status(payload.get("status"))
        if state == "running":
            return None
        if state == "failed":
            # The vendor's `error` text is not echoed: it may quote URLs or the request body.
            raise ProviderError("LIP_SYNC_FAILED", "sync.so could not lip-sync the media.")
        url = find_output_url(payload)
        if url is None:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT",
                "sync.so completed the job without an output location.",
                retryable=True,
            )
        uri = self._outputs.get(job_id)
        if uri is None:
            if not ctx.derivedPrefix:
                raise ValueError("sync.so evaluate needs a derived prefix in the provider context")
            uri = output_uri(ctx.derivedPrefix, job_id)
        self._store_output(_https_only(url, "output URL"), uri)
        return {
            "status": "COMPLETED",
            "applied": True,
            "syncConfidence": find_confidence(payload),
            "video": uri,
        }

    # ---------- helpers ----------

    def _presign(self, uri: str) -> str:
        try:
            url = self._storage.presigned_get_url(uri, self._url_ttl_s)
        except StorageUriError as e:
            raise ProviderError(
                "PROVIDER_ERROR",
                "sync.so needs object storage that can issue fetchable URLs (STORAGE_DRIVER=s3).",
            ) from e
        except StorageError as e:
            raise ProviderError(
                "PROVIDER_UNAVAILABLE", "Could not presign the lip-sync inputs.", retryable=True
            ) from e
        return _https_only(url, "input URL")

    def _headers(self, *, json_body: bool) -> dict[str, str]:
        headers = {"x-api-key": self._api_key, "accept": "application/json"}
        if json_body:
            headers["content-type"] = "application/json"
        return headers

    def _json(self, method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(  # noqa: S310 - https enforced by _https_only
            _https_only(url, "endpoint"),
            data=data,
            method=method,
            headers=self._headers(json_body=body is not None),
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:  # noqa: S310
                raw = resp.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as e:
            raise self._http_error(e.code) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ProviderError(
                "PROVIDER_UNAVAILABLE", "sync.so could not be reached.", retryable=True
            ) from e
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "sync.so returned an oversized response.", retryable=True
            )
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "sync.so returned a non-JSON response.", retryable=True
            ) from e
        if not isinstance(payload, dict):
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "sync.so returned an unexpected response.", retryable=True
            )
        return payload

    @staticmethod
    def _http_error(code: int) -> ProviderError:
        if code == 429 or code >= 500:
            return ProviderError(
                "PROVIDER_THROTTLED",
                f"sync.so is throttling or unavailable (HTTP {code}).",
                retryable=True,
            )
        if code in (401, 403):
            return ProviderError(
                "PROVIDER_ERROR", f"sync.so rejected the credentials (HTTP {code})."
            )
        return ProviderError("PROVIDER_ERROR", f"sync.so rejected the request (HTTP {code}).")

    def _store_output(self, url: str, uri: str) -> None:
        req = urllib.request.Request(url, method="GET")  # noqa: S310 - https enforced
        with tempfile.TemporaryDirectory(prefix="polycast-lipsync-") as d:
            path = Path(d) / "output.mp4"
            try:
                with (
                    urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp,  # noqa: S310
                    path.open("wb") as out,
                ):
                    shutil.copyfileobj(resp, out, length=_CHUNK)
            except urllib.error.HTTPError as e:
                raise ProviderError(
                    "PROVIDER_BAD_OUTPUT",
                    f"sync.so output could not be fetched (HTTP {e.code}).",
                    retryable=True,
                ) from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                raise ProviderError(
                    "PROVIDER_UNAVAILABLE",
                    "sync.so output could not be downloaded.",
                    retryable=True,
                ) from e
            if path.stat().st_size == 0:
                raise ProviderError(
                    "PROVIDER_BAD_OUTPUT", "sync.so output was empty.", retryable=True
                )
            self._storage.put(uri, path, "video/mp4")
