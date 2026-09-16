"""FR-023: dubbed speech over the ducked bed, two-pass loudnorm, ebur128 verification."""

from __future__ import annotations

from pathlib import Path

import pytest

from polycast_worker.audio import measure_loudness
from polycast_worker.models import MixingOutput
from polycast_worker.providers.base import SpeechPlacement
from polycast_worker.providers.ffmpeg import (
    DubMixer,
    PassthroughMixer,
    build_dub_filter,
    duck_expression,
    parse_loudnorm_json,
    wav_duration_us,
)
from polycast_worker.stages import mixing
from polycast_worker.tools import Tools

from .aws_stubs import MemoryStorage, aws_providers, env_for, segment_dicts, target_task
from .conftest import new_id, validate_schema, write_tone_wav


def _ffmpeg() -> Tools:
    tools = Tools.detect()
    if not tools.has_ffmpeg:
        pytest.skip("ffmpeg not installed")
    return tools


def test_filter_graph_and_loudnorm_parsing(tmp_path: Path) -> None:
    p = [
        SpeechPlacement("a", tmp_path / "a.wav", 1_000_000, 3_500_000),
        SpeechPlacement("b", tmp_path / "b.wav", 4_250_000, 6_000_000),
    ]
    assert duck_expression(p) == "between(t,1.000000,3.500000)+between(t,4.250000,6.000000)"
    graph = build_dub_filter(p, 2)
    assert graph.startswith("[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo")
    assert "volume=0.15:enable='between(t,1.000000,3.500000)+" in graph
    assert "[1:a]" in graph and "adelay=1000:all=1[s1]" in graph
    assert "adelay=4250:all=1[s2]" in graph
    assert graph.endswith("[bed][s1][s2]amix=inputs=3:normalize=0:duration=first[mixed]")
    assert "channel_layouts=mono" in build_dub_filter([], 1) and "volume" not in build_dub_filter(
        [], 1
    )
    stderr = (
        '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.40",\n\t"input_tp" : "-6.10",\n'
        '\t"input_lra" : "3.20",\n\t"input_thresh" : "-33.50",\n\t"output_i" : "-16.00",\n'
        '\t"target_offset" : "0.12"\n}\n'
    )
    parsed = parse_loudnorm_json(stderr)
    assert (
        parsed is not None and parsed["input_i"] == "-23.40" and parsed["target_offset"] == "0.12"
    )
    assert parse_loudnorm_json("nothing") is None


@pytest.mark.parametrize(("channels", "target"), [(1, -19.0), (2, -16.0)])
def test_dub_mixer_hits_loudness_targets(tmp_path: Path, channels: int, target: float) -> None:
    tools = _ffmpeg()
    source = write_tone_wav(tmp_path / "bed.wav", seconds=12.0, freq=220.0, channels=channels)
    speech = write_tone_wav(tmp_path / "speech.wav", seconds=2.0, rate=16000, freq=880.0)
    placements = [
        SpeechPlacement("s1", speech, 1_000_000, 3_000_000),
        SpeechPlacement("s2", speech, 8_000_000, 10_000_000),
    ]
    out = tmp_path / "mix.wav"
    lufs, peak = DubMixer(tools).mix(source, placements, out, channels=channels)
    assert abs(lufs - target) <= 1.0, lufs
    assert peak <= -1.0 + 0.1, peak
    assert abs(wav_duration_us(out) - 12_000_000) < 50_000
    remeasured = measure_loudness(tools, out)
    assert remeasured is not None and abs(remeasured[0] - lufs) < 0.2

    # the passthrough (M1) mixer still normalises the bare source to −16 stereo
    passthrough = tmp_path / "pass.wav"
    lufs_p, _ = PassthroughMixer(tools).mix(source, [], passthrough, channels=channels)
    assert -20.0 < lufs_p < -12.0


def test_mixing_stage_places_fitted_speech_from_earlier_stages(tmp_path: Path) -> None:
    tools = _ffmpeg()
    storage = MemoryStorage()
    source_uri = "s3://source/org/asset.wav"
    storage.put(source_uri, write_tone_wav(tmp_path / "bed.wav", seconds=12.0), "audio/wav")
    segments = segment_dicts(new_id())
    speech = []
    for i, seg in enumerate(segments):
        wav = write_tone_wav(tmp_path / f"{i}.wav", seconds=2.0, freq=660.0)
        stage = "timing" if i == 0 else "synthesizing"
        name = f"{seg['id']}.fit.wav" if i == 0 else f"{seg['id']}.wav"
        storage.put(f"s3://derived/org/targets/t1/{stage}/speech/{name}", wav, "audio/wav")
        speech.append(
            {
                "renderId": new_id(),
                "translationVersionId": new_id(),
                "segmentId": seg["id"],
                "measuredDurationUs": 2_000_000,
                "timeStretchRatio": 1.0,
                "voiceId": "Mia",
            }
        )
    task = target_task("MIXING", segments=segments, speech=speech, source=source_uri)
    providers = aws_providers({}, storage, tools)
    env, _ = env_for(providers)
    out = mixing.run(task, storage, tools, env)
    validate_schema("output-mixing", out)
    parsed = MixingOutput.model_validate(out)
    assert parsed.mix == f"{task.storage.derivedPrefix}mix.wav" and storage.exists(parsed.mix)
    assert abs(parsed.integratedLufs + 19.0) <= 1.0  # mono source → −19 LUFS
    assert parsed.truePeakDbtp <= -0.9
