"""HTTP tests for GET /api/packets/{id}/defense-package.pdf."""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import IncidentRecord
from app.packet_core import create_packet_snapshot
from app.schemas import IncidentCreate


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('u-brk', 'broker@thirdspace.risk', 'broker', None)}"}


@pytest.fixture
def client_pid(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(IncidentRecord(
            id="inc-api", venue_id="elsewhere-brooklyn", occurred_at="2026-05-02T23:13:00Z",
            location="rear bar", summary="brawl", reported_by="op",
            injury_observed=True, police_called=True, ems_called=False,
        ))
        s.commit()
        pkt = create_packet_snapshot(
            session=s, venue_id="elsewhere-brooklyn", incident_id="inc-api",
            incident=IncidentCreate(
                occurred_at="2026-05-02T23:13:00Z", location="rear bar", summary="brawl",
                reported_by="op", injury_observed=True, police_called=True, ems_called=False,
            ),
            risk_signal={"type": "altercation_event", "severity": "medium", "confidence": 0.8, "review_status": "needs_review"},
            action_plan=[], claims_timeline=[],
            underwriting_memo={"summary": "m", "open_questions": [], "review_status": "draft"},
            citations=[], rubric_version="demo-rubric-v1",
        )
        s.commit()
        pid = pkt.id

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c, pid
    app.dependency_overrides.clear()


def test_defense_pdf_endpoint_returns_pdf(client_pid):
    client, pid = client_pid
    r = client.get(f"/api/packets/{pid}/defense-package.pdf", headers=_broker_headers())
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"


def test_defense_pdf_unknown_packet_404(client_pid):
    client, _ = client_pid
    r = client.get("/api/packets/pkt-nope/defense-package.pdf", headers=_broker_headers())
    assert r.status_code == 404


def test_defense_pdf_requires_auth(client_pid):
    client, pid = client_pid
    r = client.get(f"/api/packets/{pid}/defense-package.pdf")
    assert r.status_code == 401
