"""Amazon Translate and Bedrock translation adapters against recorded responses."""

from __future__ import annotations

import json
import re

import pytest
from botocore.stub import ANY

from polycast_worker.models import TranslatingOutput
from polycast_worker.providers.aws.bedrock import (
    SYSTEM_PROMPT,
    BedrockTranslationProvider,
    build_request,
    parse_response,
    prompt_version,
)
from polycast_worker.providers.aws.clients import ClientFactory
from polycast_worker.providers.aws.locales import (
    SEED_LOCALES,
    TRANSLATE_CODES,
    max_chars_for,
    translate_code,
)
from polycast_worker.providers.aws.translate import (
    MAX_REQUEST_BYTES,
    TranslateProvider,
    batch_texts,
    formality_for,
)
from polycast_worker.runner import run_task
from polycast_worker.stages import translating
from polycast_worker.stages.common import provider_context
from polycast_worker.tools import Tools

from .aws_stubs import (
    SEG_TEXTS,
    MemoryStorage,
    aws_providers,
    env_for,
    recorded,
    segment_dicts,
    stub_client,
    target_task,
)
from .conftest import new_id, validate_schema


def test_translate_code_table_is_total_over_seed_locales() -> None:
    assert set(TRANSLATE_CODES) == set(SEED_LOCALES) and len(SEED_LOCALES) == 22
    assert translate_code("es-MX") == "es-MX"
    assert translate_code("pt-BR") == "pt" and translate_code("pt-PT") == "pt-PT"
    assert translate_code("zh-CN") == "zh" and translate_code("ar-001") == "ar"
    assert translate_code("fr-CA") == "fr-CA" and translate_code("en-GB") == "en"
    assert translate_code("xx-YY") == "xx"  # unknown tags degrade to the language


def test_batch_texts_respects_the_byte_limit() -> None:
    texts = ["a" * 4000, "b" * 4000, "c" * 4000, "é" * 6000, "d"]
    groups = batch_texts(texts, MAX_REQUEST_BYTES)
    assert groups == [[0, 1], [2], [3], [4]]  # "é" is 2 bytes → 12,000 alone
    for g in groups:
        joined = "\n".join(texts[i] for i in g)
        assert len(joined.encode()) <= MAX_REQUEST_BYTES or len(g) == 1
    assert batch_texts([]) == []


def test_formality_only_for_supported_targets() -> None:
    assert formality_for("de", None) == "INFORMAL"
    assert formality_for("de", "keep it formal") == "FORMAL"
    assert formality_for("de", "informal please") == "INFORMAL"
    assert formality_for("es-MX", None) is None
    assert formality_for("zh", "formal") is None


def test_translate_stage_batches_segments_and_keeps_ids() -> None:
    storage = MemoryStorage()
    client, stubber = stub_client("translate")
    rec = recorded("translate", "translate_text", "batched")
    stubber.add_response("translate_text", rec["response"], rec["expected_params"])
    providers = aws_providers({"translate": client}, storage)
    segments = segment_dicts(new_id())
    task = target_task("TRANSLATING", segments=segments, target_locale="de-DE")
    env, _ = env_for(providers)
    out = translating.run(task, storage, Tools.none(), env)
    validate_schema("output-translating", out)
    stubber.assert_no_pending_responses()
    parsed = TranslatingOutput.model_validate(out)
    assert parsed.provider == "aws-translate" and parsed.promptVersion is None
    assert [t.segmentId for t in parsed.translations] == [s["id"] for s in segments]
    assert parsed.translations[2].adaptedText.startswith("Besuche polycast.example.com für 3")
    assert all(t.confidence == 0.75 and t.literalText is None for t in parsed.translations)
    assert [t.timingBudgetUs for t in parsed.translations] == [4_160_000, 4_350_000, 2_330_000]


def test_translate_falls_back_per_segment_when_line_count_drifts() -> None:
    client, stubber = stub_client("translate")
    provider = TranslateProvider(ClientFactory.with_clients({"translate": client}))
    joined = "\n".join(SEG_TEXTS)
    stubber.add_response(
        "translate_text",
        {
            "TranslatedText": "solo dos\nlíneas",
            "SourceLanguageCode": "en",
            "TargetLanguageCode": "es-MX",
        },
        {"Text": joined, "SourceLanguageCode": "en", "TargetLanguageCode": "es-MX"},
    )
    for i, text in enumerate(SEG_TEXTS):
        stubber.add_response(
            "translate_text",
            {"TranslatedText": f"t{i}", "SourceLanguageCode": "en", "TargetLanguageCode": "es-MX"},
            {"Text": text, "SourceLanguageCode": "en", "TargetLanguageCode": "es-MX"},
        )
    ctx = provider_context(target_task("TRANSLATING", segments=segment_dicts(new_id())))
    out = provider.translate(
        [{"segmentId": f"s{i}", "text": t} for i, t in enumerate(SEG_TEXTS)],
        "es-MX",
        ctx,
        None,
        source_locale="en-US",
    )
    assert [o["adaptedText"] for o in out] == ["t0", "t1", "t2"]
    stubber.assert_no_pending_responses()


def test_translate_passes_terminology_and_maps_errors() -> None:
    client, stubber = stub_client("translate")
    provider = TranslateProvider(
        ClientFactory.with_clients({"translate": client}), terminology_name="podcast-glossary"
    )
    rec = recorded("translate", "translate_text")
    stubber.add_response(
        "translate_text",
        rec["response"],
        {**rec["expected_params"], "TerminologyNames": ["podcast-glossary"]},
    )
    ctx = provider_context(target_task("TRANSLATING", segments=[]))
    out = provider.translate(
        [{"segmentId": "s", "text": SEG_TEXTS[2]}], "es-MX", ctx, source_locale="en-US"
    )
    assert out[0]["adaptedText"] == "Visita polycast.example.com para 3 episodios gratis."
    stubber.add_client_error("translate_text", "TooManyRequestsException")
    task = target_task("TRANSLATING", segments=segment_dicts(new_id())[:1])
    providers = aws_providers({"translate": client}, MemoryStorage())
    env, _ = env_for(providers)
    result = run_task(task, MemoryStorage(), Tools.none(), "w", env)
    assert result.status == "failed" and result.error is not None
    assert result.error.code == "PROVIDER_THROTTLED" and result.retryable is True


def test_translate_output_that_drops_entities_is_caught_by_the_entity_check() -> None:
    from polycast_worker.qc.entity_check import missing_entities

    client, stubber = stub_client("translate")
    rec = recorded("translate", "translate_text", "entity_dropped")
    stubber.add_response("translate_text", rec["response"], rec["expected_params"])
    provider = TranslateProvider(ClientFactory.with_clients({"translate": client}))
    ctx = provider_context(target_task("TRANSLATING", segments=[]))
    out = provider.translate(
        [{"segmentId": "s", "text": SEG_TEXTS[2]}], "es-MX", ctx, source_locale="en-US"
    )
    adapted = str(out[0]["adaptedText"])
    assert missing_entities(SEG_TEXTS[2], adapted) == ["polycast.example.com", "3"]
    stubber.assert_no_pending_responses()


# ---------- Bedrock ----------


def test_max_chars_follow_speaking_rate_and_shorter_hint() -> None:
    assert max_chars_for(4_000_000, "es-MX") == 64
    assert max_chars_for(4_000_000, "es-MX", shorter=True) == 51
    assert max_chars_for(4_000_000, "ja-JP") == 32
    assert max_chars_for(1, "en-US") == 1
    req = build_request(
        [
            {"segmentId": "a", "text": "Hi", "timingBudgetUs": 2_000_000, "speaker": "Host"},
            {"segmentId": "b", "text": "There", "timingBudgetUs": 1_000_000},
        ],
        "en-US",
        "de-DE",
        "make it shorter",
    )
    segs = req["segments"]
    assert isinstance(segs, list)
    assert segs[0]["maxChars"] == 22 and segs[1]["maxChars"] == 11
    assert segs[1]["context"] == "Hi" and segs[0]["speaker"] == "Host"


def test_parse_response_is_strict() -> None:
    ok = parse_response(
        '```json\n[{"segmentId":"a","adaptedText":"Hola","literalText":null}]\n```', ["a"]
    )
    assert ok[0]["adaptedText"] == "Hola" and ok[0]["literalText"] is None
    for bad in (
        "not json",
        "[]",
        '[{"segmentId":"b","adaptedText":"x","literalText":null}]',
        '[{"segmentId":"a","adaptedText":"","literalText":null}]',
        '[{"segmentId":"a","adaptedText":"x","literalText":null,"extra":1}]',
        '[{"segmentId":"a","adaptedText":"x","literalText":5}]',
    ):
        with pytest.raises(ValueError):
            parse_response(bad, ["a"])


def test_bedrock_stage_records_prompt_hash_and_literal_text() -> None:
    storage = MemoryStorage()
    client, stubber = stub_client("bedrock-runtime")
    segments = segment_dicts(new_id())
    ids = [s["id"] for s in segments]
    rec = recorded("bedrock", "converse", SEG_1=ids[0], SEG_2=ids[1], SEG_3=ids[2])
    task = target_task("TRANSLATING", segments=segments, hint="make it shorter")
    inputs = [
        {
            "segmentId": s["id"],
            "text": s["text"],
            "generation": None,
            "timingBudgetUs": s["range"]["end"] - s["range"]["start"],
            "speaker": "Speaker A",
        }
        for s in segments
    ]
    expected_payload = build_request(inputs, "en-US", "es-MX", "make it shorter")
    stubber.add_response(
        "converse",
        rec["response"],
        {
            "modelId": "anthropic.claude-3-5-haiku-20241022-v1:0",
            "system": [{"text": SYSTEM_PROMPT}],
            "messages": [
                {
                    "role": "user",
                    "content": [{"text": json.dumps(expected_payload, ensure_ascii=False)}],
                }
            ],
            "inferenceConfig": {"maxTokens": 4096, "temperature": 0.2},
        },
    )
    providers = aws_providers({"bedrock-runtime": client}, storage, TRANSLATION_PROVIDER="bedrock")
    assert isinstance(providers.translation, BedrockTranslationProvider)
    env, _ = env_for(providers)
    out = translating.run(task, storage, Tools.none(), env)
    validate_schema("output-translating", out)
    stubber.assert_no_pending_responses()
    parsed = TranslatingOutput.model_validate(out)
    assert parsed.provider == "aws-bedrock"
    assert parsed.providerVersion == "anthropic.claude-3-5-haiku-20241022-v1:0"
    assert parsed.promptVersion == prompt_version()
    assert re.fullmatch(r"bedrock-v1:[0-9a-f]{8}", parsed.promptVersion or "")
    assert parsed.translations[1].literalText is None
    assert parsed.translations[2].literalText is not None
    assert "polycast.example.com" in parsed.translations[2].adaptedText
    assert all(t.confidence == 0.85 for t in parsed.translations)


def test_bedrock_malformed_output_retries_once_then_fails_retryable() -> None:
    client, stubber = stub_client("bedrock-runtime")
    bad = recorded("bedrock", "converse", "malformed")["response"]
    stubber.add_response(
        "converse", bad, {"modelId": ANY, "system": ANY, "messages": ANY, "inferenceConfig": ANY}
    )
    stubber.add_response(
        "converse", bad, {"modelId": ANY, "system": ANY, "messages": ANY, "inferenceConfig": ANY}
    )
    providers = aws_providers(
        {"bedrock-runtime": client}, MemoryStorage(), TRANSLATION_PROVIDER="bedrock"
    )
    env, _ = env_for(providers)
    task = target_task("TRANSLATING", segments=segment_dicts(new_id()))
    result = run_task(task, MemoryStorage(), Tools.none(), "w", env)
    stubber.assert_no_pending_responses()
    assert result.status == "failed" and result.error is not None
    assert result.error.code == "PROVIDER_BAD_OUTPUT" and result.retryable is True
