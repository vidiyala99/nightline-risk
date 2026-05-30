"""HTTP tests for the broker to-do feed (GET /api/broker/tasks).

Composes renewal reminders (expiring policies, bucketed by urgency) with
pending operator PolicyRequests into one prioritized list.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, PolicyRequest, UserRecord, Venue


VENUE = "tasks-venue-a"
BROKER_ID = "user-broker-tasks"
SOON_POLICY = "pol-tasks-soon"


def _broker_headers():
    return {"Authorization": f"Bearer {create_token(BROKER_ID, 'b@x.com', 'broker', None)}"}


def _operator_headers():
    return {"Authorization": f"Bearer {create_token('op-tasks', 'o@x.com', 'venue_operator', VENUE)}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _seed():
    s = next(get_session())
    try:
        if not s.get(UserRecord, BROKER_ID):
            s.add(UserRecord(id=BROKER_ID, email="b@x.com", password_hash="x", name="B", role="broker"))
        if not s.get(Venue, VENUE):
            s.add(Venue(id=VENUE, name="Tasks Venue"))
        if not s.get(Policy, SOON_POLICY):
            s.add(Policy(
                id=SOON_POLICY, policy_number="POL-SOON", submission_id="sub-t",
                bound_quote_id="q-t", venue_id=VENUE, carrier_id="markel-specialty",
                status="active", effective_date=date.today() - timedelta(days=345),
                expiration_date=date.today() + timedelta(days=20),  # urgent bucket
                annual_premium=Decimal("5000.00"), commission_amount=Decimal("750.00"),
                commission_rate=Decimal("0.15"), coverage_lines=["gl"],
            ))
        # one pending request
        pr_id = "preq-tasks-1"
        if not s.get(PolicyRequest, pr_id):
            s.add(PolicyRequest(
                id=pr_id, policy_id=SOON_POLICY, venue_id=VENUE,
                request_type="coi", status="pending", requested_by="op-tasks", note="need a cert",
            ))
        s.commit()
    finally:
        s.close()


def test_tasks_includes_renewal_and_request(client):
    r = client.get("/api/broker/tasks", headers=_broker_headers())
    assert r.status_code == 200, r.text
    tasks = r.json()
    renewal = next((t for t in tasks if t["id"] == f"task-renewal-{SOON_POLICY}"), None)
    request = next((t for t in tasks if t["id"] == "task-request-preq-tasks-1"), None)
    assert renewal is not None
    assert renewal["kind"] == "renewal" and renewal["urgency"] == "urgent"
    assert renewal["days_until"] <= 30
    assert request is not None
    assert request["kind"] == "request" and request["urgency"] == "action"


def test_tasks_requires_broker(client):
    assert client.get("/api/broker/tasks").status_code == 401
    assert client.get("/api/broker/tasks", headers=_operator_headers()).status_code == 403


# ─── persisted overlay: dismiss / snooze / complete / manual ────────────────


def _feed_ids(client):
    return {t["id"] for t in client.get("/api/broker/tasks", headers=_broker_headers()).json()}


def test_dismiss_hides_computed_task_then_reopen_restores(client):
    key = f"task-renewal-{SOON_POLICY}"
    assert key in _feed_ids(client)

    d = client.post(f"/api/broker/tasks/{key}/dismiss", headers=_broker_headers())
    assert d.status_code == 200, d.text
    assert d.json()["status"] == "dismissed"
    assert key not in _feed_ids(client)

    # reopen restores it (and leaves shared state clean for other tests)
    r = client.post(f"/api/broker/tasks/{key}/reopen", headers=_broker_headers())
    assert r.status_code == 200, r.text
    assert key in _feed_ids(client)


def test_manual_task_appears_then_completes(client):
    created = client.post(
        "/api/broker/tasks",
        json={"title": "Call carrier re: Mirage", "note": "follow up"},
        headers=_broker_headers(),
    )
    assert created.status_code == 201, created.text
    tid = created.json()["id"]
    assert created.json()["kind"] == "manual"
    assert tid in _feed_ids(client)

    done = client.post(f"/api/broker/tasks/{tid}/complete", headers=_broker_headers())
    assert done.status_code == 200
    assert done.json()["status"] == "done"
    assert tid not in _feed_ids(client)


def test_snooze_future_hides_but_expired_snooze_shows(client):
    # future snooze → hidden
    future = client.post(
        "/api/broker/tasks", json={"title": "future snooze"}, headers=_broker_headers(),
    ).json()["id"]
    s1 = client.post(
        f"/api/broker/tasks/{future}/snooze",
        json={"until": (date.today() + timedelta(days=10)).isoformat()},
        headers=_broker_headers(),
    )
    assert s1.status_code == 200, s1.text
    assert future not in _feed_ids(client)

    # snooze with a past date → reverts to visible
    past = client.post(
        "/api/broker/tasks", json={"title": "expired snooze"}, headers=_broker_headers(),
    ).json()["id"]
    client.post(
        f"/api/broker/tasks/{past}/snooze",
        json={"until": (date.today() - timedelta(days=1)).isoformat()},
        headers=_broker_headers(),
    )
    assert past in _feed_ids(client)


def test_task_actions_require_broker(client):
    key = f"task-renewal-{SOON_POLICY}"
    assert client.post(f"/api/broker/tasks/{key}/dismiss").status_code == 401
    assert client.post(
        f"/api/broker/tasks/{key}/dismiss", headers=_operator_headers()
    ).status_code == 403
