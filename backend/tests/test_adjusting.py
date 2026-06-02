"""Tests for app/services/adjusting.py — carrier adjuster coverage determination.

Coverage:
  - decide_coverage("covered"): stamps decision fields + advances notified→under_investigation
  - decide_coverage("denied"):  stamps decision fields + closes claim as closed_denied
  - blank rationale raises ClaimsError
  - invalid decision value raises ClaimsError
"""
from datetime import date

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.models import Policy, UserRecord, Venue
from app.services.claims import ClaimsError, file_fnol
from app.services.adjusting import decide_coverage


VENUE_ID = "elsewhere-brooklyn"
USER_ID = "user-broker-test"


# ─── minimal session + claim helpers (mirrors test_claims_service.py) ────


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(
        id=USER_ID, email="b@x.com", password_hash="x", name="Broker", role="broker",
    ))
    s.commit()
    return s


def _active_policy(s: Session) -> Policy:
    p = Policy(
        id="pol-test-1",
        policy_number="POL-2026-0001",
        submission_id="sub-test-1",
        bound_quote_id="q-test-1",
        venue_id=VENUE_ID,
        carrier_id="markel-specialty",
        status="active",
        effective_date=date(2026, 1, 1),
        expiration_date=date(2027, 1, 1),
        annual_premium="5000.00",
        commission_amount="750.00",
        commission_rate="0.15",
        coverage_lines=["gl", "liquor"],
        terms_snapshot={},
        snapshot_hash="hash-test",
    )
    s.add(p)
    s.commit()
    return p


def _filed_claim(s: Session):
    pol = _active_policy(s)
    return file_fnol(
        s, policy_id=pol.id, coverage_line="gl",
        date_of_loss=date(2026, 3, 15), filed_by=USER_ID,
    )


@pytest.fixture
def make_claim_session():
    s = _session()
    claim = _filed_claim(s)
    s.commit()
    yield s, claim


# ─── tests ──────────────────────────────────────────────────────────────


def test_covered_sets_decision_and_advances(make_claim_session):
    s, claim = make_claim_session
    out = decide_coverage(s, claim.id, decision="covered", rationale="policy responds", adjuster_id="u-carrier")
    s.commit()
    assert out.coverage_decision == "covered"
    assert out.status == "under_investigation"
    assert out.coverage_rationale == "policy responds"


def test_denied_closes_the_claim(make_claim_session):
    s, claim = make_claim_session
    out = decide_coverage(s, claim.id, decision="denied", rationale="A&B exclusion applies", adjuster_id="u-carrier")
    s.commit()
    assert out.coverage_decision == "denied"
    assert out.status == "closed_denied"


def test_rationale_required(make_claim_session):
    s, claim = make_claim_session
    with pytest.raises(ClaimsError):
        decide_coverage(s, claim.id, decision="covered", rationale="  ", adjuster_id="u-carrier")


def test_bad_decision_rejected(make_claim_session):
    s, claim = make_claim_session
    with pytest.raises(ClaimsError):
        decide_coverage(s, claim.id, decision="maybe", rationale="x", adjuster_id="u-carrier")
