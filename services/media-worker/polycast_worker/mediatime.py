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


def from_frames(frames: int, sample_rate: int) -> int:
    """Sample count at a sample rate → microseconds (exact, half-up)."""
    return from_rational(frames, 1, sample_rate)


def _split_clock(us: int) -> tuple[int, int, int, int]:
    if us < 0:
        raise ValueError("media time must be non-negative")
    ms, _ = divmod(us, 1000)
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return hours, minutes, seconds, millis


def to_srt_timestamp(us: int) -> str:
    """`HH:MM:SS,mmm` (SubRip). Truncates sub-millisecond precision."""
    h, m, s, ms = _split_clock(us)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_vtt_timestamp(us: int) -> str:
    """`HH:MM:SS.mmm` (WebVTT)."""
    h, m, s, ms = _split_clock(us)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
