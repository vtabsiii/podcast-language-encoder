"""MIXING: normalised WAV mix plus a loudness measurement (FR-023).

Every segment with a speech render whose WAV exists (fitted from TIMING, else the raw render
from SYNTHESIZING) is placed at its segment start; the registry's Mixer does the rest. In
local mode the mixer is a passthrough (loudnorm of the untranslated source, as in M1) and
mock renders carry no audio anyway. Stereo sources target −16 LUFS, mono −19; true peak −1.
"""

from __future__ import annotations

from ..models import MixingOutput, WorkerTask
from ..providers.base import SpeechPlacement
from ..providers.ffmpeg import wav_duration_us
from ..storage import Storage
from ..tools import Tools
from .common import (
    StageEnv,
    StageError,
    derived_uri,
    find_speech_wav,
    require_source,
    resolve_env,
    workdir,
)

FIXTURE_LUFS = -16.0
FIXTURE_TRUE_PEAK = -1.0
MIX_FILE = "mix.wav"


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    source_uri = require_source(task)
    channels = params.metadata.audio.channels if params.metadata.audio is not None else 2
    with workdir() as wd:
        local = wd / "source.bin"
        storage.download(source_uri, local)
        placements: list[SpeechPlacement] = []
        segments = {s.id: s for s in params.segments}
        for sp in params.speech:
            seg = segments.get(sp.segmentId)
            if seg is None:
                continue
            uri = find_speech_wav(task, storage, sp.segmentId)
            if uri is None:
                if env.providers.is_mock:
                    continue  # mock renders carry no audio
                raise StageError(
                    "SPEECH_RENDER_MISSING",
                    "A dubbed speech render is missing, so the mix would keep the original voice.",
                    retryable=True,
                )
            wav = wd / f"speech-{sp.segmentId}.wav"
            storage.download(uri, wav)
            start = seg.range.start
            placements.append(
                SpeechPlacement(sp.segmentId, wav, start, start + wav_duration_us(wav))
            )
        placements.sort(key=lambda p: p.start_us)
        if not placements and not env.providers.is_mock and params.speech:
            raise StageError("SPEECH_RENDER_MISSING", "No dubbed speech renders were found to mix.")
        mix = wd / MIX_FILE
        lufs, peak = env.providers.mixer.mix(local, placements, mix, channels=channels)
        uri = derived_uri(task, MIX_FILE)
        storage.put(uri, mix, "audio/wav")
    return MixingOutput(mix=uri, integratedLufs=lufs, truePeakDbtp=peak).model_dump()
