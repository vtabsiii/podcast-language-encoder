"""`python -m polycast_worker.notify --kind KIND --to RECIPIENT --ref ID [--org ID]`

Sends one notification through the registry's Notifier (FR-055): SES email when
PROVIDER_MODE=aws and SES_FROM_ADDRESS is set, otherwise the in-app JSON list under the
derived bucket. The API does not call this yet; M5 wires it to job events.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Sequence

from .config import WorkerConfig
from .logsafe import configure_logging
from .providers.base import NOTIFICATION_KINDS, NotificationKind, ProviderContext, ProviderError
from .providers.registry import ProviderSet, build_providers


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="polycast_worker.notify")
    parser.add_argument("--kind", required=True, choices=NOTIFICATION_KINDS)
    parser.add_argument("--to", required=True, help="recipient (email address or user id)")
    parser.add_argument("--ref", required=True, help="subject id (target job, job or project)")
    parser.add_argument("--org", default="", help="organization id for the audit trail")
    parser.add_argument("--correlation-id", default=None)
    return parser.parse_args(argv)


def send(
    providers: ProviderSet,
    kind: NotificationKind,
    recipient: str,
    subject_ref: str,
    *,
    organization_id: str = "",
    correlation_id: str | None = None,
) -> dict[str, object]:
    ctx = ProviderContext(
        organizationId=organization_id,
        projectId="",
        jobId=subject_ref,
        region=providers.region,
        idempotencyKey=f"notify:{subject_ref}:{uuid.uuid4()}",
        correlationId=correlation_id or str(uuid.uuid4()),
    )
    return providers.notifier.notify(kind, recipient, subject_ref, ctx)


def main(argv: Sequence[str] | None = None, providers: ProviderSet | None = None) -> int:
    args = parse_args(argv)
    configure_logging()
    if providers is None:
        providers = build_providers(WorkerConfig.from_env())
    try:
        result = send(
            providers,
            args.kind,
            args.to,
            args.ref,
            organization_id=args.org,
            correlation_id=args.correlation_id,
        )
    except ProviderError as e:
        print(json.dumps({"error": e.code, "retryable": e.retryable}), file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
