"""Shared helpers for stage handlers."""

from __future__ import annotations

import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from ..models import Segment, TargetParams, TranslationInput, WorkerTask
from ..providers.base import ProviderContext
from ..storage import Storage, join_uri


class StageError(Exception):
    """Typed failure reported to the API. Messages never carry paths, text or tool output."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


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
    )


def require_source(task: WorkerTask) -> str:
    if task.storage.source is None:
        raise StageError("INVALID_TASK", f"stage {task.stage} requires a source location")
    return task.storage.source


def derived_uri(task: WorkerTask, name: str) -> str:
    return join_uri(task.storage.derivedPrefix, name)


def sibling_uri(task: WorkerTask, stage: str, name: str) -> str:
    """URI of `name` under the derived prefix of another stage of the same target.

    The API mints `.../{targetId}/{stage}/` per task, so a later stage finds an earlier
    stage's artefact by swapping the trailing stage segment. Prefixes that do not end in
    the current stage name are shared, and are used as-is.
    """
    prefix = task.storage.derivedPrefix
    head, _, last = prefix.rstrip("/").rpartition("/")
    if head and last == task.stage.lower():
        return join_uri(f"{head}/{stage.lower()}/", name)
    return join_uri(prefix, name)


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


def source_extension(source_uri: str, container: str) -> str:
    name = source_uri.rsplit("/", 1)[-1]
    if "." in name:
        ext = name.rsplit(".", 1)[-1].lower()
        if ext.isalnum() and len(ext) <= 5:
            return ext
    return {"mov": "mp4", "matroska": "mkv"}.get(container, container or "bin")


CONTENT_TYPES: dict[str, str] = {
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "json": "application/json",
    "srt": "application/x-subrip",
    "vtt": "text/vtt",
    "sha256": "text/plain",
}


def content_type_for(ext: str) -> str:
    return CONTENT_TYPES.get(ext.lower(), "application/octet-stream")
