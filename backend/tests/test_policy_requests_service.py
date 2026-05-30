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
from app.models import (
    AuditEvent,
    CertificateOfInsurance,
    Policy,
    PolicyRequest,
    Submission,
)
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
    sub_id = f"sub-{pid}"
    # A real prior submission so create_renewal (executed on approval) can
    # carry forward its coverage terms.
    session.add(Submission(
        id=sub_id, venue_id=venue_id, status="bound",
        effective_date=date(2025, 1, 1), coverage_lines=["gl"],
        requested_limits={"gl": {"per_occurrence": "1000000"}},
    ))
    pol = Policy(
        id=pid, submission_id=sub_id, bound_quote_id="q-x", venue_id=venue_id,
        carrier_id="markel-specialty", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2026, 1, 1),
        annual_premium=Decimal("10000.00"), commission_amount=Decimal("1500.00"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
    )
    session.add(pol)
    session.flush()
    return pol


# Valid per-type payloads for approvals that execute a real action.
_COI_PAYLOAD = {
    "certificate_holder": "123 Wythe Ave Landlord LLC",
    "certificate_holder_address": "123 Wythe Ave, Brooklyn, NY",
    "description_of_operations": "Nightclub — general liability proof for landlord.",
    "expires_on": "2026-12-31",
}


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
        payload=_COI_PAYLOAD,
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved",
        decided_by="user_001", decision_note="Issued the certificate.",
    )
    assert decided.status == "approved"
    assert decided.decided_by == "user_001"
    assert decided.decision_note == "Issued the certificate."
    assert decided.decided_at is not None


# ─── decide (broker) — approval EXECUTES the underlying action ──────────────


def test_approve_renewal_creates_submission(session):
    _make_active_policy(session, pid="pol-1", venue_id="elsewhere-brooklyn")
    req = create_policy_request(
        session, policy_id="pol-1", request_type="renewal", requested_by="user_002",
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved", decided_by="user_001",
    )
    # A real renewal Submission now exists, pointing back at the prior policy.
    assert decided.result_entity_type == "submission"
    renewal = session.get(Submission, decided.result_entity_id)
    assert renewal is not None
    assert renewal.prior_policy_id == "pol-1"
    assert renewal.status == "open"


def test_approve_coi_issues_certificate(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="coi", requested_by="user_002",
        payload=_COI_PAYLOAD,
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved", decided_by="user_001",
    )
    assert decided.result_entity_type == "certificate"
    coi = session.get(CertificateOfInsurance, decided.result_entity_id)
    assert coi is not None
    assert coi.status == "active"
    assert coi.certificate_holder == _COI_PAYLOAD["certificate_holder"]
    assert coi.policy_id == "pol-1"


def test_approve_cancellation_cancels_policy(session):
    pol = _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="cancellation",
        requested_by="user_002",
        payload={"cancellation_date": "2025-09-01", "method": "pro_rata"},
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved", decided_by="user_001",
    )
    assert decided.result_entity_type == "policy"
    assert pol.status == "cancelled"
    assert pol.refund_amount is not None


def test_approve_coverage_change_is_decision_only(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="coverage_change",
        requested_by="user_002", payload={"requested": "add liquor liability"},
    )
    decided = decide_policy_request(
        session, request_id=req.id, decision="approved", decided_by="user_001",
    )
    # No deterministic mid-term endorsement service exists — approval records
    # the decision but creates no downstream entity.
    assert decided.status == "approved"
    assert decided.result_entity_type is None
    assert decided.result_entity_id is None


def test_approve_coi_missing_payload_raises_and_stays_pending(session):
    _make_active_policy(session)
    req = create_policy_request(
        session, policy_id="pol-1", request_type="coi", requested_by="user_002",
        payload={},  # missing the required COI fields
    )
    with pytest.raises(PolicyRequestError, match="COI"):
        decide_policy_request(
            session, request_id=req.id, decision="approved", decided_by="user_001",
        )
    # Validation happens before the transition, so the request is untouched.
    assert req.status == "pending"
    assert req.decided_at is None


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
    r2 = create_policy_request(
        session, policy_id="pol-2", request_type="coi", requested_by="u",
        payload=_COI_PAYLOAD,
    )
    decide_policy_request(session, request_id=r2.id, decision="approved", decided_by="user_001")

    assert {r.id for r in list_policy_requests(session, venue_id="venue-a")} == {r1.id}
    assert {r.id for r in list_policy_requests(session, policy_id="pol-2")} == {r2.id}
    assert {r.id for r in list_policy_requests(session, status_in=["pending"])} == {r1.id}
    assert {r.id for r in list_policy_requests(session)} == {r1.id, r2.id}
