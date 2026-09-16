"""Every contract schema file has a Python model whose sample instance round-trips through it."""

from __future__ import annotations

from typing import Any

import pytest

from polycast_worker import models as m

from .conftest import SCHEMA_DIR, validate_schema

A_ID = "018f3a2e-7b1c-7c3d-9e4f-0123456789ab"
B_ID = "018f3a2e-7b1c-7c3d-9e4f-0123456789ac"
C_ID = "018f3a2e-7b1c-7c3d-9e4f-0123456789ad"
D_ID = "018f3a2e-7b1c-7c3d-9e4f-0123456789ae"
SHA = "a" * 64
TS = "2026-09-16T10:00:00.000Z"

METADATA: dict[str, Any] = {
    "container": "mov",
    "durationUs": 61_027_000,
    "video": {
        "codec": "h264",
        "width": 1920,
        "height": 1080,
        "frameRate": {"num": 30000, "den": 1001},
        "variableFrameRate": False,
        "colorPrimaries": "bt709",
        "hdr": False,
    },
    "audio": {"codec": "aac", "sampleRate": 48000, "channels": 2, "channelLayout": "stereo"},
}
AUDIO_ONLY_METADATA: dict[str, Any] = {
    "container": "wav",
    "durationUs": 12_000_000,
    "audio": {"codec": "pcm_s16le", "sampleRate": 16000, "channels": 1, "channelLayout": "mono"},
}
RANGE = {"start": 0, "end": 4_000_000}
WORD = {"text": "hello", "range": {"start": 0, "end": 500_000}, "confidence": 0.9}
SPEAKER = {
    "id": C_ID,
    "label": "Speaker A",
    "onCamera": False,
    "voicePolicy": "stock",
    "sampleRanges": [RANGE],
}
SEGMENT = {
    "id": B_ID,
    "seq": 0,
    "speakerId": C_ID,
    "range": RANGE,
    "text": "hello there",
    "language": "en",
    "confidence": 0.9,
    "words": [WORD],
    "version": 1,
}
QC_REPORT: dict[str, Any] = {
    "schemaVersion": 1,
    "generatedAt": TS,
    "targetJobId": A_ID,
    "locale": "es-MX",
    "passed": False,
    "checks": [
        {
            "metric": "entity-preservation",
            "threshold": None,
            "value": None,
            "passed": False,
            "provider": "mock-quality",
        }
    ],
    "issues": [
        {
            "id": D_ID,
            "segmentId": B_ID,
            "metric": "entity-preservation",
            "severity": "warning",
            "recommendation": "Regenerate.",
            "resolution": "open",
        }
    ],
    "summary": "1 issue",
}
MANIFEST: dict[str, Any] = {
    "schemaVersion": 1,
    "generator": "polycast-media-worker/0.1.0",
    "generatedAt": TS,
    "jobId": A_ID,
    "targetJobId": B_ID,
    "projectId": C_ID,
    "sourceLocale": "en-US",
    "targetLocale": "es-MX",
    "sourceSha256": SHA,
    "syntheticVoice": False,
    "lipSyncApplied": False,
    "mock": True,
    "models": [
        {
            "capability": "translation",
            "adapterId": "mock-translation",
            "version": "0",
            "tier": "unavailable",
            "dataPolicy": "no-training",
        }
    ],
    "segmentCount": 1,
    "translationVersionIds": [D_ID],
    "files": [{"fileName": "captions.es-MX.srt", "sha256": SHA, "byteSize": 12}],
    "disclosure": "Generated with mock providers.",
}
PARAMS_VALIDATING = {
    "assetId": A_ID,
    "projectId": B_ID,
    "quarantine": "local://quarantine/org/asset.wav",
    "declaredContentType": "audio/wav",
    "declaredByteSize": 384044,
    "maxDurationUs": 3_600_000_000,
}
PARAMS_ANALYZING = {
    "assetId": A_ID,
    "projectId": B_ID,
    "metadata": AUDIO_ONLY_METADATA,
    "declaredLocale": None,
}
PARAMS_TARGET: dict[str, Any] = {
    "targetJobId": A_ID,
    "projectId": B_ID,
    "jobId": C_ID,
    "sourceLocale": "en-US",
    "targetLocale": "es-MX",
    "direction": "ltr",
    "lipSync": False,
    "metadata": METADATA,
    "sourceSha256": SHA,
    "speakers": [SPEAKER],
    "segments": [SEGMENT],
    "translations": [
        {
            "translationVersionId": D_ID,
            "segmentId": B_ID,
            "adaptedText": "[es-MX] hello there",
            "timingBudgetUs": 4_000_000,
            "generation": 1,
        }
    ],
    "speech": [
        {
            "renderId": D_ID,
            "translationVersionId": D_ID,
            "segmentId": B_ID,
            "measuredDurationUs": 800_000,
            "timeStretchRatio": 1.0,
            "voiceId": "mock-es-MX-1",
        }
    ],
    "hint": None,
    "packageVersion": 1,
    "provenance": {"translationVersionIds": [D_ID], "qcReport": QC_REPORT},
}


def _task(stage: str, params: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": A_ID,
        "organizationId": B_ID,
        "jobId": C_ID,
        "targetJobId": None,
        "assetId": A_ID,
        "stage": stage,
        "attempt": 1,
        "idempotencyKey": "abcdefgh-1",
        "correlationId": "corr-1",
        "storage": {
            "source": "local://source/org/asset.wav",
            "derivedPrefix": "local://derived/org/asset/",
            "deliverablesPrefix": None,
        },
        "parameters": params,
        "taskToken": None,
        "leaseSeconds": 60,
    }


SAMPLES: dict[str, list[tuple[type[m.ContractModel], dict[str, Any]]]] = {
    "media-metadata": [(m.MediaMetadata, METADATA), (m.MediaMetadata, AUDIO_ONLY_METADATA)],
    "provenance-manifest": [(m.ProvenanceManifest, MANIFEST)],
    "qc-report": [(m.QcReport, QC_REPORT)],
    "worker-task": [
        (m.WorkerTask, _task("VALIDATING", PARAMS_VALIDATING)),
        (m.WorkerTask, _task("ANALYZING", PARAMS_ANALYZING)),
        (m.WorkerTask, _task("PACKAGING", PARAMS_TARGET)),
    ],
    "task-result": [
        (
            m.TaskResult,
            {
                "status": "succeeded",
                "retryable": False,
                "error": None,
                "output": {"mix": "local://d/x/mix.wav"},
                "workerId": "w-1",
            },
        ),
        (
            m.TaskResult,
            {
                "status": "failed",
                "retryable": True,
                "error": {"code": "STORAGE_IO", "message": "failed to read object"},
                "output": None,
                "workerId": "w-1",
            },
        ),
    ],
    "params-validating": [(m.ValidatingParams, PARAMS_VALIDATING)],
    "params-analyzing": [(m.AnalyzingParams, PARAMS_ANALYZING)],
    "params-target": [(m.TargetParams, PARAMS_TARGET)],
    "output-validating": [
        (
            m.ValidatingOutput,
            {
                "metadata": METADATA,
                "sha256": SHA,
                "byteSize": 10,
                "source": "local://source/org/asset.mp4",
            },
        )
    ],
    "output-analyzing": [
        (
            m.AnalyzingOutput,
            {
                "detectedLocale": "en-US",
                "detectionConfidence": 0.93,
                "provider": "mock-transcription",
                "providerVersion": "0",
                "hasVideo": False,
                "proxy": "local://derived/org/asset/proxy.mp3",
                "waveform": "local://derived/org/asset/waveform.json",
                "speakers": [
                    {
                        "key": "A",
                        "label": "Speaker A",
                        "onCamera": False,
                        "voicePolicy": "stock",
                        "sampleRanges": [RANGE],
                    }
                ],
                "segments": [
                    {
                        "seq": 0,
                        "speakerKey": "A",
                        "range": RANGE,
                        "text": "hello there",
                        "language": "en",
                        "confidence": 0.9,
                        "words": [WORD],
                    }
                ],
            },
        )
    ],
    "output-translating": [
        (
            m.TranslatingOutput,
            {
                "provider": "mock-translation",
                "providerVersion": "0",
                "promptVersion": "mock-v1",
                "translations": [
                    {
                        "segmentId": B_ID,
                        "adaptedText": "[es-MX] hello there",
                        "literalText": None,
                        "confidence": 0.8,
                        "timingBudgetUs": 4_000_000,
                    }
                ],
            },
        )
    ],
    "output-synthesizing": [
        (
            m.SynthesizingOutput,
            {
                "provider": "mock-speech",
                "providerVersion": "0",
                "renders": [
                    {
                        "segmentId": B_ID,
                        "translationVersionId": D_ID,
                        "voiceId": "mock-es-MX-1",
                        "measuredDurationUs": 800_000,
                        "audio": None,
                    }
                ],
            },
        )
    ],
    "output-timing": [
        (
            m.TimingOutput,
            {
                "fits": [
                    {
                        "segmentId": B_ID,
                        "strategy": "rate",
                        "timeStretchRatio": 1.05,
                        "boundaryShiftUs": 0,
                        "fits": True,
                    }
                ]
            },
        )
    ],
    "output-lipsync": [
        (
            m.LipSyncOutput,
            {
                "provider": "mock-lipSync",
                "providerVersion": "0",
                "applied": False,
                "renders": [{"segmentId": B_ID, "syncConfidence": 0.0, "video": None}],
            },
        )
    ],
    "output-mixing": [
        (
            m.MixingOutput,
            {"mix": "local://derived/org/t/mix.wav", "integratedLufs": -16.0, "truePeakDbtp": -1.0},
        )
    ],
    "output-encoding": [
        (
            m.EncodingOutput,
            {"encode": "local://derived/org/t/encode.mp3", "container": "mp3", "byteSize": 1000},
        )
    ],
    "output-target-qa": [
        (
            m.TargetQaOutput,
            {
                "provider": "mock-quality",
                "checks": [
                    {
                        "metric": "loudness-integrated",
                        "threshold": -16.0,
                        "value": -16.1,
                        "passed": True,
                    }
                ],
                "issues": [
                    {
                        "metric": "entity-preservation",
                        "segmentId": B_ID,
                        "severity": "warning",
                        "range": RANGE,
                        "recommendation": "Regenerate.",
                    }
                ],
            },
        )
    ],
    "output-packaging": [
        (
            m.PackagingOutput,
            {
                "deliverables": [
                    {
                        "kind": "captions-srt",
                        "fileName": "captions.es-MX.srt",
                        "contentType": "application/x-subrip",
                        "byteSize": 12,
                        "sha256": SHA,
                        "uri": "local://deliverables/org/t/v1/captions.es-MX.srt",
                    }
                ],
                "manifest": MANIFEST,
            },
        )
    ],
}

# Schemas consumed only by the Node side; the worker has no model for them by design.
NODE_ONLY = {"domain-event", "error-envelope"}

SCHEMA_NAMES = sorted(p.name.removesuffix(".schema.json") for p in SCHEMA_DIR.glob("*.schema.json"))


def test_schema_directory_is_present():
    assert SCHEMA_NAMES, "run pnpm --filter @polycast/contracts build"


@pytest.mark.parametrize("name", SCHEMA_NAMES)
def test_every_schema_has_a_round_tripping_model(name: str) -> None:
    if name in NODE_ONLY:
        assert name not in SAMPLES
        return
    assert name in SAMPLES, f"no Python model sample for contract schema {name}"
    for model, sample in SAMPLES[name]:
        validate_schema(name, sample)
        parsed = model.model_validate(sample)
        dumped = parsed.model_dump()
        validate_schema(name, dumped)
        assert dumped == sample


def test_models_reject_additional_properties() -> None:
    with pytest.raises(ValueError):
        m.MixingOutput.model_validate(
            {"mix": "local://d/x/mix.wav", "integratedLufs": -16.0, "truePeakDbtp": -1.0, "x": 1}
        )


def test_output_models_cover_every_stage() -> None:
    assert set(m.OUTPUT_MODELS) == set(m.WORKER_STAGES)
