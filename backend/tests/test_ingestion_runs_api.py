"""HTTP tests for GET /api/ingestion/runs (broker/admin observability)."""
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import IngestionRun


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk-ing', 'b@x.com', 'broker', None)}"}


def _operator_headers():
    return {"Authorization": f"Bearer {create_token('op-ing', 'o@x.com', 'venue_operator', 'v1')}"}


@pytest.fixture(autouse=True)
def _seed_runs():
    session = next(get_session())
    try:
        for i in range(2):
            rid = f"ingest-apitest-{i}"
            if not session.get(IngestionRun, rid):
                session.add(IngestionRun(id=rid, source_system="pos", status="success", loaded=3))
        session.commit()
    finally:
        session.close()


def test_runs_requires_auth(client):
    assert client.get("/api/ingestion/runs").status_code == 401


def test_runs_forbidden_for_operator(client):
    assert client.get("/api/ingestion/runs", headers=_operator_headers()).status_code == 403


def test_runs_returns_recent_runs_for_broker(client):
    resp = client.get("/api/ingestion/runs", headers=_broker_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    ids = {r["id"] for r in body}
    assert "ingest-apitest-0" in ids
    sample = next(r for r in body if r["id"] == "ingest-apitest-0")
    for key in ("source_system", "status", "extracted", "loaded", "skipped", "rejected", "rejected_reasons"):
        assert key in sample
    assert isinstance(sample["rejected_reasons"], dict)  # {} when none, never null


def test_runs_respects_limit(client):
    resp = client.get("/api/ingestion/runs?limit=1", headers=_broker_headers())
    assert resp.status_code == 200
    assert len(resp.json()) == 1
