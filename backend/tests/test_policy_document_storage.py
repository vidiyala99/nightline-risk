"""Tests for PolicyDocument persistence + enriched SourceRecord metadata.

When a broker uploads a policy doc, the handler must:
  1. Persist one PolicyDocument row with the full hierarchical tree_json.
  2. Persist N SourceRecord rows (one per leaf) with source_metadata fields
     `doc_id`, `node_id`, `page_start`, `page_end`, `path` populated.
  3. Stay idempotent — re-ingesting the same text creates 0 new SourceRecords
     and at most one PolicyDocument.

These assertions are what the citation chip in the FE compliance detail page
reads from. If they break, the chip can't render a page anchor.
"""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import PolicyDocument, SourceRecord, Venue
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


@pytest.fixture(autouse=True)
def _force_regex_mode(monkeypatch):
    monkeypatch.setenv("POLICY_PARSER", "regex")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    db_path = tmp_path / "test_policydoc.db"
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


def test_upload_persists_one_policy_document_row(client_and_engine):
    client, engine = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_broker_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert "doc_id" in body, "response must surface the doc_id for the FE"

    with Session(engine) as session:
        docs = session.exec(
            select(PolicyDocument).where(PolicyDocument.venue_id == "elsewhere-brooklyn")
        ).all()
        assert len(docs) == 1
        doc = docs[0]
        assert doc.id == body["doc_id"]
        assert doc.source_file == "master.md"
        assert doc.status == "ready"
        assert isinstance(doc.tree_json, dict)
        assert doc.tree_json.get("title") == "master.md"
        section_titles = {c["title"] for c in doc.tree_json.get("children", [])}
        assert "Coverage Section" in section_titles
        assert "Exclusions" in section_titles


def test_each_source_record_carries_pageindex_metadata(client_and_engine):
    client, engine = client_and_engine
    response = client.post(
        "/api/venues/elsewhere-brooklyn/policy-docs",
        headers={"Authorization": f"Bearer {_broker_token()}"},
        json={"text": SAMPLE_POLICY, "source_file": "master.md"},
    )
    assert response.status_code == 201
    doc_id = response.json()["doc_id"]

    with Session(engine) as session:
        rows = session.exec(
            select(SourceRecord)
            .where(SourceRecord.venue_id == "elsewhere-brooklyn")
            .where(SourceRecord.origin_system == "policy_ingestion")
        ).all()
        assert len(rows) >= 3
        for r in rows:
            meta = r.source_metadata
            assert meta.get("doc_id") == doc_id, "every leaf must back-reference its PolicyDocument"
            assert meta.get("node_id"), "every leaf must have a stable node_id for citations"
            assert isinstance(meta.get("page_start"), int)
            assert isinstance(meta.get("page_end"), int)
            assert " > " in meta.get("path", ""), "path must be a section > clause breadcrumb"


def test_re_upload_is_idempotent_at_both_layers(client_and_engine):
    client, engine = client_and_engine
    headers = {"Authorization": f"Bearer {_broker_token()}"}
    payload = {"text": SAMPLE_POLICY, "source_file": "master.md"}

    first = client.post("/api/venues/elsewhere-brooklyn/policy-docs", headers=headers, json=payload).json()
    second = client.post("/api/venues/elsewhere-brooklyn/policy-docs", headers=headers, json=payload).json()

    # Leaf-level idempotency stays — no duplicate SourceRecords.
    assert second["chunks_inserted"] == 0
    # PolicyDocument-level idempotency — re-upload returns the existing doc_id.
    assert second["doc_id"] == first["doc_id"]

    with Session(engine) as session:
        docs = session.exec(select(PolicyDocument)).all()
        assert len(docs) == 1
