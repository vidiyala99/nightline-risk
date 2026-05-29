"""Integration tests: operator compliance queue and resolve flow use ComplianceSignal DB.

Task 4 — signal-fusion feature: the /live compliance_queue and the
resolve/upload routes all read+write from the persisted ComplianceSignal table,
so the operator queue and the risk score are ONE source of truth.
"""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import ComplianceSignal, Venue
from app.seed_data import VENUES

VENUE = "elsewhere-brooklyn"


def _broker_token() -> str:
    return create_token("u-broker-int", "broker@test.example", "broker", "tenant-1")


def _broker_headers() -> dict:
    return {"Authorization": f"Bearer {_broker_token()}"}


@pytest.fixture
def client_and_engine(tmp_path, monkeypatch):
    """Isolated SQLite DB with a Venue row; tests seed their own ComplianceSignal rows."""
    db_path = tmp_path / "test_integration.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)

    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)

    with Session(engine) as bootstrap:
        bootstrap.add(Venue(id=VENUE, name=VENUES[VENUE]["name"]))
        bootstrap.commit()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as client:
        yield client, engine
    app.dependency_overrides.clear()


def _seed_signal(engine, item_id="cs-it-1", venue=VENUE, status="open"):
    with Session(engine) as session:
        session.add(ComplianceSignal(
            id=item_id, venue_id=venue, title="License renewal",
            description="Upload renewed liquor license.",
            provenance="underwriter_verified", severity="medium", status=status,
        ))
        session.commit()


def test_live_queue_lists_open_signals(client_and_engine):
    """GET /live compliance_queue reflects open ComplianceSignal rows from the DB."""
    client, engine = client_and_engine
    _seed_signal(engine, item_id="cs-it-open")

    live = client.get(f"/api/venues/{VENUE}/live").json()
    ids = [c["id"] for c in live["compliance_queue"]]
    assert "cs-it-open" in ids


def test_live_queue_excludes_resolved_signals(client_and_engine):
    """Resolved signals must not appear in the compliance_queue."""
    client, engine = client_and_engine
    _seed_signal(engine, item_id="cs-it-resolved", status="resolved")

    live = client.get(f"/api/venues/{VENUE}/live").json()
    ids = [c["id"] for c in live["compliance_queue"]]
    assert "cs-it-resolved" not in ids


def test_resolve_transitions_signal_and_disappears_from_queue(client_and_engine):
    """Broker PATCH /resolve transitions the DB row to resolved and removes it from /live."""
    client, engine = client_and_engine
    _seed_signal(engine, item_id="cs-it-resolveme")

    # Confirm item is in the queue
    live_before = client.get(f"/api/venues/{VENUE}/live").json()
    assert "cs-it-resolveme" in [c["id"] for c in live_before["compliance_queue"]]

    r = client.patch(
        f"/api/venues/{VENUE}/compliance/cs-it-resolveme/resolve",
        json={"reason": "verified"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200
    assert r.json() == {"status": "resolved", "item_id": "cs-it-resolveme"}

    # Item must be gone from the queue now
    live_after = client.get(f"/api/venues/{VENUE}/live").json()
    assert "cs-it-resolveme" not in [c["id"] for c in live_after["compliance_queue"]]

    # DB row must be resolved
    with Session(engine) as session:
        row = session.get(ComplianceSignal, "cs-it-resolveme")
        assert row.status == "resolved"
        assert row.resolved_at is not None


def test_resolve_unknown_item_404(client_and_engine):
    """Resolving a non-existent item returns 404."""
    client, _ = client_and_engine
    r = client.patch(
        f"/api/venues/{VENUE}/compliance/DOES_NOT_EXIST/resolve",
        json={},
        headers=_broker_headers(),
    )
    assert r.status_code == 404


def test_resolving_signal_raises_compliance_factor(client_and_engine):
    """Resolving an open signal improves (raises) the compliance risk factor score.

    The compliance factor reads all signals (open + resolved) from the DB and
    assigns a reduced weight to resolved rows — so resolving a signal should
    move the score upward (better) compared to when it was open.
    """
    client, engine = client_and_engine
    _seed_signal(engine, item_id="cs-it-score-test")

    before = client.get(f"/api/venues/{VENUE}/risk-score").json()["factors"]["compliance"]["score"]

    r = client.patch(
        f"/api/venues/{VENUE}/compliance/cs-it-score-test/resolve",
        json={"reason": "verified"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200

    after = client.get(f"/api/venues/{VENUE}/risk-score").json()["factors"]["compliance"]["score"]
    assert after > before, (
        f"Expected compliance score to improve after resolve, but got {before} -> {after}"
    )


def test_anonymous_cannot_resolve(client_and_engine):
    """Unauthenticated resolve requests are rejected with 401."""
    client, engine = client_and_engine
    _seed_signal(engine, item_id="cs-it-anon")
    r = client.patch(f"/api/venues/{VENUE}/compliance/cs-it-anon/resolve")
    assert r.status_code == 401
