"""FR-055: SES notifier against a recorded SendEmail, the in-app JSON channel, and the CLI."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from botocore.stub import ANY

from polycast_worker import notify
from polycast_worker.logsafe import FORBIDDEN_KEYS
from polycast_worker.providers.aws.ses import SesNotifier, render
from polycast_worker.providers.base import NOTIFICATION_KINDS, Notifier, ProviderContext
from polycast_worker.providers.inapp import InAppNotifier
from polycast_worker.providers.registry import build_providers
from polycast_worker.storage import LocalFsStorage

from .aws_stubs import MemoryStorage, aws_config, aws_providers, recorded, stub_client

CTX = ProviderContext(
    organizationId="org-1",
    projectId="p",
    jobId="j",
    region="us-east-1",
    idempotencyKey="notify-1",
    correlationId="corr-9",
)


def test_render_covers_every_kind_without_content() -> None:
    for kind in NOTIFICATION_KINDS:
        subject, body = render(kind, "target-123", CTX)
        assert subject.startswith("Polycast:") and "target-123" in body and "corr-9" in body
        low = (subject + body).lower()
        assert not any(k in low for k in FORBIDDEN_KEYS)
    with pytest.raises(ValueError):
        render("spam", "x", CTX)  # type: ignore[arg-type]


def test_ses_notifier_sends_plain_text_email() -> None:
    client, stubber = stub_client("ses")
    rec = recorded("ses", "send_email")
    stubber.add_response("send_email", rec["response"], {**rec["expected_params"], "Message": ANY})
    providers = aws_providers(
        {"ses": client}, MemoryStorage(), SES_FROM_ADDRESS="noreply@polycast.test"
    )
    assert isinstance(providers.notifier, SesNotifier) and isinstance(providers.notifier, Notifier)
    result = providers.notifier.notify(
        "review-required", "reviewer@example.test", "target-123", CTX
    )
    stubber.assert_no_pending_responses()
    assert result["channel"] == "email" and result["mock"] is False
    assert result["messageId"] == rec["response"]["MessageId"]

    stubber.add_client_error("send_email", "Throttling")
    with pytest.raises(Exception, match="throttling") as info:
        providers.notifier.notify("ready", "reviewer@example.test", "t", CTX)
    assert getattr(info.value, "retryable", False) is True
    with pytest.raises(ValueError):
        SesNotifier(providers.notifier._clients, from_address="")  # type: ignore[attr-defined]


def test_inapp_notifier_appends_to_json_list(tmp_path: Path) -> None:
    storage = LocalFsStorage(tmp_path / "storage")
    notifier = InAppNotifier(storage, "local://derived/notifications.json")
    first = notifier.notify("ready", "user-1", "target-1", CTX)
    second = notifier.notify("failed", "user-1", "job-2", CTX)
    assert first["channel"] == "in-app" and first["mock"] is True and second["kind"] == "failed"
    items = json.loads(storage.get("local://derived/notifications.json"))
    assert [i["kind"] for i in items] == ["ready", "failed"]
    assert items[0]["recipient"] == "user-1" and items[0]["read"] is False
    assert items[1]["subjectRef"] == "job-2" and items[1]["correlationId"] == "corr-9"

    cfg = aws_config(LOCAL_STORAGE_DIR=str(tmp_path / "s2"), PROVIDER_MODE="local")
    local = build_providers(cfg)
    assert isinstance(local.notifier, InAppNotifier)
    assert local.notifier.uri == "local://derived/notifications.json"


def test_cli_sends_through_injected_providers(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cfg = aws_config(LOCAL_STORAGE_DIR=str(tmp_path / "s"), PROVIDER_MODE="local")
    providers = build_providers(cfg)
    code = notify.main(
        [
            "--kind",
            "budget-threshold",
            "--to",
            "owner@example.test",
            "--ref",
            "project-7",
            "--org",
            "org-1",
        ],
        providers=providers,
    )
    assert code == 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert printed["kind"] == "budget-threshold" and printed["channel"] == "in-app"
    items = json.loads(LocalFsStorage(tmp_path / "s").get(providers.notifier.uri))  # type: ignore[attr-defined]
    assert items[0]["organizationId"] == "org-1" and items[0]["subjectRef"] == "project-7"
    with pytest.raises(SystemExit):
        notify.main(["--kind", "spam", "--to", "x", "--ref", "y"], providers=providers)
