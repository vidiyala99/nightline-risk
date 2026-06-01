"""HTTP integration tests for Phase 4 renewals endpoints.

Mirrors test_claims_api.py — uses TestClient against app.main.app with the
real shared DB. Seeds data directly via get_session() and exercises:
  GET  /api/renewals/due
  POST /api/policies/{id}/renew
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, Submission

USER_ID = "user-broker-renewals-api"
# Reuse a real seeded venue (has full venue_data including capacity) so we
# don't pollute the shared DB with a bare/malformed Venue row.
VENUE_ID = "elsewhere-brooklyn"


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
    """Insert a Submission + active Policy expiring within 30 days.

    Reuses the real seeded venue VENUE_ID = "elsewhere-brooklyn" — no Venue
    row is created here (the seed data already has it with full venue_data).
    Idempotent: skips rows that already exist (test isolation via unique IDs).
    """
    session = next(get_session())
    try:
        # Clear any renewal submissions left by a prior run. The shared DB
        # accumulates rows across runs; a stale renewal for pol-renewals-due
        # would trip the new live-renewal exclusion and make the due-list
        # tests flake. Each test that needs a renewal creates its own.
        stale = session.exec(
            select(Submission).where(Submission.prior_policy_id == "pol-renewals-due")
        ).all()
        for s in stale:
            session.delete(s)
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


def test_renewals_due_excludes_policy_with_live_renewal(client):
    """Once a policy has a renewal in flight it must drop off the due list —
    otherwise a renewed policy nags the broker forever (and re-renews)."""
    _seed_renewable()
    # Confirm it's on the due list before we renew it.
    before = client.get("/api/renewals/due?within_days=60", headers=_broker_headers())
    assert "pol-renewals-due" in [row["policy_id"] for row in before.json()]

    renew = client.post(
        "/api/policies/pol-renewals-due/renew",
        headers=_broker_headers(),
        json={"effective_date": str(date.today() + timedelta(days=31))},
    )
    assert renew.status_code == 201, renew.text

    after = client.get("/api/renewals/due?within_days=60", headers=_broker_headers())
    assert "pol-renewals-due" not in [row["policy_id"] for row in after.json()]
    # _seed_renewable() in subsequent tests clears the renewal again


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


# ─── POST /api/quotes/{qid}/build-indicative — renewal experience rating ─────


def test_renewal_quote_applies_loss_adjustment(client):
    """Renewal submission with loss ratio ≥ 1.0 must get loss_adjustment 1.60."""
    from app.models import Claim, CarrierQuote

    session = next(get_session())
    try:
        # prior policy with a loss ratio of 1.2 (12000 incurred / 10000 premium) -> band 1.60
        if session.get(Submission, "sub-renewal-quote-prior") is None:
            session.add(
                Submission(
                    id="sub-renewal-quote-prior",
                    venue_id=VENUE_ID,
                    status="bound",
                    effective_date=date(2025, 1, 1),
                    coverage_lines=["gl"],
                    requested_limits={},
                )
            )
        if session.get(Policy, "pol-renewal-quote") is None:
            session.add(
                Policy(
                    id="pol-renewal-quote",
                    submission_id="sub-renewal-quote-prior",
                    bound_quote_id="q-rq-x",
                    venue_id=VENUE_ID,
                    carrier_id="markel-specialty",
                    status="active",
                    effective_date=date(2025, 1, 1),
                    expiration_date=date(2026, 1, 1),
                    annual_premium=Decimal("10000.00"),
                    commission_amount=Decimal("1500.00"),
                    commission_rate=Decimal("0.15"),
                    coverage_lines=["gl"],
                )
            )
        if session.get(Claim, "clm-rq-big") is None:
            session.add(
                Claim(
                    id="clm-rq-big",
                    policy_id="pol-renewal-quote",
                    coverage_line="gl",
                    date_of_loss=date(2025, 6, 1),
                    status="closed_paid",
                    total_incurred=Decimal("12000.00"),
                )
            )
        if session.get(Submission, "sub-renewal-quote") is None:
            session.add(
                Submission(
                    id="sub-renewal-quote",
                    venue_id=VENUE_ID,
                    status="quoting",
                    effective_date=date.today(),
                    coverage_lines=["gl"],
                    requested_limits={},
                    prior_policy_id="pol-renewal-quote",
                )
            )
        if session.get(CarrierQuote, "q-renewal-quote") is None:
            session.add(
                CarrierQuote(
                    id="q-renewal-quote",
                    submission_id="sub-renewal-quote",
                    carrier_id="markel-specialty",
                    status="requested",
                )
            )
        session.commit()
    finally:
        session.close()

    r = client.post(
        "/api/quotes/q-renewal-quote/build-indicative",
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    line = r.json()["lines"]["gl"]
    assert line["loss_adjustment"] == "1.60"
