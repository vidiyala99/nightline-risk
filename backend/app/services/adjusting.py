"""Carrier claims adjudication — the adjuster's seat. Thin layer over the
existing claim services. The carrier OWNS these decisions (carrier_desk); the
broker's relay path (broker_relay) is untouched."""
from __future__ import annotations

from sqlmodel import Session

from app.models import Claim
from app.packet_core import _add_audit_event
from app.services.claims import (
    ClaimsError,
    _compute_claim_snapshot_hash,
    _transition_claim,
    close_claim,
)
from app.time import now_utc

_COVERAGE_DECISIONS = {"covered", "denied", "reservation_of_rights"}


def decide_coverage(
    session: Session,
    claim_id: str,
    *,
    decision: str,
    rationale: str,
    adjuster_id: str,
) -> Claim:
    """The adjuster's 'do we owe?' determination.

    covered / reservation_of_rights  — advance the claim to under_investigation
                                       (implicit notified→acknowledged→under_investigation
                                       if needed) and stamp the decision fields.
    denied                            — same implicit transitions then close_claim
                                       with disposition='denied' → closed_denied.

    Carrier-owned action (decision_source='carrier_desk').
    """
    if decision not in _COVERAGE_DECISIONS:
        raise ClaimsError(
            f"coverage decision {decision!r} invalid; must be one of "
            f"{sorted(_COVERAGE_DECISIONS)}"
        )
    rationale = (rationale or "").strip()
    if not rationale:
        raise ClaimsError("a coverage rationale is required")

    claim = session.get(Claim, claim_id)
    if claim is None:
        raise ClaimsError(f"Unknown Claim {claim_id!r}")
    if claim.status in {"closed_paid", "closed_denied", "closed_dropped"}:
        raise ClaimsError(
            f"Claim {claim_id!r} is {claim.status!r}; reopen before deciding coverage"
        )

    # Implicitly walk notified → acknowledged → under_investigation.
    if claim.status == "notified":
        _transition_claim(
            session, claim, to="acknowledged", actor_id=adjuster_id,
            metadata={"implicit": "adjuster_opened", "decision_source": "carrier_desk"},
        )
    if claim.status == "acknowledged":
        _transition_claim(
            session, claim, to="under_investigation", actor_id=adjuster_id,
            metadata={"implicit": "coverage_review", "decision_source": "carrier_desk"},
        )

    # Stamp decision fields.
    claim.coverage_decision = decision
    claim.coverage_rationale = rationale
    claim.coverage_decided_by = adjuster_id
    claim.coverage_decided_at = now_utc().isoformat()
    claim.snapshot_hash = _compute_claim_snapshot_hash(claim)
    session.add(claim)
    session.flush()

    _add_audit_event(
        session=session,
        actor_id=adjuster_id,
        actor_type="user",
        entity_type="claim",
        entity_id=claim.id,
        event_type="claim.coverage_decided",
        event_metadata={
            "coverage_decision": decision,
            "rationale": rationale,
            "decision_source": "carrier_desk",
        },
    )

    if decision == "denied":
        return close_claim(
            session, claim.id,
            disposition="denied",
            closed_by=adjuster_id,
            decision_source="carrier_desk",
        )
    return claim
