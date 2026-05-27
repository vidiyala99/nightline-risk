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
from typing import Optional, Protocol, runtime_checkable

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


# ── S3Storage goes here ──────────────────────────────────────────────────
# Implement the same Storage protocol against boto3 (save → put_object,
# read → get_object, local_path → None, etc.) and select it below when
# STORAGE_BACKEND=s3. Deferred until an object-store subscription exists.


_storage: Optional[Storage] = None


def get_storage() -> Storage:
    """Process-wide storage singleton, chosen by STORAGE_BACKEND (default local)."""
    global _storage
    if _storage is None:
        backend = os.getenv("STORAGE_BACKEND", "local").lower()
        if backend != "local":
            raise NotImplementedError(
                f"STORAGE_BACKEND={backend!r} is not implemented yet. "
                "Only 'local' is available; an S3 backend is a future swap."
            )
        _storage = LocalStorage()
    return _storage
