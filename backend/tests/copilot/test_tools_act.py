"""Task 3 — confirm-gated ACT tools (two-phase).

``validate_*`` returns an ``ActValidation`` carrying a ``ProposedAction``
(phase 1, no side effects); ``execute_*`` performs the action through the
EXISTING audited service (phase 2). No autonomous execution.
"""
from sqlmodel import select

from app.copilot.tools import (
    ActValidation,
    execute_send_to_broker,
    validate_resolve_compliance,
    validate_send_to_broker,
)
from app.models import ClaimProposal, ComplianceSignal, UnderwritingPacket


def test_send_to_broker_blocked_without_active_policy(seeded_borderline_incident_no_policy):
    scope, incident_id = seeded_borderline_incident_no_policy
    v: ActValidation = validate_send_to_broker(scope, incident_id)
    assert v.ok is False
    assert "policy" in v.reason.lower()


def test_send_to_broker_ok_when_borderline_and_insured(seeded_borderline_incident_insured):
    scope, incident_id = seeded_borderline_incident_insured
    v = validate_send_to_broker(scope, incident_id)
    assert v.ok is True
    assert v.proposed.kind == "send_to_broker"


def test_execute_send_to_broker_creates_exactly_one_proposal(seeded_borderline_incident_insured):
    scope, incident_id = seeded_borderline_incident_insured

    first = execute_send_to_broker(scope, incident_id)
    assert first.data["executed"] is True

    # Calling execute twice must not create a duplicate: the second call is
    # gated out ("already sent"), and create_proposal is itself idempotent per
    # packet — either way exactly ONE proposal row exists.
    second = execute_send_to_broker(scope, incident_id)
    assert second.data["executed"] is False

    pkt = scope.session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == incident_id)
    ).first()
    rows = scope.session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == pkt.id)
    ).all()
    assert len(rows) == 1


def test_validate_resolve_compliance_unknown_item(seeded_borderline_incident_no_policy):
    scope, _ = seeded_borderline_incident_no_policy
    v = validate_resolve_compliance(scope, "NOPE_DOES_NOT_EXIST")
    assert v.ok is False


def test_validate_resolve_compliance_open_item_requires_attachment(seeded_borderline_incident_no_policy):
    scope, _ = seeded_borderline_incident_no_policy
    scope.session.add(ComplianceSignal(
        id="SIG_OPEN_001", venue_id=scope.primary_venue_id,
        title="Footage gap", description="Upload verified security footage.",
        provenance="underwriter_verified", severity="medium", status="open",
    ))
    scope.session.commit()

    v = validate_resolve_compliance(scope, "SIG_OPEN_001")
    assert v.ok is True
    assert v.proposed.kind == "resolve_compliance"
    assert v.proposed.requires_attachment is True
