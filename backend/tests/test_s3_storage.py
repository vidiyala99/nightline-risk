"""S3Storage adapter tests — no network, via botocore's Stubber.

These pin the Storage-protocol contract for the remote backend so the call
sites (evidence/compliance upload + serve) behave identically whether the
process runs LocalStorage or S3Storage. R2 is just an S3 endpoint, so a
stubbed boto3 client exercises the exact code path used against Cloudflare.
"""
from __future__ import annotations

import io

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

import app.storage as storage_mod
from app.storage import S3Storage, Storage, get_storage


def _make_storage() -> tuple[S3Storage, Stubber]:
    client = boto3.client(
        "s3",
        region_name="auto",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        endpoint_url="https://acct.r2.cloudflarestorage.com",
    )
    stub = Stubber(client)
    store = S3Storage(
        bucket="nightline-evidence",
        endpoint_url="https://acct.r2.cloudflarestorage.com",
        access_key_id="test",
        secret_access_key="test",
        client=client,
    )
    return store, stub


def test_s3storage_satisfies_storage_protocol() -> None:
    store, _ = _make_storage()
    assert isinstance(store, Storage)


def test_save_puts_object_and_returns_key() -> None:
    store, stub = _make_storage()
    stub.add_response(
        "put_object",
        {},
        {"Bucket": "nightline-evidence", "Key": "ev1_photo.jpg", "Body": b"bytes"},
    )
    with stub:
        ref = store.save("ev1_photo.jpg", b"bytes")
    # The ref is the key itself, so read()/exists()/delete() round-trip on it.
    assert ref == "ev1_photo.jpg"


def test_read_streams_object_bytes() -> None:
    store, stub = _make_storage()
    payload = b"injury-report-pdf"
    body = StreamingBody(io.BytesIO(payload), content_length=len(payload))
    stub.add_response(
        "get_object",
        {"Body": body, "ContentLength": len(payload)},
        {"Bucket": "nightline-evidence", "Key": "ev1_photo.jpg"},
    )
    with stub:
        assert store.read("ev1_photo.jpg") == payload


def test_local_path_is_none_for_remote_backend() -> None:
    # Forces the serve endpoint down the StreamingResponse branch.
    store, _ = _make_storage()
    assert store.local_path("ev1_photo.jpg") is None


def test_exists_true_when_head_succeeds() -> None:
    store, stub = _make_storage()
    stub.add_response(
        "head_object", {}, {"Bucket": "nightline-evidence", "Key": "ev1_photo.jpg"}
    )
    with stub:
        assert store.exists("ev1_photo.jpg") is True


def test_exists_false_on_404() -> None:
    store, stub = _make_storage()
    stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
    with stub:
        assert store.exists("missing.jpg") is False


def test_exists_reraises_non_404_errors() -> None:
    store, stub = _make_storage()
    stub.add_client_error(
        "head_object", service_error_code="AccessDenied", http_status_code=403
    )
    with stub, pytest.raises(Exception):
        store.exists("forbidden.jpg")


def test_delete_calls_delete_object() -> None:
    store, stub = _make_storage()
    stub.add_response(
        "delete_object", {}, {"Bucket": "nightline-evidence", "Key": "ev1_photo.jpg"}
    )
    with stub:
        store.delete("ev1_photo.jpg")  # no raise == pass


def test_get_storage_s3_requires_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # Fail fast (matching validate_startup_env discipline) when STORAGE_BACKEND=s3
    # is set but the credentials are missing — never silently fall back to local.
    monkeypatch.setattr(storage_mod, "_storage", None)
    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    for var in ("S3_BUCKET", "S3_ENDPOINT_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(RuntimeError, match="S3_BUCKET"):
        get_storage()
    monkeypatch.setattr(storage_mod, "_storage", None)
