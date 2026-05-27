"""Tests for the file-storage abstraction (app/storage.py)."""
import pytest

from app.storage import LocalStorage, Storage, get_storage


def test_local_storage_round_trips_bytes(tmp_path):
    s = LocalStorage(tmp_path)
    ref = s.save("ev-123_photo.jpg", b"hello bytes")
    assert s.read(ref) == b"hello bytes"


def test_local_storage_ref_is_a_real_path(tmp_path):
    s = LocalStorage(tmp_path)
    ref = s.save("a/b/nested.bin", b"x")  # nested key creates parent dirs
    lp = s.local_path(ref)
    assert lp is not None and lp.exists()
    assert lp.read_bytes() == b"x"


def test_local_storage_exists_and_delete(tmp_path):
    s = LocalStorage(tmp_path)
    ref = s.save("gone.txt", b"bye")
    assert s.exists(ref) is True
    s.delete(ref)
    assert s.exists(ref) is False
    assert s.local_path(ref) is None  # missing → no local path


def test_local_storage_satisfies_protocol(tmp_path):
    assert isinstance(LocalStorage(tmp_path), Storage)


def test_get_storage_defaults_to_local(monkeypatch):
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    import app.storage as storage_mod
    storage_mod._storage = None  # reset singleton
    assert isinstance(get_storage(), LocalStorage)


def test_get_storage_rejects_unimplemented_backend(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    import app.storage as storage_mod
    storage_mod._storage = None
    with pytest.raises(NotImplementedError, match="s3"):
        get_storage()
    storage_mod._storage = None  # don't leak state to other tests
