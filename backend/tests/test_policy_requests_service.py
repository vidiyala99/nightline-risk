"""Service tests for the operator→broker PolicyRequest object (Tier 1 #1).

Mirrors the ClaimProposal propose→decide pattern but built to the modern
broker-platform conventions: typed lifecycle (app.lifecycles), audit events
on every transition, typed errors. The router (api/v1/policy_requests.py)
owns commit/rollback — these tests flush and assert in-session.
"""
import pytest
from datetime import date

from sqlmodel import Session, SQLModel, create_engine, select

from app.lifecycles import InvalidTransitionError
from app.models import AuditEvent, Policy, PolicyRequest
from app.services.policy_requests import (
    PolicyRequestError,
    create_policy_request,
    decide_policy_request,
    cancel_policy_request,
    list_policy_requests,
)


@pytest.fixture()
def session():
    """In-memory SQLite session for policy-request service tests."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _make_active_policy(session, *, pid="pol-1", venue_id="elsewhere-brooklyn"):
    from decimal import Decimal
    pol = Policy(
        id=pid, submission_id="sub-x", bound_quote_id="q-x", venue_id=venue_id,
        carrier_id="markel-specialty", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2026, 1, 1),
        annual_premium=Decimal("10000.00"), commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    )
    session.add(pol)
    session.flush()
    return pol


# ─── create ───────────────────────────────────────────────────────────────


def test_create_request_defaults_to_pending_and_copies_venue(session):
    _make_active_policy(session, pid="pol-1", venue_id="elsewhere-brooklyn")
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal",
        requested_by="user_002", note="Please renew, business is up.",
    )
    assert req.status == "pending"
    assert req.venue_id == "elsewhere-brooklyn"   # denormalized from the policy
    assert req.request_type == "renewal"
    assert req.requested_by == "user_002"
    assert req.id.startswith("preq-")


def test_create_request_emits_audit_event(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="cancellation",
        requested_by="user_002", payload={"cancellation_date": "2025-09-01"},
    )
    events = session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == req.id)
    ).all()
    assert any(e.event_type == "policy_request.pending" for e in events)


def test_create_request_unknown_policy_raises(session):
    with pytest.raises(PolicyRequestError, match="not found"):
        create_policy_request(
            session, policy_id="pol-nope", request_type="renewal",
            requested_by="user_002",
        )


def test_create_request_invalid_type_raises(session):
    _make_active_policy(session)
    with pytest.raises(PolicyRequestError, match="request_type"):
        create_policy_request(
            session, policy_id="pol-1", request_type="bogus",
            requested_by="user_002",
        )


# ─── decide (broker) ────────────────────────────────────────────────────────


def test_decide_approve_sets_decision_fields(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="coi", requested_by="user_002",
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved",
        decided_by="user_001", decision_note="Issued the certificate.",
    )
    assert decided.status == "approved"
    assert decided.decided_by == "user_001"
    assert decided.decision_note == "Issued the certificate."
    assert decided.decided_at is not None


def test_decide_decline_transitions_and_audits(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="cancellation", requested_by="user_002",
    )
    decide_policy_request(session, request_id=req.id, decision="declined", decided_by="user_001")
    events = session.exec(
        select(AuditEvent).where(AuditEvent.entity_id == req.id)
    ).all()
    assert any(e.event_type == "policy_request.declined" for e in events)


def test_decide_invalid_decision_value_raises(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal", requested_by="user_002",
    )
    with pytest.raises(PolicyRequestError, match="decision"):
        decide_policy_request(session, request_id=req.id, decision="maybe", decided_by="user_001")


def test_decide_unknown_request_raises(session):
    with pytest.raises(PolicyRequestError, match="not found"):
        decide_policy_request(session, request_id="preq-nope", decision="approved", decided_by="user_001")


def test_decide_already_decided_raises_invalid_transition(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal", requested_by="user_002",
    )
    decide_policy_request(session, request_id=req.id, decision="approved", decided_by="user_001")
    with pytest.raises(InvalidTransitionError):
        decide_policy_request(session, request_id=req.id, decision="declined", decided_by="user_001")


# ─── cancel (operator) ──────────────────────────────────────────────────────


def test_cancel_pending_request(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal", requested_by="user_002",
    )
    cancelled = cancel_policy_request(session, request_id=req.id, cancelled_by="user_002")
    assert cancelled.status == "cancelled"


def test_cancel_already_decided_raises_invalid_transition(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal", requested_by="user_002",
    )
    decide_policy_request(session, request_id=req.id, decision="approved", decided_by="user_001")
    with pytest.raises(InvalidTransitionError):
        cancel_policy_request(session, request_id=req.id, cancelled_by="user_002")


# ─── list ───────────────────────────────────────────────────────────────────


def test_list_filters_by_venue_and_policy_and_status(session):
    _make_active_policy(session, pid="pol-1", venue_id="venue-a")
    _make_active_policy(session, pid="pol-2", venue_id="venue-b")
    r1 = create_policy_request(session, policy_id="pol-1", request_type="renewal", requested_by="u")
    r2 = create_policy_request(session, policy_id="pol-2", request_type="coi", requested_by="u")
    decide_policy_request(session, request_id=r2.id, decision="approved", decided_by="user_001")

    assert {r.id for r in list_policy_requests(session, venue_id="venue-a")} == {r1.id}
    assert {r.id for r in list_policy_requests(session, policy_id="pol-2")} == {r2.id}
    assert {r.id for r in list_policy_requests(session, status_in=["pending"])} == {r1.id}
    assert {r.id for r in list_policy_requests(session)} == {r1.id, r2.id}
