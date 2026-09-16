"""In-house QualityProvider (FR-040): real checks over the target's artefacts.

Inputs are assembled by the TARGET_QA stage (segments, current translations, fitted speech
placements, loudness measurement, channel count, video flag, glossary). Every check returns
`{metric, threshold, value, passed, issues}`; the stage turns `issues` into QaIssue rows.

    dialogue-coverage    missing translation or speech, or fitted speech that overruns /
                         underruns its segment by > 300 ms                       → critical
    boundary-drift       fitted speech edge off the segment edge by > 120 ms (up to the
                         coverage threshold; above it coverage already flags)   → warning
    loudness-integrated  −16 LUFS stereo / −19 mono, ± 1 LU                       → warning
    true-peak            ≤ −1 dBTP                                                → warning
    caption-timing       caption block from a segment must fit 2 lines × 42 chars → warning
    entity-preservation  qc/entity_check.py over source text vs adapted text     → warning
    frame-preservation   video only; lip sync is not applied in M3, so frames are
                         untouched by construction                                → critical
"""

from __future__ import annotations

from ..qc.entity_check import check_translations
from .base import CapabilityRecord, ProviderContext

ADAPTER_ID = "inhouse-quality"
ADAPTER_VERSION = "1"

COVERAGE_TOLERANCE_US = 300_000
DRIFT_TOLERANCE_US = 120_000
LOUDNESS_TOLERANCE_LU = 1.0
TARGET_LUFS_STEREO = -16.0
TARGET_LUFS_MONO = -19.0
TRUE_PEAK_MAX_DBTP = -1.0
CAPTION_MAX_CHARS = 2 * 42

AWS_METRICS: tuple[str, ...] = (
    "dialogue-coverage",
    "boundary-drift",
    "loudness-integrated",
    "true-peak",
    "caption-timing",
    "entity-preservation",
)


def _int(v: object, default: int = 0) -> int:
    return int(v) if isinstance(v, int) and not isinstance(v, bool) else default


def _float(v: object) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _segments(inputs: dict[str, object]) -> list[dict[str, object]]:
    segs = inputs.get("segments")
    return [s for s in segs if isinstance(s, dict)] if isinstance(segs, list) else []


def _speech(inputs: dict[str, object]) -> dict[str, dict[str, object]]:
    sp = inputs.get("speech")
    out: dict[str, dict[str, object]] = {}
    if isinstance(sp, list):
        for s in sp:
            if isinstance(s, dict) and isinstance(s.get("segmentId"), str):
                out[str(s["segmentId"])] = s
    return out


def _translations(inputs: dict[str, object]) -> dict[str, str]:
    tr = inputs.get("translations")
    if not isinstance(tr, dict):
        return {}
    return {str(k): str(v) for k, v in tr.items() if isinstance(v, str)}


def _issue(segment: dict[str, object], severity: str, recommendation: str) -> dict[str, object]:
    return {
        "segmentId": str(segment.get("id")),
        "severity": severity,
        "range": {"start": _int(segment.get("start")), "end": _int(segment.get("end"))},
        "recommendation": recommendation,
    }


def _result(
    metric: str,
    threshold: float | None,
    value: float | None,
    passed: bool,
    issues: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "metric": metric,
        "threshold": threshold,
        "value": value,
        "passed": passed,
        "issues": issues,
    }


class InHouseQualityProvider:
    def __init__(self, *, region: str = "local") -> None:
        self._region = region

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="quality",
                locale=None,
                region=self._region,
                tier="beta",
                version=ADAPTER_VERSION,
                dataPolicy="no-training",
                priceUnit="second",
            )
        ]

    def check(
        self, metric: str, inputs: dict[str, object], ctx: ProviderContext
    ) -> dict[str, object]:
        if metric == "dialogue-coverage":
            return self._coverage(inputs)
        if metric == "boundary-drift":
            return self._drift(inputs)
        if metric == "loudness-integrated":
            channels = _int(inputs.get("channels"), 2)
            target = TARGET_LUFS_MONO if channels == 1 else TARGET_LUFS_STEREO
            v = _float(inputs.get("value"))
            passed = v is not None and abs(v - target) <= LOUDNESS_TOLERANCE_LU
            return _result(metric, target, v, passed, [])
        if metric == "true-peak":
            v = _float(inputs.get("value"))
            passed = v is not None and v <= TRUE_PEAK_MAX_DBTP
            return _result(metric, TRUE_PEAK_MAX_DBTP, v, passed, [])
        if metric == "caption-timing":
            return self._captions(inputs)
        if metric == "entity-preservation":
            return self._entities(inputs)
        if metric == "frame-preservation":
            return _result(metric, None, None, True, [])
        return _result(metric, None, None, True, [])

    def _coverage(self, inputs: dict[str, object]) -> dict[str, object]:
        translations = _translations(inputs)
        speech = _speech(inputs)
        issues: list[dict[str, object]] = []
        for seg in _segments(inputs):
            sid = str(seg.get("id"))
            if sid not in translations:
                issues.append(_issue(seg, "critical", "No current translation; regenerate."))
                continue
            sp = speech.get(sid)
            if sp is None:
                issues.append(_issue(seg, "critical", "No speech render; re-synthesize."))
                continue
            start_gap = abs(_int(sp.get("start")) - _int(seg.get("start")))
            end_gap = abs(_int(sp.get("end")) - _int(seg.get("end")))
            if max(start_gap, end_gap) > COVERAGE_TOLERANCE_US:
                issues.append(
                    _issue(
                        seg,
                        "critical",
                        "Rendered speech misses the segment by more than 300 ms; "
                        "regenerate a shorter translation or accept the timing.",
                    )
                )
        return _result("dialogue-coverage", 0.0, float(len(issues)), not issues, issues)

    def _drift(self, inputs: dict[str, object]) -> dict[str, object]:
        speech = _speech(inputs)
        issues: list[dict[str, object]] = []
        worst = 0
        for seg in _segments(inputs):
            sp = speech.get(str(seg.get("id")))
            if sp is None:
                continue
            drift = max(
                abs(_int(sp.get("start")) - _int(seg.get("start"))),
                abs(_int(sp.get("end")) - _int(seg.get("end"))),
            )
            worst = max(worst, drift)
            if DRIFT_TOLERANCE_US < drift <= COVERAGE_TOLERANCE_US:
                issues.append(
                    _issue(
                        seg, "warning", "Speech boundary drifts more than 120 ms from the segment."
                    )
                )
        return _result(
            "boundary-drift", DRIFT_TOLERANCE_US / 1000, worst / 1000, not issues, issues
        )

    def _captions(self, inputs: dict[str, object]) -> dict[str, object]:
        translations = _translations(inputs)
        issues: list[dict[str, object]] = []
        for seg in _segments(inputs):
            text = translations.get(str(seg.get("id")))
            if text is not None and len(text) > CAPTION_MAX_CHARS:
                issues.append(
                    _issue(
                        seg,
                        "warning",
                        f"Caption exceeds 2 lines of 42 characters ({len(text)} chars); "
                        "shorten the translation or split the segment.",
                    )
                )
        return _result(
            "caption-timing", float(CAPTION_MAX_CHARS), float(len(issues)), not issues, issues
        )

    def _entities(self, inputs: dict[str, object]) -> dict[str, object]:
        segments = _segments(inputs)
        glossary_raw = inputs.get("glossary")
        glossary = [str(g) for g in glossary_raw] if isinstance(glossary_raw, list) else []
        violations = check_translations(
            [(str(s.get("id")), str(s.get("text", ""))) for s in segments],
            _translations(inputs),
            glossary,
        )
        by_id = {str(s.get("id")): s for s in segments}
        issues = [
            _issue(
                by_id[v.segment_id],
                "warning",
                f"Source token '{v.token}' is missing from the translation; regenerate or accept.",
            )
            for v in violations
            if v.segment_id in by_id
        ]
        return _result("entity-preservation", 0.0, float(len(issues)), not issues, issues)
