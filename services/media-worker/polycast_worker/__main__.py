"""`python -m polycast_worker --api-url URL [--once] [--poll-interval S] [--worker-id ID]`."""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
from collections.abc import Sequence

from .client import ApiClient
from .config import WorkerConfig
from .logsafe import configure_logging
from .providers.registry import build_providers
from .runner import run_loop
from .storage import LocalFsStorage, S3Storage, Storage
from .tools import Tools

log = logging.getLogger("polycast_worker")


def build_storage(cfg: WorkerConfig) -> Storage:
    if cfg.storage_driver == "s3":
        return S3Storage(
            endpoint_url=cfg.s3_endpoint,
            region=cfg.region,
            access_key_id=cfg.s3_access_key_id,
            secret_access_key=cfg.s3_secret_access_key,
        )
    return LocalFsStorage(cfg.local_storage_dir)


def parse_args(argv: Sequence[str] | None, default_api_url: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="polycast_worker", description="Polycast media worker")
    parser.add_argument("--api-url", default=default_api_url, help="API base url")
    parser.add_argument(
        "--once", action="store_true", help="process queued tasks until the queue is empty, exit 0"
    )
    parser.add_argument("--poll-interval", type=float, default=2.0, help="seconds between polls")
    parser.add_argument("--worker-id", default=None, help="stable worker id (default host-pid)")
    parser.add_argument("--verbose", action="store_true", help="debug logging")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    cfg = WorkerConfig.from_env()
    args = parse_args(argv, cfg.api_url)
    configure_logging(logging.DEBUG if args.verbose else logging.INFO)
    worker_id = args.worker_id or f"{socket.gethostname()}-{os.getpid()}"
    tools = Tools.detect()
    storage = build_storage(cfg)
    providers = build_providers(cfg, storage=storage, tools=tools)
    log.info(
        "worker %s starting: env=%s storage=%s providers=%s ffmpeg=%s ffprobe=%s",
        worker_id,
        cfg.env,
        cfg.storage_driver,
        providers.mode,
        tools.has_ffmpeg,
        tools.has_ffprobe,
    )
    client = ApiClient(args.api_url, cfg.worker_token, worker_id)
    try:
        return run_loop(
            client,
            storage,
            tools,
            once=args.once,
            poll_interval_s=max(0.1, args.poll_interval),
            providers=providers,
        )
    except KeyboardInterrupt:
        log.info("worker %s stopping", worker_id)
        return 130


if __name__ == "__main__":
    sys.exit(main())
