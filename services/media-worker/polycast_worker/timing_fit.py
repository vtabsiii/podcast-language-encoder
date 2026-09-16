"""Duration-fit arithmetic (FR-013 / FR-022). Integer microseconds in, one decision out.

ratio = measured / budget
ratio <  0.88              → "none"            (leave the render as is; it is shorter)
0.88 ≤ ratio ≤ 1.12        → "rate"            (atempo by `ratio`, bounded ±12%)
otherwise, if stretching to 1.12 still overruns by ≤ 120 ms → "boundary-shift"
otherwise                  → "retranslate"     (fits = false; the API asks for a shorter text)
"""

from __future__ import annotations

import math

from .providers.base import TimingDecision

RATE_MIN = 0.88
RATE_MAX = 1.12
MAX_BOUNDARY_SHIFT_US = 120_000
ATEMPO_MIN = 0.5
ATEMPO_MAX = 2.0


def fit_segment(measured_us: int, budget_us: int) -> TimingDecision:
    budget = max(1, budget_us)
    ratio = measured_us / budget
    if ratio < RATE_MIN:
        return TimingDecision("none", 1.0, 0, True)
    if ratio <= RATE_MAX:
        return TimingDecision("rate", round(ratio, 4), 0, True)
    shift = math.ceil(measured_us / RATE_MAX) - budget
    if shift <= MAX_BOUNDARY_SHIFT_US:
        stretched = min(RATE_MAX, measured_us / (budget + shift))
        return TimingDecision("boundary-shift", round(stretched, 4), shift, True)
    return TimingDecision("retranslate", round(ratio, 4), 0, False)


def fitted_duration_us(measured_us: int, ratio: float) -> int:
    """Duration after an atempo of `ratio` (speed factor); exact for ratio 1.0."""
    if ratio <= 0 or ratio == 1.0:
        return measured_us
    return int(round(measured_us / ratio))


def atempo_chain(ratio: float) -> list[float]:
    """ffmpeg `atempo` accepts 0.5–2.0 per instance; larger changes are chained."""
    if ratio <= 0:
        raise ValueError("tempo ratio must be positive")
    factors: list[float] = []
    remaining = ratio
    while remaining > ATEMPO_MAX:
        factors.append(ATEMPO_MAX)
        remaining /= ATEMPO_MAX
    while remaining < ATEMPO_MIN:
        factors.append(ATEMPO_MIN)
        remaining /= ATEMPO_MIN
    factors.append(round(remaining, 6))
    return factors
