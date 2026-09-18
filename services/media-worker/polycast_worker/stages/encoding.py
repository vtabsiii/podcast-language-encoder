"""ENCODING: final container from the mix via the registry's MediaEncodeProvider.

    ffmpeg        MP4 with copied video + AAC 128k, or MP3 128k (synchronous, in-worker)
    mediaconvert  CreateJob / GetJob polled every 5 s with lease heartbeats

Both write `encode.<ext>` under this stage's derived prefix. When LIP_SYNCING produced a
lip-synced video for this target it is the encode source (its picture, the MIXING audio).
The original source is used only when lip sync was not requested or only the mock vendor is
configured; a requested real lip sync whose video is missing fails the stage.
"""

from __future__ import annotations

from ..models import EncodingOutput, WorkerTask
from ..providers.mock import MockLipSyncProvider
from ..storage import Storage
from ..tools import Tools
from .common import (
    StageEnv,
    StageError,
    find_artifact,
    poll_until_done,
    provider_context,
    require_source,
    resolve_env,
    workdir,
)
from .lip_syncing import find_lip_sync_video
from .mixing import MIX_FILE


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    source_uri = require_source(task)
    if params.metadata.video is not None:
        lip_synced = find_lip_sync_video(task, storage)
        if lip_synced is not None:
            source_uri = lip_synced
        elif params.lipSync and not isinstance(env.providers.lip_sync, MockLipSyncProvider):
            # Never ship the untouched picture when the target asked for lip sync and a real
            # vendor is configured: that is a broken pipeline, not a degraded deliverable.
            raise StageError(
                "LIP_SYNC_OUTPUT_MISSING",
                "Lip sync was requested but no lip-synced video was found for this target.",
            )
    provider = env.providers.encode
    ctx = provider_context(task, env.providers.region)
    with workdir() as wd:
        preset: dict[str, object] = {
            "workdir": wd,
            "outputPrefix": task.storage.derivedPrefix,
            "hasVideo": params.metadata.video is not None,
            "container": params.metadata.container,
            "mix": find_artifact(task, storage, "MIXING", MIX_FILE),
        }
        handle = provider.encode(source_uri, preset, ctx)
        result = poll_until_done(env, lambda: provider.poll(handle, ctx))
        uri = result.get("encode")
        ext = result.get("container")
        if not isinstance(uri, str) or not isinstance(ext, str):
            raise StageError("PROVIDER_BAD_OUTPUT", "The encoder returned no output location.")
        size_raw = result.get("byteSize")
        size = size_raw if isinstance(size_raw, int) and size_raw > 0 else storage.size(uri)
    return EncodingOutput(encode=uri, container=ext, byteSize=size).model_dump()
