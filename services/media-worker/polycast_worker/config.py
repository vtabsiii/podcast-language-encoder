"""Worker configuration. Production fails closed on missing providers, tokens or storage.

Email notifications are the one optional production integration: without ``SES_FROM_ADDRESS``
the registry falls back to the in-app notifier, so notifications land in the derived bucket's
``notifications.json`` and no email is sent until a verified sender is configured.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_WORKER_TOKEN = "dev-worker-token"  # noqa: S105 - documented dev-only default
DEFAULT_LOCAL_STORAGE_DIR = ".polycast-data/storage"
DEFAULT_API_URL = "http://127.0.0.1:4000"
DEFAULT_BEDROCK_MODEL_ID = "anthropic.claude-3-5-haiku-20241022-v1:0"
DEFAULT_DERIVED_BUCKET = "derived"

PROVIDER_MODES = ("local", "aws")
TRANSLATION_PROVIDERS = ("translate", "bedrock")
POLLY_ENGINES = ("neural", "long-form", "generative")
ENCODE_PROVIDERS = ("ffmpeg", "mediaconvert")


@dataclass(frozen=True)
class WorkerConfig:
    env: str
    provider_mode: str
    region: str
    queue_url: str | None
    source_bucket: str | None
    api_url: str
    worker_token: str
    storage_driver: str
    local_storage_dir: Path
    s3_endpoint: str | None
    s3_access_key_id: str | None
    s3_secret_access_key: str | None
    # M3 provider selection (only read when provider_mode == "aws")
    translation_provider: str = "translate"
    bedrock_model_id: str = DEFAULT_BEDROCK_MODEL_ID
    polly_engine: str = "neural"
    encode_provider: str = "ffmpeg"
    mediaconvert_role_arn: str | None = None
    mediaconvert_queue_arn: str | None = None
    # Optional in every environment: unset means email notifications are off (in-app only).
    ses_from_address: str | None = None
    transcribe_data_access_role_arn: str | None = None
    derived_bucket: str = DEFAULT_DERIVED_BUCKET
    translate_terminology_name: str | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> WorkerConfig:
        e = env if env is not None else dict(os.environ)
        env_name = e.get("POLYCAST_ENV", "development")
        token = e.get("WORKER_TOKEN") or (DEFAULT_WORKER_TOKEN if env_name != "production" else "")
        cfg = cls(
            env=env_name,
            provider_mode=e.get("PROVIDER_MODE", "local"),
            region=e.get("AWS_REGION", "us-east-1"),
            queue_url=e.get("WORKER_QUEUE_URL"),
            source_bucket=e.get("MEDIA_BUCKET_SOURCE"),
            api_url=e.get("API_BASE_URL", DEFAULT_API_URL),
            worker_token=token,
            storage_driver=e.get("STORAGE_DRIVER", "local"),
            local_storage_dir=Path(e.get("LOCAL_STORAGE_DIR", DEFAULT_LOCAL_STORAGE_DIR)),
            s3_endpoint=e.get("S3_ENDPOINT") or None,
            s3_access_key_id=e.get("S3_ACCESS_KEY_ID") or None,
            s3_secret_access_key=e.get("S3_SECRET_ACCESS_KEY") or None,
            translation_provider=e.get("TRANSLATION_PROVIDER", "translate"),
            bedrock_model_id=e.get("BEDROCK_MODEL_ID") or DEFAULT_BEDROCK_MODEL_ID,
            polly_engine=e.get("POLLY_ENGINE", "neural"),
            encode_provider=e.get("ENCODE_PROVIDER", "ffmpeg"),
            mediaconvert_role_arn=e.get("MEDIACONVERT_ROLE_ARN") or None,
            mediaconvert_queue_arn=e.get("MEDIACONVERT_QUEUE_ARN") or None,
            ses_from_address=e.get("SES_FROM_ADDRESS") or None,
            transcribe_data_access_role_arn=e.get("TRANSCRIBE_DATA_ACCESS_ROLE_ARN") or None,
            derived_bucket=e.get("MEDIA_BUCKET_DERIVED") or DEFAULT_DERIVED_BUCKET,
            translate_terminology_name=e.get("TRANSLATE_TERMINOLOGY_NAME") or None,
        )
        if cfg.storage_driver not in ("local", "s3"):
            raise RuntimeError("STORAGE_DRIVER must be 'local' or 's3'")
        if cfg.provider_mode not in PROVIDER_MODES:
            raise RuntimeError("PROVIDER_MODE must be 'local' or 'aws'")
        if cfg.translation_provider not in TRANSLATION_PROVIDERS:
            raise RuntimeError("TRANSLATION_PROVIDER must be 'translate' or 'bedrock'")
        if cfg.polly_engine not in POLLY_ENGINES:
            raise RuntimeError("POLLY_ENGINE must be 'neural', 'long-form' or 'generative'")
        if cfg.encode_provider not in ENCODE_PROVIDERS:
            raise RuntimeError("ENCODE_PROVIDER must be 'ffmpeg' or 'mediaconvert'")
        if cfg.encode_provider == "mediaconvert":
            missing_mc = [
                k
                for k, v in (
                    ("MEDIACONVERT_ROLE_ARN", cfg.mediaconvert_role_arn),
                    ("MEDIACONVERT_QUEUE_ARN", cfg.mediaconvert_queue_arn),
                )
                if not v
            ]
            if missing_mc:
                raise RuntimeError("ENCODE_PROVIDER=mediaconvert requires " + ", ".join(missing_mc))
        if cfg.env == "production":
            missing = [
                k
                for k, v in (
                    ("WORKER_QUEUE_URL", cfg.queue_url),
                    ("MEDIA_BUCKET_SOURCE", cfg.source_bucket),
                    ("WORKER_TOKEN", cfg.worker_token),
                )
                if not v
            ]
            if cfg.worker_token == DEFAULT_WORKER_TOKEN:
                missing.append("WORKER_TOKEN (dev default is not allowed)")
            if cfg.provider_mode != "aws":
                missing.append("PROVIDER_MODE=aws")
            if cfg.storage_driver != "s3":
                missing.append("STORAGE_DRIVER=s3")
            if missing:
                raise RuntimeError(
                    "Refusing to start worker in production with local/mock config. Missing: "
                    + ", ".join(missing)
                )
        return cfg
