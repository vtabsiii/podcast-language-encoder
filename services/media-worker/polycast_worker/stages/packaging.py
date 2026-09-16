"""PACKAGING: deliverable set under the (already versioned) deliverables prefix.

    episode.{locale}.{mp4|mp3}   copy of the ENCODING artefact
    captions.{locale}.srt/.vtt   adapted text over segment ranges
    transcript.{locale}.json     segments + translations, ids, ranges in µs
    qc-report.json               QcReport from the control plane (or a passing one)
    provenance.json              ProvenanceManifest (FR-063, BR-08)
    checksums.sha256             `sha256sum` format over every other file

Deliverables are never mutated: the API hands out a new prefix per package version.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .. import __version__
from ..mediatime import to_srt_timestamp, to_vtt_timestamp
from ..models import (
    Deliverable,
    DeliverableKind,
    ManifestFile,
    PackagingOutput,
    ProvenanceManifest,
    ProvenanceModel,
    QcReport,
    Segment,
    TargetParams,
    TranslationInput,
    WorkerTask,
)
from ..providers.registry import ProviderSet
from ..storage import Storage, join_uri, sha256_of_path
from ..tools import Tools
from .common import (
    StageEnv,
    StageError,
    content_type_for,
    find_artifact,
    now_iso,
    require_source,
    resolve_env,
    segments_by_seq,
    source_extension,
    translations_by_segment,
    workdir,
)

GENERATOR = f"polycast-media-worker/{__version__}"
DISCLOSURE = (
    "Generated with mock providers: audio is the untranslated source; "
    "captions are pseudo-translations."
)
DISCLOSURE_SYNTHETIC = (
    "Dialogue was machine-translated and voiced with a synthetic (stock) voice; "
    "lip sync was not applied. Providers are listed in `models` with their tiers."
)
PROVENANCE_FILE = "provenance.json"
CHECKSUMS_FILE = "checksums.sha256"
QC_REPORT_FILE = "qc-report.json"


@dataclass(frozen=True)
class _File:
    kind: DeliverableKind
    name: str
    content_type: str
    path: Path

    @property
    def sha256(self) -> str:
        return sha256_of_path(self.path)

    @property
    def size(self) -> int:
        return self.path.stat().st_size


def _fetch_media(
    task: WorkerTask, params: TargetParams, storage: Storage, wd: Path
) -> tuple[Path, str]:
    source_uri = require_source(task)
    preferred = "mp4" if params.metadata.video is not None else "mp3"
    fallback_ext = source_extension(source_uri, params.metadata.container)
    for ext in dict.fromkeys((preferred, "mp3", "mp4", fallback_ext)):
        uri = find_artifact(task, storage, "ENCODING", f"encode.{ext}")
        if uri is not None:
            local = wd / f"media.{ext}"
            storage.download(uri, local)
            return local, ext
    local = wd / f"media.{fallback_ext}"
    storage.download(source_uri, local)
    return local, fallback_ext


def _caption_text(seg: Segment, current: dict[str, TranslationInput]) -> str:
    t = current.get(seg.id)
    return t.adaptedText if t is not None else seg.text


def build_srt(segments: list[Segment], current: dict[str, TranslationInput]) -> str:
    blocks = []
    for i, seg in enumerate(segments, start=1):
        blocks.append(
            f"{i}\n{to_srt_timestamp(seg.range.start)} --> {to_srt_timestamp(seg.range.end)}\n"
            f"{_caption_text(seg, current)}\n"
        )
    return "\n".join(blocks) + ("\n" if blocks else "")


def build_vtt(segments: list[Segment], current: dict[str, TranslationInput]) -> str:
    out = ["WEBVTT\n"]
    for i, seg in enumerate(segments, start=1):
        out.append(
            f"{i}\n{to_vtt_timestamp(seg.range.start)} --> {to_vtt_timestamp(seg.range.end)}\n"
            f"{_caption_text(seg, current)}\n"
        )
    return "\n".join(out)


def build_transcript(
    params: TargetParams, segments: list[Segment], current: dict[str, TranslationInput]
) -> dict[str, object]:
    items: list[dict[str, object]] = []
    for seg in segments:
        t = current.get(seg.id)
        items.append(
            {
                "id": seg.id,
                "seq": seg.seq,
                "speakerId": seg.speakerId,
                "range": {"start": seg.range.start, "end": seg.range.end},
                "text": seg.text,
                "translation": None
                if t is None
                else {
                    "translationVersionId": t.translationVersionId,
                    "adaptedText": t.adaptedText,
                    "generation": t.generation,
                    "timingBudgetUs": t.timingBudgetUs,
                },
            }
        )
    return {
        "schemaVersion": 1,
        "targetJobId": params.targetJobId,
        "jobId": params.jobId,
        "projectId": params.projectId,
        "sourceLocale": params.sourceLocale,
        "targetLocale": params.targetLocale,
        "direction": params.direction,
        "segments": items,
    }


def _qc_report(params: TargetParams) -> QcReport:
    if params.provenance is not None and params.provenance.qcReport is not None:
        return params.provenance.qcReport
    return QcReport(
        generatedAt=now_iso(),
        targetJobId=params.targetJobId,
        locale=params.targetLocale,
        passed=True,
        checks=[],
        issues=[],
        summary="No QC report was supplied by the control plane; packaged as passed.",
    )


def provenance_models(providers: ProviderSet, params: TargetParams) -> list[ProvenanceModel]:
    """One entry per (capability, adapter) that took part, narrowed to the target locale.

    In local mode the encoder is left out: the M1 manifest lists exactly the mock set."""
    seen: set[tuple[str, str]] = set()
    out: list[ProvenanceModel] = []
    for r in providers.capabilities(locale=params.targetLocale, lip_sync=params.lipSync):
        if providers.is_mock and r.kind == "encode":
            continue
        if (r.kind, r.adapterId) in seen:
            continue
        seen.add((r.kind, r.adapterId))
        out.append(
            ProvenanceModel(
                capability=r.kind,
                adapterId=r.adapterId,
                version=r.version,
                tier=r.tier,
                dataPolicy=r.dataPolicy,
            )
        )
    return out


def _dump_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run(
    task: WorkerTask, storage: Storage, tools: Tools, env: StageEnv | None = None
) -> dict[str, object]:
    env = resolve_env(env, storage, tools)
    providers = env.providers
    params = task.target_params()
    prefix = task.storage.deliverablesPrefix
    if prefix is None:
        raise StageError("INVALID_TASK", "PACKAGING requires a deliverables prefix")
    if params.packageVersion is None:
        raise StageError("INVALID_TASK", "PACKAGING requires a package version")
    locale = params.targetLocale
    segments = segments_by_seq(params)
    current = translations_by_segment(params)

    with workdir() as wd:
        media_path, media_ext = _fetch_media(task, params, storage, wd)
        files: list[_File] = [
            _File("media", f"episode.{locale}.{media_ext}", content_type_for(media_ext), media_path)
        ]

        srt = wd / f"captions.{locale}.srt"
        srt.write_text(build_srt(segments, current), encoding="utf-8")
        files.append(_File("captions-srt", srt.name, content_type_for("srt"), srt))

        vtt = wd / f"captions.{locale}.vtt"
        vtt.write_text(build_vtt(segments, current), encoding="utf-8")
        files.append(_File("captions-vtt", vtt.name, content_type_for("vtt"), vtt))

        transcript = wd / f"transcript.{locale}.json"
        _dump_json(transcript, build_transcript(params, segments, current))
        files.append(_File("transcript-json", transcript.name, "application/json", transcript))

        qc = wd / QC_REPORT_FILE
        _dump_json(qc, _qc_report(params).model_dump())
        files.append(_File("qc-report", qc.name, "application/json", qc))

        if params.provenance is not None:
            translation_ids = list(params.provenance.translationVersionIds)
        else:
            translation_ids = sorted(t.translationVersionId for t in current.values())
        manifest = ProvenanceManifest(
            generator=GENERATOR,
            generatedAt=now_iso(),
            jobId=params.jobId,
            targetJobId=params.targetJobId,
            projectId=params.projectId,
            sourceLocale=params.sourceLocale,
            targetLocale=locale,
            sourceSha256=params.sourceSha256,
            syntheticVoice=not providers.is_mock and bool(params.speech),
            lipSyncApplied=False,
            mock=providers.is_mock,
            models=provenance_models(providers, params),
            segmentCount=len(segments),
            translationVersionIds=translation_ids,
            files=[ManifestFile(fileName=f.name, sha256=f.sha256, byteSize=f.size) for f in files],
            disclosure=DISCLOSURE if providers.is_mock else DISCLOSURE_SYNTHETIC,
        )
        prov = wd / PROVENANCE_FILE
        _dump_json(prov, manifest.model_dump())
        files.append(_File("provenance-manifest", prov.name, "application/json", prov))

        checksums = wd / CHECKSUMS_FILE
        checksums.write_text("".join(f"{f.sha256}  {f.name}\n" for f in files), encoding="utf-8")
        files.append(_File("checksums", checksums.name, content_type_for("sha256"), checksums))

        deliverables: list[Deliverable] = []
        for f in files:
            uri = join_uri(prefix, f.name)
            storage.put(uri, f.path, f.content_type)
            deliverables.append(
                Deliverable(
                    kind=f.kind,
                    fileName=f.name,
                    contentType=f.content_type,
                    byteSize=f.size,
                    sha256=f.sha256,
                    uri=uri,
                )
            )

    return PackagingOutput(deliverables=deliverables, manifest=manifest).model_dump()
