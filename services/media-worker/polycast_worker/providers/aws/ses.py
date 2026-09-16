"""Amazon SES notifier (FR-055): plain-text email per notification kind.

Bodies carry ids and a kind only: never transcript text, media links or signed URLs (A-17).
"""

from __future__ import annotations

from ..base import NOTIFICATION_KINDS, NotificationKind, ProviderContext, ProviderError
from .clients import ClientFactory, provider_error

ADAPTER_ID = "aws-ses"

SUBJECTS: dict[NotificationKind, str] = {
    "review-required": "Polycast: a target needs your review",
    "ready": "Polycast: deliverables are ready",
    "failed": "Polycast: a job failed",
    "budget-threshold": "Polycast: budget threshold reached",
}

BODIES: dict[NotificationKind, str] = {
    "review-required": (
        "Quality checks flagged segments on target job {ref}. Open the review studio to "
        "regenerate, edit or accept them."
    ),
    "ready": "Target job {ref} has finished and its deliverables can be downloaded.",
    "failed": "Job {ref} failed. The job page lists the typed reason and the next step.",
    "budget-threshold": "Project {ref} has crossed a configured budget threshold.",
}


def render(kind: NotificationKind, subject_ref: str, ctx: ProviderContext) -> tuple[str, str]:
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"unknown notification kind {kind}")
    body = BODIES[kind].format(ref=subject_ref)
    return SUBJECTS[kind], f"{body}\n\nCorrelation id: {ctx.correlationId}\n"


class SesNotifier:
    def __init__(self, clients: ClientFactory, *, from_address: str) -> None:
        if not from_address:
            raise ValueError("SES_FROM_ADDRESS is required for the SES notifier")
        self._clients = clients
        self._from = from_address

    def notify(
        self, kind: NotificationKind, recipient: str, subject_ref: str, ctx: ProviderContext
    ) -> dict[str, object]:
        subject, body = render(kind, subject_ref, ctx)
        try:
            resp = self._clients.client("ses").send_email(
                Source=self._from,
                Destination={"ToAddresses": [recipient]},
                Message={
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
                },
            )
        except Exception as e:
            raise provider_error("ses", e) from e
        message_id = str(resp.get("MessageId", ""))
        if not message_id:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "SES returned no message id.", retryable=True
            )
        return {"channel": "email", "kind": kind, "messageId": message_id, "mock": False}
