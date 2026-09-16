"""LIP_SYNCING: re-render the speaker's mouth movements onto the translated voice.

Two paths, chosen per task:

    applied      `params.lipSync` is true, the asset has video and the registry's
                 LipSyncProvider is a real adapter (sync.so). The stage builds the dubbed
                 speech track (every fitted speech render at its segment start, silence
                 elsewhere), uploads it as `lip-sync/speech-track.wav`, submits one
                 whole-episode job, polls it with lease heartbeats and records `applied: true`
                 with the lip-synced video on every render. The output is also persisted as
                 `lip-sync.json` under this stage's prefix so ENCODING (encode source) and
                 PACKAGING (`lipSyncApplied`) can find it.
    not applied  everything else (audio-only asset, lip sync not requested, or the mock
                 adapter): one render per segment with `applied: false` and confidence 0.0,
                 as in M1. Only the mock adapter is exercised here; a real adapter is never
                 called for a target that did not ask for lip sync.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from pydantic import ValidationError

from ..models import LipSyncOutput, LipSyncRender, TargetParams, WorkerTask
from ..providers.base import LipSyncProvider, ProviderContext, SpeechPlacement
from ..providers.ffmpeg import build_speech_track, wav_duration_us
from ..providers.mock import MockLipSyncProvider
from ..storage import Storage, StorageError, StorageUriError
from ..tools import Tools
from .common import (
    StageEnv,
    StageError,
    derived_uri,
    find_artifact,
    find_speech_wav,
    poll_until_done,
    provider_context,
    require_source,
    resolve_env,
    segments_by_seq,
    workdir,
)

log = logging.getLogger(__name__)

SPEECH_TRACK_FILE = "lip-sync/speech-track.wav"
LIP_SYNC_OUTPUT_FILE = "lip-sync.json"


def find_lip_sync_video(task: WorkerTask, storage: Storage) -> str | None:
    """The lip-synced episode video recorded by LIP_SYNCING for this target, if it applied."""
    uri = find_artifact(task, storage, "LIP_SYNCING", LIP_SYNC_OUTPUT_FILE)
    if uri is None:
        return None
    try:
        output = LipSyncOutput.model_validate(json.loads(storage.get(uri).decode("utf-8")))
    except (StorageError, StorageUriError, UnicodeDecodeError, ValueError, ValidationError):
        return None
    if not output.applied or output.video is None or not storage.exists(output.video):
        return None
    return output.video


def _clamp_confidence(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return min(1.0, max(0.0, float(value)))


def _not_applied(
    params: TargetParams, provider: LipSyncProvider, ctx: ProviderContext
) -> LipSyncOutput:
    exercise = isinstance(provider, MockLipSyncProvider)
    renders: list[LipSyncRender] = []
    for seg in segments_by_seq(params):
        evaluated: dict[str, object] = {}
        if exercise:
            handle = provider.render({"segmentId": seg.id}, ctx)
            evaluated = provider.evaluate(handle, ctx) or {}
        renders.append(
            LipSyncRender(
                segmentId=seg.id,
                syncConfidence=_clamp_confidence(evaluated.get("syncConfidence")),
                video=None,
            )
        )
    record = provider.capabilities()[0]
    return LipSyncOutput(
        provider=record.adapterId,
        providerVersion=record.version,
        applied=False,
        renders=renders,
        video=None,
    )


def _placements(
    task: WorkerTask, params: TargetParams, storage: Storage, wd: Path
) -> list[SpeechPlacement]:
    segments = {s.id: s for s in params.segments}
    placements: list[SpeechPlacement] = []
    for sp in params.speech:
        seg = segments.get(sp.segmentId)
        if seg is None:
            continue
        uri = find_speech_wav(task, storage, sp.segmentId)
        if uri is None:
            continue
        wav = wd / f"speech-{sp.segmentId}.wav"
        storage.download(uri, wav)
        start = seg.range.start
        placements.append(SpeechPlacement(sp.segmentId, wav, start, start + wav_duration_us(wav)))
    placements.sort(key=lambda p: p.start_us)
    return placements


def _applied(
    task: WorkerTask,
    params: TargetParams,
    storage: Storage,
    tools: Tools,
    env: StageEnv,
    provider: LipSyncProvider,
    ctx: ProviderContext,
) -> LipSyncOutput:
    source_uri = require_source(task)
    duration_us = params.metadata.durationUs
    with workdir() as wd:
        placements = _placements(task, params, storage, wd)
        if not placements:
            raise StageError("LIP_SYNC_NO_SPEECH", "No speech renders were available to lip-sync.")
        track = wd / "speech-track.wav"
        build_speech_track(tools, placements, track, duration_us=duration_us, channels=1)
        track_uri = derived_uri(task, SPEECH_TRACK_FILE)
        storage.put(track_uri, track, "audio/wav")
    shot: dict[str, object] = {
        "videoUri": source_uri,
        "audioUri": track_uri,
        "durationUs": duration_us,
    }
    handle = provider.render(shot, ctx)
    log.info("lip-sync job submitted for target %s", params.targetJobId)
    result = poll_until_done(env, lambda: provider.evaluate(handle, ctx))
    video = result.get("video")
    if not isinstance(video, str) or not video:
        raise StageError("PROVIDER_BAD_OUTPUT", "The lip-sync provider returned no video.")
    if not storage.exists(video):
        raise StageError(
            "PROVIDER_BAD_OUTPUT", "The lip-sync provider's video was not stored.", retryable=True
        )
    confidence = _clamp_confidence(result.get("syncConfidence", 1.0))
    record = provider.capabilities()[0]
    return LipSyncOutput(
        provider=record.adapterId,
        providerVersion=record.version,
        applied=bool(result.get("applied", True)),
        renders=[
            LipSyncRender(segmentId=seg.id, syncConfidence=confidence, video=video)
            for seg in segments_by_seq(params)
        ],
        video=video,
    )


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    ctx = provider_context(task, env.providers.region)
    provider = env.providers.lip_sync
    wanted = (
        params.lipSync
        and params.metadata.video is not None
        and not isinstance(provider, MockLipSyncProvider)
    )
    if wanted:
        output = _applied(task, params, storage, tools, env, provider, ctx)
    else:
        output = _not_applied(params, provider, ctx)
    if output.applied:
        storage.put(
            derived_uri(task, LIP_SYNC_OUTPUT_FILE),
            json.dumps(output.model_dump()).encode("utf-8"),
            "application/json",
        )
    return output.model_dump()
