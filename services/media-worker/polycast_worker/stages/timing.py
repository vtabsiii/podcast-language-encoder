"""TIMING: decide how each speech render fits its budget (FR-022 subset, deterministic)."""

from __future__ import annotations

import math

from ..models import TimingFit, TimingOutput, TimingStrategy, WorkerTask
from ..storage import Storage
from ..tools import Tools

RATE_MIN = 0.88
RATE_MAX = 1.12
MAX_BOUNDARY_SHIFT_US = 120_000


def fit_segment(measured_us: int, budget_us: int) -> tuple[TimingStrategy, float, int, bool]:
    """(strategy, timeStretchRatio, boundaryShiftUs, fits) for one render."""
    budget = max(1, budget_us)
    ratio = measured_us / budget
    if ratio < RATE_MIN:
        return "none", 1.0, 0, True
    if ratio <= RATE_MAX:
        return "rate", round(ratio, 4), 0, True
    shift = math.ceil(measured_us / RATE_MAX) - budget
    if shift <= MAX_BOUNDARY_SHIFT_US:
        stretched = min(RATE_MAX, measured_us / (budget + shift))
        return "boundary-shift", round(stretched, 4), shift, True
    return "retranslate", round(ratio, 4), 0, False


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.target_params()
    budgets = {t.translationVersionId: t.timingBudgetUs for t in params.translations}
    segment_durations = {s.id: s.range.duration_us for s in params.segments}
    fits: list[TimingFit] = []
    for sp in params.speech:
        budget = budgets.get(sp.translationVersionId, segment_durations.get(sp.segmentId, 0))
        strategy, ratio, shift, ok = fit_segment(sp.measuredDurationUs, budget)
        fits.append(
            TimingFit(
                segmentId=sp.segmentId,
                strategy=strategy,
                timeStretchRatio=ratio,
                boundaryShiftUs=shift,
                fits=ok,
            )
        )
    return TimingOutput(fits=fits).model_dump()
