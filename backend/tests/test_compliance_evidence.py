"""Tests for compliance evidence persistence — previously the file was discarded."""

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import ComplianceEvidence, Venue
from app.seed_data import VENUES


def _h():
    # compliance upload is venue-access gated; a broker token passes any venue.
    return {"Authorization": f"Bearer {create_token('u-cmp-ev', 'b@e.com', 'broker', None)}"}


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    # File-backed SQLite so the lifespan migration block (which connects to
    # engine directly, bypassing get_session) targets the same DB as our requests.
    db_path = tmp_path / "test_compliance.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)

    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)

    with Session(engine) as bootstrap:
        bootstrap.add(Venue(id="elsewhere-brooklyn", name=VENUES["elsewhere-brooklyn"]["name"]))
        bootstrap.commit()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app, headers=_h()) as client:
        yield client, engine
    app.dependency_overrides.clear()


def test_compliance_upload_persists_file_to_disk_and_db_row(client_and_engine):
    client, engine = client_and_engine

    payload = b"fake jpeg bytes representing a fixed-camera photo"
    response = client.post(
        "/api/venues/elsewhere-brooklyn/compliance/CAMERA_REPAIR_001/upload",
        files={"file": ("camera-fixed.jpg", io.BytesIO(payload), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "accepted"
    assert body["item_id"] == "CAMERA_REPAIR_001"
    assert body["file_size"] == len(payload)
    assert body["evidence_id"].startswith("ce-")

    with Session(engine) as session:
        rows = session.exec(
            select(ComplianceEvidence)
            .where(ComplianceEvidence.venue_id == "elsewhere-brooklyn")
            .where(ComplianceEvidence.compliance_item_id == "CAMERA_REPAIR_001")
        ).all()
        assert len(rows) == 1
        row = rows[0]
        assert row.filename == "camera-fixed.jpg"
        assert row.content_type == "image/jpeg"
        assert row.file_size == len(payload)
        assert Path(row.file_path).exists()
        assert Path(row.file_path).read_bytes() == payload


def test_compliance_evidence_listing_returns_persisted_files(client_and_engine):
    client, _ = client_and_engine

    for i in range(2):
        client.post(
            "/api/venues/elsewhere-brooklyn/compliance/CAMERA_REPAIR_002/upload",
            files={"file": (f"photo-{i}.jpg", io.BytesIO(b"data"), "image/jpeg")},
        )

    response = client.get("/api/venues/elsewhere-brooklyn/compliance/CAMERA_REPAIR_002/evidence")
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 2
    assert {r["filename"] for r in rows} == {"photo-0.jpg", "photo-1.jpg"}


def test_compliance_upload_rejects_oversized_file(client_and_engine):
    client, _ = client_and_engine

    big = b"x" * (21 * 1024 * 1024)  # 21MB > 20MB cap
    response = client.post(
        "/api/venues/elsewhere-brooklyn/compliance/CAMERA_REPAIR_003/upload",
        files={"file": ("huge.jpg", io.BytesIO(big), "image/jpeg")},
    )
    assert response.status_code == 413
    # Phase B: compliance route migrated to v1/compliance.py which uses the
    # ErrorEnvelope shape ({detail: {error, message, details?}}). The old
    # shape was a plain string `detail`; both versions of the assertion
    # remain meaningful so the test outlives the next envelope migration.
    body = response.json()
    detail = body["detail"]
    if isinstance(detail, dict):
        assert detail["error"] == "compliance_evidence_too_large"
        assert "too large" in detail["message"].lower()
    else:
        assert "too large" in detail.lower()
