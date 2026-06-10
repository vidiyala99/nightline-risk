"""Security (P0): a client-controlled evidence filename must not escape the
storage root (path traversal) nor inject into the `Content-Disposition` header
on serve (CRLF / quote injection).

The route used to build the storage key as f"{evidence_id}_{file.filename}"
with the raw filename — the `evidence_id` prefix only neutralizes the *first*
`../` segment, so `../../../etc/passwd` still climbed out of evidence_uploads.
"""
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import EvidenceFile, IncidentRecord
from app.storage import LocalStorage


def _h():
    return {"Authorization": f"Bearer {create_token('u-trav', 'b@e.com', 'broker', None)}"}


@pytest.fixture
def client_engine(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    engine = create_engine(f"sqlite:///{db}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    # Isolate all uploads to tmp so a traversal write can't touch the real repo.
    store_root = tmp_path / "evidence_uploads"
    monkeypatch.setattr("app.storage._storage", LocalStorage(store_root))
    with Session(engine) as s:
        s.add(IncidentRecord(
            id="inc-trav", venue_id="v1", occurred_at="2026-01-01T00:00:00Z",
            location="rear bar", summary="altercation", reported_by="shift-lead",
            injury_observed=True, police_called=True, ems_called=False,
        ))
        s.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, engine, store_root
    app.dependency_overrides.clear()


def test_traversal_filename_is_reduced_to_a_safe_basename(client_engine):
    client, engine, store_root = client_engine
    r = client.post(
        "/api/incidents/inc-trav/evidence",
        files={"file": ("../../../../etc/passwd", io.BytesIO(b"x"), "application/octet-stream")},
        headers=_h(),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # Stored display filename is the basename only — no directory components.
    assert body["filename"] == "passwd"

    with Session(engine) as s:
        row = s.get(EvidenceFile, body["id"])
        assert row is not None
        # The persisted storage ref stays inside the evidence root.
        assert ".." not in row.file_path
        assert Path(row.file_path).resolve().is_relative_to(store_root.resolve())
        assert row.filename == "passwd"


def test_backslash_separators_are_stripped(client_engine):
    client, _engine, _ = client_engine
    r = client.post(
        "/api/incidents/inc-trav/evidence",
        files={"file": ("..\\..\\windows\\system32\\cfg", io.BytesIO(b"x"), "application/octet-stream")},
        headers=_h(),
    )
    assert r.status_code == 201, r.text
    assert r.json()["filename"] == "cfg"


def test_header_injection_filename_is_neutralized_on_serve(client_engine):
    client, _engine, _ = client_engine
    # Quote + CRLF + a forged header would break out of Content-Disposition.
    evil = 'evil".png\r\nSet-Cookie: pwned=1'
    r = client.post(
        "/api/incidents/inc-trav/evidence",
        files={"file": (evil, io.BytesIO(b"x"), "application/octet-stream")},
        headers=_h(),
    )
    assert r.status_code == 201, r.text
    stored = r.json()["filename"]
    assert '"' not in stored and "\r" not in stored and "\n" not in stored

    got = client.get(f"/api/evidence/{r.json()['id']}/file", headers=_h())
    assert got.status_code == 200, got.text
    cd = got.headers.get("content-disposition", "")
    # The security property is no raw CRLF breaking out of the header value
    # (a forged `Set-Cookie` would need a real newline) — not the literal substring.
    assert "\r" not in cd and "\n" not in cd
