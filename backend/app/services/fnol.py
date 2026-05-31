"""Resolve the FNOL defaults for an approved claim proposal.

A First Notice of Loss needs a policy, a coverage line, and a date of loss.
All three are derivable from the proposal's incident; this surfaces them
(plus any blockers) so the broker confirms rather than types.
"""
from datetime import date, datetime
from typing import Optional

from sqlmodel import Session, select

from app.models import ClaimProposal, IncidentRecord, Policy, UnderwritingPacket

# Active = a bound policy we can file against. "bound_pending_number" is a
# freshly-bound policy awaiting its carrier number; both are fileable.
ACTIVE_POLICY_STATUSES = {"bound", "bound_pending_number"}

# Map the risk classifier's type to a policy coverage line. Default to GL.
# Short codes must match Policy.coverage_lines (see app/seed_carriers.py::COVERAGE_LINES).
RISK_TYPE_TO_COVERAGE = {
    "premises_liability": "gl",
    "altercation_event": "gl",
    "medical_emergency": "gl",
    "crowd_management": "gl",
    "property_damage": "property",
    "liquor_liability": "liquor",
}


def _date_of_loss(occurred_at: str) -> Optional[date]:
    try:
        return datetime.fromisoformat(occurred_at.replace("Z", "+00:00")).date()
    except (ValueError, AttributeError):
        return None


def resolve_fnol_defaults(session: Session, proposal: ClaimProposal) -> dict:
    blockers: list[str] = []
    notes: list[str] = []

    packet = session.get(UnderwritingPacket, proposal.packet_id)
    incident = session.get(IncidentRecord, packet.incident_id) if packet else None
    venue_id = proposal.venue_id

    policies = session.exec(
        select(Policy).where(Policy.venue_id == venue_id)
    ).all()
    active = [p for p in policies if p.status in ACTIVE_POLICY_STATUSES]
    if not active:
        blockers.append("no_active_policy")
        policy_id = None
    else:
        active.sort(key=lambda p: p.effective_date, reverse=True)
        policy_id = active[0].id
        if len(active) > 1:
            notes.append("multiple_policies")

    risk_type = (packet.risk_signals or {}).get("type", "") if packet else ""
    coverage_line = RISK_TYPE_TO_COVERAGE.get(risk_type, "gl")

    dol = _date_of_loss(incident.occurred_at) if incident else None
    if dol is None:
        blockers.append("no_date_of_loss")

    return {
        "policy_id": policy_id,
        "coverage_line": coverage_line,
        "date_of_loss": dol,
        "blockers": blockers,
        "notes": notes,
    }
