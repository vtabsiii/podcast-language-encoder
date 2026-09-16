"""Drives the worker loop through the whole M1 stage sequence against a FakeApi.

Runs twice: with the real ffmpeg/ffprobe when installed, and with Tools forced to none so
the stdlib WAV fallbacks are exercised in CI images without ffmpeg.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

import pytest

from polycast_worker.client import ApiClient
from polycast_worker.logsafe import FORBIDDEN_KEYS
from polycast_worker.runner import run_loop
from polycast_worker.storage import LocalFsStorage, join_uri
from polycast_worker.tools import Tools

from .conftest import validate_schema, write_tone_wav
from .fake_api import FakeApi, FakeTransport

OUTPUT_SCHEMA = {
    "VALIDATING": "output-validating",
    "ANALYZING": "output-analyzing",
    "TRANSLATING": "output-translating",
    "SYNTHESIZING": "output-synthesizing",
    "TIMING": "output-timing",
    "MIXING": "output-mixing",
    "ENCODING": "output-encoding",
    "TARGET_QA": "output-target-qa",
    "PACKAGING": "output-packaging",
}


def _tools(mode: str) -> Tools:
    if mode == "no-ffmpeg":
        return Tools.none()
    tools = Tools.detect()
    if not (tools.has_ffmpeg and tools.has_ffprobe):
        pytest.skip("ffmpeg/ffprobe not installed")
    return tools


@pytest.mark.parametrize("mode", ["ffmpeg", "no-ffmpeg"])
def test_full_slice_over_a_generated_wav(
    tmp_path: Path, mode: str, caplog: pytest.LogCaptureFixture
) -> None:
    tools = _tools(mode)
    storage = LocalFsStorage(tmp_path / "storage")
    wav = write_tone_wav(tmp_path / "fixture.wav", seconds=12.0, rate=16000)
    quarantine = "local://quarantine/org1/upload.wav"
    storage.put(quarantine, wav, "audio/wav")

    api = FakeApi(
        token="dev-worker-token",  # noqa: S106 - dev default under test
        quarantine_uri=quarantine,
        source_uri="local://source/org1/asset.wav",
        derived_prefix="local://derived/org1/target1/",
        deliverables_prefix="local://deliverables/org1/target1/v1/",
        declared_byte_size=wav.stat().st_size,
    )
    client = ApiClient(
        "http://api.test", "dev-worker-token", "worker-test", transport=FakeTransport(api)
    )

    caplog.set_level(logging.INFO, logger="polycast_worker")
    exit_code = run_loop(client, storage, tools, once=True, poll_interval_s=0.01, max_tasks=50)
    assert exit_code == 0
    assert api.claims == len(api.script) + 1  # one trailing 204

    # every task succeeded and every output matches its contract schema
    stages = [stage for stage, _, _ in api.results]
    assert stages == [s.stage for s in api.script]
    for stage, _, result in api.results:
        validate_schema("task-result", result)
        assert result["status"] == "succeeded", (stage, result.get("error"))
        validate_schema(OUTPUT_SCHEMA[stage], result["output"])
    by_stage: dict[str, list[dict[str, object]]] = {}
    for stage, _, result in api.results:
        by_stage.setdefault(stage, []).append(result["output"])

    # VALIDATING: exact duration, immutable copy
    validating = by_stage["VALIDATING"][0]
    assert validating["metadata"]["durationUs"] == 12_000_000  # type: ignore[index]
    assert storage.sha256(api.source_uri) == validating["sha256"]
    assert validating["byteSize"] == wav.stat().st_size

    # ANALYZING: proxy + waveform + fixture
    analyzing = by_stage["ANALYZING"][0]
    assert analyzing["hasVideo"] is False and analyzing["detectedLocale"] == "en-US"
    assert storage.exists(str(analyzing["proxy"]))
    assert str(analyzing["proxy"]).endswith("proxy.mp3" if mode == "ffmpeg" else "proxy.wav")
    waveform = json.loads(storage.get(str(analyzing["waveform"])))
    assert waveform["version"] == 1 and waveform["peaksPerSecond"] == 50
    assert waveform["durationUs"] == 12_000_000 and len(waveform["peaks"]) == 600
    assert all(0.0 <= p <= 1.0 for p in waveform["peaks"])
    assert max(waveform["peaks"]) > 0.3  # 440 Hz tone at ~0.37 full scale
    segments = analyzing["segments"]
    assert isinstance(segments, list) and len(segments) >= 2
    assert [s["speakerKey"] for s in segments[:2]] == ["A", "B"]
    assert segments[-1]["range"]["end"] == 12_000_000

    # first TARGET_QA flags exactly one issue on the lowest-seq segment
    qa1, qa2 = by_stage["TARGET_QA"]
    first_segment = min(api.segments, key=lambda s: s["seq"])
    assert len(qa1["issues"]) == 1
    issue = qa1["issues"][0]  # type: ignore[index]
    assert issue["metric"] == "entity-preservation" and issue["severity"] == "warning"
    assert issue["segmentId"] == first_segment["id"]
    assert issue["range"] == first_segment["range"]
    checks1 = {c["metric"]: c["passed"] for c in qa1["checks"]}  # type: ignore[union-attr]
    assert checks1["entity-preservation"] is False
    assert all(v for k, v in checks1.items() if k != "entity-preservation"), checks1
    assert set(checks1) == {
        "dialogue-coverage",
        "loudness-integrated",
        "true-peak",
        "caption-timing",
        "entity-preservation",
    }

    # the regeneration produced a generation-2, shorter pseudo-translation
    regen = by_stage["TRANSLATING"][1]["translations"][0]  # type: ignore[index]
    assert regen["segmentId"] == first_segment["id"]
    assert regen["adaptedText"].startswith("[es-MX v2] ")
    assert (
        len(regen["adaptedText"].split()) == len(first_segment["text"].split()) + 1
    )  # tag - 1 word
    assert api.translations[first_segment["id"]]["generation"] == 2

    # second TARGET_QA (generation 2) flags nothing
    assert qa2["issues"] == []
    assert all(c["passed"] for c in qa2["checks"])  # type: ignore[union-attr]

    # MIXING / ENCODING artefacts
    mixing = by_stage["MIXING"][-1]
    assert storage.exists(str(mixing["mix"]))
    if mode == "ffmpeg":
        assert -20.0 < float(mixing["integratedLufs"]) < -12.0  # type: ignore[arg-type]
        assert float(mixing["truePeakDbtp"]) <= -1.0  # type: ignore[arg-type]
    else:
        assert (mixing["integratedLufs"], mixing["truePeakDbtp"]) == (-16.0, -1.0)
    encoding = by_stage["ENCODING"][-1]
    assert encoding["container"] == ("mp3" if mode == "ffmpeg" else "wav")
    assert storage.size(str(encoding["encode"])) == encoding["byteSize"]

    # PACKAGING: deliverables, manifest, checksums
    packaging = by_stage["PACKAGING"][0]
    deliverables = {d["kind"]: d for d in packaging["deliverables"]}  # type: ignore[union-attr]
    assert set(deliverables) == {
        "media",
        "captions-srt",
        "captions-vtt",
        "transcript-json",
        "qc-report",
        "provenance-manifest",
        "checksums",
    }
    ext = "mp3" if mode == "ffmpeg" else "wav"
    assert deliverables["media"]["fileName"] == f"episode.es-MX.{ext}"
    for d in deliverables.values():
        uri = join_uri(api.deliverables_prefix, str(d["fileName"]))
        assert d["uri"] == uri and storage.exists(uri)
        assert storage.sha256(uri) == d["sha256"] and storage.size(uri) == d["byteSize"]

    checksums = storage.get(join_uri(api.deliverables_prefix, "checksums.sha256")).decode()
    lines = [ln for ln in checksums.splitlines() if ln.strip()]
    assert len(lines) == 6
    listed = set()
    for line in lines:
        digest, name = line.split("  ", 1)
        listed.add(name)
        data = storage.get(join_uri(api.deliverables_prefix, name))
        assert hashlib.sha256(data).hexdigest() == digest, name
    assert listed == {d["fileName"] for k, d in deliverables.items() if k != "checksums"}

    manifest = json.loads(storage.get(join_uri(api.deliverables_prefix, "provenance.json")))
    validate_schema("provenance-manifest", manifest)
    assert manifest == packaging["manifest"]
    assert manifest["mock"] is True and manifest["syntheticVoice"] is False
    assert manifest["lipSyncApplied"] is False
    assert manifest["generator"] == "polycast-media-worker/0.1.0"
    assert {m["tier"] for m in manifest["models"]} == {"unavailable"}
    assert manifest["segmentCount"] == len(api.segments)
    assert manifest["sourceSha256"] == validating["sha256"]
    assert {f["fileName"] for f in manifest["files"]} == listed - {"provenance.json"}
    assert "mock providers" in manifest["disclosure"]

    qc = json.loads(storage.get(join_uri(api.deliverables_prefix, "qc-report.json")))
    validate_schema("qc-report", qc)
    assert qc["passed"] is True and qc["issues"] == []

    srt = storage.get(join_uri(api.deliverables_prefix, "captions.es-MX.srt")).decode()
    assert "-->" in srt and regen["adaptedText"] in srt and srt.startswith("1\n00:00:00,000")
    vtt = storage.get(join_uri(api.deliverables_prefix, "captions.es-MX.vtt")).decode()
    assert vtt.startswith("WEBVTT\n") and "00:00:00.000 -->" in vtt
    transcript = json.loads(storage.get(join_uri(api.deliverables_prefix, "transcript.es-MX.json")))
    assert len(transcript["segments"]) == len(api.segments)
    assert transcript["segments"][0]["translation"]["generation"] == 2
    assert transcript["segments"][0]["range"]["end"] == first_segment["range"]["end"]

    # heartbeats were accepted for open tasks only, and no log line leaks forbidden keys (A-17)
    assert all(h in {t for _, t, _ in api.results} for h in api.heartbeats)
    for record in caplog.records:
        msg = record.getMessage().lower()
        assert not any(k in msg for k in FORBIDDEN_KEYS), record.getMessage()
        assert "/" not in msg or "local://" not in msg
    assert any("succeeded" in r.getMessage() for r in caplog.records)


def test_loop_reports_invalid_and_failing_tasks_without_crashing(tmp_path: Path) -> None:
    storage = LocalFsStorage(tmp_path / "storage")
    api = FakeApi(
        token="t",  # noqa: S106
        quarantine_uri="local://quarantine/org1/missing.wav",
        source_uri="local://source/org1/asset.wav",
        derived_prefix="local://derived/org1/t/",
        deliverables_prefix="local://deliverables/org1/t/v1/",
        declared_byte_size=10,
    )
    api.script = api.script[:1]  # VALIDATING against a missing quarantine object
    client = ApiClient("http://api.test", "t", "w", transport=FakeTransport(api))
    assert run_loop(client, storage, Tools.none(), once=True, poll_interval_s=0.01) == 0
    stage, _, result = api.results[0]
    assert stage == "VALIDATING" and result["status"] == "failed"
    assert result["error"]["code"] == "STORAGE_IO" and result["retryable"] is True

    # wrong token: terminal, exit 1, nothing processed
    bad = ApiClient("http://api.test", "wrong", "w", transport=FakeTransport(api))
    assert run_loop(bad, storage, Tools.none(), once=True, poll_interval_s=0.01) == 1
