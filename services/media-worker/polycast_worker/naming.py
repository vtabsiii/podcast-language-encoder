"""File-name and content-type helpers shared by stages and providers (no I/O)."""

from __future__ import annotations

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


def source_extension(source_uri: str, container: str) -> str:
    name = source_uri.rsplit("/", 1)[-1]
    if "." in name:
        ext = name.rsplit(".", 1)[-1].lower()
        if ext.isalnum() and len(ext) <= 5:
            return ext
    return {"mov": "mp4", "matroska": "mkv"}.get(container, container or "bin")
