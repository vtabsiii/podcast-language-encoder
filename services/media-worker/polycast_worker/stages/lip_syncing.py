"""LIP_SYNCING: the registry's LipSyncProvider (mock until M4, never applied)."""

from __future__ import annotations

from ..models import LipSyncOutput, LipSyncRender, WorkerTask
from ..storage import Storage
from ..tools import Tools
from .common import StageEnv, provider_context, resolve_env, segments_by_seq


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    ctx = provider_context(task, env.providers.region)
    provider = env.providers.lip_sync
    renders: list[LipSyncRender] = []
    applied = False
    for seg in segments_by_seq(params):
        handle = provider.render({"segmentId": seg.id}, ctx)
        evaluated = provider.evaluate(handle, ctx) or {}
        confidence = evaluated.get("syncConfidence")
        applied = applied or bool(evaluated.get("applied"))
        renders.append(
            LipSyncRender(
                segmentId=seg.id,
                syncConfidence=float(confidence) if isinstance(confidence, int | float) else 0.0,
                video=None,
            )
        )
    record = provider.capabilities()[0]
    return LipSyncOutput(
        provider=record.adapterId,
        providerVersion=record.version,
        applied=applied,
        renders=renders,
    ).model_dump()
