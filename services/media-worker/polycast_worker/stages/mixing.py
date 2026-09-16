"""MIXING: normalised stereo 48 kHz WAV from the source audio plus a loudness measurement.

Mock speech renders carry no audio, so in M1 the mix is the untranslated source audio.
The provenance manifest discloses this.
"""

from __future__ import annotations

from ..audio import is_riff_wave, measure_loudness
from ..models import MixingOutput, WorkerTask
from ..storage import Storage
from ..tools import Tools
from .common import StageError, derived_uri, require_source, workdir

FIXTURE_LUFS = -16.0
FIXTURE_TRUE_PEAK = -1.0
MIX_FILE = "mix.wav"


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    task.target_params()
    source_uri = require_source(task)
    with workdir() as wd:
        local = wd / "source.bin"
        storage.download(source_uri, local)
        if tools.has_ffmpeg:
            mix = wd / MIX_FILE
            tools.run_ffmpeg(
                [
                    "-i",
                    local,
                    "-vn",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                    "-af",
                    "loudnorm=I=-16:TP=-1",
                    "-c:a",
                    "pcm_s16le",
                    mix,
                ]
            )
            lufs, peak = measure_loudness(tools, mix) or (FIXTURE_LUFS, FIXTURE_TRUE_PEAK)
        else:
            with local.open("rb") as f:
                if not is_riff_wave(f.read(12)):
                    raise StageError(
                        "TOOL_UNAVAILABLE",
                        "ffmpeg is required to mix this source",
                        retryable=True,
                    )
            mix = local
            lufs, peak = FIXTURE_LUFS, FIXTURE_TRUE_PEAK
        uri = derived_uri(task, MIX_FILE)
        storage.put(uri, mix, "audio/wav")
    return MixingOutput(mix=uri, integratedLufs=lufs, truePeakDbtp=peak).model_dump()
