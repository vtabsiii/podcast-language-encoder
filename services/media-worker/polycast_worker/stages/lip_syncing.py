"""LIP_SYNCING: mock adapter, never applied. The API only queues it for video with lipSync on."""

from __future__ import annotations

from ..models import LipSyncOutput, LipSyncRender, WorkerTask
from ..providers.mock import MOCK_PROVIDER_VERSION, MockLipSyncProvider
from ..storage import Storage
from ..tools import Tools
from .common import provider_context, segments_by_seq


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    ctx = provider_context(task)
    provider = MockLipSyncProvider()
    renders: list[LipSyncRender] = []
    for seg in segments_by_seq(params):
        handle = provider.render({"segmentId": seg.id}, ctx)
        evaluated = provider.evaluate(handle, ctx) or {}
        confidence = evaluated.get("syncConfidence")
        renders.append(
            LipSyncRender(
                segmentId=seg.id,
                syncConfidence=float(confidence) if isinstance(confidence, int | float) else 0.0,
                video=None,
            )
        )
    return LipSyncOutput(
        provider="mock-lipSync",
        providerVersion=MOCK_PROVIDER_VERSION,
        applied=False,
        renders=renders,
    ).model_dump()
