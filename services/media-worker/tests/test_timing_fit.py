"""FR-013 / FR-022: duration-fit arithmetic in integer µs and the atempo stretch on real WAVs."""

from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest

from polycast_worker.models import TimingOutput
from polycast_worker.providers.ffmpeg import AtempoTimingFitter, wav_duration_us
from polycast_worker.stages import timing
from polycast_worker.timing_fit import (
    MAX_BOUNDARY_SHIFT_US,
    RATE_MAX,
    atempo_chain,
    fit_segment,
    fitted_duration_us,
)
from polycast_worker.tools import Tools

from .aws_stubs import MemoryStorage, aws_providers, env_for, segment_dicts, target_task
from .conftest import new_id, validate_schema, write_tone_wav


def test_fit_segment_integer_arithmetic() -> None:
    assert fit_segment(3_000_000, 4_000_000) == ("none", 1.0, 0, True)
    assert fit_segment(3_520_000, 4_000_000) == ("rate", 0.88, 0, True)
    assert fit_segment(4_480_000, 4_000_000) == ("rate", 1.12, 0, True)
    d = fit_segment(4_500_000, 4_000_000)  # 4.5/1.12 = 4017857 → shift 17857 µs
    assert d.strategy == "boundary-shift" and d.boundary_shift_us == 17_858 and d.fits
    assert d.time_stretch_ratio <= RATE_MAX
    edge = fit_segment(4_614_400, 4_000_000)  # 4614400/1.12 = 4120000 → exactly 120 ms
    assert edge.strategy == "boundary-shift" and edge.boundary_shift_us == MAX_BOUNDARY_SHIFT_US
    over = fit_segment(4_614_401, 4_000_000)
    assert over.strategy == "retranslate" and over.fits is False and over.boundary_shift_us == 0
    assert fit_segment(0, 0) == ("none", 1.0, 0, True)


def test_fitted_duration_and_atempo_chain() -> None:
    assert fitted_duration_us(4_480_000, 1.12) == 4_000_000
    assert fitted_duration_us(4_000_000, 1.0) == 4_000_000
    assert fitted_duration_us(4_000_000, 0) == 4_000_000
    assert atempo_chain(1.05) == [1.05]
    assert atempo_chain(3.0) == [2.0, 1.5]
    assert atempo_chain(0.3) == [0.5, 0.6]
    assert atempo_chain(5.0) == [2.0, 2.0, 1.25]
    with pytest.raises(ValueError):
        atempo_chain(0)


def _wav_bytes(path: Path) -> bytes:
    return path.read_bytes()


def test_timing_stage_stretches_render_to_budget(tmp_path: Path) -> None:
    tools = Tools.detect()
    if not tools.has_ffmpeg:
        pytest.skip("ffmpeg not installed")
    storage = MemoryStorage()
    segments = segment_dicts(new_id())
    budgets = [s["range"]["end"] - s["range"]["start"] for s in segments]
    # renders: 4.5 s over a 4.16 s slot (rate), 3.5 s in a 4.35 s slot (none), way too long
    measured = [4_500_000, 3_500_000, 6_000_000]
    translations = []
    speech = []
    for seg, budget, dur in zip(segments, budgets, measured, strict=True):
        tv = new_id()
        translations.append(
            {
                "translationVersionId": tv,
                "segmentId": seg["id"],
                "adaptedText": "x",
                "timingBudgetUs": budget,
                "generation": 1,
            }
        )
        speech.append(
            {
                "renderId": new_id(),
                "translationVersionId": tv,
                "segmentId": seg["id"],
                "measuredDurationUs": dur,
                "timeStretchRatio": 1.0,
                "voiceId": "Mia",
            }
        )
    task = target_task("TIMING", segments=segments, translations=translations, speech=speech)
    for seg, dur in zip(segments, measured, strict=True):
        wav = write_tone_wav(tmp_path / f"{seg['id']}.wav", seconds=dur / 1e6)
        storage.put(
            f"s3://derived/org/targets/t1/synthesizing/speech/{seg['id']}.wav", wav, "audio/wav"
        )
    providers = aws_providers({}, storage, tools)
    env, _ = env_for(providers)
    out = timing.run(task, storage, tools, env)
    validate_schema("output-timing", out)
    fits = TimingOutput.model_validate(out).fits
    assert [f.strategy for f in fits] == ["rate", "none", "retranslate"]
    assert [f.fits for f in fits] == [True, True, False]

    fitted = f"{task.storage.derivedPrefix}speech/{segments[0]['id']}.fit.wav"
    with wave.open(io.BytesIO(storage.get(fitted)), "rb") as w:
        dur_us = w.getnframes() * 1_000_000 // w.getframerate()
    assert abs(dur_us - budgets[0]) < 60_000  # atempo lands within 60 ms of the slot
    copied = f"{task.storage.derivedPrefix}speech/{segments[1]['id']}.fit.wav"
    assert storage.get(copied) == _wav_bytes(tmp_path / f"{segments[1]['id']}.wav")
    assert not storage.exists(f"{task.storage.derivedPrefix}speech/{segments[2]['id']}.fit.wav")

    fitter = AtempoTimingFitter(tools)
    src = write_tone_wav(tmp_path / "src.wav", seconds=2.0)
    out_path = tmp_path / "out.wav"
    assert abs(fitter.stretch(src, out_path, 2.0) - 1_000_000) < 30_000
    assert wav_duration_us(src) == 2_000_000


def test_timing_stage_without_audio_is_arithmetic_only(storage: object) -> None:
    segments = segment_dicts(new_id())
    tv = new_id()
    task = target_task(
        "TIMING",
        segments=segments,
        translations=[
            {
                "translationVersionId": tv,
                "segmentId": segments[0]["id"],
                "adaptedText": "x",
                "timingBudgetUs": 4_000_000,
                "generation": 1,
            }
        ],
        speech=[
            {
                "renderId": new_id(),
                "translationVersionId": tv,
                "segmentId": segments[0]["id"],
                "measuredDurationUs": 4_200_000,
                "timeStretchRatio": 1.0,
                "voiceId": "mock-es-MX-1",
            }
        ],
        prefix="local://d/x/",
        source="local://s/a.wav",
    )
    out = timing.run(task, storage, Tools.none())  # type: ignore[arg-type]
    assert out["fits"][0]["strategy"] == "rate" and out["fits"][0]["timeStretchRatio"] == 1.05  # type: ignore[index]
