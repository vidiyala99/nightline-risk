import pytest
from datetime import date
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine, select

from app.underwriting.pricing import loss_adjustment_from_loss_ratio


@pytest.fixture()
def session():
    """In-memory SQLite session for renewals service tests."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_loss_adjustment_bands():
    assert loss_adjustment_from_loss_ratio(Decimal("0.0")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.39")) == Decimal("0.90")
    assert loss_adjustment_from_loss_ratio(Decimal("0.40")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.69")) == Decimal("1.00")
    assert loss_adjustment_from_loss_ratio(Decimal("0.70")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("0.99")) == Decimal("1.25")
    assert loss_adjustment_from_loss_ratio(Decimal("1.00")) == Decimal("1.60")
    assert loss_adjustment_from_loss_ratio(Decimal("3.5")) == Decimal("1.60")


from app.models import AuditEvent, Claim, Policy, Submission, Venue
from app.services.renewals import (
    LossExperience,
    RenewalsError,
    compute_loss_experience,
    create_renewal,
)


def _make_active_policy(session, *, premium="10000.00", pid="pol-exp1"):
    pol = Policy(
        id=pid, submission_id="sub-x", bound_quote_id="q-x", venue_id="v1",
        carrier_id="markel-specialty", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2026, 1, 1),
        annual_premium=Decimal(premium), commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    )
    session.add(pol)
    session.flush()
    return pol


def test_loss_experience_zero_claims(session):
    _make_active_policy(session)
    exp = compute_loss_experience(session, "pol-exp1")
    assert exp.claim_count == 0
    assert exp.incurred == Decimal("0.00")
    assert exp.loss_ratio == Decimal("0")


def test_loss_experience_open_and_closed_claims(session):
    _make_active_policy(session, premium="10000.00")
    session.add(Claim(
        id="clm-1", policy_id="pol-exp1", coverage_line="gl",
        date_of_loss=date(2025, 6, 1), status="reserved",
        current_reserve=Decimal("2000.00"), indemnity_paid_to_date=Decimal("1000.00"),
        expense_paid_to_date=Decimal("0.00"), recoveries_to_date=Decimal("0.00"),
    ))
    session.add(Claim(
        id="clm-2", policy_id="pol-exp1", coverage_line="gl",
        date_of_loss=date(2025, 7, 1), status="closed_paid",
        total_incurred=Decimal("4000.00"),
    ))
    session.flush()
    exp = compute_loss_experience(session, "pol-exp1")
    assert exp.claim_count == 2
    assert exp.incurred == Decimal("7000.00")
    assert exp.loss_ratio == Decimal("0.7")


def test_loss_experience_unknown_policy(session):
    with pytest.raises(RenewalsError):
        compute_loss_experience(session, "pol-missing")


def _seed_prior_submission(session):
    import json as _json
    # Venue row needed so _venue_dict falls back to DB when "v1" not in VENUES dict.
    # venue_data must be non-empty JSON for _venue_dict's DB fallback path.
    session.add(Venue(id="v1", name="Test Venue", venue_data=_json.dumps({"name": "Test Venue"})))
    session.flush()
    sub = Submission(
        id="sub-prior", venue_id="v1", status="bound",
        effective_date=date(2025, 1, 1), coverage_lines=["gl", "liquor"],
        requested_limits={"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
        assigned_producer_id="user-broker",
    )
    session.add(sub)
    session.flush()
    return sub


def test_create_renewal_carries_forward_terms(session):
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-renew1")
    pol.submission_id = "sub-prior"
    session.add(pol)
    session.flush()

    renewal = create_renewal(
        session, "pol-renew1", effective_date=date(2026, 1, 1), actor_id="user-broker",
    )
    assert renewal.status == "open"
    assert renewal.prior_policy_id == "pol-renew1"
    assert renewal.coverage_lines == ["gl", "liquor"]
    assert renewal.requested_limits == {"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}}
    assert renewal.venue_id == "v1"
    events = list(session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == renewal.id)
    ))
    assert any(e.event_type == "submission.renewal_created" for e in events)


def test_create_renewal_rejects_non_active_policy(session):
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-cancelled")
    pol.submission_id = "sub-prior"
    pol.status = "cancelled"
    session.add(pol)
    session.flush()
    with pytest.raises(RenewalsError):
        create_renewal(session, "pol-cancelled", effective_date=date(2026, 1, 1))
