"""Test factories that satisfy FK parents SQLite ignored but Postgres enforces.

Historically several fixtures built a ``Policy`` (or an endorsement / incident)
with phantom ``submission_id`` / ``bound_quote_id`` / ``created_by`` values: the
parent rows were never inserted. SQLite doesn't enforce foreign keys by default,
so the dangling references were silently tolerated; Postgres rejects them with a
ForeignKeyViolation. These get-or-create helpers insert the minimal valid parent
rows so the same fixtures pass on both engines (the Postgres-fidelity CI lane).

All helpers ``session.flush()`` so the parent is visible to the immediately
following child insert (column-level FKs without a Relationship() are checked at
flush time — see project_postgres_fk_ordering).
"""
from __future__ import annotations

from datetime import date

from sqlmodel import Session

from datetime import date as _date
from decimal import Decimal

from app.models import (
    Carrier,
    CarrierQuote,
    IncidentRecord,
    Policy,
    RubricVersion,
    Submission,
    UnderwritingPacket,
    UserRecord,
    Venue,
)


def ensure_venue(session: Session, venue_id: str, *, name: str | None = None) -> Venue:
    row = session.get(Venue, venue_id)
    if row is None:
        row = Venue(id=venue_id, name=name or venue_id)
        session.add(row)
        session.flush()
    return row


def ensure_carrier(
    session: Session,
    carrier_id: str = "markel-specialty",
    *,
    name: str = "Markel Specialty",
    market_type: str = "e&s",
) -> Carrier:
    row = session.get(Carrier, carrier_id)
    if row is None:
        row = Carrier(id=carrier_id, name=name, market_type=market_type)
        session.add(row)
        session.flush()
    return row


def ensure_user(
    session: Session,
    user_id: str,
    *,
    email: str | None = None,
    name: str = "Test User",
    role: str = "broker",
) -> UserRecord:
    row = session.get(UserRecord, user_id)
    if row is None:
        row = UserRecord(
            id=user_id,
            email=email or f"{user_id}@example.com",
            password_hash="x",
            name=name,
            role=role,
        )
        session.add(row)
        session.flush()
    return row


def ensure_submission(
    session: Session,
    submission_id: str,
    venue_id: str,
    *,
    effective_date: date = date(2026, 1, 1),
    coverage_lines: list | None = None,
    status: str = "bound",
) -> Submission:
    row = session.get(Submission, submission_id)
    if row is None:
        row = Submission(
            id=submission_id,
            venue_id=venue_id,
            effective_date=effective_date,
            coverage_lines=coverage_lines or ["gl"],
            status=status,
        )
        session.add(row)
        session.flush()
    return row


def ensure_quote(
    session: Session,
    quote_id: str,
    submission_id: str,
    *,
    carrier_id: str = "markel-specialty",
    status: str = "bound",
) -> CarrierQuote:
    ensure_carrier(session, carrier_id)
    row = session.get(CarrierQuote, quote_id)
    if row is None:
        row = CarrierQuote(
            id=quote_id,
            submission_id=submission_id,
            carrier_id=carrier_id,
            status=status,
        )
        session.add(row)
        session.flush()
    return row


def ensure_policy(
    session: Session,
    policy_id: str,
    venue_id: str,
    *,
    submission_id: str | None = None,
    quote_id: str | None = None,
    carrier_id: str = "markel-specialty",
    status: str = "active",
) -> Policy:
    """Ensure a minimal valid bound Policy (and all its FK parents) exists.

    For fixtures that build a child row (PolicyRequest, Claim, …) referencing a
    phantom ``policy_id`` the parent Policy never inserted.
    """
    row = session.get(Policy, policy_id)
    if row is not None:
        return row
    submission_id = submission_id or f"sub-{policy_id}"
    quote_id = quote_id or f"q-{policy_id}"
    ensure_policy_parents(
        session, submission_id=submission_id, quote_id=quote_id,
        venue_id=venue_id, carrier_id=carrier_id,
    )
    row = Policy(
        id=policy_id, policy_number=f"POL-{policy_id}",
        submission_id=submission_id, bound_quote_id=quote_id,
        venue_id=venue_id, carrier_id=carrier_id, status=status,
        effective_date=_date(2026, 1, 1), expiration_date=_date(2027, 1, 1),
        annual_premium=Decimal("5000.00"), commission_amount=Decimal("750.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    )
    session.add(row)
    session.flush()
    return row


def ensure_packet(
    session: Session,
    packet_id: str,
    venue_id: str,
    *,
    status: str = "needs_review",
) -> UnderwritingPacket:
    """Ensure an UnderwritingPacket (and its incident + rubric parents) exist.

    For fixtures that build a ClaimProposal with a phantom ``packet_id`` — the
    packet→incident→rubric FK chain is enforced on Postgres.
    """
    row = session.get(UnderwritingPacket, packet_id)
    if row is not None:
        return row
    ensure_venue(session, venue_id)
    rubric_id = "test-rubric-v1"
    if session.get(RubricVersion, rubric_id) is None:
        session.add(RubricVersion(id=rubric_id, name="Test Rubric", version="1"))
        session.flush()
    incident_id = f"inc-for-{packet_id}"
    if session.get(IncidentRecord, incident_id) is None:
        session.add(IncidentRecord(
            id=incident_id, venue_id=venue_id, occurred_at="2026-01-01T00:00:00Z",
            location="test", summary="test incident", reported_by="test",
            injury_observed=False, police_called=False, ems_called=False,
        ))
        session.flush()
    row = UnderwritingPacket(
        id=packet_id, venue_id=venue_id, incident_id=incident_id,
        rubric_version_id=rubric_id, status=status, snapshot_hash="testhash",
    )
    session.add(row)
    session.flush()
    return row


def ensure_policy_parents(
    session: Session,
    *,
    submission_id: str,
    quote_id: str,
    venue_id: str,
    carrier_id: str = "markel-specialty",
) -> None:
    """Ensure the Submission + CarrierQuote (+ Carrier) a Policy references exist.

    Call immediately before adding a ``Policy(submission_id=..., bound_quote_id=...)``
    in a fixture that previously relied on SQLite ignoring those FKs. Also ensures
    the venue + carrier the Policy references exist.
    """
    ensure_venue(session, venue_id)
    ensure_carrier(session, carrier_id)
    ensure_submission(session, submission_id, venue_id)
    ensure_quote(session, quote_id, submission_id, carrier_id=carrier_id)
