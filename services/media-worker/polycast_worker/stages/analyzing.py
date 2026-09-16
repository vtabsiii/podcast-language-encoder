"""ANALYZING: proxy + waveform from the immutable source, then the mock analysis fixture.

The fixture is deterministic per assetId so re-runs and tests see identical segments.
It is a Mock adapter (tier unavailable): no real language detection or transcription.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from ..audio import (
    PEAKS_PER_SECOND,
    AudioError,
    compute_peaks,
    decode_mono_pcm_ffmpeg,
    is_riff_wave,
    iter_wav_mono_pcm,
)
from ..models import (
    AnalyzedSegment,
    AnalyzedSpeaker,
    AnalyzingOutput,
    MediaMetadata,
    TimeRange,
    Word,
    WorkerTask,
)
from ..providers.mock import MOCK_PROVIDER_VERSION
from ..storage import Storage
from ..tools import Tools
from .common import StageError, derived_uri, require_source, workdir

DEFAULT_LOCALE = "en-US"
DETECTION_CONFIDENCE = 0.93
WORD_CONFIDENCE = 0.9
SEGMENT_GAP_US = 300_000
SEGMENT_MIN_US = 3_000_000
SEGMENT_MAX_US = 7_000_000
_MIN_TAIL_US = 1_000_000

SENTENCES: tuple[str, ...] = (
    "Welcome back to the show, today we are talking about how podcasts get made.",
    "Most producers start by planning the episode outline before recording anything.",
    "A quiet room and a decent microphone matter more than expensive gear.",
    "Recording each guest on a separate track makes editing far easier later.",
    "Always capture a minute of room tone so you can smooth out edits.",
    "Levels should peak well below zero to leave headroom for mastering.",
    "Interviews flow better when the host listens instead of reading questions.",
    "Editing removes long pauses, false starts and the occasional cough.",
    "Loudness normalisation keeps every episode at a consistent listening level.",
    "Show notes and chapter markers help listeners find the parts they care about.",
    "Transcripts make an episode searchable and accessible to more people.",
    "A good intro sets expectations in the first thirty seconds.",
    "Music beds should sit under the voice, never compete with it.",
    "Publishing on a regular schedule builds a loyal audience over time.",
    "Feedback from listeners often shapes the next season of the show.",
    "Backing up raw recordings protects months of work from a single failure.",
    "Remote interviews work best when everyone wears headphones.",
    "Short episodes are easier to finish, so many shows aim for under an hour.",
    "Reviewing analytics shows which topics keep people listening to the end.",
    "The final mix is checked on headphones, laptop speakers and in a car.",
)


def _speaker_key(index: int) -> str:
    return "A" if index % 2 == 0 else "B"


def fixture_segments(asset_id: str, duration_us: int) -> list[AnalyzedSegment]:
    rng = random.Random(f"polycast-analysis:{asset_id}")  # noqa: S311 - deterministic fixture
    segments: list[AnalyzedSegment] = []
    cursor = 0
    seq = 0
    while cursor < duration_us:
        length = rng.randint(SEGMENT_MIN_US, SEGMENT_MAX_US)
        end = min(cursor + length, duration_us)
        if duration_us - end < _MIN_TAIL_US:
            end = duration_us
        text = SENTENCES[rng.randrange(len(SENTENCES))]
        words = text.split()
        span = end - cursor
        step = span // len(words)
        word_models: list[Word] = []
        for i, w in enumerate(words):
            w_start = cursor + i * step
            w_end = end if i == len(words) - 1 else cursor + (i + 1) * step
            word_models.append(
                Word(text=w, range=TimeRange(start=w_start, end=w_end), confidence=WORD_CONFIDENCE)
            )
        segments.append(
            AnalyzedSegment(
                seq=seq,
                speakerKey=_speaker_key(seq),
                range=TimeRange(start=cursor, end=end),
                text=text,
                language="en",
                confidence=WORD_CONFIDENCE,
                words=word_models,
            )
        )
        seq += 1
        cursor = end + SEGMENT_GAP_US
    return segments


def fixture_speakers(segments: list[AnalyzedSegment], has_video: bool) -> list[AnalyzedSpeaker]:
    out: list[AnalyzedSpeaker] = []
    for key in ("A", "B"):
        samples = [s.range for s in segments if s.speakerKey == key][:2]
        out.append(
            AnalyzedSpeaker(
                key=key,
                label=f"Speaker {key}",
                onCamera=has_video,
                voicePolicy="stock",
                sampleRanges=samples,
            )
        )
    return out


def _write_proxy(
    task: WorkerTask, storage: Storage, tools: Tools, local: Path, wd: Path, is_wav: bool
) -> str:
    if tools.has_ffmpeg:
        proxy = wd / "proxy.mp3"
        tools.run_ffmpeg(
            ["-i", local, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", proxy]
        )
        uri = derived_uri(task, "proxy.mp3")
        storage.put(uri, proxy, "audio/mpeg")
        return uri
    if is_wav:
        uri = derived_uri(task, "proxy.wav")
        storage.put(uri, local, "audio/wav")
        return uri
    raise StageError(
        "TOOL_UNAVAILABLE", "ffmpeg is required to build a proxy for this source", retryable=True
    )


def _write_waveform(
    task: WorkerTask,
    storage: Storage,
    tools: Tools,
    local: Path,
    metadata: MediaMetadata,
    is_wav: bool,
) -> str:
    if tools.has_ffmpeg:
        rate, chunks = decode_mono_pcm_ffmpeg(tools, local)
    elif is_wav:
        try:
            rate, chunks = iter_wav_mono_pcm(local)
        except AudioError as e:
            raise StageError("MALFORMED_MEDIA", "The source wav could not be decoded.") from e
    else:
        raise StageError(
            "TOOL_UNAVAILABLE", "ffmpeg is required to decode this source", retryable=True
        )
    peaks = compute_peaks(rate, chunks, metadata.durationUs, PEAKS_PER_SECOND)
    payload = {
        "version": 1,
        "peaksPerSecond": PEAKS_PER_SECOND,
        "durationUs": metadata.durationUs,
        "peaks": peaks,
    }
    uri = derived_uri(task, "waveform.json")
    storage.put(uri, json.dumps(payload, separators=(",", ":")).encode(), "application/json")
    return uri


def run(task: WorkerTask, storage: Storage, tools: Tools) -> dict[str, object]:
    params = task.analyzing_params()
    source_uri = require_source(task)
    metadata = params.metadata
    has_video = metadata.video is not None
    with workdir() as wd:
        local = wd / "source.bin"
        storage.download(source_uri, local)
        with local.open("rb") as f:
            is_wav = is_riff_wave(f.read(12))
        proxy = _write_proxy(task, storage, tools, local, wd, is_wav)
        waveform = _write_waveform(task, storage, tools, local, metadata, is_wav)

    segments = fixture_segments(params.assetId, metadata.durationUs)
    return AnalyzingOutput(
        detectedLocale=params.declaredLocale or DEFAULT_LOCALE,
        detectionConfidence=DETECTION_CONFIDENCE,
        provider="mock-transcription",
        providerVersion=MOCK_PROVIDER_VERSION,
        hasVideo=has_video,
        proxy=proxy,
        waveform=waveform,
        speakers=fixture_speakers(segments, has_video),
        segments=segments,
    ).model_dump()
