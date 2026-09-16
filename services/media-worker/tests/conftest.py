from __future__ import annotations

import json
import math
import re
import struct
import uuid
import wave
from collections.abc import Callable
from pathlib import Path

import jsonschema
import pytest

from polycast_worker.storage import LocalFsStorage

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "packages/contracts/schema"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")

FORMAT_CHECKER = jsonschema.Draft7Validator.FORMAT_CHECKER


@FORMAT_CHECKER.checks("uuid")
def _check_uuid(value: object) -> bool:
    return not isinstance(value, str) or bool(_UUID_RE.match(value))


@FORMAT_CHECKER.checks("date-time")
def _check_datetime(value: object) -> bool:
    return not isinstance(value, str) or bool(_DATETIME_RE.match(value))


def load_schema(name: str) -> dict[str, object]:
    path = SCHEMA_DIR / f"{name}.schema.json"
    if not path.exists():
        pytest.skip("contracts schema not built; run pnpm --filter @polycast/contracts build")
    data: dict[str, object] = json.loads(path.read_text())
    return data


def validate_schema(name: str, instance: object) -> None:
    jsonschema.validate(instance, load_schema(name), format_checker=FORMAT_CHECKER)


def new_id() -> str:
    return str(uuid.uuid4())


def write_tone_wav(
    path: Path, seconds: float = 12.0, rate: int = 16000, freq: float = 440.0, channels: int = 1
) -> Path:
    frames = int(seconds * rate)
    amp = 12000
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        chunk = bytearray()
        for i in range(frames):
            s = int(amp * math.sin(2 * math.pi * freq * i / rate))
            chunk += struct.pack("<h", s) * channels
        w.writeframes(bytes(chunk))
    return path


@pytest.fixture
def storage(tmp_path: Path) -> LocalFsStorage:
    return LocalFsStorage(tmp_path / "storage")


@pytest.fixture
def tone_wav(tmp_path: Path) -> Path:
    return write_tone_wav(tmp_path / "tone.wav")


@pytest.fixture
def schema() -> Callable[[str, object], None]:
    return validate_schema
