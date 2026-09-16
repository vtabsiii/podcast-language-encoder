"""Test helpers for the AWS adapters: recorded fixtures → botocore Stubber, in-memory storage.

Fixture files live under tests/fixtures/providers/<service>/<operation>[.<variant>].json as
`{"service", "operation", "expected_params"?, "response"}`. Inside them:
    {"__blob_base64__": "..."}  → a StreamingBody (streaming blob outputs such as Polly audio)
    "<ANY>"                     → botocore.stub.ANY in expected params
    "<PLACEHOLDER>"             → replaced through `subst`
No test here ever opens a network connection: every client is wrapped in a Stubber before use.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import boto3
from botocore.response import StreamingBody
from botocore.stub import ANY, Stubber

from polycast_worker.config import WorkerConfig
from polycast_worker.models import WorkerTask
from polycast_worker.providers.aws.clients import ClientFactory
from polycast_worker.providers.registry import ProviderSet, build_providers
from polycast_worker.stages.common import StageEnv
from polycast_worker.storage import StorageError, parse_uri
from polycast_worker.tools import Tools

from .conftest import new_id

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "providers"
REGION = "us-east-1"
FAKE_CREDENTIALS = {
    "region_name": REGION,
    "aws_access_key_id": "testing",
    "aws_secret_access_key": "testing",  # noqa: S106 - stubbed client, never sent
}


def _convert(value: Any, subst: dict[str, str]) -> Any:
    if isinstance(value, dict):
        if set(value) == {"__blob_base64__"}:
            raw = base64.b64decode(value["__blob_base64__"])
            return StreamingBody(io.BytesIO(raw), len(raw))
        return {k: _convert(v, subst) for k, v in value.items()}
    if isinstance(value, list):
        return [_convert(v, subst) for v in value]
    if isinstance(value, str):
        if value == "<ANY>":
            return ANY
        for key, replacement in subst.items():
            value = value.replace(f"<{key}>", replacement)
        return value
    return value


def recorded(
    service: str, operation: str, variant: str | None = None, **subst: str
) -> dict[str, Any]:
    name = f"{operation}.{variant}.json" if variant else f"{operation}.json"
    data = json.loads((FIXTURE_DIR / service / name).read_text(encoding="utf-8"))
    assert data["service"] == service and data["operation"] == operation
    out = {"response": _convert(data["response"], subst)}
    if "expected_params" in data:
        out["expected_params"] = _convert(data["expected_params"], subst)
    return out


def transcribe_output() -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / "transcribe" / "output.json").read_text(encoding="utf-8"))


def stub_client(service: str) -> tuple[Any, Stubber]:
    client = boto3.client(service, **FAKE_CREDENTIALS)
    stubber = Stubber(client)
    stubber.activate()
    return client, stubber


class MemoryStorage:
    """Scheme-agnostic Storage over a dict, so tests can use realistic `s3://` URIs."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}

    def _key(self, uri: str) -> str:
        parse_uri(uri)
        return uri

    def get(self, uri: str) -> bytes:
        try:
            return self.objects[self._key(uri)]
        except KeyError as e:
            raise StorageError("failed to read object") from e

    def download(self, uri: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.get(uri))

    def put(self, uri: str, data: bytes | Path, content_type: str) -> None:
        key = self._key(uri)
        self.objects[key] = data.read_bytes() if isinstance(data, Path) else bytes(data)
        self.content_types[key] = content_type

    def exists(self, uri: str) -> bool:
        return self._key(uri) in self.objects

    def sha256(self, uri: str) -> str:
        return hashlib.sha256(self.get(uri)).hexdigest()

    def size(self, uri: str) -> int:
        return len(self.get(uri))


def aws_config(**overrides: str) -> WorkerConfig:
    env = {"PROVIDER_MODE": "aws", "AWS_REGION": REGION, "MEDIA_BUCKET_DERIVED": "derived"}
    env.update(overrides)
    return WorkerConfig.from_env(env)


@dataclass
class Lease:
    beats: int = 0
    sleeps: list[float] = field(default_factory=list)

    def heartbeat(self) -> None:
        self.beats += 1

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)


def aws_providers(
    clients: dict[str, Any],
    storage: MemoryStorage,
    tools: Tools | None = None,
    **overrides: str,
) -> ProviderSet:
    factory = ClientFactory.with_clients(clients, REGION)
    return build_providers(
        aws_config(**overrides), factory, storage=storage, tools=tools or Tools.none()
    )


def env_for(providers: ProviderSet, lease: Lease | None = None) -> tuple[StageEnv, Lease]:
    lease = lease or Lease()
    return StageEnv(providers=providers, heartbeat=lease.heartbeat, sleep=lease.sleep), lease


SEG_TEXTS = (
    "Welcome back to the show, today we are talking about how podcasts get made.",
    "Most producers start by planning the episode outline before recording anything.",
    "Visit polycast.example.com for 3 free episodes.",
)
SEG_RANGES = ((0, 4_160_000), (4_900_000, 9_250_000), (9_600_000, 11_930_000))


def segment_dicts(speaker_id: str, ids: list[str] | None = None) -> list[dict[str, Any]]:
    ids = ids or [new_id() for _ in SEG_TEXTS]
    return [
        {
            "id": sid,
            "seq": i,
            "speakerId": speaker_id,
            "range": {"start": r[0], "end": r[1]},
            "text": text,
            "language": "en",
            "confidence": 0.98,
            "words": [],
            "version": 1,
        }
        for i, (sid, text, r) in enumerate(zip(ids, SEG_TEXTS, SEG_RANGES, strict=True))
    ]


def target_task(
    stage: str,
    *,
    segments: list[dict[str, Any]],
    translations: list[dict[str, Any]] | None = None,
    speech: list[dict[str, Any]] | None = None,
    hint: str | None = None,
    target_locale: str = "es-MX",
    prefix: str = "s3://derived/org/targets/t1/",
    source: str | None = "s3://source/org/asset.wav",
    metadata: dict[str, Any] | None = None,
    package_version: int | None = None,
    deliverables_prefix: str | None = None,
    make: Callable[[dict[str, Any]], WorkerTask] = WorkerTask.model_validate,
) -> WorkerTask:
    speaker_id = segments[0]["speakerId"] if segments else new_id()
    return make(
        {
            "taskId": new_id(),
            "organizationId": new_id(),
            "jobId": new_id(),
            "targetJobId": new_id(),
            "assetId": None,
            "stage": stage,
            "attempt": 1,
            "idempotencyKey": f"idem-{stage.lower()}-{new_id()}",
            "correlationId": "corr-aws",
            "storage": {
                "source": source,
                "derivedPrefix": f"{prefix}{stage.lower()}/",
                "deliverablesPrefix": deliverables_prefix,
            },
            "parameters": {
                "targetJobId": new_id(),
                "projectId": new_id(),
                "jobId": new_id(),
                "sourceLocale": "en-US",
                "targetLocale": target_locale,
                "direction": "ltr",
                "lipSync": False,
                "metadata": metadata
                or {
                    "container": "wav",
                    "durationUs": 12_000_000,
                    "audio": {
                        "codec": "pcm_s16le",
                        "sampleRate": 16000,
                        "channels": 1,
                        "channelLayout": "mono",
                    },
                },
                "sourceSha256": "0" * 64,
                "speakers": [
                    {
                        "id": speaker_id,
                        "label": "Speaker A",
                        "onCamera": False,
                        "voicePolicy": "stock",
                        "sampleRanges": [],
                    }
                ],
                "segments": segments,
                "translations": translations or [],
                "speech": speech or [],
                "hint": hint,
                "packageVersion": package_version,
                "provenance": None,
            },
            "taskToken": None,
            "leaseSeconds": 30,
        }
    )
