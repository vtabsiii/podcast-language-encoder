"""External tool discovery (ffmpeg/ffprobe) and a guarded subprocess runner.

`Tools` is injected into stage handlers so tests can force the no-ffmpeg code paths.
Arguments are always lists; the worker never builds shell strings. Error messages never
carry file paths or raw tool stderr (A-17).
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class ToolError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class Tools:
    ffmpeg: str | None
    ffprobe: str | None
    timeout_s: float = 600.0

    @classmethod
    def detect(cls) -> Tools:
        return cls(ffmpeg=shutil.which("ffmpeg"), ffprobe=shutil.which("ffprobe"))

    @classmethod
    def none(cls) -> Tools:
        return cls(ffmpeg=None, ffprobe=None)

    @property
    def has_ffmpeg(self) -> bool:
        return self.ffmpeg is not None

    @property
    def has_ffprobe(self) -> bool:
        return self.ffprobe is not None

    def run_ffmpeg(self, args: list[str | Path], *, capture_stdout: bool = False) -> bytes:
        """Run ffmpeg with the given arguments; returns stdout bytes (empty unless captured)."""
        if self.ffmpeg is None:
            raise ToolError("ffmpeg is not installed on this worker", retryable=True)
        cmd: list[str] = [self.ffmpeg, "-hide_banner", "-nostdin", "-y"]
        cmd.extend(str(a) for a in args)
        try:
            out = subprocess.run(
                cmd,
                stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=self.timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise ToolError("ffmpeg timed out", retryable=True) from e
        except OSError as e:
            raise ToolError("ffmpeg could not be started", retryable=True) from e
        if out.returncode != 0:
            raise ToolError("ffmpeg failed to process the media")
        return out.stdout if capture_stdout else b""

    def run_ffmpeg_stderr(self, args: list[str | Path]) -> str:
        """Run ffmpeg and return its stderr text (used for filter reports such as ebur128)."""
        if self.ffmpeg is None:
            raise ToolError("ffmpeg is not installed on this worker", retryable=True)
        cmd: list[str] = [self.ffmpeg, "-hide_banner", "-nostdin", "-nostats"]
        cmd.extend(str(a) for a in args)
        try:
            out = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=self.timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise ToolError("ffmpeg timed out", retryable=True) from e
        except OSError as e:
            raise ToolError("ffmpeg could not be started", retryable=True) from e
        if out.returncode != 0:
            raise ToolError("ffmpeg failed to analyse the media")
        return out.stderr.decode("utf-8", errors="replace")
