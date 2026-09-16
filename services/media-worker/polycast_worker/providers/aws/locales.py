"""Locale tables for the Amazon adapters (BCP-47 seed tags → service codes).

The 22 seed locales come from packages/domain/src/capabilities/registry.ts. Every table is
total over SEED_LOCALES so a missing mapping is a test failure, not a runtime surprise.
"""

from __future__ import annotations

from dataclasses import dataclass

SEED_LOCALES: tuple[str, ...] = (
    "en-US",
    "en-GB",
    "es-419",
    "es-MX",
    "es-ES",
    "zh-CN",
    "hi-IN",
    "ar-001",
    "ar-SA",
    "pt-BR",
    "pt-PT",
    "fr-FR",
    "fr-CA",
    "de-DE",
    "ja-JP",
    "ko-KR",
    "id-ID",
    "bn-IN",
    "bn-BD",
    "ur-PK",
    "ru-RU",
    "tr-TR",
)

# Amazon Translate language codes (https://docs.aws.amazon.com/translate/latest/dg/what-is-languages.html)
TRANSLATE_CODES: dict[str, str] = {
    "en-US": "en",
    "en-GB": "en",
    "es-419": "es",
    "es-MX": "es-MX",
    "es-ES": "es",
    "zh-CN": "zh",
    "hi-IN": "hi",
    "ar-001": "ar",
    "ar-SA": "ar",
    "pt-BR": "pt",
    "pt-PT": "pt-PT",
    "fr-FR": "fr",
    "fr-CA": "fr-CA",
    "de-DE": "de",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "id-ID": "id",
    "bn-IN": "bn",
    "bn-BD": "bn",
    "ur-PK": "ur",
    "ru-RU": "ru",
    "tr-TR": "tr",
}

# Target codes for which Translate accepts Settings.Formality.
TRANSLATE_FORMALITY_CODES: frozenset[str] = frozenset(
    {"de", "es", "fr", "fr-CA", "hi", "it", "ja", "ko", "nl", "pt-PT"}
)

# Amazon Transcribe batch LanguageCode for a declared-locale hint. Where Transcribe has no
# exact regional model the closest one is used; detection (IdentifyLanguage) is the default.
TRANSCRIBE_CODES: dict[str, str] = {
    "en-US": "en-US",
    "en-GB": "en-GB",
    "es-419": "es-US",
    "es-MX": "es-US",
    "es-ES": "es-ES",
    "zh-CN": "zh-CN",
    "hi-IN": "hi-IN",
    "ar-001": "ar-SA",
    "ar-SA": "ar-SA",
    "pt-BR": "pt-BR",
    "pt-PT": "pt-PT",
    "fr-FR": "fr-FR",
    "fr-CA": "fr-CA",
    "de-DE": "de-DE",
    "ja-JP": "ja-JP",
    "ko-KR": "ko-KR",
    "id-ID": "id-ID",
    "bn-IN": "bn-IN",
    "bn-BD": "bn-IN",
    "ur-PK": "ur-IN",
    "ru-RU": "ru-RU",
    "tr-TR": "tr-TR",
}


@dataclass(frozen=True)
class PollyVoice:
    language_code: str
    voice_id: str
    engine: str = "neural"


# Default Polly voice per seed locale (neural engine). `None` = no neural voice → the speech
# capability for that locale is registered as "unavailable" (FR-020, FR-021).
POLLY_VOICES: dict[str, PollyVoice | None] = {
    "en-US": PollyVoice("en-US", "Joanna"),
    "en-GB": PollyVoice("en-GB", "Amy"),
    "es-419": PollyVoice("es-US", "Lupe"),
    "es-MX": PollyVoice("es-MX", "Mia"),
    "es-ES": PollyVoice("es-ES", "Lucia"),
    "zh-CN": PollyVoice("cmn-CN", "Zhiyu"),
    "hi-IN": PollyVoice("hi-IN", "Kajal"),
    "ar-001": PollyVoice("ar-AE", "Hala"),
    "ar-SA": PollyVoice("ar-AE", "Hala"),
    "pt-BR": PollyVoice("pt-BR", "Camila"),
    "pt-PT": PollyVoice("pt-PT", "Ines"),
    "fr-FR": PollyVoice("fr-FR", "Lea"),
    "fr-CA": PollyVoice("fr-CA", "Gabrielle"),
    "de-DE": PollyVoice("de-DE", "Vicki"),
    "ja-JP": PollyVoice("ja-JP", "Takumi"),
    "ko-KR": PollyVoice("ko-KR", "Seoyeon"),
    "id-ID": None,
    "bn-IN": None,
    "bn-BD": None,
    "ur-PK": None,
    "ru-RU": None,  # Polly Russian (Tatyana/Maxim) is standard-engine only
    "tr-TR": PollyVoice("tr-TR", "Burcu"),
}

# Characters of adapted text per second of speech, by language, used to derive the
# `maxChars` budget the LLM translator must respect (FR-013).
SPEAKING_RATE_CPS: dict[str, float] = {
    "en": 15.0,
    "es": 16.0,
    "pt": 15.0,
    "fr": 15.0,
    "de": 14.0,
    "it": 15.0,
    "ja": 8.0,
    "zh": 5.0,
    "ko": 9.0,
    "ar": 12.0,
    "hi": 12.0,
    "bn": 12.0,
    "ur": 12.0,
    "ru": 14.0,
    "tr": 14.0,
    "id": 15.0,
}
DEFAULT_SPEAKING_RATE_CPS = 14.0


def language_of(locale: str) -> str:
    return locale.split("-", 1)[0].lower()


def translate_code(locale: str) -> str:
    return TRANSLATE_CODES.get(locale, language_of(locale))


def transcribe_code(locale: str) -> str:
    return TRANSCRIBE_CODES.get(locale, locale)


def speaking_rate_cps(locale: str) -> float:
    return SPEAKING_RATE_CPS.get(language_of(locale), DEFAULT_SPEAKING_RATE_CPS)


def max_chars_for(budget_us: int, locale: str, *, shorter: bool = False) -> int:
    chars = int(budget_us * speaking_rate_cps(locale) // 1_000_000)
    if shorter:
        chars = chars * 80 // 100
    return max(1, chars)
