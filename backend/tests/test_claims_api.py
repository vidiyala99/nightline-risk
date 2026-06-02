"""HTTP integration tests for Phase 3 carrier-claim endpoints.

Mirrors test_policies_api.py — uses TestClient against app.main.app,
tests auth gating + the new cross-policy GET /api/claims endpoint.

The HTTP layer for the per-claim mutations (FNOL, reserve, payment,
close, reopen) is exercised end-to-end in test_claims_service.py at
the service layer; this file focuses on what the HTTP route adds —
auth, query parsing, and the cross-policy list semantic.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, UserRecord, Venue
from app.services.claims import (
    close_claim,
    file_fnol,
    record_carrier_reserve,
)


VENUE_A = "elsewhere-brooklyn"
VENUE_B = "house-of-yes"
USER_ID = "user-broker-claims-api"


def _broker_headers():
    token = create_token(USER_ID, "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-claims-api", "op@example.com", "venue_operator", VENUE_A)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_two_policies_with_claims():
    """Insert two policies (different venues) each with one claim,
    via direct session writes. Returns (claim_a_id, claim_b_id).

    Direct service-layer setup keeps the HTTP test focused on the new
    endpoint rather than re-exercising the full bind chain.
    """
    session = next(get_session())
    try:
        if not session.get(UserRecord, USER_ID):
            session.add(UserRecord(
                id=USER_ID, email="broker@example.com",
                password_hash="x", name="Broker", role="broker",
            ))
        for vid, vname in [(VENUE_A, "Elsewhere"), (VENUE_B, "House of Yes")]:
            if not session.get(Venue, vid):
                session.add(Venue(id=vid, name=vname))
        session.commit()

        # Two active policies with the lines we'll file against.
        policies: dict[str, Policy] = {}
        for suffix, venue in [("a", VENUE_A), ("b", VENUE_B)]:
            pid = f"pol-claims-api-{suffix}"
            existing = session.get(Policy, pid)
            if existing is None:
                p = Policy(
                    id=pid,
                    policy_number=f"POL-API-{suffix.upper()}",
                    submission_id=f"sub-claims-api-{suffix}",
                    bound_quote_id=f"q-claims-api-{suffix}",
                    venue_id=venue,
                    carrier_id="markel-specialty",
                    status="active",
                    effective_date=date(2026, 1, 1),
                    expiration_date=date(2027, 1, 1),
                    annual_premium=Decimal("5000.00"),
                    commission_amount=Decimal("750.00"),
                    commission_rate=Decimal("0.15"),
                    coverage_lines=["gl"],
                    terms_snapshot={},
                    snapshot_hash="hash",
                )
                session.add(p); session.commit()
                policies[venue] = p
            else:
                policies[venue] = existing

        # One claim per policy.
        a = file_fnol(
            session, policy_id=policies[VENUE_A].id, coverage_line="gl",
            date_of_loss=date(2026, 3, 1), filed_by=USER_ID,
        )
        b = file_fnol(
            session, policy_id=policies[VENUE_B].id, coverage_line="gl",
            date_of_loss=date(2026, 3, 2), filed_by=USER_ID,
        )
        session.commit()
        return a.id, b.id
    finally:
        session.close()


# ─── Auth gating ────────────────────────────────────────────────────────


def test_list_claims_requires_auth(client):
    r = client.get("/api/claims")
    assert r.status_code == 401


def test_list_claims_rejects_operator_role(client):
    r = client.get("/api/claims", headers=_operator_headers())
    assert r.status_code == 403


# ─── Happy paths ────────────────────────────────────────────────────────


def test_list_claims_returns_all_across_policies(client):
    a, b = _seed_two_policies_with_claims()
    r = client.get("/api/claims", headers=_broker_headers())
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert {a, b}.issubset(ids)


def test_list_claims_filters_by_venue(client):
    a, b = _seed_two_policies_with_claims()
    r = client.get(f"/api/claims?venue_id={VENUE_A}", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    returned_ids = {row["id"] for row in rows}
    # Filtered to venue A; b lives on a different venue and must be absent.
    assert a in returned_ids
    assert b not in returned_ids


def test_list_claims_open_only_excludes_closed(client):
    a, _ = _seed_two_policies_with_claims()
    # Close claim a directly via service-layer for setup speed.
    session = next(get_session())
    try:
        record_carrier_reserve(
            session, a, new_reserve=Decimal("100"),
            change_reason="initial", received_from="adj",
            received_at=datetime(2026, 3, 5, tzinfo=timezone.utc),
            recorded_by=USER_ID,
        )
        close_claim(session, a, disposition="denied", closed_by=USER_ID)
        session.commit()
    finally:
        session.close()

    r = client.get("/api/claims?open_only=true", headers=_broker_headers())
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert a not in ids  # closed claim excluded


def test_list_claims_rejects_open_only_with_status(client):
    _seed_two_policies_with_claims()
    r = client.get(
        "/api/claims?open_only=true&status=notified",
        headers=_broker_headers(),
    )
    assert r.status_code == 400


# ─── Route resolution sanity ────────────────────────────────────────────


def test_get_claims_does_not_shadow_claim_detail(client):
    """/api/claims and /api/claims/{cid} must coexist. Ensures the list
    route doesn't swallow the detail path-param route."""
    a, _ = _seed_two_policies_with_claims()
    detail = client.get(f"/api/claims/{a}", headers=_broker_headers())
    assert detail.status_code == 200
    assert detail.json()["id"] == a


# ─── Operator closed loop: GET /api/venues/{venue_id}/claims ─────────────


def test_venue_claims_requires_auth(client):
    """The closed-loop read still demands a token — no anonymous peek."""
    r = client.get(f"/api/venues/{VENUE_A}/claims")
    assert r.status_code == 401


def test_venue_claims_operator_reads_own_venue(client):
    """The black-box kill: an operator sees the carrier claim filed for
    their own venue (and only their venue's claim)."""
    a, b = _seed_two_policies_with_claims()
    r = client.get(f"/api/venues/{VENUE_A}/claims", headers=_operator_headers())
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert a in ids          # their venue's claim is visible
    assert b not in ids      # a different venue's claim is not


def test_venue_claims_operator_denied_other_venue(client):
    """Tenant isolation: VENUE_A's operator cannot read VENUE_B's claims."""
    _seed_two_policies_with_claims()
    r = client.get(f"/api/venues/{VENUE_B}/claims", headers=_operator_headers())
    assert r.status_code == 403


def test_venue_claims_broker_reads_any_venue(client):
    """Brokers keep cross-venue access through the same window."""
    _, b = _seed_two_policies_with_claims()
    r = client.get(f"/api/venues/{VENUE_B}/claims", headers=_broker_headers())
    assert r.status_code == 200
    assert b in {row["id"] for row in r.json()}


def test_venue_claims_open_only_excludes_closed(client):
    """open_only filter works on the venue-scoped read too."""
    a, _ = _seed_two_policies_with_claims()
    session = next(get_session())
    try:
        record_carrier_reserve(
            session, a, new_reserve=Decimal("100"),
            change_reason="initial", received_from="adj",
            received_at=datetime(2026, 3, 5, tzinfo=timezone.utc),
            recorded_by=USER_ID,
        )
        close_claim(session, a, disposition="denied", closed_by=USER_ID)
        session.commit()
    finally:
        session.close()

    r = client.get(
        f"/api/venues/{VENUE_A}/claims?open_only=true",
        headers=_operator_headers(),
    )
    assert r.status_code == 200
    assert a not in {row["id"] for row in r.json()}


# ─── Coverage decision surface ──────────────────────────────────────────


def _carrier_headers():
    token = create_token("user-carrier-claims-api", "carrier@example.com", "carrier", None)
    return {"Authorization": f"Bearer {token}"}


def test_venue_claims_include_coverage(client):
    """Carrier decides coverage; operator reads it back via venue-scoped list."""
    a, _ = _seed_two_policies_with_claims()

    # 1. Carrier decides coverage (denied) via adjudication endpoint.
    r = client.post(
        f"/api/adjusting/claims/{a}/decide-coverage",
        json={"decision": "denied", "rationale": "Excluded cause — assault exclusion applies."},
        headers=_carrier_headers(),
    )
    assert r.status_code == 200, r.text

    # 2. Operator reads their venue's claims.
    r = client.get(f"/api/venues/{VENUE_A}/claims", headers=_operator_headers())
    assert r.status_code == 200, r.text

    # 3. The row for claim `a` must expose coverage_decision and coverage_rationale.
    rows = {row["id"]: row for row in r.json()}
    assert a in rows, "claim not found in venue claims list"
    row = rows[a]
    assert row["coverage_decision"] == "denied"
    assert "assault exclusion" in (row["coverage_rationale"] or "")
