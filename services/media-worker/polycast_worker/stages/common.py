"""Shared helpers for stage handlers."""

from __future__ import annotations

import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from ..config import WorkerConfig
from ..models import Segment, TargetParams, TranslationInput, WorkerTask
from ..naming import CONTENT_TYPES, content_type_for, source_extension
from ..providers.base import CapabilityRecord, ProviderContext
from ..providers.registry import ProviderSet, build_providers
from ..storage import Storage, join_uri
from ..tools import Tools

POLL_INTERVAL_S = 5.0
MAX_POLLS = 4 * 60 * 60 // 5  # four hours of 5 s polls


class StageError(Exception):
    """Typed failure reported to the API. Messages never carry paths, text or tool output."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def _noop() -> None:
    return None


@dataclass(frozen=True)
class StageEnv:
    """What a handler needs beyond task/storage/tools: providers and the lease hooks.

    `heartbeat` is called on every provider poll so long-running provider jobs (Transcribe,
    MediaConvert) keep the task lease alive; `sleep` is injectable for tests.
    """

    providers: ProviderSet
    heartbeat: Callable[[], None] = field(default=_noop)
    sleep: Callable[[float], None] = field(default=time.sleep)
    poll_interval_s: float = POLL_INTERVAL_S

    @classmethod
    def local(cls, storage: Storage, tools: Tools) -> StageEnv:
        """Default for direct handler calls: the mock set over the given storage/tools."""
        cfg = WorkerConfig.from_env({})
        return cls(providers=build_providers(cfg, storage=storage, tools=tools))


def resolve_env(env: StageEnv | None, storage: Storage, tools: Tools) -> StageEnv:
    return env if env is not None else StageEnv.local(storage, tools)


def poll_until_done(
    env: StageEnv, poll: Callable[[], dict[str, object] | None], *, max_polls: int = MAX_POLLS
) -> dict[str, object]:
    for _ in range(max_polls):
        result = poll()
        if result is not None:
            return result
        env.heartbeat()
        env.sleep(env.poll_interval_s)
    raise StageError("PROVIDER_TIMEOUT", "The provider job did not finish in time.", retryable=True)


@contextmanager
def workdir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="polycast-") as d:
        yield Path(d)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def provider_context(task: WorkerTask, region: str = "local") -> ProviderContext:
    project_id = getattr(task.parameters, "projectId", "")
    return ProviderContext(
        organizationId=task.organizationId,
        projectId=str(project_id),
        jobId=task.jobId or task.assetId or "",
        region=region,
        idempotencyKey=task.idempotencyKey,
        correlationId=task.correlationId,
        derivedPrefix=task.storage.derivedPrefix,
    )


def capability_for(records: list[CapabilityRecord], locale: str | None) -> CapabilityRecord:
    """The record naming a provider in a stage output: locale-specific first, else the first."""
    for r in records:
        if locale is not None and r.locale == locale:
            return r
    for r in records:
        if r.locale is None:
            return r
    return records[0]


def require_source(task: WorkerTask) -> str:
    if task.storage.source is None:
        raise StageError("INVALID_TASK", f"stage {task.stage} requires a source location")
    return task.storage.source


def _join_path(prefix: str, name: str) -> str:
    """`name` may contain '/' sub-directories (`speech/<id>.wav`); each part is validated."""
    parts = name.split("/")
    uri = prefix
    for part in parts[:-1]:
        uri = join_uri(uri, part) + "/"
    return join_uri(uri, parts[-1])


def derived_uri(task: WorkerTask, name: str) -> str:
    return _join_path(task.storage.derivedPrefix, name)


def sibling_uri(task: WorkerTask, stage: str, name: str) -> str:
    """URI of `name` under the derived prefix of another stage of the same target.

    The API mints `.../{targetId}/{stage}/` per task, so a later stage finds an earlier
    stage's artefact by swapping the trailing stage segment. Prefixes that do not end in
    the current stage name are shared, and are used as-is.
    """
    prefix = task.storage.derivedPrefix
    head, _, last = prefix.rstrip("/").rpartition("/")
    if head and last == task.stage.lower():
        return _join_path(f"{head}/{stage.lower()}/", name)
    return _join_path(prefix, name)


def find_artifact(task: WorkerTask, storage: Storage, stage: str, name: str) -> str | None:
    """First existing location of an artefact: this task's prefix, then `stage`'s prefix."""
    for uri in dict.fromkeys((derived_uri(task, name), sibling_uri(task, stage, name))):
        if storage.exists(uri):
            return uri
    return None


def segments_by_seq(params: TargetParams) -> list[Segment]:
    return sorted(params.segments, key=lambda s: s.seq)


def translations_by_segment(params: TargetParams) -> dict[str, TranslationInput]:
    """Latest translation per segment (highest generation wins)."""
    out: dict[str, TranslationInput] = {}
    for t in params.translations:
        cur = out.get(t.segmentId)
        if cur is None or t.generation > cur.generation:
            out[t.segmentId] = t
    return out


def speech_wav_name(segment_id: str, *, fitted: bool = False) -> str:
    return f"speech/{segment_id}.fit.wav" if fitted else f"speech/{segment_id}.wav"


def find_speech_wav(task: WorkerTask, storage: Storage, segment_id: str) -> str | None:
    """Fitted render from TIMING if present, else the raw render from SYNTHESIZING."""
    fitted = find_artifact(task, storage, "TIMING", speech_wav_name(segment_id, fitted=True))
    if fitted is not None:
        return fitted
    return find_artifact(task, storage, "SYNTHESIZING", speech_wav_name(segment_id))


__all__ = [
    "CONTENT_TYPES",
    "StageEnv",
    "StageError",
    "capability_for",
    "content_type_for",
    "derived_uri",
    "find_artifact",
    "find_speech_wav",
    "now_iso",
    "poll_until_done",
    "provider_context",
    "require_source",
    "resolve_env",
    "segments_by_seq",
    "sibling_uri",
    "source_extension",
    "speech_wav_name",
    "translations_by_segment",
    "workdir",
]
