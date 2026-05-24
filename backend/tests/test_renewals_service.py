import pytest
from datetime import date
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine

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


from app.models import Claim, Policy
from app.services.renewals import (
    LossExperience,
    RenewalsError,
    compute_loss_experience,
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
