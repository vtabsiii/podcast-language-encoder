"""Audio helpers: WAV fallback probing, PCM decoding, waveform peaks, loudness parsing.

Everything here is pure Python plus optional ffmpeg via `Tools`. No numpy: the worker only
needs coarse peaks (50/s) and the fixtures are short, so chunked loops are fast enough.
"""

from __future__ import annotations

import re
import sys
import wave
from array import array
from collections.abc import Iterator
from pathlib import Path

from .mediatime import MICROS_PER_SECOND, from_frames
from .models import AudioMetadata, MediaMetadata
from .tools import Tools

PEAKS_PER_SECOND = 50
_DECODE_RATE = 8000
_FRAMES_PER_CHUNK = 65536


class AudioError(ValueError):
    """The bytes are not audio the fallback path can handle (terminal)."""


def is_riff_wave(head: bytes) -> bool:
    return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE"


def _channel_layout(channels: int) -> str:
    return {1: "mono", 2: "stereo"}.get(channels, f"{channels} channels")


def probe_wav(path: Path) -> MediaMetadata:
    """MediaMetadata for a PCM WAV using the stdlib; duration is exact (frames / rate)."""
    try:
        with wave.open(str(path), "rb") as w:
            channels = w.getnchannels()
            rate = w.getframerate()
            width = w.getsampwidth()
            frames = w.getnframes()
    except (wave.Error, EOFError, OSError) as e:
        raise AudioError("malformed wav") from e
    if channels <= 0 or rate <= 0 or width <= 0:
        raise AudioError("malformed wav")
    codec = "pcm_u8" if width == 1 else f"pcm_s{8 * width}le"
    return MediaMetadata(
        container="wav",
        durationUs=from_frames(frames, rate),
        video=None,
        audio=AudioMetadata(
            codec=codec, sampleRate=rate, channels=channels, channelLayout=_channel_layout(channels)
        ),
    )


def _to_int16_array(raw: bytes) -> array[int]:
    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def iter_wav_mono_pcm(path: Path) -> tuple[int, Iterator[array[int]]]:
    """(sample_rate, chunks of mono int16 samples) decoded with the stdlib wave module."""
    try:
        w = wave.open(str(path), "rb")
    except (wave.Error, EOFError, OSError) as e:
        raise AudioError("malformed wav") from e
    channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
    if width != 2:
        w.close()
        raise AudioError("only 16-bit pcm wav is supported without ffmpeg")

    def chunks() -> Iterator[array[int]]:
        try:
            while True:
                raw = w.readframes(_FRAMES_PER_CHUNK)
                if not raw:
                    break
                samples = _to_int16_array(raw)
                if channels == 1:
                    yield samples
                    continue
                mono = array("h")
                for i in range(0, len(samples) - channels + 1, channels):
                    mono.append(sum(samples[i : i + channels]) // channels)
                yield mono
        finally:
            w.close()

    return rate, chunks()


def decode_mono_pcm_ffmpeg(tools: Tools, path: Path) -> tuple[int, Iterator[array[int]]]:
    """(sample_rate, one chunk of mono int16 samples) decoded at 8 kHz by ffmpeg."""
    raw = tools.run_ffmpeg(
        ["-i", path, "-vn", "-f", "s16le", "-ac", "1", "-ar", str(_DECODE_RATE), "-"],
        capture_stdout=True,
    )
    return _DECODE_RATE, iter([_to_int16_array(raw)])


def compute_peaks(
    rate: int, chunks: Iterator[array[int]], duration_us: int, peaks_per_second: int
) -> list[float]:
    """Peak |amplitude| in [0, 1] per window; exactly ceil(duration * pps) entries."""
    window = max(1, rate // peaks_per_second)
    expected = -(-duration_us * peaks_per_second // MICROS_PER_SECOND)  # ceil
    peaks: list[float] = []
    current = 0
    filled = 0
    for chunk in chunks:
        for s in chunk:
            a = -s if s < 0 else s
            if a > current:
                current = a
            filled += 1
            if filled == window:
                peaks.append(round(min(current, 32767) / 32767, 4))
                current = 0
                filled = 0
    if filled:
        peaks.append(round(min(current, 32767) / 32767, 4))
    if len(peaks) < expected:
        peaks.extend([0.0] * (expected - len(peaks)))
    return peaks[:expected]


_LUFS_RE = re.compile(r"^\s*I:\s+(-?[0-9.]+|-inf)\s+LUFS", re.M)
_PEAK_RE = re.compile(r"^\s*Peak:\s+(-?[0-9.]+|-inf)\s+dBFS", re.M)


def parse_ebur128_summary(stderr: str) -> tuple[float, float] | None:
    """(integrated LUFS, true peak dBTP) from ffmpeg's ebur128 summary block, or None."""
    summary = stderr.rsplit("Summary:", 1)
    if len(summary) != 2:
        return None
    lufs = _LUFS_RE.search(summary[1])
    peak = _PEAK_RE.search(summary[1])
    if not lufs or not peak or "inf" in lufs.group(1) or "inf" in peak.group(1):
        return None
    return float(lufs.group(1)), float(peak.group(1))


def measure_loudness(tools: Tools, path: Path) -> tuple[float, float] | None:
    if not tools.has_ffmpeg:
        return None
    stderr = tools.run_ffmpeg_stderr(
        ["-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]
    )
    return parse_ebur128_summary(stderr)
