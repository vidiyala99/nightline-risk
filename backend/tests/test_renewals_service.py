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


def test_create_renewal_falls_back_to_policy_when_prior_submission_missing(session):
    # A policy whose originating submission is gone (imported / migrated / seeded
    # / purged) must still renew — the in-force policy is the source of truth, so
    # we carry forward its own coverage lines rather than hard-failing.
    import json as _json
    session.add(Venue(id="v1", name="Test Venue", venue_data=_json.dumps({"name": "Test Venue"})))
    pol = _make_active_policy(session, pid="pol-nosub")
    pol.submission_id = "ghost-sub"          # references a Submission that doesn't exist
    pol.coverage_lines = ["gl", "liquor"]
    session.add(pol)
    session.flush()

    renewal = create_renewal(session, "pol-nosub", effective_date=date(2026, 1, 1))
    assert renewal.status == "open"
    assert renewal.prior_policy_id == "pol-nosub"
    assert renewal.coverage_lines == ["gl", "liquor"]
    assert renewal.venue_id == "v1"


def test_create_renewal_unknown_venue_raises_renewals_error(session):
    # A policy referencing a venue that no longer resolves must surface a typed
    # RenewalsError (router -> 400 with a message), NOT an unmapped
    # SubmissionsError that escapes as a 500 the frontend can't display.
    pol = _make_active_policy(session, pid="pol-novenue")
    pol.venue_id = "ghost-venue"
    pol.submission_id = "ghost-sub"
    session.add(pol)
    session.flush()
    with pytest.raises(RenewalsError):
        create_renewal(session, "pol-novenue", effective_date=date(2026, 1, 1))


def test_create_renewal_rejects_non_active_policy(session):
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-cancelled")
    pol.submission_id = "sub-prior"
    pol.status = "cancelled"
    session.add(pol)
    session.flush()
    with pytest.raises(RenewalsError):
        create_renewal(session, "pol-cancelled", effective_date=date(2026, 1, 1))


def test_create_renewal_rejects_when_renewal_already_in_flight(session):
    """One live renewal per policy. Without this guard a policy could be
    renewed infinitely — each click spawning a duplicate renewal submission."""
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-reren")
    pol.submission_id = "sub-prior"
    session.add(pol)
    session.flush()

    create_renewal(session, "pol-reren", effective_date=date(2026, 1, 1), actor_id="user-broker")
    with pytest.raises(RenewalsError):
        create_renewal(session, "pol-reren", effective_date=date(2026, 1, 1), actor_id="user-broker")


def test_create_renewal_allowed_after_prior_renewal_declined(session):
    """A renewal that fell through (declined / lost / withdrawn) frees the
    policy to be re-renewed — the guard only blocks *live* renewals."""
    _seed_prior_submission(session)
    pol = _make_active_policy(session, pid="pol-reren2")
    pol.submission_id = "sub-prior"
    session.add(pol)
    session.flush()

    first = create_renewal(session, "pol-reren2", effective_date=date(2026, 1, 1))
    first.status = "declined"  # carrier declined / venue went elsewhere
    session.add(first)
    session.flush()

    second = create_renewal(session, "pol-reren2", effective_date=date(2026, 1, 1))
    assert second.id != first.id
    assert second.prior_policy_id == "pol-reren2"
