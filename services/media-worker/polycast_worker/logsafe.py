"""Logging guard (A-17): drop any record that could carry transcript text, media, URLs or secrets.

The worker's own log lines only ever contain ids, stages and durations. This filter is the
backstop for anything else (third-party libraries, future mistakes): a record whose rendered
message contains a forbidden key is dropped entirely rather than partially redacted.
"""

from __future__ import annotations

import logging

FORBIDDEN_KEYS: tuple[str, ...] = (
    "transcript",
    "adaptedtext",
    "literaltext",
    "hint",
    "mediaurl",
    "signedurl",
    "x-amz-",
    "signature=",
    "embedding",
    "token",
    "authorization",
    "secret",
    "password",
)


class RedactingFilter(logging.Filter):
    """Drops records whose message (after %-formatting) mentions a forbidden key."""

    def __init__(self, forbidden: tuple[str, ...] = FORBIDDEN_KEYS) -> None:
        super().__init__()
        self._forbidden = tuple(k.lower() for k in forbidden)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - a broken format string must not crash logging
            return False
        haystack = message.lower()
        return not any(key in haystack for key in self._forbidden)


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    root.setLevel(level)
    if not root.handlers:
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        root.addHandler(stream)
    for handler in root.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
