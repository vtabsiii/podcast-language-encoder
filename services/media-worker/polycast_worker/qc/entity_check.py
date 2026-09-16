"""Entity preservation check (FR-011).

Tokens that must survive translation verbatim: URLs, numbers, capitalised multi-word names
(not at sentence start, where capitalisation is grammatical) and glossary / product names.
The check is deliberately simple and deterministic: the same function runs after TRANSLATING
and inside TARGET_QA, so a violation is always reproducible from the persisted translation.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

_URL_RE = re.compile(
    r"(?:https?://|www\.)[^\s,;)]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai)\b", re.I
)
_NUMBER_RE = re.compile(r"(?<![\w.])[+-]?\d[\d,.\-]*\d(?![\w])|(?<![\w.])\d(?![\w.])")
_NUMBER_TOKEN_RE = re.compile(r"[+-]?[\d,.\-]+")
_CAP_WORD = r"[A-Z][\w'’-]*"
_CAP_RUN_RE = re.compile(rf"\b{_CAP_WORD}(?:\s+{_CAP_WORD})+\b")
_SENTENCE_START_RE = re.compile(r"(?:^|[.!?]\s+)")


@dataclass(frozen=True)
class EntityViolation:
    segment_id: str
    token: str

    def as_dict(self) -> dict[str, object]:
        return {"segmentId": self.segment_id, "token": self.token}


def _normalise_number(token: str) -> str:
    return re.sub(r"[^\d]", "", token)


def _sentence_starts(text: str) -> set[int]:
    return {m.end() for m in _SENTENCE_START_RE.finditer(text)}


def extract_entities(text: str, glossary: Iterable[str] = ()) -> list[str]:
    """Ordered, de-duplicated tokens of `text` that a translation must preserve."""
    found: dict[str, None] = {}
    for m in _URL_RE.finditer(text):
        found.setdefault(m.group(0).rstrip(".,;:"), None)
    starts = _sentence_starts(text)
    for m in _CAP_RUN_RE.finditer(text):
        if m.start() in starts:
            # Skip the sentence-initial word but keep the rest of the run when it is itself
            # a multi-word name ("Welcome New York" → "New York").
            rest = m.group(0).split(None, 1)
            if len(rest) == 2 and _CAP_RUN_RE.fullmatch(rest[1]):
                found.setdefault(rest[1], None)
            continue
        found.setdefault(m.group(0), None)
    for m in _NUMBER_RE.finditer(text):
        token = m.group(0)
        if any(token in url for url in found):
            continue
        found.setdefault(token, None)
    lowered = text.lower()
    for term in glossary:
        t = term.strip()
        if t and t.lower() in lowered:
            found.setdefault(t, None)
    return list(found)


def _present(token: str, translation: str) -> bool:
    if token.lower() in translation.lower():
        return True
    if _NUMBER_TOKEN_RE.fullmatch(token):
        # Numbers may be re-punctuated by locale (10,000 → 10.000 / 10 000).
        return _normalise_number(token) in _normalise_number(translation)
    return False


def missing_entities(source: str, translation: str, glossary: Iterable[str] = ()) -> list[str]:
    """Entities of `source` absent from `translation`, in source order."""
    return [t for t in extract_entities(source, glossary) if not _present(t, translation)]


def check_translations(
    segments: Iterable[tuple[str, str]],
    translations: dict[str, str],
    glossary: Iterable[str] = (),
) -> list[EntityViolation]:
    """`segments` are (segmentId, sourceText); `translations` map segmentId → adaptedText.

    Segments without a translation are not entity violations (that is a coverage problem).
    """
    terms = tuple(glossary)
    out: list[EntityViolation] = []
    for segment_id, text in segments:
        translated = translations.get(segment_id)
        if translated is None:
            continue
        out.extend(
            EntityViolation(segment_id, t) for t in missing_entities(text, translated, terms)
        )
    return out
