import json
from pathlib import Path

import jsonschema
import pytest

from polycast_worker.ffprobe import ProbeError, parse_probe_output

SCHEMA = (
    Path(__file__).resolve().parents[3] / "packages/contracts/schema/media-metadata.schema.json"
)

SAMPLE = {
    "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "61.027000"},
    "streams": [
        {
            "codec_type": "video",
            "codec_name": "h264",
            "width": 1920,
            "height": 1080,
            "avg_frame_rate": "30000/1001",
            "r_frame_rate": "30000/1001",
            "color_primaries": "bt709",
            "color_transfer": "bt709",
            "disposition": {"attached_pic": 0},
        },
        {
            "codec_type": "audio",
            "codec_name": "aac",
            "sample_rate": "48000",
            "channels": 2,
            "channel_layout": "stereo",
        },
    ],
}


def test_parse_sample_matches_contract_schema():
    meta = parse_probe_output(SAMPLE)
    assert meta.container == "mov"
    assert meta.durationUs == 61_027_000
    assert meta.video is not None and meta.video.frameRate.den == 1001
    assert meta.video.variableFrameRate is False and meta.video.hdr is False
    assert meta.audio is not None and meta.audio.channels == 2
    if SCHEMA.exists():
        jsonschema.validate(meta.dump_contract(), json.loads(SCHEMA.read_text()))
    else:
        pytest.skip("contracts schema not built; run pnpm --filter @polycast/contracts build")


def test_vfr_and_hdr_detection():
    s = json.loads(json.dumps(SAMPLE))
    s["streams"][0]["r_frame_rate"] = "60/1"
    s["streams"][0]["color_transfer"] = "smpte2084"
    meta = parse_probe_output(s)
    assert meta.video is not None
    assert meta.video.variableFrameRate is True
    assert meta.video.hdr is True


def test_audio_only_source_has_no_video():
    s = {"format": SAMPLE["format"], "streams": [SAMPLE["streams"][1]]}
    meta = parse_probe_output(s)
    assert meta.video is None


def test_missing_audio_is_an_error():
    with pytest.raises(ProbeError):
        parse_probe_output({"format": SAMPLE["format"], "streams": [SAMPLE["streams"][0]]})
