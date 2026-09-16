"""Amazon Transcribe batch adapter (TranscriptionProvider).

    transcribe()  StartTranscriptionJob with speaker labels, language identification (or the
                  declared locale), output under the task's derived prefix
    poll()        GetTranscriptionJob; on COMPLETED reads the job output JSON through the
                  Storage abstraction and parses it into the AnalyzingOutput shape

Parsing rules: consecutive words of one speaker merge into a segment that is at most 8 s long
and is split on a silence of ≥ 600 ms; every timestamp is converted with
`mediatime.from_seconds_str` (exact decimal → µs, never a float).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from ...mediatime import from_seconds_str
from ...storage import Storage, parse_uri
from ..base import AsyncHandle, CapabilityRecord, ProviderContext, ProviderError
from .clients import ClientFactory, error_code, provider_error
from .locales import SEED_LOCALES, transcribe_code

ADAPTER_ID = "aws-transcribe"
ADAPTER_VERSION = "1"
MAX_SPEAKER_LABELS = 10
SEGMENT_MAX_US = 8_000_000
SILENCE_SPLIT_US = 600_000
_JOB_NAME_RE = re.compile(r"[^0-9A-Za-z._-]")
_HINT_CONFIDENCE = 1.0


def job_name_for(ctx: ProviderContext) -> str:
    digest = hashlib.sha256(ctx.idempotencyKey.encode("utf-8")).hexdigest()[:32]
    return f"polycast-{digest}"


def _speaker_key(index: int) -> str:
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return letters[index] if index < 26 else f"S{index}"


@dataclass
class _Word:
    text: str
    start_us: int
    end_us: int
    confidence: float
    speaker: str


def _speaker_map(results: dict[str, Any]) -> dict[str, str]:
    """start_time string → speaker label, from results.speaker_labels.segments[].items[]."""
    out: dict[str, str] = {}
    labels = results.get("speaker_labels")
    if not isinstance(labels, dict):
        return out
    for seg in labels.get("segments", []):
        label = str(seg.get("speaker_label", ""))
        for item in seg.get("items", []):
            start = item.get("start_time")
            if isinstance(start, str):
                out[start] = label
    return out


def _words(results: dict[str, Any]) -> list[_Word]:
    by_start = _speaker_map(results)
    words: list[_Word] = []
    for item in results.get("items", []):
        kind = item.get("type")
        alternatives = item.get("alternatives") or [{}]
        content = str(alternatives[0].get("content", ""))
        if kind == "punctuation":
            if words:
                words[-1].text += content
            continue
        start, end = item.get("start_time"), item.get("end_time")
        if not isinstance(start, str) or not isinstance(end, str):
            continue
        conf_raw = alternatives[0].get("confidence", "0")
        try:
            confidence = min(1.0, max(0.0, float(conf_raw)))
        except (TypeError, ValueError):
            confidence = 0.0
        speaker = str(item.get("speaker_label") or by_start.get(start) or "spk_0")
        words.append(
            _Word(content, from_seconds_str(start), from_seconds_str(end), confidence, speaker)
        )
    return words


def segment_words(words: list[_Word]) -> list[list[_Word]]:
    groups: list[list[_Word]] = []
    for w in words:
        if groups:
            cur = groups[-1]
            same_speaker = cur[-1].speaker == w.speaker
            gap = w.start_us - cur[-1].end_us
            too_long = w.end_us - cur[0].start_us > SEGMENT_MAX_US
            if same_speaker and gap < SILENCE_SPLIT_US and not too_long:
                cur.append(w)
                continue
        groups.append([w])
    return groups


def parse_transcript(payload: dict[str, Any], *, locale_hint: str | None) -> dict[str, object]:
    """Transcribe job output JSON → AnalyzingOutput fields (minus proxy/waveform/onCamera).

    `onCamera` is left False; the stage knows whether the source has video."""
    results = payload.get("results")
    if not isinstance(results, dict):
        raise ProviderError("PROVIDER_BAD_OUTPUT", "Transcribe output had no results.")
    words = _words(results)
    groups = segment_words(words)
    speakers_in_order: dict[str, None] = {}
    for g in groups:
        speakers_in_order.setdefault(g[0].speaker, None)
    key_of = {label: _speaker_key(i) for i, label in enumerate(speakers_in_order)}
    if not key_of:
        key_of = {"spk_0": "A"}

    language_code = str(payload.get("language_code") or results.get("language_code") or "")
    score: float | None = None
    for ident in results.get("language_identification", []) or []:
        if isinstance(ident, dict) and ident.get("code") == language_code:
            try:
                score = float(ident.get("score", 0))
            except (TypeError, ValueError):
                score = None
    if not language_code:
        language_code = locale_hint or "en-US"
    language = language_code.split("-", 1)[0].lower()

    segments: list[dict[str, object]] = []
    for seq, g in enumerate(groups):
        conf = round(sum(w.confidence for w in g) / len(g), 4)
        segments.append(
            {
                "seq": seq,
                "speakerKey": key_of[g[0].speaker],
                "range": {"start": g[0].start_us, "end": g[-1].end_us},
                "text": " ".join(w.text for w in g),
                "language": language,
                "confidence": conf,
                "words": [
                    {
                        "text": w.text,
                        "range": {"start": w.start_us, "end": w.end_us},
                        "confidence": round(w.confidence, 4),
                    }
                    for w in g
                ],
            }
        )
    speakers: list[dict[str, object]] = []
    for key in key_of.values():
        samples = [s["range"] for s in segments if s["speakerKey"] == key][:2]
        speakers.append(
            {
                "key": key,
                "label": f"Speaker {key}",
                "onCamera": False,
                "voicePolicy": "stock",
                "sampleRanges": samples,
            }
        )
    confidence = _HINT_CONFIDENCE if locale_hint else (score if score is not None else 0.5)
    return {
        "detectedLocale": language_code,
        "detectionConfidence": round(min(1.0, max(0.0, confidence)), 4),
        "speakers": speakers,
        "segments": segments,
    }


class TranscribeProvider:
    def __init__(
        self,
        clients: ClientFactory,
        storage: Storage,
        *,
        data_access_role_arn: str | None = None,
    ) -> None:
        self._clients = clients
        self._storage = storage
        self._role = data_access_role_arn
        self._hints: dict[str, str | None] = {}

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="transcription",
                locale=loc,
                region=self._clients.region,
                tier="beta",
                version=ADAPTER_VERSION,
                dataPolicy="no-training",
                priceUnit="second",
            )
            for loc in SEED_LOCALES
        ]

    @staticmethod
    def output_uri(ctx: ProviderContext, job_name: str) -> tuple[str, str, str]:
        """(uri, bucket, key) of the job output under the task's derived prefix."""
        if not ctx.derivedPrefix:
            raise ProviderError("INVALID_TASK", "Transcribe needs a derived prefix.")
        prefix = ctx.derivedPrefix if ctx.derivedPrefix.endswith("/") else ctx.derivedPrefix + "/"
        u = parse_uri(prefix + "x")
        key = u.key[:-1] + f"transcribe/{job_name}.json"
        return f"{u.scheme}://{u.bucket}/{key}", u.bucket, key

    def transcribe(
        self, input_s3_uri: str, locale_hint: str | None, ctx: ProviderContext
    ) -> AsyncHandle:
        job_name = job_name_for(ctx)
        _, bucket, key = self.output_uri(ctx, job_name)
        params: dict[str, Any] = {
            "TranscriptionJobName": job_name,
            "Media": {"MediaFileUri": input_s3_uri},
            "OutputBucketName": bucket,
            "OutputKey": key,
            "Settings": {"ShowSpeakerLabels": True, "MaxSpeakerLabels": MAX_SPEAKER_LABELS},
        }
        if locale_hint:
            params["LanguageCode"] = transcribe_code(locale_hint)
        else:
            params["IdentifyLanguage"] = True
        if self._role:
            params["JobExecutionSettings"] = {"DataAccessRoleArn": self._role}
        try:
            self._clients.client("transcribe").start_transcription_job(**params)
        except Exception as e:  # botocore exceptions are dynamic classes
            if error_code(e) != "ConflictException":  # already started: poll it
                raise provider_error("transcribe", e) from e
        self._hints[job_name] = locale_hint
        return AsyncHandle(adapterId=ADAPTER_ID, externalId=job_name)

    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        try:
            resp = self._clients.client("transcribe").get_transcription_job(
                TranscriptionJobName=handle.externalId
            )
        except Exception as e:
            raise provider_error("transcribe", e) from e
        job = resp.get("TranscriptionJob", {})
        status = str(job.get("TranscriptionJobStatus", ""))
        if status in ("QUEUED", "IN_PROGRESS"):
            return None
        if status != "COMPLETED":
            raise ProviderError("TRANSCRIPTION_FAILED", "Transcribe could not process the media.")
        uri, _, _ = self.output_uri(ctx, handle.externalId)
        try:
            payload = json.loads(self._storage.get(uri).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ProviderError("PROVIDER_BAD_OUTPUT", "Transcribe output was not JSON.") from e
        if not isinstance(payload, dict):
            raise ProviderError("PROVIDER_BAD_OUTPUT", "Transcribe output was not an object.")
        hint = self._hints.get(handle.externalId)
        language_code = job.get("LanguageCode")
        if isinstance(language_code, str) and language_code:
            payload = {**payload, "language_code": language_code}
        parsed = parse_transcript(payload, locale_hint=hint)
        score = job.get("IdentifiedLanguageScore")
        if hint is None and isinstance(score, int | float):
            parsed["detectionConfidence"] = round(min(1.0, max(0.0, float(score))), 4)
        return {"status": "COMPLETED", **parsed}
