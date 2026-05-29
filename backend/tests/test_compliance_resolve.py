"""Broker waiver: PATCH /api/venues/{id}/compliance/{item}/resolve."""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import ComplianceSignal, Venue
from app.seed_data import VENUES

VENUE = "elsewhere-brooklyn"

_SIGNAL_ID = "COMP_CAMERA_REAR_001"


def _broker():
    return {"Authorization": f"Bearer {create_token('u-broker', 'b@x.com', 'broker', 'tenant-1')}"}


def _operator():
    return {"Authorization": f"Bearer {create_token('u-op', 'o@x.com', 'venue_operator', VENUE)}"}


@pytest.fixture
def client_with_signal(tmp_path, monkeypatch):
    """Isolated SQLite DB with a single open ComplianceSignal for elsewhere-brooklyn."""
    db_path = tmp_path / "test_resolve.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)

    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)

    with Session(engine) as bootstrap:
        bootstrap.add(Venue(id=VENUE, name=VENUES[VENUE]["name"]))
        bootstrap.add(ComplianceSignal(
            id=_SIGNAL_ID,
            venue_id=VENUE,
            title="CAMERA_FEED_REAR — Footage Gap",
            description="Upload verified security footage to preserve claims defensibility.",
            provenance="underwriter_verified",
            severity="medium",
            status="open",
        ))
        bootstrap.commit()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _first_item_id(client) -> str:
    live = client.get(f"/api/venues/{VENUE}/live", headers=_broker()).json()
    queue = live.get("compliance_queue") or []
    assert queue, "expected seeded compliance items for elsewhere-brooklyn"
    return queue[0]["id"]


def test_broker_can_resolve_and_item_disappears(client_with_signal):
    client = client_with_signal
    item_id = _first_item_id(client)
    resp = client.patch(
        f"/api/venues/{VENUE}/compliance/{item_id}/resolve",
        headers=_broker(),
        json={"reason": "Reviewed off-platform; waiving."},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "resolved", "item_id": item_id}

    live = client.get(f"/api/venues/{VENUE}/live", headers=_broker()).json()
    remaining = {i["id"] for i in (live.get("compliance_queue") or [])}
    assert item_id not in remaining


def test_resolve_unknown_item_404(client_with_signal):
    client = client_with_signal
    resp = client.patch(
        f"/api/venues/{VENUE}/compliance/NOPE_DOES_NOT_EXIST/resolve",
        headers=_broker(),
        json={},
    )
    assert resp.status_code == 404


def test_operator_cannot_resolve(client_with_signal):
    client = client_with_signal
    item_id = _first_item_id(client)
    resp = client.patch(
        f"/api/venues/{VENUE}/compliance/{item_id}/resolve",
        headers=_operator(),
    )
    assert resp.status_code == 403


def test_anonymous_cannot_resolve(client_with_signal):
    client = client_with_signal
    resp = client.patch(f"/api/venues/{VENUE}/compliance/{_SIGNAL_ID}/resolve")
    assert resp.status_code == 401
