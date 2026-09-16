"""ffprobe wrapper. Produces MediaMetadata from a local file path.

The worker never shells out with user-controlled strings: arguments are passed as a list.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .mediatime import from_rational, from_seconds_str
from .models import AudioMetadata, MediaMetadata, Rational, VideoMetadata


class ProbeError(RuntimeError):
    pass


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def _parse_rational(text: str) -> Rational:
    num, _, den = text.partition("/")
    return Rational(num=int(num), den=int(den or "1"))


def parse_probe_output(data: dict[str, object]) -> MediaMetadata:
    """Pure function over ffprobe -print_format json output; unit-tested without ffprobe."""
    fmt = data.get("format")
    streams = data.get("streams")
    if not isinstance(fmt, dict) or not isinstance(streams, list):
        raise ProbeError("malformed ffprobe output")

    container = str(fmt.get("format_name", "")).split(",")[0]
    duration_us = from_seconds_str(str(fmt.get("duration", "0")))

    video: VideoMetadata | None = None
    audio: AudioMetadata | None = None
    for s in streams:
        if not isinstance(s, dict):
            continue
        kind = s.get("codec_type")
        if (
            kind == "video"
            and video is None
            and s.get("disposition", {}).get("attached_pic", 0) != 1
        ):
            avg = _parse_rational(str(s.get("avg_frame_rate", "0/1")))
            r = _parse_rational(str(s.get("r_frame_rate", "0/1")))
            if avg.num == 0:
                continue  # cover art / still stream
            # ffprobe reports VFR when avg and r frame rates disagree.
            vfr = Fraction_eq(avg, r) is False
            transfer = s.get("color_transfer")
            video = VideoMetadata(
                codec=str(s.get("codec_name", "unknown")),
                width=int(s["width"]),
                height=int(s["height"]),
                frameRate=avg,
                variableFrameRate=vfr,
                colorPrimaries=(str(s["color_primaries"]) if s.get("color_primaries") else None),
                transferCharacteristics=(str(transfer) if transfer else None),
                hdr=str(transfer) in {"smpte2084", "arib-std-b67"},
            )
            # Prefer the stream duration when the container lacks one.
            if duration_us == 0 and s.get("duration_ts") is not None and s.get("time_base"):
                tb = _parse_rational(str(s["time_base"]))
                duration_us = from_rational(int(s["duration_ts"]), tb.num, tb.den)
        elif kind == "audio" and audio is None:
            audio = AudioMetadata(
                codec=str(s.get("codec_name", "unknown")),
                sampleRate=int(s.get("sample_rate", 0)),
                channels=int(s.get("channels", 0)),
                channelLayout=str(s.get("channel_layout", "unknown")),
            )

    if audio is None:
        raise ProbeError("source has no audio stream")
    return MediaMetadata(container=container, durationUs=duration_us, video=video, audio=audio)


def Fraction_eq(a: Rational, b: Rational) -> bool:  # noqa: N802 - small local helper
    return a.num * b.den == b.num * a.den


def probe(path: Path, timeout_s: float = 60.0) -> MediaMetadata:
    if not ffprobe_available():
        raise ProbeError("ffprobe is not installed")
    if not path.is_file():
        raise ProbeError(f"not a file: {path.name}")
    args = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired as e:
        raise ProbeError("ffprobe timed out") from e
    if out.returncode != 0:
        raise ProbeError("ffprobe failed to read the file")
    return parse_probe_output(json.loads(out.stdout))
