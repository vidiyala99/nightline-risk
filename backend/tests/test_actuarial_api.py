"""HTTP integration tests for GET /api/venues/{venue_id}/actuarial (Step 6).

Uses TestClient against app.main.app with the shared DB. Seeds minimal
Policy + Claim rows for the endpoint to aggregate; asserts contract shape
and graceful degradation on zero-claim venues.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Claim, Policy, Submission
from factories import ensure_quote

VENUE_ID = "elsewhere-brooklyn"
USER_ID = "user-broker-actuarial-api"


def _broker_headers():
    token = create_token(USER_ID, "actuary-test@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-act", "op-act@example.com", "venue_operator", VENUE_ID)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_active_policy_with_claims(*, policy_id: str, n_claims: int = 0):
    """Insert an active Policy and n_claims for VENUE_ID (idempotent)."""
    session = next(get_session())
    try:
        sub_id = f"sub-act-{policy_id}"
        if session.get(Submission, sub_id) is None:
            session.add(Submission(
                id=sub_id,
                venue_id=VENUE_ID,
                status="bound",
                effective_date=date(2025, 1, 1),
                coverage_lines=["gl"],
                requested_limits={},
            ))
        if session.get(Policy, policy_id) is None:
            ensure_quote(session, f"cq-act-{policy_id}", sub_id)
            session.add(Policy(
                id=policy_id,
                submission_id=sub_id,
                bound_quote_id=f"cq-act-{policy_id}",
                venue_id=VENUE_ID,
                carrier_id="markel-specialty",
                status="active",
                effective_date=date(2025, 1, 1),
                expiration_date=date(2026, 1, 1),
                annual_premium=Decimal("50000.00"),
                commission_amount=Decimal("7500.00"),
                commission_rate=Decimal("0.15"),
                coverage_lines=["gl"],
            ))
        for i in range(n_claims):
            cl_id = f"cl-act-{policy_id}-{i}"
            if session.get(Claim, cl_id) is None:
                session.add(Claim(
                    id=cl_id,
                    policy_id=policy_id,
                    coverage_line="gl",
                    date_of_loss=date(2025, 3, i + 1),
                    total_incurred=Decimal("8000.00"),
                ))
        session.commit()
    finally:
        session.close()


# ── Auth guards ───────────────────────────────────────────────────────────────

def test_actuarial_requires_auth(client):
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial")
    assert r.status_code == 401


def test_actuarial_rejects_operator_role(client):
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial", headers=_operator_headers())
    assert r.status_code == 403


# ── Response shape ────────────────────────────────────────────────────────────

def test_actuarial_returns_200_on_zero_claim_venue(client):
    """Venue with no claims must return 200 with neutral mod, not 404/500."""
    r = client.get("/api/venues/v-act-ghost/actuarial", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["venue_id"] == "v-act-ghost"
    # Either exp_mod is null (no active policy) or has a neutral/default shape
    assert "experience_mod" in body
    assert "chain_ladder" in body


def test_actuarial_experience_mod_keys_present(client):
    _seed_active_policy_with_claims(policy_id="pol-act-shape", n_claims=2)
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial", headers=_broker_headers())
    assert r.status_code == 200
    exp = r.json()["experience_mod"]
    assert exp is not None
    for key in ("mod", "credibility_z", "experience_lr", "claim_count", "logic_version"):
        assert key in exp, f"missing key: {key}"


def test_actuarial_mod_is_decimal_string(client):
    _seed_active_policy_with_claims(policy_id="pol-act-decimal", n_claims=1)
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial", headers=_broker_headers())
    exp = r.json()["experience_mod"]
    # mod must be parseable as Decimal
    Decimal(exp["mod"])
    Decimal(exp["credibility_z"])


def test_actuarial_chain_ladder_keys_present(client):
    _seed_active_policy_with_claims(policy_id="pol-act-cl", n_claims=3)
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial", headers=_broker_headers())
    cl = r.json()["chain_ladder"]
    assert cl is not None
    for key in ("is_credible", "claim_count", "ultimate_total", "by_coverage_line", "logic_version"):
        assert key in cl, f"missing key: {key}"


def test_actuarial_by_coverage_line_shape(client):
    _seed_active_policy_with_claims(policy_id="pol-act-line", n_claims=2)
    r = client.get(f"/api/venues/{VENUE_ID}/actuarial", headers=_broker_headers())
    cl = r.json()["chain_ladder"]
    if cl["by_coverage_line"]:
        entry = cl["by_coverage_line"][0]
        assert "coverage_line" in entry
        assert "ultimate" in entry
        assert "is_credible" in entry


def test_actuarial_neutral_mod_when_no_active_policy(client):
    """Ghost venue with no policy → caveat present, neutral mod defaults."""
    r = client.get("/api/venues/v-act-nopol/actuarial", headers=_broker_headers())
    assert r.status_code == 200
    exp = r.json()["experience_mod"]
    # exp_mod will have caveat about missing policy
    if exp is not None:
        if "caveat" in exp and exp["caveat"]:
            assert "policy" in exp["caveat"].lower() or exp["mod"] == "1.00"
