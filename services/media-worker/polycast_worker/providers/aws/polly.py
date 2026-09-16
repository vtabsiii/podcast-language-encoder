"""Amazon Polly adapter (SpeechProvider).

`synthesize()` requests raw 16 kHz PCM (timing-exact: durationUs comes from the byte length,
integer arithmetic through `mediatime.from_frames`) and word speech marks in a second call;
it returns the render as WAV bytes plus the marks and leaves persisting to the stage, which
writes `speech/<segmentId>.wav` under the derived prefix. `list_voices()` wraps DescribeVoices
for the locale's Polly language code. The default voice table (FR-021) is in `locales.py`;
locales without a neural voice register as tier "unavailable" for speech.
"""

from __future__ import annotations

import io
import json
import wave
from typing import Any

from ...mediatime import from_frames
from ..base import CapabilityRecord, ProviderContext, ProviderError
from .clients import ClientFactory, provider_error
from .locales import POLLY_VOICES, SEED_LOCALES

ADAPTER_ID = "aws-polly"
ADAPTER_VERSION = "1"
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
MAX_TEXT_CHARS = 3000  # Polly limit for plain text (billed characters)


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(SAMPLE_WIDTH)
        w.setframerate(sample_rate)
        w.writeframes(pcm[: len(pcm) - (len(pcm) % SAMPLE_WIDTH)])
    return buf.getvalue()


def pcm_duration_us(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> int:
    return from_frames(len(pcm) // SAMPLE_WIDTH, sample_rate)


def parse_speech_marks(raw: bytes) -> list[dict[str, object]]:
    """Polly emits one JSON object per line: {"time": ms, "type": "word", "value": ...}."""
    marks: list[dict[str, object]] = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "word":
            marks.append(
                {"text": str(obj.get("value", "")), "timeUs": int(obj.get("time", 0)) * 1000}
            )
    return marks


def _read_stream(body: Any) -> bytes:
    data = body.read() if hasattr(body, "read") else body
    return bytes(data) if isinstance(data, bytes | bytearray) else b""


class PollyProvider:
    def __init__(self, clients: ClientFactory, *, engine: str = "neural") -> None:
        self._clients = clients
        self.engine = engine

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="speech",
                locale=loc,
                region=self._clients.region,
                tier="beta" if POLLY_VOICES.get(loc) else "unavailable",
                version=f"{ADAPTER_VERSION}-{self.engine}",
                dataPolicy="no-training",
                priceUnit="character",
            )
            for loc in SEED_LOCALES
        ]

    def default_voice(self, locale: str) -> str | None:
        v = POLLY_VOICES.get(locale)
        return v.voice_id if v else None

    def list_voices(self, locale: str) -> list[dict[str, object]]:
        v = POLLY_VOICES.get(locale)
        if v is None:
            return []
        try:
            resp = self._clients.client("polly").describe_voices(
                Engine=self.engine, LanguageCode=v.language_code
            )
        except Exception as e:
            raise provider_error("polly", e) from e
        return [
            {
                "voiceId": str(item.get("Id")),
                "displayName": str(item.get("Name", item.get("Id"))),
                "locale": locale,
                "gender": str(item.get("Gender", "")),
                "engines": list(item.get("SupportedEngines", [])),
            }
            for item in resp.get("Voices", [])
        ]

    def synthesize(
        self, text: str, voice_id: str, target_duration_us: int | None, ctx: ProviderContext
    ) -> dict[str, object]:
        if len(text) > MAX_TEXT_CHARS:
            raise ProviderError("PROVIDER_ERROR", "Segment text exceeds the Polly length limit.")
        polly = self._clients.client("polly")
        try:
            audio = polly.synthesize_speech(
                Engine=self.engine,
                OutputFormat="pcm",
                SampleRate=str(SAMPLE_RATE),
                Text=text,
                TextType="text",
                VoiceId=voice_id,
            )
            marks = polly.synthesize_speech(
                Engine=self.engine,
                OutputFormat="json",
                SpeechMarkTypes=["word"],
                Text=text,
                TextType="text",
                VoiceId=voice_id,
            )
        except Exception as e:
            raise provider_error("polly", e) from e
        pcm = _read_stream(audio.get("AudioStream"))
        if not pcm:
            raise ProviderError("PROVIDER_BAD_OUTPUT", "Polly returned no audio.", retryable=True)
        return {
            "durationUs": pcm_duration_us(pcm),
            "assetRef": None,
            "wav": pcm_to_wav(pcm),
            "sampleRate": SAMPLE_RATE,
            "words": parse_speech_marks(_read_stream(marks.get("AudioStream"))),
        }
