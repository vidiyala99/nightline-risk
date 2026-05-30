"""Plan acceptance step 7 — citation chip linkage end-to-end.

The story: a broker ingests a policy doc with a clause about camera surveillance;
an operator uploads evidence against a compliance item ("camera footage gap");
the resulting ComplianceEvidence row carries a `cited_*` link back to the
policy clause that the evidence is meant to satisfy.

If this contract breaks, the FE citation chip can't render a clause label or a
page anchor — that's the demo moment we're protecting.
"""

import io

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app.auth import create_token
from app.database import get_session
from app.live_state import live_state_manager
from app.main import app
from app.models import ComplianceEvidence, Venue
from app.seed_data import VENUES


# Clause 7.3 talks about the same thing COMP_CAMERA_REAR_001 asks for —
# "alternative footage" — so TF-IDF retrieval consistently picks it.
SAMPLE_POLICY = """## Surveillance & Evidence

### 7.3 Camera Footage Continuity
The licensee shall preserve continuous camera footage covering rear and side
entrances. When primary cameras are degraded, alternative footage or a written
outage record must be retained to preserve claims defensibility.

### 7.4 Incident Report Preservation
Final incident reports require manager countersignature within seven days of
occurrence and shall be stored for a minimum of three years.

## Exclusions

### 9.1 Force Majeure
Damage from acts of god is excluded from premises liability coverage.
"""


@pytest.fixture(autouse=True)
def _force_regex_mode(monkeypatch):
    monkeypatch.setenv("POLICY_PARSER", "regex")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture(autouse=True)
def _reset_live_state():
    """LiveStateManager is a module-level singleton — reset between tests so
    the seed compliance queue is re-hydrated for every case."""
    live_state_manager._states.clear()
    yield
    live_state_manager._states.clear()


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    db_path = tmp_path / "test_citation_linkage.db"
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


def _ingest_policy(client):
    res = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_broker_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_evidence_upload_stamps_citation_link(client_and_engine):
    client, engine = client_and_engine
    ingest = _ingest_policy(client)
    doc_id = ingest["doc_id"]

    payload = b"fake jpeg bytes - rear camera repaired"
    response = client.post(
        "/api/venues/elsewhere-brooklyn/compliance/COMP_CAMERA_REAR_001/upload",
        files={"file": ("rear-cam-fixed.jpg", io.BytesIO(payload), "image/jpeg")},
        headers={"Authorization": f"Bearer {_broker_token()}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # The handler echoes the chosen citation back so the FE can update the chip
    # without a follow-up GET.
    assert body["citation"] is not None
    assert body["citation"]["doc_id"] == doc_id
    assert isinstance(body["citation"]["page_start"], int)

    with Session(engine) as session:
        row = session.exec(
            select(ComplianceEvidence)
            .where(ComplianceEvidence.compliance_item_id == "COMP_CAMERA_REAR_001")
        ).one()
        # The four locator columns are populated — this is what the FE chip reads.
        assert row.cited_source_id is not None
        assert row.cited_source_id.startswith("ingested-")
        assert row.cited_doc_id == doc_id
        assert row.cited_node_id is not None
        assert isinstance(row.cited_page_start, int)
        assert isinstance(row.cited_page_end, int)


def test_citation_preview_endpoint_returns_citation_for_known_item(client_and_engine):
    """The FE chip queries this endpoint BEFORE the operator uploads, so they
    know which clause they're satisfying."""
    client, _ = client_and_engine
    _ingest_policy(client)

    res = client.get(
        "/api/venues/elsewhere-brooklyn/compliance/COMP_CAMERA_REAR_001/citation"
    )
    assert res.status_code == 200
    body = res.json()
    assert body["citation"] is not None
    assert body["citation"]["source_type"] in {"policy", "policy_exclusion"}
    assert body["citation"]["page_start"] is not None


def test_citation_preview_falls_back_to_seed_sources_without_page_anchors(client_and_engine):
    """Pre-PageIndex demo state: no broker doc uploaded yet, but seed
    KNOWLEDGE_SOURCES already cover camera footage. The chip should still render
    the clause excerpt but with no `· p.X` suffix (locator fields stay null)."""
    client, _ = client_and_engine
    res = client.get(
        "/api/venues/elsewhere-brooklyn/compliance/COMP_CAMERA_REAR_001/citation"
    )
    assert res.status_code == 200
    citation = res.json()["citation"]
    assert citation is not None, "seed sources still produce a citation"
    # Locator fields are PageIndex-derived; seed sources don't carry them so
    # the chip degrades to "clause excerpt only, no page anchor".
    assert citation["doc_id"] is None
    assert citation["node_id"] is None
    assert citation["page_start"] is None
    assert citation["page_end"] is None


def test_citation_preview_returns_null_for_unknown_item(client_and_engine):
    """Unknown item id (already resolved or never existed) — chip stays hidden."""
    client, _ = client_and_engine
    _ingest_policy(client)

    res = client.get(
        "/api/venues/elsewhere-brooklyn/compliance/NOPE_NOT_AN_ITEM/citation"
    )
    assert res.status_code == 200
    assert res.json()["citation"] is None
