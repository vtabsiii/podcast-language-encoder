"""Worker configuration. Production fails closed on missing providers, tokens or storage."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_WORKER_TOKEN = "dev-worker-token"  # noqa: S105 - documented dev-only default
DEFAULT_LOCAL_STORAGE_DIR = ".polycast-data/storage"
DEFAULT_API_URL = "http://127.0.0.1:4000"


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
        )
        if cfg.storage_driver not in ("local", "s3"):
            raise RuntimeError("STORAGE_DRIVER must be 'local' or 's3'")
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
