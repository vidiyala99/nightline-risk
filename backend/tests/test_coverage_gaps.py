"""Coverage-gap remediation: service analysis + the broker endpoint that backs
the /policies/{pid}/gaps page (and the rerouted coverage-gap CTA)."""
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

from app.auth import create_token
from app.database import get_session
from app.main import app
from app.models import Policy, Venue
from app.seed_carriers import seed_broker_platform_data
from app.services.coverage_gaps import analyze_policy_gaps
from factories import ensure_policy, ensure_user


VENUE_ID = "elsewhere-brooklyn"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    seed_broker_platform_data(s)  # seeds CoverageLine rows (gl/liquor/wc required)
    s.commit()
    return s


def _policy(s: Session, pid: str, lines: list[str]) -> Policy:
    p = Policy(
        id=pid, policy_number=f"POL-{pid}", submission_id=f"s-{pid}",
        bound_quote_id=f"q-{pid}", venue_id=VENUE_ID, carrier_id="c1",
        status="active", effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1), annual_premium=Decimal("5000"),
        commission_amount=Decimal("750"), commission_rate=Decimal("0.15"),
        coverage_lines=lines,
    )
    s.add(p)
    s.commit()
    return p


# ─── Service: analyze_policy_gaps ────────────────────────────────────────


def test_missing_required_line_is_a_gap():
    s = _session()
    p = _policy(s, "pol-gap", ["gl"])  # missing liquor + wc (both required)
    out = analyze_policy_gaps(s, p)

    gap_ids = {g["id"] for g in out["gaps"]}
    assert gap_ids == {"liquor", "wc"}
    assert out["summary"]["gap_count"] == 2
    assert out["summary"]["highest_severity"] == "high"
    # Each gap carries the prefilled-endorse deep-link the page renders as a button.
    wc = next(g for g in out["gaps"] if g["id"] == "wc")
    assert wc["endorse_href"] == (
        "/policies/pol-gap/endorse?type=add_coverage&coverage_line=wc"
    )
    assert wc["name"]  # resolved from CoverageLine
    assert wc["recommended_limit"] is not None


def test_fully_covered_policy_has_no_gaps():
    s = _session()
    p = _policy(s, "pol-ok", ["gl", "liquor", "wc"])
    out = analyze_policy_gaps(s, p)

    assert out["gaps"] == []
    assert out["summary"]["gap_count"] == 0
    assert out["summary"]["highest_severity"] is None
    covered_ids = {c["id"] for c in out["covered"]}
    assert {"gl", "liquor", "wc"} <= covered_ids


# ─── Endpoint: GET /api/policies/{pid}/coverage-gaps ─────────────────────


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _seed_via_app(pid: str, lines: list[str]) -> None:
    sess = next(get_session())
    try:
        ensure_user(sess, "user-broker-gap-test", email="broker@example.com", role="broker")
        ensure_user(sess, "user-op-gap-test", email="op@example.com", role="venue_operator")
        seed_broker_platform_data(sess)
        p = ensure_policy(sess, pid, VENUE_ID)
        p.coverage_lines = lines
        sess.add(p)
        sess.commit()
    finally:
        sess.close()


def _broker_headers():
    return {"Authorization": f"Bearer {create_token('user-broker-gap-test', 'broker@example.com', 'broker', None)}"}


def _operator_headers():
    return {"Authorization": f"Bearer {create_token('user-op-gap-test', 'op@example.com', 'venue_operator', VENUE_ID)}"}


def test_endpoint_returns_gaps_for_broker(client):
    _seed_via_app("pol-ep-gap", ["gl"])
    r = client.get("/api/policies/pol-ep-gap/coverage-gaps", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["policy_id"] == "pol-ep-gap"
    assert {g["id"] for g in body["gaps"]} == {"liquor", "wc"}


def test_endpoint_404_for_unknown_policy(client):
    r = client.get("/api/policies/pol-nope/coverage-gaps", headers=_broker_headers())
    assert r.status_code == 404


def test_endpoint_rejects_non_broker(client):
    _seed_via_app("pol-ep-auth", ["gl"])
    r = client.get("/api/policies/pol-ep-auth/coverage-gaps", headers=_operator_headers())
    assert r.status_code in (401, 403)
