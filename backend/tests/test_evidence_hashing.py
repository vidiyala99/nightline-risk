"""Evidence authentication: content_hash + captured_at stamped at upload."""
import hashlib
import io

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.database import get_session
from app.main import app
from app.models import EvidenceFile, IncidentRecord


@pytest.fixture
def client_engine(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    engine = create_engine(f"sqlite:///{db}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    monkeypatch.setattr("app.main.EVIDENCE_DIR", tmp_path)
    with Session(engine) as s:
        s.add(IncidentRecord(
            id="inc-hash-test", venue_id="v1", occurred_at="2026-01-01T00:00:00Z",
            location="rear bar", summary="altercation", reported_by="shift-lead",
            injury_observed=True, police_called=True, ems_called=False,
        ))
        s.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, engine
    app.dependency_overrides.clear()


def test_upload_hashes_content_and_falls_back_capture_time(client_engine):
    client, engine = client_engine
    payload = b"incident photo bytes"
    # Non-image content-type so the vision background task isn't triggered.
    r = client.post(
        "/api/incidents/inc-hash-test/evidence",
        files={"file": ("photo.bin", io.BytesIO(payload), "application/octet-stream")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["content_hash"] == hashlib.sha256(payload).hexdigest()
    assert body["captured_at"]  # falls back to upload time when not supplied

    with Session(engine) as s:
        row = s.get(EvidenceFile, body["id"])
        assert row.content_hash == hashlib.sha256(payload).hexdigest()
        assert row.captured_at is not None


def test_upload_uses_supplied_capture_time(client_engine):
    client, _ = client_engine
    r = client.post(
        "/api/incidents/inc-hash-test/evidence?captured_at=2026-05-01T23:14:00Z",
        files={"file": ("p.bin", io.BytesIO(b"x"), "application/octet-stream")},
    )
    assert r.status_code == 201, r.text
    assert r.json()["captured_at"] == "2026-05-01T23:14:00Z"
