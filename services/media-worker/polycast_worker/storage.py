"""Object storage behind one small Protocol.

URIs are `local://bucket/key` (filesystem driver, shared with the API's local driver) or
`s3://bucket/key` (MinIO in docker compose, S3 in AWS). The worker only ever sees URIs;
it never mints signed URLs and never logs keys.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

URI_RE = re.compile(r"^(s3|local)://([a-z0-9.-]+)/(.+)$")
_CHUNK = 1 << 20


class StorageError(RuntimeError):
    """I/O failure against the storage backend (treated as retryable by the runner)."""


class StorageUriError(ValueError):
    """Malformed or unsafe storage URI (terminal)."""


@dataclass(frozen=True)
class StorageUri:
    scheme: str
    bucket: str
    key: str

    def __str__(self) -> str:
        return f"{self.scheme}://{self.bucket}/{self.key}"


def parse_uri(uri: str) -> StorageUri:
    m = URI_RE.match(uri)
    if not m:
        raise StorageUriError("storage uri must match (s3|local)://bucket/key")
    scheme, bucket, key = m.groups()
    parts = key.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise StorageUriError("storage key must not contain empty, '.' or '..' segments")
    return StorageUri(scheme=scheme, bucket=bucket, key=key)


def join_uri(prefix: str, name: str) -> str:
    """Append a file name to a prefix URI. Prefixes end with '/' per the contract."""
    parse_uri(prefix.rstrip("/"))
    if "/" in name or name in ("", ".", ".."):
        raise StorageUriError("file name must be a single path segment")
    return prefix + name if prefix.endswith("/") else f"{prefix}/{name}"


def uri_basename(uri: str) -> str:
    return parse_uri(uri).key.rsplit("/", 1)[-1]


def sha256_of_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


@runtime_checkable
class Storage(Protocol):
    def get(self, uri: str) -> bytes: ...
    def download(self, uri: str, path: Path) -> None: ...
    def put(self, uri: str, data: bytes | Path, content_type: str) -> None: ...
    def exists(self, uri: str) -> bool: ...
    def sha256(self, uri: str) -> str: ...
    def size(self, uri: str) -> int: ...


class LocalFsStorage:
    """`local://bucket/key` → `{root}/bucket/key`. Writes are atomic (temp file + rename)."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def path_for(self, uri: str) -> Path:
        u = parse_uri(uri)
        if u.scheme != "local":
            raise StorageUriError("local storage driver cannot serve non-local uris")
        p = (self.root / u.bucket / u.key).resolve()
        if self.root not in p.parents:
            raise StorageUriError("storage key escapes the storage root")
        return p

    def get(self, uri: str) -> bytes:
        try:
            return self.path_for(uri).read_bytes()
        except OSError as e:
            raise StorageError("failed to read object") from e

    def download(self, uri: str, path: Path) -> None:
        src = self.path_for(uri)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with src.open("rb") as fin, path.open("wb") as fout:
                for chunk in iter(lambda: fin.read(_CHUNK), b""):
                    fout.write(chunk)
        except OSError as e:
            raise StorageError("failed to download object") from e

    def put(self, uri: str, data: bytes | Path, content_type: str) -> None:
        dst = self.path_for(uri)
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(prefix=".upload-", dir=dst.parent)
            tmp = Path(tmp_name)
            try:
                with os.fdopen(fd, "wb") as fout:
                    if isinstance(data, Path):
                        with data.open("rb") as fin:
                            for chunk in iter(lambda: fin.read(_CHUNK), b""):
                                fout.write(chunk)
                    else:
                        fout.write(data)
                    fout.flush()
                    os.fsync(fout.fileno())
                os.replace(tmp, dst)
            finally:
                if tmp.exists():
                    tmp.unlink()
        except OSError as e:
            raise StorageError("failed to write object") from e

    def exists(self, uri: str) -> bool:
        return self.path_for(uri).is_file()

    def sha256(self, uri: str) -> str:
        try:
            return sha256_of_path(self.path_for(uri))
        except OSError as e:
            raise StorageError("failed to hash object") from e

    def size(self, uri: str) -> int:
        try:
            return self.path_for(uri).stat().st_size
        except OSError as e:
            raise StorageError("failed to stat object") from e


class S3Storage:
    """`s3://bucket/key` via boto3. Works against MinIO with `endpoint_url`."""

    def __init__(
        self,
        *,
        endpoint_url: str | None = None,
        region: str = "us-east-1",
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        if client is None:
            import boto3

            client = boto3.client(
                "s3",
                endpoint_url=endpoint_url,
                region_name=region,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
            )
        self._client: Any = client

    @staticmethod
    def _split(uri: str) -> tuple[str, str]:
        u = parse_uri(uri)
        if u.scheme != "s3":
            raise StorageUriError("s3 storage driver cannot serve non-s3 uris")
        return u.bucket, u.key

    @staticmethod
    def _is_missing(exc: Exception) -> bool:
        response = getattr(exc, "response", None)
        if not isinstance(response, dict):
            return False
        error = response.get("Error")
        code = error.get("Code") if isinstance(error, dict) else None
        return code in ("404", "NoSuchKey", "NotFound")

    def get(self, uri: str) -> bytes:
        bucket, key = self._split(uri)
        try:
            body = self._client.get_object(Bucket=bucket, Key=key)["Body"]
            data: bytes = body.read()
            return data
        except Exception as e:  # botocore exceptions are not importable without stubs
            raise StorageError("failed to read object") from e

    def download(self, uri: str, path: Path) -> None:
        bucket, key = self._split(uri)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._client.download_file(bucket, key, str(path))
        except Exception as e:
            raise StorageError("failed to download object") from e

    def put(self, uri: str, data: bytes | Path, content_type: str) -> None:
        bucket, key = self._split(uri)
        try:
            if isinstance(data, Path):
                self._client.upload_file(
                    str(data), bucket, key, ExtraArgs={"ContentType": content_type}
                )
            else:
                self._client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
        except Exception as e:
            raise StorageError("failed to write object") from e

    def exists(self, uri: str) -> bool:
        bucket, key = self._split(uri)
        try:
            self._client.head_object(Bucket=bucket, Key=key)
            return True
        except Exception as e:
            if self._is_missing(e):
                return False
            raise StorageError("failed to stat object") from e

    def sha256(self, uri: str) -> str:
        bucket, key = self._split(uri)
        h = hashlib.sha256()
        try:
            body = self._client.get_object(Bucket=bucket, Key=key)["Body"]
            for chunk in iter(lambda: body.read(_CHUNK), b""):
                h.update(chunk)
        except Exception as e:
            raise StorageError("failed to hash object") from e
        return h.hexdigest()

    def size(self, uri: str) -> int:
        bucket, key = self._split(uri)
        try:
            length: int = int(self._client.head_object(Bucket=bucket, Key=key)["ContentLength"])
            return length
        except Exception as e:
            raise StorageError("failed to stat object") from e
