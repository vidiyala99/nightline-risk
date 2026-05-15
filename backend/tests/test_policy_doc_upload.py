"""Tests for policy doc upload — broker-only, never operator-accessible."""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import SourceRecord, Venue
from app.seed_data import VENUES


SAMPLE_POLICY = """## Coverage Section

### 4.2 Premises Liability
The carrier shall cover bodily injury claims arising from slips, trips, and falls
on insured premises, provided wet floor signage and lighting standards are met.

### 4.3 Liquor Liability
Coverage applies to dram-shop claims when the licensee can demonstrate staff
completed responsible-service training within the calendar year.

## Exclusions

### 5.1 Excluded Activities
Pyrotechnic displays and open flames are excluded from coverage at all venues.
"""


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    db_path = tmp_path / "test_policy.db"
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
    with TestClient(app) as client:
        yield client, engine
    app.dependency_overrides.clear()


def _broker_token():
    return create_token("user-broker-1", "broker@example.com", "broker", "tenant-1")


def _operator_token():
    return create_token("user-op-1", "operator@example.com", "venue_operator", "elsewhere-brooklyn")


def _admin_token():
    return create_token("user-admin-1", "admin@example.com", "admin")


def test_anonymous_cannot_upload_policy_doc(client_and_engine):
    client, _ = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 401


def test_operator_cannot_upload_policy_doc(client_and_engine):
    client, _ = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_operator_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 403
    assert "broker" in response.json()["detail"].lower()


def test_broker_can_upload_policy_doc_and_chunks_are_persisted(client_and_engine):
    client, engine = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_broker_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["chunks_inserted"] >= 3  # 2 coverage clauses + 1 exclusion
    assert all(sid.startswith("ingested-") for sid in body["source_ids"])

    with Session(engine) as session:
        rows = session.exec(
            select(SourceRecord)
            .where(SourceRecord.venue_id == "elsewhere-brooklyn")
            .where(SourceRecord.origin_system == "policy_ingestion")
        ).all()
        assert len(rows) >= 3
        source_types = {r.source_type for r in rows}
        assert "policy" in source_types
        assert "policy_exclusion" in source_types  # The "## Exclusions" section


def test_admin_can_upload_policy_doc(client_and_engine):
    client, _ = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_admin_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 201


def test_re_uploading_same_policy_is_idempotent(client_and_engine):
    client, engine = client_and_engine
    headers = {"Authorization": f"Bearer {_broker_token()}"}

    first = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers=headers,
        json={"text": SAMPLE_POLICY},
    ).json()
    second = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers=headers,
        json={"text": SAMPLE_POLICY},
    ).json()

    assert first["chunks_inserted"] >= 3
    assert second["chunks_inserted"] == 0  # all chunks already present, none re-inserted
    assert second["chunks_extracted"] == first["chunks_extracted"]
