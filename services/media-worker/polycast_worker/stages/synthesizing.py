"""SYNTHESIZING: the registry's SpeechProvider renders every translation in scope (FR-020).

Renders that come back with WAV bytes are written to `speech/<segmentId>.wav` under the
derived prefix and referenced by `audio`; mock renders carry no audio (`audio: null`).
"""

from __future__ import annotations

from ..models import SpeechRender, SynthesizingOutput, WorkerTask
from ..storage import Storage
from ..tools import Tools
from .common import (
    StageEnv,
    StageError,
    capability_for,
    derived_uri,
    provider_context,
    resolve_env,
    speech_wav_name,
)


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    ctx = provider_context(task, env.providers.region)
    provider = env.providers.speech
    voice_id = provider.default_voice(params.targetLocale)
    if voice_id is None:
        raise StageError(
            "VOICE_UNAVAILABLE", "No speech voice is configured for the target locale."
        )
    renders: list[SpeechRender] = []
    for t in params.translations:
        measured = provider.synthesize(t.adaptedText, voice_id, t.timingBudgetUs, ctx)
        duration = measured.get("durationUs")
        audio: str | None = None
        wav = measured.get("wav")
        if isinstance(wav, bytes | bytearray) and wav:
            audio = derived_uri(task, speech_wav_name(t.segmentId))
            storage.put(audio, bytes(wav), "audio/wav")
        renders.append(
            SpeechRender(
                segmentId=t.segmentId,
                translationVersionId=t.translationVersionId,
                voiceId=voice_id,
                measuredDurationUs=int(duration) if isinstance(duration, int) else 0,
                audio=audio,
            )
        )
    record = capability_for(provider.capabilities(), params.targetLocale)
    return SynthesizingOutput(
        provider=record.adapterId, providerVersion=record.version, renders=renders
    ).model_dump()
