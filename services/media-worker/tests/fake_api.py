"""A scripted stand-in for the API's internal task endpoints.

It plays the control plane's role for one asset and one target: it hands out the next task
in the M1 stage sequence, folds each posted result into its state (assigning ids the way the
API would), and serves 204 when the script is exhausted.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from polycast_worker.client import Response

_TASK_RE = re.compile(r"^/internal/v1/tasks/([^/]+)/(heartbeat|result)$")


def _id() -> str:
    return str(uuid.uuid4())


@dataclass
class Step:
    stage: str
    scope: str = "all"  # "all" | "flagged"
    hint: str | None = None


DEFAULT_SCRIPT: list[Step] = [
    Step("VALIDATING"),
    Step("ANALYZING"),
    Step("TRANSLATING"),
    Step("SYNTHESIZING"),
    Step("TIMING"),
    Step("MIXING"),
    Step("ENCODING"),
    Step("TARGET_QA"),
    # reviewer regenerates the flagged segment with a hint
    Step("TRANSLATING", scope="flagged", hint="make it shorter"),
    Step("SYNTHESIZING", scope="flagged"),
    Step("TIMING", scope="flagged"),
    Step("MIXING"),
    Step("ENCODING"),
    Step("TARGET_QA"),
    Step("PACKAGING"),
]


@dataclass
class FakeApi:
    token: str
    quarantine_uri: str
    source_uri: str
    derived_prefix: str
    deliverables_prefix: str
    declared_byte_size: int
    declared_content_type: str = "audio/wav"
    target_locale: str = "es-MX"
    script: list[Step] = field(default_factory=lambda: list(DEFAULT_SCRIPT))
    organization_id: str = field(default_factory=_id)
    project_id: str = field(default_factory=_id)
    asset_id: str = field(default_factory=_id)
    job_id: str = field(default_factory=_id)
    target_job_id: str = field(default_factory=_id)

    # recorded traffic
    results: list[tuple[str, str, dict[str, Any]]] = field(
        default_factory=list
    )  # (stage, taskId, result)
    heartbeats: list[str] = field(default_factory=list)
    claims: int = 0

    # state the control plane would keep in Postgres
    metadata: dict[str, Any] | None = None
    source_sha256: str | None = None
    speakers: list[dict[str, Any]] = field(default_factory=list)
    segments: list[dict[str, Any]] = field(default_factory=list)
    translations: dict[str, dict[str, Any]] = field(default_factory=dict)  # by segmentId
    speech: dict[str, dict[str, Any]] = field(default_factory=dict)  # by segmentId
    flagged_segment_id: str | None = None
    qc_report: dict[str, Any] | None = None

    _cursor: int = 0
    _open: dict[str, Step] = field(default_factory=dict)

    # ---- transport ----

    def handle(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> Response:
        if headers.get("X-Worker-Token") != self.token:
            return Response(401, b'{"code":"UNAUTHENTICATED"}')
        path = url.split("://", 1)[-1].split("/", 1)[-1]
        path = "/" + path
        payload = json.loads(body.decode()) if body else {}
        if method == "POST" and path == "/internal/v1/tasks/claim":
            self.claims += 1
            task = self.next_task()
            if task is None:
                return Response(204, b"")
            return Response(200, json.dumps(task).encode())
        m = _TASK_RE.match(path)
        if method == "POST" and m:
            task_id, action = m.groups()
            if task_id not in self._open:
                return Response(404, b'{"code":"NOT_FOUND"}')
            if action == "heartbeat":
                self.heartbeats.append(task_id)
                return Response(200, b'{"ok":true}')
            step = self._open.pop(task_id)
            self.results.append((step.stage, task_id, payload))
            if payload.get("status") == "succeeded":
                self._apply(step, payload["output"])
            return Response(200, b'{"accepted":true,"nextState":null}')
        return Response(404, b'{"code":"NOT_FOUND"}')

    # ---- task construction ----

    def stage_prefix(self, stage: str) -> str:
        """Per-stage derived prefix, exactly as apps/api's LocalOrchestrator mints it."""
        kind = "assets" if stage in ("VALIDATING", "ANALYZING") else "targets"
        owner = self.asset_id if kind == "assets" else self.target_job_id
        return f"{self.derived_prefix}{kind}/{owner}/{stage.lower()}/"

    def next_task(self) -> dict[str, Any] | None:
        if self._cursor >= len(self.script):
            return None
        step = self.script[self._cursor]
        self._cursor += 1
        task_id = _id()
        self._open[task_id] = step
        base: dict[str, Any] = {
            "taskId": task_id,
            "organizationId": self.organization_id,
            "jobId": None if step.stage in ("VALIDATING", "ANALYZING") else self.job_id,
            "targetJobId": None
            if step.stage in ("VALIDATING", "ANALYZING")
            else self.target_job_id,
            "assetId": self.asset_id,
            "stage": step.stage,
            "attempt": 1,
            "idempotencyKey": f"{self.target_job_id}:{step.stage}:{self._cursor}",
            "correlationId": f"corr-{self._cursor}",
            "storage": {
                "source": self.source_uri,
                "derivedPrefix": self.stage_prefix(step.stage),
                "deliverablesPrefix": self.deliverables_prefix
                if step.stage == "PACKAGING"
                else None,
            },
            "taskToken": None,
            "leaseSeconds": 30,
        }
        if step.stage == "VALIDATING":
            base["parameters"] = {
                "assetId": self.asset_id,
                "projectId": self.project_id,
                "quarantine": self.quarantine_uri,
                "declaredContentType": self.declared_content_type,
                "declaredByteSize": self.declared_byte_size,
                "maxDurationUs": 3_600_000_000,
            }
        elif step.stage == "ANALYZING":
            base["parameters"] = {
                "assetId": self.asset_id,
                "projectId": self.project_id,
                "metadata": self.metadata,
                "declaredLocale": "en-US",
            }
        else:
            base["parameters"] = self._target_params(step)
        return base

    def _target_params(self, step: Step) -> dict[str, Any]:
        if step.scope == "flagged":
            assert self.flagged_segment_id, "no flagged segment yet"
            segments = [s for s in self.segments if s["id"] == self.flagged_segment_id]
        else:
            segments = list(self.segments)
        ids = {s["id"] for s in segments}
        return {
            "targetJobId": self.target_job_id,
            "projectId": self.project_id,
            "jobId": self.job_id,
            "sourceLocale": "en-US",
            "targetLocale": self.target_locale,
            "direction": "ltr",
            "lipSync": False,
            "metadata": self.metadata,
            "sourceSha256": self.source_sha256,
            "speakers": self.speakers,
            "segments": segments,
            "translations": [t for sid, t in self.translations.items() if sid in ids],
            "speech": [s for sid, s in self.speech.items() if sid in ids],
            "hint": step.hint,
            "packageVersion": 1 if step.stage == "PACKAGING" else None,
            "provenance": {
                "translationVersionIds": sorted(
                    t["translationVersionId"] for t in self.translations.values()
                ),
                "qcReport": self.qc_report,
            }
            if step.stage == "PACKAGING"
            else None,
        }

    # ---- state folding ----

    def _apply(self, step: Step, output: dict[str, Any]) -> None:
        if step.stage == "VALIDATING":
            self.metadata = output["metadata"]
            self.source_sha256 = output["sha256"]
        elif step.stage == "ANALYZING":
            key_to_id = {}
            for sp in output["speakers"]:
                sid = _id()
                key_to_id[sp["key"]] = sid
                self.speakers.append(
                    {
                        "id": sid,
                        "label": sp["label"],
                        "onCamera": sp["onCamera"],
                        "voicePolicy": sp["voicePolicy"],
                        "sampleRanges": sp["sampleRanges"],
                    }
                )
            for seg in output["segments"]:
                self.segments.append(
                    {
                        "id": _id(),
                        "seq": seg["seq"],
                        "speakerId": key_to_id[seg["speakerKey"]],
                        "range": seg["range"],
                        "text": seg["text"],
                        "language": seg["language"],
                        "confidence": seg["confidence"],
                        "words": seg["words"],
                        "version": 1,
                    }
                )
        elif step.stage == "TRANSLATING":
            for t in output["translations"]:
                prev = self.translations.get(t["segmentId"])
                self.translations[t["segmentId"]] = {
                    "translationVersionId": _id(),
                    "segmentId": t["segmentId"],
                    "adaptedText": t["adaptedText"],
                    "timingBudgetUs": t["timingBudgetUs"],
                    "generation": (prev["generation"] + 1) if prev else 1,
                }
        elif step.stage == "SYNTHESIZING":
            for r in output["renders"]:
                self.speech[r["segmentId"]] = {
                    "renderId": _id(),
                    "translationVersionId": r["translationVersionId"],
                    "segmentId": r["segmentId"],
                    "measuredDurationUs": r["measuredDurationUs"],
                    "timeStretchRatio": 1.0,
                    "voiceId": r["voiceId"],
                }
        elif step.stage == "TARGET_QA":
            issues = output["issues"]
            if issues:
                self.flagged_segment_id = issues[0]["segmentId"]
            self.qc_report = {
                "schemaVersion": 1,
                "generatedAt": "2026-09-16T10:00:00.000Z",
                "targetJobId": self.target_job_id,
                "locale": self.target_locale,
                "passed": all(c["passed"] for c in output["checks"]),
                "checks": [{**c, "provider": output["provider"]} for c in output["checks"]],
                "issues": [
                    {
                        "id": _id(),
                        "segmentId": i["segmentId"],
                        "metric": i["metric"],
                        "severity": i["severity"],
                        "recommendation": i["recommendation"],
                        "resolution": "open",
                    }
                    for i in issues
                ],
                "summary": f"{len(issues)} issue(s)",
            }


class FakeTransport:
    def __init__(self, api: FakeApi) -> None:
        self.api = api

    def request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Response:
        return self.api.handle(method, url, headers, body)
