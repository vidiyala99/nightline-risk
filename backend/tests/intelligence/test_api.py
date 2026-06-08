import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.main import app
from app.database import get_session
from app.auth import create_token
from app.models import IncidentRecord


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    with Session(engine) as s:
        s.add(IncidentRecord(id="inc-1", venue_id="v1", occurred_at="2026-06-01",
                             location="x", summary="Brawl", reported_by="s",
                             injury_observed=True, police_called=False,
                             ems_called=False, status="open"))
        s.commit()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_operator_sees_their_exposure(client):
    token = create_token("u1", "op@v.com", "venue_operator", "v1")
    res = client.get("/api/intelligence/exposure", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert body["persona"] == "venue_operator"
    kinds = [f["kind"] for f in body["findings"]]
    assert "evidence_gap" in kinds
    f = body["findings"][0]
    assert f["subject"]["href"].startswith("/incidents/")
    assert f["why"]  # citations present


def test_requires_auth(client):
    res = client.get("/api/intelligence/exposure")
    assert res.status_code == 401
