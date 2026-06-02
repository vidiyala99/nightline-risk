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


# ─── Task 4: approve_payment / adjust_reserve / adjuster_queue ──────────


from datetime import date, datetime
from decimal import Decimal
from app.services.adjusting import approve_payment, adjust_reserve, adjuster_queue


def test_indemnity_allowed_after_coverage(make_claim_session):
    s, claim = make_claim_session
    decide_coverage(s, claim.id, decision="reservation_of_rights", rationale="investigating", adjuster_id="u-carrier")
    adjust_reserve(s, claim.id, new_reserve=Decimal("5000"), change_reason="init", adjuster_id="u-carrier")
    s.commit()
    approve_payment(s, claim.id, amount=Decimal("500"), payment_type="expense",
                    paid_on=date(2026, 6, 1), description="defense", adjuster_id="u-carrier")
    approve_payment(s, claim.id, amount=Decimal("1000"), payment_type="indemnity",
                    paid_on=date(2026, 6, 2), description="settlement", adjuster_id="u-carrier")
    s.commit()


def test_indemnity_rejected_with_no_coverage(make_claim_session):
    s, claim = make_claim_session
    from app.services.claims import record_carrier_reserve
    record_carrier_reserve(s, claim.id, new_reserve=Decimal("5000"), change_reason="init",
                           received_from="x", received_at=datetime(2026, 6, 1), recorded_by="u-brk")
    s.commit()
    import pytest
    with pytest.raises(ClaimsError):
        approve_payment(s, claim.id, amount=Decimal("1000"), payment_type="indemnity",
                        paid_on=date(2026, 6, 2), description="settlement", adjuster_id="u-carrier")


def test_adjuster_queue_lists_open_claims(make_claim_session):
    s, claim = make_claim_session
    row = next((r for r in adjuster_queue(s) if r["claim_id"] == claim.id), None)
    assert row is not None
    assert "coverage_decision" in row and "current_reserve" in row and "venue_id" in row


# ─── Task 5: reserve_hint ────────────────────────────────────────────────

from app.services.adjusting import reserve_hint


def test_reserve_hint_degrades_without_history(make_claim_session):
    s, claim = make_claim_session
    hint = reserve_hint(s, claim)
    # Fresh venue with no prior losses → None; or a well-formed dict if history exists.
    assert hint is None or ("low" in hint and "severity_band" in hint and "basis" in hint)


# ─── Coverage-first lifecycle (the carrier-desk order) ───────────────────
#
# The desk gates reserve/payment/close behind a recorded coverage decision, so
# the real order is decide → reserve → pay → close. decide_coverage lands the
# claim in under_investigation; posting a reserve / indemnity from there must
# advance the lifecycle, otherwise closed_paid is unreachable.

from app.services.adjusting import close_claim_as_carrier


def test_coverage_first_reserve_advances_to_reserved(make_claim_session):
    s, claim = make_claim_session
    decide_coverage(s, claim.id, decision="covered", rationale="covered", adjuster_id="u-carrier")
    out = adjust_reserve(s, claim.id, new_reserve=Decimal("25000"), change_reason="init", adjuster_id="u-carrier")
    s.commit()
    assert out.status == "reserved"


def test_coverage_first_full_flow_reaches_closed_paid(make_claim_session):
    s, claim = make_claim_session
    decide_coverage(s, claim.id, decision="covered", rationale="covered", adjuster_id="u-carrier")
    adjust_reserve(s, claim.id, new_reserve=Decimal("20000"), change_reason="init", adjuster_id="u-carrier")
    approve_payment(s, claim.id, amount=Decimal("16000"), payment_type="indemnity",
                    paid_on=date(2026, 6, 2), description="settlement", adjuster_id="u-carrier")
    closed = close_claim_as_carrier(s, claim.id, disposition="paid",
                                    final_indemnity=Decimal("16000"), adjuster_id="u-carrier")
    s.commit()
    assert closed.status == "closed_paid"


def test_coverage_first_indemnity_without_reserve_advances_to_settling(make_claim_session):
    s, claim = make_claim_session
    decide_coverage(s, claim.id, decision="covered", rationale="covered", adjuster_id="u-carrier")
    # Pay indemnity straight from under_investigation (no reserve posted first).
    approve_payment(s, claim.id, amount=Decimal("5000"), payment_type="indemnity",
                    paid_on=date(2026, 6, 2), description="advance", adjuster_id="u-carrier")
    s.commit()
    assert s.get(type(claim), claim.id).status == "settling"
