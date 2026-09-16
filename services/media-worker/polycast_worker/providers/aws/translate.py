"""Amazon Translate adapter (TranslationProvider).

Segments are batched into requests of at most 10,000 bytes (newline separated) and the
response is split back per segment; if a batch comes back with a different line count the
adapter falls back to one request per segment so ids never drift (FR-010). Formality is
only sent for target languages that support it; a configured custom terminology is passed as
`TerminologyNames` (FR-015 glossary hook). Translate reports no confidence; 0.75 is fixed.
"""

from __future__ import annotations

from typing import Any

from ..base import CapabilityRecord, ProviderContext
from .clients import ClientFactory, provider_error
from .locales import SEED_LOCALES, TRANSLATE_FORMALITY_CODES, translate_code

ADAPTER_ID = "aws-translate"
ADAPTER_VERSION = "1"
TRANSLATE_CONFIDENCE = 0.75
MAX_REQUEST_BYTES = 10_000
DEFAULT_FORMALITY = "INFORMAL"  # conversational podcast register; a "formal" hint flips it


def batch_texts(texts: list[str], limit: int = MAX_REQUEST_BYTES) -> list[list[int]]:
    """Indices of `texts` grouped so that each group joined by '\\n' stays within `limit` bytes.

    A single text above the limit is its own group (Translate will reject it; the error is
    typed, not silent).
    """
    groups: list[list[int]] = []
    current: list[int] = []
    size = 0
    for i, t in enumerate(texts):
        n = len(t.encode("utf-8"))
        extra = n + (1 if current else 0)
        if current and size + extra > limit:
            groups.append(current)
            current, size = [], 0
            extra = n
        current.append(i)
        size += extra
    if current:
        groups.append(current)
    return groups


def formality_for(target_code: str, hint: str | None) -> str | None:
    if target_code not in TRANSLATE_FORMALITY_CODES:
        return None
    h = (hint or "").lower()
    if "formal" in h and "informal" not in h:
        return "FORMAL"
    return DEFAULT_FORMALITY


class TranslateProvider:
    def __init__(self, clients: ClientFactory, *, terminology_name: str | None = None) -> None:
        self._clients = clients
        self._terminology = terminology_name

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="translation",
                locale=loc,
                region=self._clients.region,
                tier="beta",
                version=ADAPTER_VERSION,
                dataPolicy="no-training",
                priceUnit="character",
            )
            for loc in SEED_LOCALES
        ]

    def _call(self, text: str, source: str, target: str, hint: str | None) -> str:
        params: dict[str, Any] = {
            "Text": text,
            "SourceLanguageCode": source,
            "TargetLanguageCode": target,
        }
        formality = formality_for(target, hint)
        if formality:
            params["Settings"] = {"Formality": formality}
        if self._terminology:
            params["TerminologyNames"] = [self._terminology]
        try:
            resp = self._clients.client("translate").translate_text(**params)
        except Exception as e:
            raise provider_error("translate", e) from e
        return str(resp.get("TranslatedText", ""))

    def translate(
        self,
        segments: list[dict[str, object]],
        target_locale: str,
        ctx: ProviderContext,
        hint: str | None = None,
        source_locale: str | None = None,
    ) -> list[dict[str, object]]:
        source = translate_code(source_locale) if source_locale else "auto"
        target = translate_code(target_locale)
        texts = [str(s.get("text", "")) for s in segments]
        translated: list[str | None] = [None] * len(texts)
        for group in batch_texts(texts):
            if len(group) > 1:
                joined = "\n".join(texts[i] for i in group)
                lines = self._call(joined, source, target, hint).split("\n")
                if len(lines) == len(group):
                    for i, line in zip(group, lines, strict=True):
                        translated[i] = line.strip()
                    continue
            for i in group:
                translated[i] = self._call(texts[i], source, target, hint).strip()
        return [
            {
                "segmentId": seg.get("segmentId"),
                "adaptedText": translated[i] or "",
                "literalText": None,
                "confidence": TRANSLATE_CONFIDENCE,
            }
            for i, seg in enumerate(segments)
        ]
