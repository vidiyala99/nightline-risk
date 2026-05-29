"""Tests for the claim-proposal decision-capture layer.

Logic-level tests against `app.claim_proposals` — they bypass FastAPI and
exercise the pure functions directly. Route-level auth/role tests live in
`test_main_claim_routes.py` (separate file).

The flow under test is:

    operator calls create_proposal       → state=pending_broker_review
    broker calls record_broker_decision  → state=approved | rejected_by_broker

The override path (operator disagreeing with the recommender) requires a
structured reason from a fixed vocabulary; `other` additionally requires a
freetext justification. These validation rules mirror the
`ReviewDecision.override_reason` pattern already enforced in
`record_review_decision()` (`backend/app/packet_core.py`).
"""

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, ClaimProposal, UnderwritingPacket
from app.claim_proposals import (
    ClaimProposalValidationError,
    compute_override_stats,
    create_proposal,
    record_broker_decision,
    record_operator_info_response,
)
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Patron required EMS after altercation; police on scene.",
    reported_by="shift-lead",
    injury_observed=True,
    police_called=True,
    ems_called=True,
)


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed_packet(session: Session, venue_id: str = "elsewhere-brooklyn") -> UnderwritingPacket:
    return create_packet_snapshot(
        session=session,
        venue_id=venue_id,
        incident_id="inc-claim-1",
        incident=DEMO_INCIDENT,
        risk_signal={
            "type": "altercation_event",
            "severity": "high",
            "confidence": 0.85,
            "review_status": "needs_review",
        },
        action_plan=[],
        claims_timeline=[],
        underwriting_memo={"summary": "Severe altercation.", "review_status": "draft"},
        citations=[
            Citation(
                source_id="policy-2026-altercation",
                source_type="policy",
                excerpt="Documented altercation triggers carrier notification.",
            )
        ],
        rubric_version="demo-rubric-v1",
    )


# ---------- create_proposal ----------


def test_create_proposal_without_override_persists_pending_state():
    with make_session() as session:
        packet = _seed_packet(session)

        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=False,
            override_reason=None,
            override_freetext=None,
        )

        assert proposal.state == "pending_broker_review"
        assert proposal.override_recommendation is False
        assert proposal.override_reason is None
        assert proposal.packet_id == packet.id
        assert proposal.venue_id == packet.venue_id
        assert proposal.proposed_by == "op-1"


def test_create_proposal_with_structured_override_reason_persists():
    with make_session() as session:
        packet = _seed_packet(session)

        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=True,
            override_reason="additional_evidence",
            override_freetext=None,
        )

        assert proposal.override_recommendation is True
        assert proposal.override_reason == "additional_evidence"
        assert proposal.state == "pending_broker_review"


def test_create_proposal_override_without_reason_raises():
    with make_session() as session:
        packet = _seed_packet(session)

        try:
            create_proposal(
                session=session,
                packet_id=packet.id,
                operator_id="op-1",
                override_recommendation=True,
                override_reason=None,
                override_freetext=None,
            )
        except ClaimProposalValidationError as error:
            assert "override_reason is required" in str(error)
        else:
            raise AssertionError("Expected override without reason to raise")


def test_create_proposal_other_reason_without_freetext_raises():
    with make_session() as session:
        packet = _seed_packet(session)

        try:
            create_proposal(
                session=session,
                packet_id=packet.id,
                operator_id="op-1",
                override_recommendation=True,
                override_reason="other",
                override_freetext=None,
            )
        except ClaimProposalValidationError as error:
            assert "override_freetext is required" in str(error)
        else:
            raise AssertionError("Expected 'other' reason without freetext to raise")


def test_create_proposal_rejects_unknown_override_reason():
    with make_session() as session:
        packet = _seed_packet(session)

        try:
            create_proposal(
                session=session,
                packet_id=packet.id,
                operator_id="op-1",
                override_recommendation=True,
                override_reason="some_random_string",
                override_freetext=None,
            )
        except ClaimProposalValidationError as error:
            assert "override_reason must be one of" in str(error)
        else:
            raise AssertionError("Expected unknown override_reason to raise")


def test_create_proposal_for_unknown_packet_raises():
    with make_session() as session:
        try:
            create_proposal(
                session=session,
                packet_id="pkt-does-not-exist",
                operator_id="op-1",
                override_recommendation=False,
                override_reason=None,
                override_freetext=None,
            )
        except ClaimProposalValidationError as error:
            assert "Packet not found" in str(error)
        else:
            raise AssertionError("Expected unknown packet to raise")


def test_create_proposal_emits_claim_proposed_audit_event():
    with make_session() as session:
        packet = _seed_packet(session)

        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=True,
            override_reason="legal_counsel",
            override_freetext=None,
        )

        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == proposal.id)
        ).all()
        types = [e.event_type for e in events]
        assert "claim.proposed" in types
        proposed_event = next(e for e in events if e.event_type == "claim.proposed")
        assert proposed_event.event_metadata["override_recommendation"] is True
        assert proposed_event.event_metadata["override_reason"] == "legal_counsel"


# ---------- record_broker_decision ----------


def test_record_broker_decision_approve_transitions_state():
    with make_session() as session:
        packet = _seed_packet(session)
        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=False,
            override_reason=None,
            override_freetext=None,
        )

        updated = record_broker_decision(
            session=session,
            proposal_id=proposal.id,
            broker_id="br-1",
            decision="approved",
            notes=None,
        )

        assert updated.state == "approved"
        assert updated.broker_decided_by == "br-1"
        assert updated.broker_decided_at is not None


def test_record_broker_decision_reject_transitions_state_and_stores_notes():
    with make_session() as session:
        packet = _seed_packet(session)
        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=True,
            override_reason="prior_pattern",
            override_freetext=None,
        )

        updated = record_broker_decision(
            session=session,
            proposal_id=proposal.id,
            broker_id="br-1",
            decision="rejected",
            notes="Net EV is negative; advised operator to not file.",
        )

        assert updated.state == "rejected_by_broker"
        assert updated.broker_notes == "Net EV is negative; advised operator to not file."


def test_record_broker_decision_on_already_decided_raises():
    with make_session() as session:
        packet = _seed_packet(session)
        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=False,
            override_reason=None,
            override_freetext=None,
        )
        record_broker_decision(
            session=session,
            proposal_id=proposal.id,
            broker_id="br-1",
            decision="approved",
            notes=None,
        )

        try:
            record_broker_decision(
                session=session,
                proposal_id=proposal.id,
                broker_id="br-1",
                decision="rejected",
                notes="Changed my mind.",
            )
        except ClaimProposalValidationError as error:
            assert "already decided" in str(error)
        else:
            raise AssertionError("Expected double-decision to raise")


def test_record_broker_decision_for_unknown_proposal_raises():
    with make_session() as session:
        try:
            record_broker_decision(
                session=session,
                proposal_id="prop-does-not-exist",
                broker_id="br-1",
                decision="approved",
                notes=None,
            )
        except ClaimProposalValidationError as error:
            assert "Proposal not found" in str(error)
        else:
            raise AssertionError("Expected unknown proposal to raise")


def test_record_broker_decision_with_invalid_decision_raises():
    with make_session() as session:
        packet = _seed_packet(session)
        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=False,
            override_reason=None,
            override_freetext=None,
        )

        try:
            record_broker_decision(
                session=session,
                proposal_id=proposal.id,
                broker_id="br-1",
                decision="something_weird",
                notes=None,
            )
        except ClaimProposalValidationError as error:
            assert "decision must be" in str(error)
        else:
            raise AssertionError("Expected invalid decision to raise")


def test_record_broker_decision_emits_audit_event():
    with make_session() as session:
        packet = _seed_packet(session)
        proposal = create_proposal(
            session=session,
            packet_id=packet.id,
            operator_id="op-1",
            override_recommendation=False,
            override_reason=None,
            override_freetext=None,
        )

        record_broker_decision(
            session=session,
            proposal_id=proposal.id,
            broker_id="br-1",
            decision="approved",
            notes=None,
        )

        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == proposal.id)
        ).all()
        types = [e.event_type for e in events]
        assert "claim.proposed" in types
        assert "claim.approved" in types


# ---------- needs_more_info round-trip (broker ↔ operator) ----------


def _pending_proposal(session, override=False, reason=None):
    packet = _seed_packet(session)
    return create_proposal(
        session=session,
        packet_id=packet.id,
        operator_id="op-1",
        override_recommendation=override,
        override_reason=reason,
        override_freetext=None,
    )


def test_request_more_info_sets_needs_more_info_and_leaves_decision_unset():
    with make_session() as session:
        proposal = _pending_proposal(session)

        updated = record_broker_decision(
            session=session,
            proposal_id=proposal.id,
            broker_id="br-1",
            decision="needs_more_info",
            notes="Please upload the door-camera footage from 11pm-midnight.",
        )

        assert updated.state == "needs_more_info"
        assert updated.info_requested_by == "br-1"
        assert updated.info_requested_at is not None
        assert updated.info_request_note is not None and "door-camera" in updated.info_request_note
        # NOT a terminal decision — broker_decided_* must stay unset.
        assert updated.broker_decided_by is None
        assert updated.broker_decided_at is None


def test_request_more_info_without_notes_raises():
    with make_session() as session:
        proposal = _pending_proposal(session)
        try:
            record_broker_decision(
                session=session, proposal_id=proposal.id, broker_id="br-1",
                decision="needs_more_info", notes="   ",
            )
        except ClaimProposalValidationError as error:
            assert "notes are required" in str(error)
        else:
            raise AssertionError("Expected blank-notes info request to raise")


def test_needs_more_info_round_trip_then_approve():
    """The core re-entry guarantee: request info → operator responds →
    proposal re-queues → broker can decide again."""
    with make_session() as session:
        proposal = _pending_proposal(session)

        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="needs_more_info", notes="Need the incident report.",
        )
        responded = record_operator_info_response(
            session=session, proposal_id=proposal.id, operator_id="op-1",
            response_note="Report attached to the incident.",
        )
        assert responded.state == "pending_broker_review"
        assert responded.operator_response_note == "Report attached to the incident."
        assert responded.operator_responded_at is not None

        decided = record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="approved", notes=None,
        )
        assert decided.state == "approved"
        assert decided.broker_decided_by == "br-1"


def test_cannot_decide_while_awaiting_operator_response():
    with make_session() as session:
        proposal = _pending_proposal(session)
        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="needs_more_info", notes="Need more.",
        )
        try:
            record_broker_decision(
                session=session, proposal_id=proposal.id, broker_id="br-1",
                decision="approved", notes=None,
            )
        except ClaimProposalValidationError as error:
            assert "awaiting an operator response" in str(error)
        else:
            raise AssertionError("Broker must not decide a proposal parked on the operator")


def test_cannot_request_info_on_already_decided_proposal():
    with make_session() as session:
        proposal = _pending_proposal(session)
        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="approved", notes=None,
        )
        try:
            record_broker_decision(
                session=session, proposal_id=proposal.id, broker_id="br-1",
                decision="needs_more_info", notes="?",
            )
        except ClaimProposalValidationError as error:
            assert "already decided" in str(error)
        else:
            raise AssertionError("Expected info request on terminal proposal to raise")


def test_operator_response_on_non_info_proposal_raises():
    with make_session() as session:
        proposal = _pending_proposal(session)  # still pending_broker_review
        try:
            record_operator_info_response(
                session=session, proposal_id=proposal.id, operator_id="op-1",
                response_note="here you go",
            )
        except ClaimProposalValidationError as error:
            assert "not awaiting more info" in str(error)
        else:
            raise AssertionError("Operator response only valid from needs_more_info")


def test_operator_response_without_note_raises():
    with make_session() as session:
        proposal = _pending_proposal(session)
        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="needs_more_info", notes="Need more.",
        )
        try:
            record_operator_info_response(
                session=session, proposal_id=proposal.id, operator_id="op-1",
                response_note="  ",
            )
        except ClaimProposalValidationError as error:
            assert "response_note is required" in str(error)
        else:
            raise AssertionError("Expected blank operator response to raise")


def test_needs_more_info_round_trip_emits_audit_events():
    with make_session() as session:
        proposal = _pending_proposal(session)
        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="needs_more_info", notes="Need more.",
        )
        record_operator_info_response(
            session=session, proposal_id=proposal.id, operator_id="op-1",
            response_note="Done.",
        )
        events = session.exec(
            select(AuditEvent).where(AuditEvent.entity_id == proposal.id)
        ).all()
        types = [e.event_type for e in events]
        assert "claim.needs_more_info" in types
        assert "claim.info_responded" in types


def test_override_stats_counts_needs_more_info_as_pending():
    with make_session() as session:
        proposal = _pending_proposal(session, override=True, reason="additional_evidence")
        record_broker_decision(
            session=session, proposal_id=proposal.id, broker_id="br-1",
            decision="needs_more_info", notes="Need the footage.",
        )
        stats = compute_override_stats(session=session, venue_id=proposal.venue_id)
        assert stats.override_pending == 1
        assert stats.override_approved == 0
        assert stats.override_rejected == 0
