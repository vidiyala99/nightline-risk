"""B1 — a reported incident spawns a persisted compliance follow-up.

Closing the operator loop: before this, compliance signals only auto-spawned
from the live camera-anomaly stream, so a reported incident produced no
follow-up task. Now create_brawl_incident_flow also opens an `operator_reported`
ComplianceSignal ("file the report / upload footage"), so the incident the
operator just filed shows up in their compliance queue and dents the compliance
factor until they resolve it — making the resolve visibly raise the score.
"""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Venue
from app.seed_data import VENUES
from app.services.compliance_signals import open_signals_for, spawn_incident_followup


def _session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    return Session(eng)


# ── Unit: the helper ─────────────────────────────────────────────────────

def test_create_incident_spawns_open_compliance_signal():
    s = _session()
    spawn_incident_followup(s, "v1", "inc-abc123", summary="brawl at rear bar")
    s.commit()
    rows = open_signals_for("v1", s)
    assert len(rows) == 1
    assert rows[0].id == "INC_FOLLOWUP_inc-abc123"
    assert rows[0].provenance == "operator_reported"
    assert rows[0].status == "open"


def test_incident_followup_is_idempotent():
    s = _session()
    spawn_incident_followup(s, "v1", "inc-abc123")
    s.commit()
    spawn_incident_followup(s, "v1", "inc-abc123")
    s.commit()
    assert len(open_signals_for("v1", s)) == 1


def test_incident_followup_respects_cap():
    # MAX_AUTO_GENERATED_COMPLIANCE_ITEMS == 3 — runaway incidents don't flood
    # the queue with unbounded open follow-ups.
    s = _session()
    for i in range(6):
        spawn_incident_followup(s, "v1", f"inc-{i}")
    s.commit()
    assert len(open_signals_for("v1", s)) == 3


# ── Integration: the loop is visible in /live ────────────────────────────

@pytest.fixture
def isolated_client(tmp_path, monkeypatch):
    """Fresh DB with the elsewhere-brooklyn Venue row so before/after queue
    counts are deterministic (not subject to shared-DB accumulation)."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'followup.db'}", connect_args={"check_same_thread": False}
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as boot:
        boot.add(Venue(id="elsewhere-brooklyn", name=VENUES["elsewhere-brooklyn"]["name"]))
        boot.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


_INCIDENT = {
    "occurred_at": "2026-05-22T01:00:00Z",
    "location": "rear bar",
    "summary": "Patron required EMS after altercation.",
    "reported_by": "shift-lead",
    "injury_observed": True,
    "police_called": True,
    "ems_called": False,
}


def _op_headers():
    return {"Authorization": f"Bearer {create_token('u-flw', 'o@e.com', 'venue_operator', 'elsewhere-brooklyn')}"}


def test_live_compliance_queue_reflects_incident_followup(isolated_client):
    h = _op_headers()
    before = isolated_client.get("/api/venues/elsewhere-brooklyn/live", headers=h).json()["compliance_queue"]

    created = isolated_client.post(
        "/api/venues/elsewhere-brooklyn/incidents", json=_INCIDENT, headers=h
    )
    assert created.status_code == 201, created.text
    incident_id = created.json()["incident"]["id"]

    after = isolated_client.get("/api/venues/elsewhere-brooklyn/live", headers=h).json()["compliance_queue"]
    assert len(after) == len(before) + 1
    assert any(item["id"] == f"INC_FOLLOWUP_{incident_id}" for item in after)
