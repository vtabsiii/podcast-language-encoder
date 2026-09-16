"""In-app notifier (FR-055, local/mock channel): appends to a JSON list in object storage."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from ..storage import Storage, StorageError
from .base import NOTIFICATION_KINDS, NotificationKind, ProviderContext

ADAPTER_ID = "inapp-notifier"
NOTIFICATIONS_FILE = "notifications.json"


class InAppNotifier:
    def __init__(self, storage: Storage, uri: str) -> None:
        self._storage = storage
        self.uri = uri

    def _load(self) -> list[dict[str, object]]:
        if not self._storage.exists(self.uri):
            return []
        try:
            data = json.loads(self._storage.get(self.uri).decode("utf-8"))
        except (StorageError, UnicodeDecodeError, json.JSONDecodeError):
            return []
        return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []

    def notify(
        self, kind: NotificationKind, recipient: str, subject_ref: str, ctx: ProviderContext
    ) -> dict[str, object]:
        if kind not in NOTIFICATION_KINDS:
            raise ValueError(f"unknown notification kind {kind}")
        entry: dict[str, object] = {
            "id": f"{ctx.idempotencyKey}:{kind}",
            "kind": kind,
            "recipient": recipient,
            "subjectRef": subject_ref,
            "organizationId": ctx.organizationId,
            "correlationId": ctx.correlationId,
            "createdAt": datetime.now(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "read": False,
        }
        items = self._load()
        items.append(entry)
        self._storage.put(
            self.uri, json.dumps(items, separators=(",", ":")).encode("utf-8"), "application/json"
        )
        return {"channel": "in-app", "kind": kind, "messageId": entry["id"], "mock": True}
