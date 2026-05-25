"""HTTP integration tests for the operator→broker PolicyRequest endpoints.

Mirrors test_claims_api.py — TestClient against app.main.app. Focuses on
what the HTTP layer adds over the service tests: auth/tenant gating
(operator-create vs broker-decide), 404s, and the lifecycle error mapping
(invalid transition → 422).
"""
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, UserRecord, Venue


VENUE_A = "elsewhere-brooklyn"
VENUE_OTHER = "house-of-yes"
POLICY_ID = "pol-preq-api"
BROKER_ID = "user-broker-preq-api"


def _broker_headers():
    token = create_token(BROKER_ID, "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _operator_headers(venue=VENUE_A):
    token = create_token(f"op-{venue}", "op@example.com", "venue_operator", venue)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _seed():
    """Idempotent seed: broker user, two venues, one active policy on VENUE_A."""
    session = next(get_session())
    try:
        if not session.get(UserRecord, BROKER_ID):
            session.add(UserRecord(
                id=BROKER_ID, email="broker@example.com",
                password_hash="x", name="Broker", role="broker",
            ))
        for vid, vname in [(VENUE_A, "Elsewhere"), (VENUE_OTHER, "House of Yes")]:
            if not session.get(Venue, vid):
                session.add(Venue(id=vid, name=vname))
        if not session.get(Policy, POLICY_ID):
            session.add(Policy(
                id=POLICY_ID, policy_number="POL-PREQ", submission_id="sub-preq",
                bound_quote_id="q-preq", venue_id=VENUE_A, carrier_id="markel-specialty",
                status="active", effective_date=date(2026, 1, 1),
                expiration_date=date(2027, 1, 1), annual_premium=Decimal("5000.00"),
                commission_amount=Decimal("750.00"), commission_rate=Decimal("0.15"),
                coverage_lines=["gl"],
            ))
        session.commit()
    finally:
        session.close()


def _create(client, **body):
    payload = {"request_type": "renewal", "note": "", "payload": {}}
    payload.update(body)
    return client.post(
        f"/api/policies/{POLICY_ID}/requests", json=payload, headers=_operator_headers(),
    )


# ─── create gating ──────────────────────────────────────────────────────────


def test_operator_creates_request(client):
    r = _create(client, request_type="renewal", note="up 3x, please renew")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["venue_id"] == VENUE_A
    assert body["request_type"] == "renewal"


def test_create_requires_auth(client):
    r = client.post(f"/api/policies/{POLICY_ID}/requests", json={"request_type": "renewal"})
    assert r.status_code == 401


def test_create_denied_for_other_venue_operator(client):
    r = client.post(
        f"/api/policies/{POLICY_ID}/requests",
        json={"request_type": "renewal"},
        headers=_operator_headers(venue=VENUE_OTHER),
    )
    assert r.status_code == 403


def test_create_unknown_policy_404(client):
    r = client.post(
        "/api/policies/pol-nope/requests",
        json={"request_type": "renewal"},
        headers=_operator_headers(),
    )
    assert r.status_code == 404


def test_create_invalid_type_400(client):
    r = _create(client, request_type="bogus")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "policy_request_error"


# ─── decide gating + lifecycle ────────────────────────────────────────────


def test_broker_approves(client):
    rid = _create(client).json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved", "decision_note": "renewing"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "approved"
    assert body["decided_by"] == BROKER_ID
    assert body["decided_at"] is not None


def test_operator_cannot_decide(client):
    rid = _create(client).json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"},
        headers=_operator_headers(),
    )
    assert r.status_code == 403


def test_decide_twice_is_invalid_transition_422(client):
    rid = _create(client).json()["id"]
    client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"}, headers=_broker_headers(),
    )
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "declined"}, headers=_broker_headers(),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_transition"


# ─── cancel + reads ──────────────────────────────────────────────────────────


def test_operator_cancels_pending(client):
    rid = _create(client).json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/cancel", headers=_operator_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"


def test_operator_sees_own_venue_coverage(client):
    r = client.get(f"/api/venues/{VENUE_A}/policies", headers=_operator_headers())
    assert r.status_code == 200, r.text
    assert POLICY_ID in {p["id"] for p in r.json()}


def test_coverage_denied_for_other_venue_operator(client):
    r = client.get(
        f"/api/venues/{VENUE_A}/policies", headers=_operator_headers(venue=VENUE_OTHER),
    )
    assert r.status_code == 403


def test_coverage_requires_auth(client):
    r = client.get(f"/api/venues/{VENUE_A}/policies")
    assert r.status_code == 401


def test_list_and_per_policy_read(client):
    rid = _create(client).json()["id"]
    # cross-venue list filtered to VENUE_A includes our request
    listed = client.get(f"/api/policy-requests?venue_id={VENUE_A}")
    assert listed.status_code == 200
    assert rid in {x["id"] for x in listed.json()}
    # per-policy read is tenant-gated
    per_policy = client.get(
        f"/api/policies/{POLICY_ID}/requests", headers=_operator_headers(),
    )
    assert per_policy.status_code == 200
    assert rid in {x["id"] for x in per_policy.json()}
