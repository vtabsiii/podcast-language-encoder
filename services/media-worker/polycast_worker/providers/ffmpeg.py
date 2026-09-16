"""ffmpeg-backed local providers: encode, duration fit (atempo) and remix/loudness.

These run inside the worker (no network). They are "real" in the sense of FR-022/FR-023 and
carry tier "beta" in aws mode; in local mode the registry registers the encoder at tier
"unavailable" alongside the mocks (M1 provenance semantics: nothing local is selectable),
and the mix degrades to the untranslated source because mock renders carry no audio.
"""

from __future__ import annotations

import json
import re
import shutil
import wave
from pathlib import Path

from ..audio import is_riff_wave, measure_loudness
from ..mediatime import MICROS_PER_SECOND, from_frames
from ..naming import content_type_for, source_extension
from ..storage import Storage
from ..timing_fit import atempo_chain, fit_segment
from ..tools import ToolError, Tools
from .base import (
    AsyncHandle,
    CapabilityRecord,
    CapabilityTier,
    ProviderContext,
    SpeechPlacement,
    TimingDecision,
)

FFMPEG_ADAPTER_VERSION = "1"
FIXTURE_LUFS = -16.0
FIXTURE_TRUE_PEAK = -1.0
TARGET_LUFS_STEREO = -16.0
TARGET_LUFS_MONO = -19.0
TARGET_TRUE_PEAK = -1.0
DUCK_GAIN = 0.15  # ≈ −16.5 dB under the dubbed dialogue
MIX_RATE = 48000

_LOUDNORM_JSON_RE = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def wav_duration_us(path: Path) -> int:
    with wave.open(str(path), "rb") as w:
        return from_frames(w.getnframes(), w.getframerate())


def _us_to_seconds(us: int) -> str:
    return f"{us / MICROS_PER_SECOND:.6f}"


# ---------- encode ----------


class FfmpegEncodeProvider:
    """MP4 (video copied, AAC 128k) or MP3 128k from the mix; source bytes without ffmpeg.

    `encode()` runs synchronously and parks the result for `poll()` so the stage can treat
    every MediaEncodeProvider the same way.
    """

    def __init__(
        self,
        storage: Storage,
        tools: Tools,
        *,
        region: str = "local",
        tier: CapabilityTier = "beta",
    ) -> None:
        self._storage = storage
        self._tools = tools
        self._region = region
        self._tier = tier
        self._results: dict[str, dict[str, object]] = {}

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId="ffmpeg-encode",
                kind="encode",
                locale=None,
                region=self._region,
                tier=self._tier,
                version=FFMPEG_ADAPTER_VERSION,
                dataPolicy="no-training",
                priceUnit="second",
            )
        ]

    def encode(
        self, input_s3_uri: str, preset: dict[str, object], ctx: ProviderContext
    ) -> AsyncHandle:
        workdir = preset.get("workdir")
        output_prefix = preset.get("outputPrefix")
        if not isinstance(workdir, Path) or not isinstance(output_prefix, str):
            raise ValueError("ffmpeg encode preset needs 'workdir' and 'outputPrefix'")
        has_video = bool(preset.get("hasVideo"))
        container = str(preset.get("container") or "")
        mix_uri = preset.get("mix")
        local = workdir / "source.bin"
        self._storage.download(input_s3_uri, local)
        if not self._tools.has_ffmpeg:
            ext = source_extension(input_s3_uri, container)
            out = local
        else:
            mix = workdir / "mix.wav"
            if isinstance(mix_uri, str):
                self._storage.download(mix_uri, mix)
            else:
                self._tools.run_ffmpeg(
                    ["-i", local, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", mix]
                )
            if has_video:
                ext = "mp4"
                out = workdir / "encode.mp4"
                self._tools.run_ffmpeg(
                    [
                        "-i",
                        local,
                        "-i",
                        mix,
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "128k",
                        "-movflags",
                        "+faststart",
                        "-shortest",
                        out,
                    ]
                )
            else:
                ext = "mp3"
                out = workdir / "encode.mp3"
                self._tools.run_ffmpeg(
                    ["-i", mix, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", out]
                )
        uri = output_prefix + f"encode.{ext}"
        self._storage.put(uri, out, content_type_for(ext))
        handle = AsyncHandle(adapterId="ffmpeg-encode", externalId=ctx.idempotencyKey)
        self._results[handle.externalId] = {
            "status": "COMPLETED",
            "encode": uri,
            "container": ext,
            "byteSize": out.stat().st_size,
        }
        return handle

    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        return self._results.get(handle.externalId)


# ---------- timing ----------


class AtempoTimingFitter:
    """FR-022: pure arithmetic decision plus an ffmpeg `atempo` stretch of the render."""

    def __init__(self, tools: Tools) -> None:
        self._tools = tools

    def fit(self, measured_us: int, budget_us: int) -> TimingDecision:
        return fit_segment(measured_us, budget_us)

    def stretch(self, wav_in: Path, wav_out: Path, ratio: float) -> int:
        if ratio == 1.0:
            shutil.copyfile(wav_in, wav_out)
            return wav_duration_us(wav_out)
        chain = ",".join(f"atempo={f}" for f in atempo_chain(ratio))
        self._tools.run_ffmpeg(["-i", wav_in, "-af", chain, "-c:a", "pcm_s16le", wav_out])
        return wav_duration_us(wav_out)


# ---------- mixing ----------


class PassthroughMixer:
    """M1 behaviour: normalised stereo 48 kHz WAV of the source audio; renders are ignored."""

    def __init__(self, tools: Tools) -> None:
        self._tools = tools

    def mix(
        self, source: Path, placements: list[SpeechPlacement], out: Path, *, channels: int
    ) -> tuple[float, float]:
        if self._tools.has_ffmpeg:
            self._tools.run_ffmpeg(
                [
                    "-i",
                    source,
                    "-vn",
                    "-ac",
                    "2",
                    "-ar",
                    "48000",
                    "-af",
                    "loudnorm=I=-16:TP=-1",
                    "-c:a",
                    "pcm_s16le",
                    out,
                ]
            )
            return measure_loudness(self._tools, out) or (FIXTURE_LUFS, FIXTURE_TRUE_PEAK)
        with source.open("rb") as f:
            if not is_riff_wave(f.read(12)):
                raise ToolError("ffmpeg is required to mix this source", retryable=True)
        shutil.copyfile(source, out)
        return FIXTURE_LUFS, FIXTURE_TRUE_PEAK


def parse_loudnorm_json(stderr: str) -> dict[str, str] | None:
    """The measurement block printed by `loudnorm=...:print_format=json` (first pass)."""
    m = _LOUDNORM_JSON_RE.findall(stderr)
    if not m:
        return None
    try:
        data = json.loads(m[-1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return {str(k): str(v) for k, v in data.items()}


def duck_expression(placements: list[SpeechPlacement]) -> str:
    """`volume` timeline expression enabling the duck only while dubbed speech plays."""
    return "+".join(
        f"between(t,{_us_to_seconds(p.start_us)},{_us_to_seconds(p.end_us)})" for p in placements
    )


def build_dub_filter(placements: list[SpeechPlacement], channels: int) -> str:
    layout = "mono" if channels == 1 else "stereo"
    fmt = f"aresample={MIX_RATE},aformat=sample_fmts=s16:channel_layouts={layout}"
    parts = [f"[0:a]{fmt}"]
    if placements:
        parts[0] += f",volume={DUCK_GAIN}:enable='{duck_expression(placements)}'"
    parts[0] += "[bed]"
    labels = ["[bed]"]
    for i, p in enumerate(placements, start=1):
        delay_ms = p.start_us // 1000
        parts.append(f"[{i}:a]{fmt},adelay={delay_ms}:all=1[s{i}]")
        labels.append(f"[s{i}]")
    parts.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=first[mixed]")
    return ";".join(parts)


class DubMixer:
    """FR-023: dubbed speech over the ducked original bed, two-pass loudnorm, ebur128 check."""

    def __init__(self, tools: Tools) -> None:
        self._tools = tools

    def _loudnorm(self, target_i: float, measured: dict[str, str] | None) -> str:
        base = f"loudnorm=I={target_i}:TP={TARGET_TRUE_PEAK}:LRA=11"
        if measured is None:
            return base
        try:
            return (
                f"{base}:measured_I={float(measured['input_i'])}"
                f":measured_TP={float(measured['input_tp'])}"
                f":measured_LRA={float(measured['input_lra'])}"
                f":measured_thresh={float(measured['input_thresh'])}"
                f":offset={float(measured['target_offset'])}:linear=true"
            )
        except (KeyError, ValueError):
            return base

    def mix(
        self, source: Path, placements: list[SpeechPlacement], out: Path, *, channels: int
    ) -> tuple[float, float]:
        if not self._tools.has_ffmpeg:
            raise ToolError("ffmpeg is required to mix dubbed speech", retryable=True)
        ch = 1 if channels == 1 else 2
        target_i = TARGET_LUFS_MONO if ch == 1 else TARGET_LUFS_STEREO
        raw = out.with_name("premix.wav")
        args: list[str | Path] = ["-i", source]
        for p in placements:
            args += ["-i", p.wav]
        args += [
            "-filter_complex",
            build_dub_filter(placements, ch),
            "-map",
            "[mixed]",
            "-c:a",
            "pcm_s16le",
            raw,
        ]
        self._tools.run_ffmpeg(args)
        first = self._tools.run_ffmpeg_stderr(
            [
                "-i",
                raw,
                "-af",
                self._loudnorm(target_i, None) + ":print_format=json",
                "-f",
                "null",
                "-",
            ]
        )
        measured = parse_loudnorm_json(first)
        self._tools.run_ffmpeg(
            [
                "-i",
                raw,
                "-af",
                self._loudnorm(target_i, measured),
                "-ar",
                str(MIX_RATE),
                "-ac",
                str(ch),
                "-c:a",
                "pcm_s16le",
                out,
            ]
        )
        return measure_loudness(self._tools, out) or (target_i, TARGET_TRUE_PEAK)
