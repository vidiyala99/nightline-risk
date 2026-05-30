"""B3 — operator alerts feedback router.

The alert_dispatcher service (get_venue_alerts + record_feedback) already
existed, but no router was mounted, so the web /alerts page's confirm /
false-alarm buttons POSTed into the void (404) and the list GET silently
failed. This wires the routes the web actually calls, venue-access gated.
"""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import AlertEvent, Venue
from app.seed_data import VENUES

VENUE = "elsewhere-brooklyn"
ALERT_ID = "alert-test-1"


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'alerts.db'}", connect_args={"check_same_thread": False}
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr("app.database.engine", engine)
    monkeypatch.setattr("app.main.engine", engine)
    with Session(engine) as s:
        s.add(Venue(id=VENUE, name=VENUES[VENUE]["name"]))
        s.add(AlertEvent(
            id=ALERT_ID, venue_id=VENUE, camera_id="cam-1", zone="rear bar",
            event_type="altercation", severity="critical", confidence=0.9,
            description="two patrons fighting",
        ))
        s.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _owner():
    return {"Authorization": f"Bearer {create_token('u-al-o', 'o@e.com', 'venue_operator', VENUE)}"}


def _other():
    return {"Authorization": f"Bearer {create_token('u-al-x', 'x@e.com', 'venue_operator', 'house-of-yes')}"}


def _broker():
    return {"Authorization": f"Bearer {create_token('u-al-b', 'b@e.com', 'broker', None)}"}


# ── GET /api/venues/{id}/alerts ──────────────────────────────────────────

def test_list_venue_alerts_denies_anonymous(client):
    assert client.get(f"/api/venues/{VENUE}/alerts").status_code == 401


def test_list_venue_alerts_denies_cross_tenant(client):
    assert client.get(f"/api/venues/{VENUE}/alerts", headers=_other()).status_code == 403


def test_list_venue_alerts_allows_owner(client):
    r = client.get(f"/api/venues/{VENUE}/alerts", headers=_owner())
    assert r.status_code == 200
    assert ALERT_ID in [a["id"] for a in r.json()]


# ── POST /api/alerts/{id}/feedback ───────────────────────────────────────

def test_alert_feedback_persists_confirmed(client):
    r = client.post(f"/api/alerts/{ALERT_ID}/feedback", json={"feedback": "confirmed"}, headers=_owner())
    assert r.status_code == 200
    assert r.json()["feedback"] == "confirmed"


def test_alert_feedback_persists_false_alarm(client):
    r = client.post(f"/api/alerts/{ALERT_ID}/feedback", json={"feedback": "false_alarm"}, headers=_broker())
    assert r.status_code == 200
    assert r.json()["feedback"] == "false_alarm"


def test_alert_feedback_rejects_unknown_value(client):
    r = client.post(f"/api/alerts/{ALERT_ID}/feedback", json={"feedback": "banana"}, headers=_owner())
    assert r.status_code == 400


def test_alert_feedback_unknown_alert_is_404(client):
    r = client.post("/api/alerts/does-not-exist/feedback", json={"feedback": "confirmed"}, headers=_owner())
    assert r.status_code == 404


def test_alert_feedback_denies_anonymous(client):
    assert client.post(f"/api/alerts/{ALERT_ID}/feedback", json={"feedback": "confirmed"}).status_code == 401


def test_alert_feedback_denies_cross_tenant(client):
    r = client.post(f"/api/alerts/{ALERT_ID}/feedback", json={"feedback": "confirmed"}, headers=_other())
    assert r.status_code == 403
