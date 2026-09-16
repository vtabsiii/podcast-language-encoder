"""Provider registry keyed by configuration.

    PROVIDER_MODE=local → Mock* adapters (tier "unavailable"), M1 behaviour unchanged
    PROVIDER_MODE=aws   → Amazon adapters (tier "beta"; never "production" — promotion is
                          only via docs/quality-benchmark.md); lip sync is the sync.so adapter
                          when LIP_SYNC_PROVIDER=synclabs, else the mock ("unavailable")

Stage handlers never instantiate adapters; they receive a ProviderSet through StageEnv.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from ..config import WorkerConfig
from ..storage import LocalFsStorage, S3Storage, Storage
from ..tools import Tools
from .aws.bedrock import BedrockTranslationProvider
from .aws.clients import ClientFactory
from .aws.mediaconvert import MediaConvertProvider
from .aws.polly import PollyProvider
from .aws.ses import SesNotifier
from .aws.transcribe import TranscribeProvider
from .aws.translate import TranslateProvider
from .base import (
    CapabilityRecord,
    LipSyncProvider,
    MediaEncodeProvider,
    Mixer,
    Notifier,
    QualityProvider,
    SpeechProvider,
    TimingFitter,
    TranscriptionProvider,
    TranslationProvider,
)
from .ffmpeg import AtempoTimingFitter, DubMixer, FfmpegEncodeProvider, PassthroughMixer
from .inapp import NOTIFICATIONS_FILE, InAppNotifier
from .mock import (
    MockLipSyncProvider,
    MockQualityProvider,
    MockSpeechProvider,
    MockTranscriptionProvider,
    MockTranslationProvider,
)
from .quality import InHouseQualityProvider
from .synclabs import SyncLabsLipSyncProvider

ProviderMode = Literal["local", "aws"]


class _HasCapabilities(Protocol):
    def capabilities(self) -> list[CapabilityRecord]: ...


@dataclass(frozen=True)
class ProviderSet:
    mode: ProviderMode
    region: str
    transcription: TranscriptionProvider
    translation: TranslationProvider
    speech: SpeechProvider
    lip_sync: LipSyncProvider
    encode: MediaEncodeProvider
    quality: QualityProvider
    notifier: Notifier
    timing: TimingFitter
    mixer: Mixer

    @property
    def is_mock(self) -> bool:
        return self.mode == "local"

    def capabilities(
        self, *, locale: str | None = None, lip_sync: bool = False
    ) -> list[CapabilityRecord]:
        """Records for the provenance manifest, narrowed to one locale when given."""
        providers: list[_HasCapabilities] = [self.transcription, self.translation, self.speech]
        if lip_sync:
            providers.append(self.lip_sync)
        providers += [self.encode, self.quality]
        out: list[CapabilityRecord] = []
        for p in providers:
            for rec in p.capabilities():
                if locale is None or rec.locale is None or rec.locale == locale:
                    out.append(rec)
        return out


def default_storage(cfg: WorkerConfig, clients: ClientFactory | None = None) -> Storage:
    if cfg.storage_driver == "s3":
        if clients is not None:
            return S3Storage(client=clients.client("s3"))
        return S3Storage(
            endpoint_url=cfg.s3_endpoint,
            region=cfg.region,
            access_key_id=cfg.s3_access_key_id,
            secret_access_key=cfg.s3_secret_access_key,
        )
    return LocalFsStorage(cfg.local_storage_dir)


def build_providers(
    cfg: WorkerConfig,
    clients: ClientFactory | None = None,
    *,
    storage: Storage | None = None,
    tools: Tools | None = None,
) -> ProviderSet:
    tools = tools if tools is not None else Tools.detect()
    if cfg.provider_mode == "local":
        storage = storage if storage is not None else default_storage(cfg)
        return ProviderSet(
            mode="local",
            region="local",
            transcription=MockTranscriptionProvider(),
            translation=MockTranslationProvider(),
            speech=MockSpeechProvider(),
            lip_sync=MockLipSyncProvider(),
            encode=FfmpegEncodeProvider(storage, tools, region="local", tier="unavailable"),
            quality=MockQualityProvider(),
            notifier=InAppNotifier(storage, f"local://{cfg.derived_bucket}/{NOTIFICATIONS_FILE}"),
            timing=AtempoTimingFitter(tools),
            mixer=PassthroughMixer(tools),
        )
    if cfg.provider_mode != "aws":
        raise RuntimeError("PROVIDER_MODE must be 'local' or 'aws'")
    clients = (
        clients if clients is not None else ClientFactory(cfg.region, endpoint_url=cfg.s3_endpoint)
    )
    storage = storage if storage is not None else default_storage(cfg, clients)

    translation: TranslationProvider
    if cfg.translation_provider == "bedrock":
        translation = BedrockTranslationProvider(clients, cfg.bedrock_model_id)
    else:
        translation = TranslateProvider(clients, terminology_name=cfg.translate_terminology_name)

    encode: MediaEncodeProvider
    if cfg.encode_provider == "mediaconvert":
        if not cfg.mediaconvert_role_arn or not cfg.mediaconvert_queue_arn:
            raise RuntimeError("ENCODE_PROVIDER=mediaconvert requires role and queue ARNs")
        encode = MediaConvertProvider(
            clients, role_arn=cfg.mediaconvert_role_arn, queue_arn=cfg.mediaconvert_queue_arn
        )
    else:
        encode = FfmpegEncodeProvider(storage, tools, region=cfg.region)

    notifier: Notifier
    if cfg.ses_from_address:
        notifier = SesNotifier(clients, from_address=cfg.ses_from_address)
    else:
        scheme = "s3" if cfg.storage_driver == "s3" else "local"
        notifier = InAppNotifier(storage, f"{scheme}://{cfg.derived_bucket}/{NOTIFICATIONS_FILE}")

    lip_sync: LipSyncProvider
    if cfg.lip_sync_provider == "synclabs":
        if not cfg.synclabs_api_key:
            raise RuntimeError("LIP_SYNC_PROVIDER=synclabs requires SYNCLABS_API_KEY")
        lip_sync = SyncLabsLipSyncProvider(
            cfg.synclabs_api_key,
            storage=storage,
            tools=tools,
            api_url=cfg.synclabs_api_url,
            model=cfg.synclabs_model,
            sync_mode=cfg.synclabs_sync_mode,
            url_ttl_s=cfg.provider_url_ttl_s,
        )
    else:
        lip_sync = MockLipSyncProvider()  # no vendor key configured; stays "unavailable"

    return ProviderSet(
        mode="aws",
        region=cfg.region,
        transcription=TranscribeProvider(
            clients, storage, data_access_role_arn=cfg.transcribe_data_access_role_arn
        ),
        translation=translation,
        speech=PollyProvider(clients, engine=cfg.polly_engine),
        lip_sync=lip_sync,
        encode=encode,
        quality=InHouseQualityProvider(region=cfg.region),
        notifier=notifier,
        timing=AtempoTimingFitter(tools),
        mixer=DubMixer(tools),
    )
