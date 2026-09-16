"""Worker configuration. Production fails closed on missing providers."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class WorkerConfig:
    env: str
    provider_mode: str
    region: str
    queue_url: str | None
    source_bucket: str | None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> WorkerConfig:
        e = env if env is not None else dict(os.environ)
        cfg = cls(
            env=e.get("POLYCAST_ENV", "development"),
            provider_mode=e.get("PROVIDER_MODE", "local"),
            region=e.get("AWS_REGION", "us-east-1"),
            queue_url=e.get("WORKER_QUEUE_URL"),
            source_bucket=e.get("MEDIA_BUCKET_SOURCE"),
        )
        if cfg.env == "production":
            missing = [
                k
                for k, v in (
                    ("WORKER_QUEUE_URL", cfg.queue_url),
                    ("MEDIA_BUCKET_SOURCE", cfg.source_bucket),
                )
                if not v
            ]
            if cfg.provider_mode != "aws":
                missing.append("PROVIDER_MODE=aws")
            if missing:
                raise RuntimeError(
                    "Refusing to start worker in production with local/mock config. Missing: "
                    + ", ".join(missing)
                )
        return cfg
