"""Exact rational → microsecond conversion (mirrors packages/domain time/media-time.ts)."""

from __future__ import annotations

from fractions import Fraction

MICROS_PER_SECOND = 1_000_000


def from_rational(pts: int, time_base_num: int, time_base_den: int) -> int:
    """Convert pts * (num/den) seconds to integer microseconds, rounding half away from zero."""
    if time_base_den == 0:
        raise ValueError("time base denominator must be non-zero")
    value = Fraction(pts * time_base_num * MICROS_PER_SECOND, time_base_den)
    q, r = divmod(value.numerator, value.denominator)
    if 2 * r >= value.denominator:
        q += 1
    if q < 0:
        raise ValueError("media time must be non-negative")
    return int(q)


def from_seconds_str(text: str) -> int:
    """Parse an ffprobe decimal seconds string exactly (no binary float)."""
    frac = Fraction(text)
    us = frac * MICROS_PER_SECOND
    q, r = divmod(us.numerator, us.denominator)
    if 2 * r >= us.denominator:
        q += 1
    if q < 0:
        raise ValueError("media time must be non-negative")
    return int(q)
