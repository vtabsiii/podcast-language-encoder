"""FR-011: entity preservation check over source text vs adapted text."""

from __future__ import annotations

from polycast_worker.qc.entity_check import (
    EntityViolation,
    check_translations,
    extract_entities,
    missing_entities,
)


def test_extract_entities_finds_urls_numbers_names_and_glossary() -> None:
    text = (
        "Welcome New York listeners. Visit https://polycast.example.com/start or "
        "polycast.example.com, call 555-0100, and ask about Acme Corp and 10,000 downloads."
    )
    found = extract_entities(text, glossary=["Polycast Studio", "acme corp"])
    assert "https://polycast.example.com/start" in found
    assert "polycast.example.com" in found
    assert "555-0100" in found and "10,000" in found
    assert "Acme Corp" in found
    assert "New York" in found  # sentence-initial "Welcome" dropped, the name kept
    assert "Welcome New York" not in found
    assert "acme corp" in found  # glossary term matched case-insensitively
    assert "Polycast Studio" not in found  # glossary term absent from the source


def test_sentence_initial_capitalised_runs_are_not_entities() -> None:
    assert extract_entities("Most producers start early. Recording each guest helps.") == []
    assert extract_entities("The show is great") == []
    assert extract_entities("we visited San Francisco Bay") == ["San Francisco Bay"]


def test_missing_entities_tolerates_locale_number_punctuation() -> None:
    assert missing_entities("Over 10,000 downloads", "Über 10.000 Downloads") == []
    assert missing_entities("Over 10,000 downloads", "Über zehntausend Downloads") == ["10,000"]
    assert missing_entities("Visit polycast.example.com", "Visita polycast.example.com") == []
    assert missing_entities("Visit polycast.example.com", "Visita nuestro sitio") == [
        "polycast.example.com"
    ]
    assert missing_entities("Ask Acme Corp", "Pregunta a ACME CORP") == []


def test_check_translations_reports_per_segment_and_skips_untranslated() -> None:
    violations = check_translations(
        [("a", "Call Acme Corp at 555-0100."), ("b", "Plain text."), ("c", "Ring 555-0100.")],
        {"a": "Llama a la empresa.", "b": "Texto plano."},
    )
    assert violations == [EntityViolation("a", "Acme Corp"), EntityViolation("a", "555-0100")]
    assert violations[0].as_dict() == {"segmentId": "a", "token": "Acme Corp"}
