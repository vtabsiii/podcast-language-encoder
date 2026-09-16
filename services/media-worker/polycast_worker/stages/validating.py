"""VALIDATING: quarantine object → probe → typed accept/reject → immutable source copy."""

from __future__ import annotations

from ..audio import AudioError, is_riff_wave, probe_wav
from ..ffprobe import ProbeError, probe
from ..models import MediaMetadata, ValidatingOutput, WorkerTask
from ..storage import Storage, StorageUriError, sha256_of_path
from ..tools import Tools
from .common import StageError, require_source, workdir

SUPPORTED_CONTAINERS = frozenset(
    {"mov", "mp4", "m4a", "matroska", "webm", "wav", "mp3", "flac", "ogg", "aiff", "mpegts"}
)
_MESSAGES = {
    "UNSUPPORTED_CONTAINER": "The file format is not supported. Upload MP4, MOV, MKV, WebM, "
    "WAV, MP3, FLAC or OGG.",
    "NO_AUDIO_STREAM": "The file contains no audio stream.",
    "DURATION_EXCEEDED": "The media is longer than the maximum allowed duration.",
    "SIZE_MISMATCH": "The uploaded size does not match the declared size; re-upload the file.",
    "MALFORMED_MEDIA": "The file could not be read as media; it may be corrupt or truncated.",
}


def _reject(code: str) -> StageError:
    return StageError(code, _MESSAGES[code])


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.validating_params()
    source_uri = require_source(task)
    with workdir() as wd:
        local = wd / "quarantine.bin"
        storage.download(params.quarantine, local)
        actual_size = local.stat().st_size
        if actual_size != params.declaredByteSize:
            raise _reject("SIZE_MISMATCH")

        with local.open("rb") as f:
            head = f.read(12)

        metadata: MediaMetadata
        if tools.has_ffprobe:
            try:
                metadata = probe(local)
            except ProbeError as e:
                code = "NO_AUDIO_STREAM" if "no audio" in str(e) else "MALFORMED_MEDIA"
                raise _reject(code) from e
            if metadata.container not in SUPPORTED_CONTAINERS:
                raise _reject("UNSUPPORTED_CONTAINER")
        elif is_riff_wave(head):
            try:
                metadata = probe_wav(local)
            except AudioError as e:
                raise _reject("MALFORMED_MEDIA") from e
        else:
            raise _reject("UNSUPPORTED_CONTAINER")

        if metadata.audio is None:
            raise _reject("NO_AUDIO_STREAM")
        if metadata.durationUs == 0:
            raise _reject("MALFORMED_MEDIA")
        if metadata.durationUs > params.maxDurationUs:
            raise _reject("DURATION_EXCEEDED")

        digest = sha256_of_path(local)
        # The source is immutable: write it once, never overwrite an existing identical copy.
        try:
            already = storage.exists(source_uri) and storage.sha256(source_uri) == digest
        except StorageUriError as e:
            raise StageError("INVALID_TASK", "source location is not a valid storage uri") from e
        if not already:
            storage.put(source_uri, local, params.declaredContentType)

    return ValidatingOutput(
        metadata=metadata, sha256=digest, byteSize=actual_size, source=source_uri
    ).model_dump()
