"""Provider contracts. Every ML/cloud capability is reachable only through these Protocols.

Adapters live in sibling modules and are registered by name. Production configuration
must fail closed when a required adapter is missing (see config.py).
"""

from .base import (
    AsyncHandle,
    CapabilityRecord,
    LipSyncProvider,
    MediaEncodeProvider,
    ProviderContext,
    QualityProvider,
    SpeechProvider,
    TranscriptionProvider,
    TranslationProvider,
)

__all__ = [
    "AsyncHandle",
    "CapabilityRecord",
    "LipSyncProvider",
    "MediaEncodeProvider",
    "ProviderContext",
    "QualityProvider",
    "SpeechProvider",
    "TranscriptionProvider",
    "TranslationProvider",
]
