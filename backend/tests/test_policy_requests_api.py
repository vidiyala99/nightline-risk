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
from sqlmodel import select

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, PolicyRequest, Submission, UserRecord, Venue


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
        # Clear renewal submissions left by prior runs (or earlier tests in
        # this run). The shared DB accumulates rows; a stale renewal for
        # POLICY_ID trips the new one-live-renewal-per-policy guard and makes
        # the approve-renewal tests fail. Each test spawns its own renewal.
        stale = session.exec(
            select(Submission).where(Submission.prior_policy_id == POLICY_ID)
        ).all()
        for s in stale:
            session.delete(s)
        if not session.get(UserRecord, BROKER_ID):
            session.add(UserRecord(
                id=BROKER_ID, email="broker@example.com",
                password_hash="x", name="Broker", role="broker",
            ))
        for vid, vname in [(VENUE_A, "Elsewhere"), (VENUE_OTHER, "House of Yes")]:
            if not session.get(Venue, vid):
                session.add(Venue(id=vid, name=vname))
        # A prior bound submission so an approved renewal can carry its terms.
        if not session.get(Submission, "sub-preq"):
            session.add(Submission(
                id="sub-preq", venue_id=VENUE_A, status="bound",
                effective_date=date(2026, 1, 1), coverage_lines=["gl"],
                requested_limits={"gl": {"per_occurrence": "1000000"}},
            ))
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


# ─── List auth + tenant scoping ──────────────────────────────────────────


def test_policy_requests_list_rejects_anonymous(client):
    """The list previously soft-stripped on the client; anonymous callers
    must now get 401 instead of every venue's requests."""
    assert client.get("/api/policy-requests").status_code == 401


def test_policy_requests_list_scoped_to_operator_venue(client):
    """An operator sees only their own venue's requests; a broker sees all."""
    session = next(get_session())
    try:
        for vid, rid in [(VENUE_A, "preq-scope-a"), (VENUE_OTHER, "preq-scope-other")]:
            if not session.get(PolicyRequest, rid):
                session.add(PolicyRequest(
                    id=rid, policy_id=f"pol-x-{vid}", venue_id=vid,
                    request_type="coi", status="pending", requested_by="op",
                ))
        session.commit()

        r = client.get("/api/policy-requests", headers=_operator_headers(VENUE_A))
        assert r.status_code == 200, r.text
        venues = {row["venue_id"] for row in r.json()}
        assert VENUE_A in venues
        assert VENUE_OTHER not in venues  # other venue's request is hidden

        rb = client.get("/api/policy-requests", headers=_broker_headers())
        assert rb.status_code == 200, rb.text
        assert {VENUE_A, VENUE_OTHER} <= {row["venue_id"] for row in rb.json()}
    finally:
        for rid in ("preq-scope-a", "preq-scope-other"):
            row = session.get(PolicyRequest, rid)
            if row:
                session.delete(row)
        session.commit()
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


# ─── approval EXECUTES the underlying action (over HTTP) ─────────────────────


_COI_PAYLOAD = {
    "certificate_holder": "Wythe Landlord LLC",
    "certificate_holder_address": "123 Wythe Ave, Brooklyn, NY",
    "description_of_operations": "GL proof for landlord.",
    "expires_on": "2026-12-31",
}


def _make_dedicated_active_policy(pid: str) -> str:
    """A throwaway active policy+submission so destructive approvals (e.g.
    cancellation) don't contaminate the shared seeded POLICY_ID."""
    session = next(get_session())
    try:
        sub_id = f"sub-{pid}"
        if not session.get(Submission, sub_id):
            session.add(Submission(
                id=sub_id, venue_id=VENUE_A, status="bound",
                effective_date=date(2026, 1, 1), coverage_lines=["gl"],
                requested_limits={"gl": {"per_occurrence": "1000000"}},
            ))
        existing = session.get(Policy, pid)
        if existing is None:
            session.add(Policy(
                id=pid, policy_number=f"POL-{pid}", submission_id=sub_id,
                bound_quote_id=f"q-{pid}", venue_id=VENUE_A,
                carrier_id="markel-specialty", status="active",
                effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                annual_premium=Decimal("5000.00"),
                commission_amount=Decimal("750.00"), commission_rate=Decimal("0.15"),
                coverage_lines=["gl"],
            ))
        else:
            # Persistent DB across runs: reset to active so a prior cancellation
            # doesn't poison this run.
            existing.status = "active"
            existing.cancelled_at = None
            existing.cancellation_method = None
            existing.refund_amount = None
            session.add(existing)
        session.commit()
    finally:
        session.close()
    return pid


def test_broker_approve_renewal_creates_submission(client):
    rid = _create(client, request_type="renewal").json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"}, headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["result_entity_type"] == "submission"
    # the created renewal submission is real and fetchable
    sub = client.get(
        f"/api/submissions/{body['result_entity_id']}", headers=_broker_headers(),
    )
    assert sub.status_code == 200, sub.text
    assert sub.json()["prior_policy_id"] == POLICY_ID


def test_broker_approve_coi_issues_certificate(client):
    rid = _create(client, request_type="coi", payload=_COI_PAYLOAD).json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"}, headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["result_entity_type"] == "certificate"
    cois = client.get(
        f"/api/policies/{POLICY_ID}/certificates", headers=_broker_headers(),
    ).json()
    assert body["result_entity_id"] in {c["id"] for c in cois}


def test_approve_coi_missing_payload_400_and_stays_pending(client):
    rid = _create(client, request_type="coi", payload={}).json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"}, headers=_broker_headers(),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "policy_request_error"
    # rolled back: the request is still pending and undecided
    after = client.get(f"/api/policies/{POLICY_ID}/requests", headers=_operator_headers())
    row = next(x for x in after.json() if x["id"] == rid)
    assert row["status"] == "pending"
    assert row["decided_at"] is None


def test_broker_approve_cancellation_cancels_policy(client):
    pid = _make_dedicated_active_policy("pol-preq-cancel")
    create = client.post(
        f"/api/policies/{pid}/requests",
        json={"request_type": "cancellation",
              "payload": {"cancellation_date": "2026-06-01", "method": "pro_rata"}},
        headers=_operator_headers(),
    )
    rid = create.json()["id"]
    r = client.post(
        f"/api/policy-requests/{rid}/decide",
        json={"decision": "approved"}, headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["result_entity_type"] == "policy"
    # the policy is now cancelled
    session = next(get_session())
    try:
        assert session.get(Policy, pid).status == "cancelled"
    finally:
        session.close()


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
    # cross-venue list filtered to VENUE_A includes our request (broker sees all)
    listed = client.get(f"/api/policy-requests?venue_id={VENUE_A}", headers=_broker_headers())
    assert listed.status_code == 200
    assert rid in {x["id"] for x in listed.json()}
    # per-policy read is tenant-gated
    per_policy = client.get(
        f"/api/policies/{POLICY_ID}/requests", headers=_operator_headers(),
    )
    assert per_policy.status_code == 200
    assert rid in {x["id"] for x in per_policy.json()}
