from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from polycast_worker.storage import (
    LocalFsStorage,
    S3Storage,
    Storage,
    StorageError,
    StorageUriError,
    join_uri,
    parse_uri,
    uri_basename,
)


def test_parse_uri_matches_contract_regex():
    u = parse_uri("s3://my-bucket.v1/org/asset.mp4")
    assert (u.scheme, u.bucket, u.key) == ("s3", "my-bucket.v1", "org/asset.mp4")
    assert str(u) == "s3://my-bucket.v1/org/asset.mp4"
    for bad in ("http://b/k", "s3://Bad_Bucket/k", "local://b", "local://b/", "local://b/../x"):
        with pytest.raises(StorageUriError):
            parse_uri(bad)


def test_join_uri_and_basename():
    assert join_uri("local://derived/org/t/", "mix.wav") == "local://derived/org/t/mix.wav"
    assert join_uri("local://derived/org/t", "mix.wav") == "local://derived/org/t/mix.wav"
    assert uri_basename("local://derived/org/t/encode.mp4") == "encode.mp4"
    with pytest.raises(StorageUriError):
        join_uri("local://derived/org/t/", "../escape")


def test_local_storage_roundtrip_is_atomic(tmp_path: Path):
    store: Storage = LocalFsStorage(tmp_path / "root")
    assert isinstance(store, Storage)
    uri = "local://derived/org/asset/waveform.json"
    assert not store.exists(uri)
    payload = b'{"peaks":[0.1]}'
    store.put(uri, payload, "application/json")
    assert store.exists(uri)
    assert store.get(uri) == payload
    assert store.size(uri) == len(payload)
    assert store.sha256(uri) == hashlib.sha256(payload).hexdigest()
    target = tmp_path / "out" / "copy.json"
    store.download(uri, target)
    assert target.read_bytes() == payload
    # from a Path
    src = tmp_path / "src.bin"
    src.write_bytes(b"abc")
    store.put("local://source/org/asset.bin", src, "application/octet-stream")
    assert store.get("local://source/org/asset.bin") == b"abc"
    # no temp files left behind, and the layout is {root}/{bucket}/{key}
    leftovers = [p for p in (tmp_path / "root").rglob(".upload-*")]
    assert leftovers == []
    assert (tmp_path / "root" / "derived" / "org" / "asset" / "waveform.json").is_file()


def test_local_storage_rejects_escape_and_foreign_schemes(tmp_path: Path):
    store = LocalFsStorage(tmp_path / "root")
    with pytest.raises(StorageUriError):
        store.get("s3://bucket/key")
    with pytest.raises(StorageUriError):
        store.get("local://bucket/a/../../etc/passwd")
    with pytest.raises(StorageError):
        store.get("local://bucket/missing")


class _FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803
        self.objects[(Bucket, Key)] = (Body, ContentType)

    def upload_file(self, filename: str, bucket: str, key: str, ExtraArgs: dict[str, Any]) -> None:  # noqa: N803
        self.objects[(bucket, key)] = (Path(filename).read_bytes(), ExtraArgs["ContentType"])

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        body, _ = self._get(Bucket, Key)
        return {"Body": _Body(body)}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        body, _ = self._get(Bucket, Key)
        return {"ContentLength": len(body)}

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        Path(filename).write_bytes(self._get(bucket, key)[0])

    def _get(self, bucket: str, key: str) -> tuple[bytes, str]:
        try:
            return self.objects[(bucket, key)]
        except KeyError:
            raise _ClientError({"Error": {"Code": "404"}}) from None


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = len(self._data) - self._pos
        out = self._data[self._pos : self._pos + n]
        self._pos += n
        return out


class _ClientError(Exception):
    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__("client error")
        self.response = response


def test_s3_storage_maps_operations_onto_the_client(tmp_path: Path):
    fake = _FakeS3()
    store = S3Storage(client=fake)
    uri = "s3://derived/org/t/mix.wav"
    assert store.exists(uri) is False
    store.put(uri, b"wav-bytes", "audio/wav")
    assert fake.objects[("derived", "org/t/mix.wav")] == (b"wav-bytes", "audio/wav")
    assert store.exists(uri) is True
    assert store.get(uri) == b"wav-bytes"
    assert store.size(uri) == 9
    assert store.sha256(uri) == hashlib.sha256(b"wav-bytes").hexdigest()
    local = tmp_path / "m.wav"
    store.download(uri, local)
    assert local.read_bytes() == b"wav-bytes"
    store.put("s3://derived/org/t/copy.wav", local, "audio/wav")
    assert store.get("s3://derived/org/t/copy.wav") == b"wav-bytes"
    with pytest.raises(StorageError):
        store.get("s3://derived/missing/key")
    with pytest.raises(StorageUriError):
        store.get("local://derived/x/y")
