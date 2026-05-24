"""HTTP integration tests for Phase 4 renewals endpoints.

Mirrors test_claims_api.py — uses TestClient against app.main.app with the
real shared DB. Seeds data directly via get_session() and exercises:
  GET  /api/renewals/due
  POST /api/policies/{id}/renew
"""
from datetime import date, timedelta
from decimal import Decimal
import json as _json

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, Submission, Venue

USER_ID = "user-broker-renewals-api"
VENUE_ID = "v1-renewals-test"


def _broker_headers():
    token = create_token(USER_ID, "broker-renewals@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token(
        "user-op-renewals-api", "op-renewals@example.com", "venue_operator", VENUE_ID
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_renewable():
    """Insert a Venue + Submission + active Policy expiring within 30 days.

    Idempotent: skips rows that already exist (test isolation via unique IDs).
    Returns (session_to_close, policy_id).
    """
    session = next(get_session())
    try:
        if session.get(Venue, VENUE_ID) is None:
            session.add(
                Venue(
                    id=VENUE_ID,
                    name="Test Venue Renewals",
                    venue_data=_json.dumps({"name": "Test Venue Renewals"}),
                )
            )
        if session.get(Submission, "sub-renewals-prior") is None:
            session.add(
                Submission(
                    id="sub-renewals-prior",
                    venue_id=VENUE_ID,
                    status="bound",
                    effective_date=date(2025, 1, 1),
                    coverage_lines=["gl"],
                    requested_limits={"gl": {"per_occurrence": "1000000"}},
                )
            )
        soon = date.today() + timedelta(days=30)
        existing_pol = session.get(Policy, "pol-renewals-due")
        if existing_pol is None:
            session.add(
                Policy(
                    id="pol-renewals-due",
                    submission_id="sub-renewals-prior",
                    bound_quote_id="q-renewals-x",
                    venue_id=VENUE_ID,
                    carrier_id="markel-specialty",
                    status="active",
                    effective_date=soon - timedelta(days=335),
                    expiration_date=soon,
                    annual_premium=Decimal("10000.00"),
                    commission_amount=Decimal("1500.00"),
                    commission_rate=Decimal("0.15"),
                    coverage_lines=["gl"],
                )
            )
        else:
            # Ensure always active + expiring soon for each test that needs it
            existing_pol.status = "active"
            existing_pol.expiration_date = soon
            session.add(existing_pol)
        session.commit()
    finally:
        session.close()


# ─── Auth gating ─────────────────────────────────────────────────────────────


def test_renewals_due_requires_auth(client):
    r = client.get("/api/renewals/due")
    assert r.status_code == 401


def test_renewals_due_rejects_operator_role(client):
    r = client.get("/api/renewals/due", headers=_operator_headers())
    assert r.status_code == 403


def test_renew_policy_requires_auth(client):
    r = client.post(
        "/api/policies/pol-renewals-due/renew",
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 401


def test_renew_policy_rejects_operator_role(client):
    r = client.post(
        "/api/policies/pol-renewals-due/renew",
        headers=_operator_headers(),
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 403


# ─── GET /api/renewals/due ────────────────────────────────────────────────────


def test_renewals_due_lists_expiring_policy(client):
    _seed_renewable()
    r = client.get("/api/renewals/due?within_days=60", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    ids = [row["policy_id"] for row in rows]
    assert "pol-renewals-due" in ids
    row = next(row for row in rows if row["policy_id"] == "pol-renewals-due")
    assert "loss_ratio" in row
    assert "projected_loss_adjustment" in row
    assert "annual_premium" in row
    assert "expiration_date" in row


def test_renewals_due_excludes_non_active_policies(client):
    _seed_renewable()
    # Mark as cancelled via service session
    session = next(get_session())
    try:
        pol = session.get(Policy, "pol-renewals-due")
        if pol and pol.status == "active":
            pol.status = "cancelled"
            session.commit()
    finally:
        session.close()

    r = client.get("/api/renewals/due?within_days=60", headers=_broker_headers())
    assert r.status_code == 200
    ids = [row["policy_id"] for row in r.json()]
    assert "pol-renewals-due" not in ids
    # _seed_renewable() in subsequent tests will restore status=active


# ─── POST /api/policies/{id}/renew ───────────────────────────────────────────


def test_renew_creates_submission_with_yoy(client):
    _seed_renewable()
    r = client.post(
        "/api/policies/pol-renewals-due/renew",
        headers=_broker_headers(),
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # submission block
    assert body["submission"]["prior_policy_id"] == "pol-renewals-due"
    assert body["submission"]["status"] == "open"
    assert "gl" in body["submission"]["coverage_lines"]
    # yoy_context block
    yoy = body["yoy_context"]
    assert yoy["prior_policy_id"] == "pol-renewals-due"
    assert yoy["prior_annual_premium"] == "10000.00"
    assert "loss_adjustment" in yoy
    assert "loss_ratio" in yoy


def test_renew_non_existent_policy_returns_404(client):
    r = client.post(
        "/api/policies/pol-does-not-exist/renew",
        headers=_broker_headers(),
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 404


def test_renew_non_active_policy_returns_400(client):
    _seed_renewable()
    # Force policy to cancelled state
    session = next(get_session())
    try:
        pol = session.get(Policy, "pol-renewals-due")
        if pol:
            pol.status = "cancelled"
            session.commit()
    finally:
        session.close()

    r = client.post(
        "/api/policies/pol-renewals-due/renew",
        headers=_broker_headers(),
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert r.status_code == 400
    # _seed_renewable() in subsequent tests will restore status=active
