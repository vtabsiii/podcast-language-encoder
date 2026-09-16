"""ENCODING: final container from the mix via the registry's MediaEncodeProvider.

    ffmpeg        MP4 with copied video + AAC 128k, or MP3 128k (synchronous, in-worker)
    mediaconvert  CreateJob / GetJob polled every 5 s with lease heartbeats

Both write `encode.<ext>` under this stage's derived prefix.
"""

from __future__ import annotations

from ..models import EncodingOutput, WorkerTask
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
from .mixing import MIX_FILE


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    source_uri = require_source(task)
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
