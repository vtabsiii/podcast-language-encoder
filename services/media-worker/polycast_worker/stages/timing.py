"""TIMING: fit each speech render into its segment slot (FR-013 / FR-022).

The decision is pure integer arithmetic (`timing_fit.fit_segment`). When the render has a
WAV (aws mode), the registry's TimingFitter applies it with ffmpeg `atempo` and writes
`speech/<segmentId>.fit.wav` under this stage's prefix for MIXING; `retranslate` renders are
reported with `fits: false` and left untouched so the API can ask for a shorter text.
"""

from __future__ import annotations

from ..models import TimingFit, TimingOutput, WorkerTask
from ..storage import Storage
from ..timing_fit import MAX_BOUNDARY_SHIFT_US, RATE_MAX, RATE_MIN, fit_segment
from ..tools import Tools
from .common import (
    StageEnv,
    derived_uri,
    find_artifact,
    resolve_env,
    speech_wav_name,
    workdir,
)

__all__ = ["MAX_BOUNDARY_SHIFT_US", "RATE_MAX", "RATE_MIN", "fit_segment", "run"]


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    params = task.target_params()
    fitter = env.providers.timing
    budgets = {t.translationVersionId: t.timingBudgetUs for t in params.translations}
    segment_durations = {s.id: s.range.duration_us for s in params.segments}
    fits: list[TimingFit] = []
    with workdir() as wd:
        for sp in params.speech:
            budget = budgets.get(sp.translationVersionId, segment_durations.get(sp.segmentId, 0))
            decision = fitter.fit(sp.measuredDurationUs, budget)
            if decision.fits:
                raw_uri = find_artifact(
                    task, storage, "SYNTHESIZING", speech_wav_name(sp.segmentId)
                )
                if raw_uri is not None:
                    raw = wd / f"{sp.segmentId}.wav"
                    fitted = wd / f"{sp.segmentId}.fit.wav"
                    storage.download(raw_uri, raw)
                    fitter.stretch(raw, fitted, decision.time_stretch_ratio)
                    storage.put(
                        derived_uri(task, speech_wav_name(sp.segmentId, fitted=True)),
                        fitted,
                        "audio/wav",
                    )
            fits.append(
                TimingFit(
                    segmentId=sp.segmentId,
                    strategy=decision.strategy,
                    timeStretchRatio=decision.time_stretch_ratio,
                    boundaryShiftUs=decision.boundary_shift_us,
                    fits=decision.fits,
                )
            )
    return TimingOutput(fits=fits).model_dump()
