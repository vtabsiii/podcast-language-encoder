"""ENCODING: final container from the mix (MP4 with copied video, or MP3 for audio-only)."""

from __future__ import annotations

from pathlib import Path

from ..models import EncodingOutput, WorkerTask
from ..storage import Storage
from ..tools import Tools
from .common import (
    content_type_for,
    derived_uri,
    find_artifact,
    require_source,
    source_extension,
    workdir,
)
from .mixing import MIX_FILE


def _mix_path(task: WorkerTask, storage: Storage, tools: Tools, wd: Path, source: Path) -> Path:
    mix = wd / MIX_FILE
    mix_uri = find_artifact(task, storage, "MIXING", MIX_FILE)
    if mix_uri is not None:
        storage.download(mix_uri, mix)
        return mix
    # MIXING artefact not present under this prefix: derive the mix from the source.
    tools.run_ffmpeg(["-i", source, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", mix])
    return mix


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    source_uri = require_source(task)
    has_video = params.metadata.video is not None
    with workdir() as wd:
        local = wd / "source.bin"
        storage.download(source_uri, local)
        if not tools.has_ffmpeg:
            ext = source_extension(source_uri, params.metadata.container)
            out = local
        else:
            mix = _mix_path(task, storage, tools, wd, local)
            if has_video:
                ext = "mp4"
                out = wd / "encode.mp4"
                tools.run_ffmpeg(
                    [
                        "-i",
                        local,
                        "-i",
                        mix,
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "128k",
                        "-movflags",
                        "+faststart",
                        "-shortest",
                        out,
                    ]
                )
            else:
                ext = "mp3"
                out = wd / "encode.mp3"
                tools.run_ffmpeg(["-i", mix, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", out])
        uri = derived_uri(task, f"encode.{ext}")
        storage.put(uri, out, content_type_for(ext))
        size = out.stat().st_size
    return EncodingOutput(encode=uri, container=ext, byteSize=size).model_dump()
