"""Amazon Polly adapter: voice table, exact PCM duration, WAV artefacts under the derived prefix."""

from __future__ import annotations

import io
import wave

from polycast_worker.models import SynthesizingOutput
from polycast_worker.providers.aws.clients import ClientFactory
from polycast_worker.providers.aws.locales import POLLY_VOICES, SEED_LOCALES
from polycast_worker.providers.aws.polly import (
    PollyProvider,
    parse_speech_marks,
    pcm_duration_us,
    pcm_to_wav,
)
from polycast_worker.runner import run_task
from polycast_worker.stages import synthesizing
from polycast_worker.tools import Tools

from .aws_stubs import (
    MemoryStorage,
    aws_providers,
    env_for,
    recorded,
    segment_dicts,
    stub_client,
    target_task,
)
from .conftest import new_id, validate_schema


def test_voice_table_covers_every_seed_locale_or_marks_it_unavailable() -> None:
    assert set(POLLY_VOICES) == set(SEED_LOCALES)
    provider = PollyProvider(ClientFactory.with_clients({}))
    records = {r.locale: r for r in provider.capabilities()}
    assert set(records) == set(SEED_LOCALES)
    for loc in SEED_LOCALES:
        voice = POLLY_VOICES[loc]
        assert records[loc].tier == ("beta" if voice else "unavailable")
        assert records[loc].tier != "production" and records[loc].dataPolicy == "no-training"
        assert provider.default_voice(loc) == (voice.voice_id if voice else None)
    assert POLLY_VOICES["es-MX"] is not None and POLLY_VOICES["es-MX"].voice_id == "Mia"
    assert POLLY_VOICES["pt-BR"] is not None and POLLY_VOICES["pt-BR"].voice_id == "Camila"
    assert POLLY_VOICES["ja-JP"] is not None and POLLY_VOICES["ja-JP"].voice_id == "Takumi"
    assert POLLY_VOICES["zh-CN"] is not None and POLLY_VOICES["zh-CN"].language_code == "cmn-CN"
    assert POLLY_VOICES["id-ID"] is None and POLLY_VOICES["ur-PK"] is None


def test_pcm_helpers_are_exact() -> None:
    pcm = b"\x00\x01" * 8000  # 8000 frames at 16 kHz = 500 ms
    assert pcm_duration_us(pcm) == 500_000
    assert pcm_duration_us(b"\x00\x01" * 3) == 188  # 3/16000 s = 187.5 µs, half-up
    with wave.open(io.BytesIO(pcm_to_wav(pcm)), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (
            1,
            2,
            16000,
            8000,
        )
    marks = parse_speech_marks(
        b'{"time":6,"type":"word","value":"Visita"}\n{"time":1,"type":"sentence"}\n'
    )
    assert marks == [{"text": "Visita", "timeUs": 6000}]


def test_synthesizing_stage_writes_speech_wav_with_measured_duration() -> None:
    storage = MemoryStorage()
    client, stubber = stub_client("polly")
    segments = segment_dicts(new_id())[2:]
    translation = {
        "translationVersionId": new_id(),
        "segmentId": segments[0]["id"],
        "adaptedText": "Visita polycast.example.com para 3 episodios gratis.",
        "timingBudgetUs": 2_330_000,
        "generation": 1,
    }
    for variant in ("pcm", "marks"):
        rec = recorded("polly", "synthesize_speech", variant)
        stubber.add_response(
            "synthesize_speech",
            rec["response"],
            {**rec["expected_params"], "Text": translation["adaptedText"]},
        )
    providers = aws_providers({"polly": client}, storage)
    env, _ = env_for(providers)
    task = target_task("SYNTHESIZING", segments=segments, translations=[translation])
    out = synthesizing.run(task, storage, Tools.none(), env)
    validate_schema("output-synthesizing", out)
    stubber.assert_no_pending_responses()
    parsed = SynthesizingOutput.model_validate(out)
    assert parsed.provider == "aws-polly" and parsed.providerVersion == "1-neural"
    render = parsed.renders[0]
    assert render.voiceId == "Mia" and render.measuredDurationUs == 500_000
    assert render.audio == f"{task.storage.derivedPrefix}speech/{segments[0]['id']}.wav"
    with wave.open(io.BytesIO(storage.get(render.audio)), "rb") as w:
        assert w.getframerate() == 16000 and w.getnframes() == 8000
    assert storage.content_types[render.audio] == "audio/wav"


def test_list_voices_and_unavailable_locale() -> None:
    client, stubber = stub_client("polly")
    rec = recorded("polly", "describe_voices")
    stubber.add_response("describe_voices", rec["response"], rec["expected_params"])
    providers = aws_providers({"polly": client}, MemoryStorage())
    voices = providers.speech.list_voices("es-MX")
    assert [v["voiceId"] for v in voices] == ["Mia", "Andres"]
    assert voices[0]["engines"] == ["neural", "standard"]
    assert providers.speech.list_voices("id-ID") == []
    stubber.assert_no_pending_responses()

    env, _ = env_for(providers)
    task = target_task("SYNTHESIZING", segments=segment_dicts(new_id()), target_locale="id-ID")
    result = run_task(task, MemoryStorage(), Tools.none(), "w", env)
    assert result.status == "failed" and result.error is not None
    assert result.error.code == "VOICE_UNAVAILABLE" and result.retryable is False

    stubber.add_client_error("synthesize_speech", "ServiceFailureException")
    task = target_task(
        "SYNTHESIZING",
        segments=segment_dicts(new_id()),
        translations=[
            {
                "translationVersionId": new_id(),
                "segmentId": new_id(),
                "adaptedText": "x",
                "timingBudgetUs": 1,
                "generation": 1,
            }
        ],
    )
    result = run_task(task, MemoryStorage(), Tools.none(), "w", env)
    assert result.error is not None and result.error.code == "PROVIDER_ERROR"
