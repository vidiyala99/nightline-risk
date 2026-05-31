"""File-storage abstraction.

All uploaded bytes (incident/compliance evidence) flow through one `Storage`
interface so the backing store is a one-class swap. Today only `LocalStorage`
exists (writes under the evidence dir); an `S3Storage` can be added later
without touching the call sites.

The stored *ref* returned by `save()` is whatever the backend persists in the
DB's `file_path` column. `LocalStorage` returns the absolute path string —
identical to what the code stored before this abstraction — so existing rows
keep working with no migration.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional, Protocol, runtime_checkable

# Single source of truth for the local upload dir (same path the app used
# before: backend/evidence_uploads). app/storage.py → parent=app, parent.parent=backend.
EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence_uploads"


@runtime_checkable
class Storage(Protocol):
    def save(self, key: str, data: bytes) -> str:
        """Persist `data` under `key`; return the ref to store in the DB."""
        ...

    def read(self, ref: str) -> bytes:
        """Return the bytes for a previously-saved ref."""
        ...

    def local_path(self, ref: str) -> Optional[Path]:
        """A local filesystem path for `ref` if one exists (lets the serve
        endpoint use FileResponse). Remote backends return None → stream via read()."""
        ...

    def exists(self, ref: str) -> bool:
        ...

    def delete(self, ref: str) -> None:
        ...


class LocalStorage:
    """Filesystem-backed storage rooted at `base_dir`."""

    def __init__(self, base_dir: Path = EVIDENCE_DIR):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def save(self, key: str, data: bytes) -> str:
        dest = self.base_dir / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return str(dest)

    def read(self, ref: str) -> bytes:
        return Path(ref).read_bytes()

    def local_path(self, ref: str) -> Optional[Path]:
        p = Path(ref)
        return p if p.exists() else None

    def exists(self, ref: str) -> bool:
        return Path(ref).exists()

    def delete(self, ref: str) -> None:
        Path(ref).unlink(missing_ok=True)


class S3Storage:
    """S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, …).

    The stored ref *is* the object key, so `save` returns the key it was given
    and `read`/`exists`/`delete` round-trip on it. `local_path` returns None,
    which routes the serve endpoint through `read()` → `StreamingResponse`.

    `client` is injectable so tests can drive a stubbed boto3 client with no
    network. In production it's built from the S3_* env vars.
    """

    def __init__(
        self,
        *,
        bucket: str,
        endpoint_url: str,
        access_key_id: str,
        secret_access_key: str,
        region: str = "auto",
        client: Any | None = None,
    ):
        self.bucket = bucket
        self._client: Any
        if client is not None:
            self._client = client
        else:
            import boto3  # local import: only required when S3 is actually selected
            from botocore.config import Config

            self._client = boto3.client(
                "s3",
                endpoint_url=endpoint_url,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                region_name=region,
                config=Config(signature_version="s3v4"),
            )

    def save(self, key: str, data: bytes) -> str:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data)
        return key

    def read(self, ref: str) -> bytes:
        obj = self._client.get_object(Bucket=self.bucket, Key=ref)
        return obj["Body"].read()

    def local_path(self, ref: str) -> Optional[Path]:
        return None  # remote backend → serve endpoint streams via read()

    def exists(self, ref: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self.bucket, Key=ref)
            return True
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def delete(self, ref: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=ref)


_storage: Optional[Storage] = None


def _require_env(name: str) -> str:
    """Read a required env var or fail fast with a clear message.

    Mirrors `config.validate_startup_env` discipline: selecting STORAGE_BACKEND=s3
    without credentials must crash loudly, never silently fall back to local.
    """
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"STORAGE_BACKEND=s3 requires {name} to be set "
            "(see backend/.env.example for the full S3_* set)."
        )
    return value


def get_storage() -> Storage:
    """Process-wide storage singleton, chosen by STORAGE_BACKEND (default local)."""
    global _storage
    if _storage is None:
        backend = os.getenv("STORAGE_BACKEND", "local").lower()
        if backend == "local":
            _storage = LocalStorage()
        elif backend == "s3":
            _storage = S3Storage(
                bucket=_require_env("S3_BUCKET"),
                endpoint_url=_require_env("S3_ENDPOINT_URL"),
                access_key_id=_require_env("S3_ACCESS_KEY_ID"),
                secret_access_key=_require_env("S3_SECRET_ACCESS_KEY"),
                region=os.getenv("S3_REGION", "auto"),
            )
        else:
            raise NotImplementedError(
                f"STORAGE_BACKEND={backend!r} is not supported. "
                "Use 'local' (default) or 's3'."
            )
    return _storage
