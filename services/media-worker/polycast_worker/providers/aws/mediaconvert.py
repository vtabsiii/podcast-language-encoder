"""AWS Elemental MediaConvert adapter (MediaEncodeProvider).

`encode()` submits one job: the source file as video input with the mix WAV as an external
audio track, output MP4 (H.264 + AAC 128k) for video sources or MP3 128k (RAW container)
for audio-only, written as `encode.<ext>` under the task's derived prefix. `poll()` maps
GetJob status; the stage measures the resulting object through Storage.
"""

from __future__ import annotations

from typing import Any

from ...storage import parse_uri
from ..base import AsyncHandle, CapabilityRecord, ProviderContext, ProviderError
from .clients import ClientFactory, provider_error

ADAPTER_ID = "aws-mediaconvert"
ADAPTER_VERSION = "1"
AUDIO_BITRATE = 128_000
VIDEO_MAX_BITRATE = 6_000_000


def _s3(uri: str) -> str:
    u = parse_uri(uri)
    return f"s3://{u.bucket}/{u.key}"


def output_uri(output_prefix: str, ext: str) -> str:
    prefix = output_prefix if output_prefix.endswith("/") else output_prefix + "/"
    return prefix + f"encode.{ext}"


def build_job_settings(
    *, source_uri: str, mix_uri: str | None, output_prefix: str, has_video: bool
) -> tuple[dict[str, Any], str]:
    ext = "mp4" if has_video else "mp3"
    audio_selector: dict[str, Any] = {"DefaultSelection": "DEFAULT"}
    if mix_uri:
        audio_selector = {"ExternalAudioFileInput": _s3(mix_uri)}
    destination = _s3(output_uri(output_prefix, ext))[: -len(f".{ext}")]
    output: dict[str, Any] = {
        "AudioDescriptions": [
            {
                "AudioSourceName": "Audio Selector 1",
                "CodecSettings": {
                    "Codec": "AAC",
                    "AacSettings": {
                        "Bitrate": AUDIO_BITRATE,
                        "CodingMode": "CODING_MODE_2_0",
                        "SampleRate": 48000,
                    },
                }
                if has_video
                else {
                    "Codec": "MP3",
                    "Mp3Settings": {
                        "Bitrate": AUDIO_BITRATE,
                        "Channels": 2,
                        "RateControlMode": "CBR",
                        "SampleRate": 48000,
                    },
                },
            }
        ],
        "ContainerSettings": {"Container": "MP4" if has_video else "RAW"},
    }
    if has_video:
        output["ContainerSettings"]["Mp4Settings"] = {"MoovPlacement": "PROGRESSIVE_DOWNLOAD"}
        output["VideoDescription"] = {
            "CodecSettings": {
                "Codec": "H_264",
                "H264Settings": {
                    "RateControlMode": "QVBR",
                    "QvbrSettings": {"QvbrQualityLevel": 8},
                    "MaxBitrate": VIDEO_MAX_BITRATE,
                    "SceneChangeDetect": "TRANSITION_DETECTION",
                },
            }
        }
    settings: dict[str, Any] = {
        "Inputs": [
            {
                "FileInput": _s3(source_uri),
                "AudioSelectors": {"Audio Selector 1": audio_selector},
                "TimecodeSource": "ZEROBASED",
            }
        ],
        "OutputGroups": [
            {
                "Name": "File Group",
                "OutputGroupSettings": {
                    "Type": "FILE_GROUP_SETTINGS",
                    "FileGroupSettings": {"Destination": destination},
                },
                "Outputs": [output],
            }
        ],
    }
    return settings, ext


class MediaConvertProvider:
    def __init__(self, clients: ClientFactory, *, role_arn: str, queue_arn: str) -> None:
        self._clients = clients
        self._role = role_arn
        self._queue = queue_arn
        self._ext: dict[str, tuple[str, str]] = {}

    def capabilities(self) -> list[CapabilityRecord]:
        return [
            CapabilityRecord(
                adapterId=ADAPTER_ID,
                kind="encode",
                locale=None,
                region=self._clients.region,
                tier="beta",
                version=ADAPTER_VERSION,
                dataPolicy="no-training",
                priceUnit="second",
            )
        ]

    def encode(
        self, input_s3_uri: str, preset: dict[str, object], ctx: ProviderContext
    ) -> AsyncHandle:
        output_prefix = preset.get("outputPrefix")
        if not isinstance(output_prefix, str):
            raise ValueError("mediaconvert preset needs 'outputPrefix'")
        mix = preset.get("mix")
        settings, ext = build_job_settings(
            source_uri=input_s3_uri,
            mix_uri=mix if isinstance(mix, str) else None,
            output_prefix=output_prefix,
            has_video=bool(preset.get("hasVideo")),
        )
        try:
            resp = self._clients.client("mediaconvert").create_job(
                Role=self._role,
                Queue=self._queue,
                ClientRequestToken=ctx.idempotencyKey[:64],
                Settings=settings,
                Tags={"polycast:jobId": ctx.jobId, "polycast:correlationId": ctx.correlationId},
            )
        except Exception as e:
            raise provider_error("mediaconvert", e) from e
        job_id = str(resp.get("Job", {}).get("Id", ""))
        if not job_id:
            raise ProviderError(
                "PROVIDER_BAD_OUTPUT", "MediaConvert returned no job id.", retryable=True
            )
        self._ext[job_id] = (output_uri(output_prefix, ext), ext)
        return AsyncHandle(adapterId=ADAPTER_ID, externalId=job_id)

    def poll(self, handle: AsyncHandle, ctx: ProviderContext) -> dict[str, object] | None:
        try:
            resp = self._clients.client("mediaconvert").get_job(Id=handle.externalId)
        except Exception as e:
            raise provider_error("mediaconvert", e) from e
        status = str(resp.get("Job", {}).get("Status", ""))
        if status in ("SUBMITTED", "PROGRESSING"):
            return None
        if status != "COMPLETE":
            raise ProviderError("ENCODE_FAILED", "MediaConvert could not encode the media.")
        uri, ext = self._ext.get(handle.externalId, ("", ""))
        if not uri and ctx.derivedPrefix:
            ext = "mp4"
            uri = output_uri(ctx.derivedPrefix, ext)
        return {"status": "COMPLETED", "encode": uri, "container": ext}
