"""LLM translation adapter over Amazon Bedrock `converse` (FR-010, FR-011, FR-013).

The system prompt demands verbatim named entities / numbers / URLs, the speaker's register,
and a strict JSON array keyed by segment id. Each segment carries a `maxChars` budget derived
from its timing budget and the locale speaking rate; a "shorter" hint shrinks it by 20%.
Malformed output is retried once, then surfaces as a retryable ProviderError.
`promptVersion` is `bedrock-v1:<sha256(system prompt)[:8]>` so lineage records the exact prompt.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..base import CapabilityRecord, ProviderContext, ProviderError
from .clients import ClientFactory, provider_error
from .locales import SEED_LOCALES, max_chars_for

ADAPTER_ID = "aws-bedrock"
PROMPT_FAMILY = "bedrock-v1"
LLM_CONFIDENCE = 0.85
MAX_TOKENS = 4096
TEMPERATURE = 0.2

SYSTEM_PROMPT = """You are a professional dubbing translator for podcasts and video.
Translate each segment from the source locale into the target locale for spoken delivery.

Rules:
1. Preserve every named entity, person and product name, number, date, currency amount and
   URL verbatim as written in the source. Never transliterate or localise them.
2. Keep the speaker's register (formal/informal), tone and intent. Do not add or drop
   information. Do not add explanations.
3. Each segment has a maxChars budget so the spoken translation fits its time slot. Stay at
   or under it; prefer shorter natural phrasing over omission.
4. Use the context and speaker fields only for coherence; translate only the "text" field.
5. Respond with a JSON array only, no prose, no code fences:
   [{"segmentId": "<id>", "adaptedText": "<translation to be spoken>",
     "literalText": "<closer literal rendering, or null>"}]
   Include exactly one object per input segment, in input order, with the same segmentId."""


def prompt_version() -> str:
    return f"{PROMPT_FAMILY}:{hashlib.sha256(SYSTEM_PROMPT.encode('utf-8')).hexdigest()[:8]}"


def build_request(
    segments: list[dict[str, object]],
    source_locale: str | None,
    target_locale: str,
    hint: str | None,
) -> dict[str, object]:
    shorter = bool(hint) and "shorter" in str(hint).lower()
    items: list[dict[str, object]] = []
    for i, s in enumerate(segments):
        budget = s.get("timingBudgetUs")
        budget_us = int(budget) if isinstance(budget, int) and budget > 0 else 4_000_000
        prev_text = str(segments[i - 1].get("text", "")) if i > 0 else None
        items.append(
            {
                "segmentId": str(s.get("segmentId")),
                "speaker": str(s.get("speaker") or ""),
                "text": str(s.get("text", "")),
                "maxChars": max_chars_for(budget_us, target_locale, shorter=shorter),
                "context": prev_text,
            }
        )
    return {
        "sourceLocale": source_locale or "auto",
        "targetLocale": target_locale,
        "hint": hint,
        "segments": items,
    }


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def parse_response(text: str, expected_ids: list[str]) -> list[dict[str, object]]:
    """Strict parse: array of objects, exactly the expected ids in order, non-empty text."""
    try:
        data = json.loads(_strip_fences(text))
    except json.JSONDecodeError as e:
        raise ValueError("not json") from e
    if not isinstance(data, list) or len(data) != len(expected_ids):
        raise ValueError("wrong shape")
    out: list[dict[str, object]] = []
    for item, expected in zip(data, expected_ids, strict=True):
        if not isinstance(item, dict) or set(item) - {"segmentId", "adaptedText", "literalText"}:
            raise ValueError("unexpected keys")
        if item.get("segmentId") != expected:
            raise ValueError("segment id mismatch")
        adapted = item.get("adaptedText")
        literal = item.get("literalText", None)
        if not isinstance(adapted, str) or not adapted.strip():
            raise ValueError("empty adaptedText")
        if literal is not None and not isinstance(literal, str):
            raise ValueError("bad literalText")
        out.append(
            {
                "segmentId": expected,
                "adaptedText": adapted.strip(),
                "literalText": literal.strip() if isinstance(literal, str) else None,
                "confidence": LLM_CONFIDENCE,
            }
        )
    return out


class BedrockTranslationProvider:
    def __init__(self, clients: ClientFactory, model_id: str) -> None:
        self._clients = clients
        self.model_id = model_id

    def prompt_version(self) -> str:
        return prompt_version()

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="translation",
                locale=loc,
                region=self._clients.region,
                tier="beta",
                version=self.model_id,
                dataPolicy="no-training",
                priceUnit="character",
            )
            for loc in SEED_LOCALES
        ]

    def _converse(self, payload: dict[str, object]) -> str:
        try:
            resp: dict[str, Any] = self._clients.client("bedrock-runtime").converse(
                modelId=self.model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": json.dumps(payload, ensure_ascii=False)}],
                    }
                ],
                inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
            )
        except Exception as e:
            raise provider_error("bedrock", e) from e
        content = resp.get("output", {}).get("message", {}).get("content", [])
        return "".join(str(c.get("text", "")) for c in content if isinstance(c, dict))

    def translate(
        self,
        segments: list[dict[str, object]],
        target_locale: str,
        ctx: ProviderContext,
        hint: str | None = None,
        source_locale: str | None = None,
    ) -> list[dict[str, object]]:
        if not segments:
            return []
        payload = build_request(segments, source_locale, target_locale, hint)
        expected = [str(s.get("segmentId")) for s in segments]
        last_error: ValueError | None = None
        for _attempt in range(2):
            text = self._converse(payload)
            try:
                return parse_response(text, expected)
            except ValueError as e:
                last_error = e
        raise ProviderError(
            "PROVIDER_BAD_OUTPUT",
            "The translation model returned malformed output twice.",
            retryable=True,
        ) from last_error
