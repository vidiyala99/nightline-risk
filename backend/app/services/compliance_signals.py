"""Read/write helpers for ComplianceSignal — the single source of truth for the
operator compliance queue AND the compliance risk factor."""
from __future__ import annotations

from sqlmodel import Session, select

from app.lifecycles import COMPLIANCE_SIGNAL_TRANSITIONS, assert_valid_transition
from app.models import ComplianceSignal
from app.packet_core import _add_audit_event
from app.time import now_utc
from app.underwriting.fusion import Signal


def open_signals_for(venue_id: str, session: Session) -> list[ComplianceSignal]:
    """All open compliance rows for a venue (drives the operator queue)."""
    return list(session.exec(
        select(ComplianceSignal)
        .where(ComplianceSignal.venue_id == venue_id)
        .where(ComplianceSignal.status == "open")
        .order_by(ComplianceSignal.created_at)
    ).all())


def compliance_signals_for(venue_id: str, session: Session) -> list[Signal]:
    """All compliance rows (any status) for a venue, mapped to engine Signals.
    Resolved rows are included so they contribute their reduced (0.2) weight."""
    rows = session.exec(
        select(ComplianceSignal).where(ComplianceSignal.venue_id == venue_id)
    ).all()
    return [Signal(provenance=r.provenance, severity=r.severity, status=r.status) for r in rows]


def transition_compliance_signal(
    session: Session, row: ComplianceSignal, *, to: str, actor_id: str,
    evidence_ref: str | None = None, metadata: dict | None = None,
) -> ComplianceSignal:
    """Move a signal between states, validating + emitting an audit event."""
    assert_valid_transition(
        COMPLIANCE_SIGNAL_TRANSITIONS, row.status, to, entity_name="compliance_signal",
    )
    row.status = to
    row.resolved_at = now_utc() if to == "resolved" else None
    if evidence_ref is not None:
        row.evidence_ref = evidence_ref
    session.add(row)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="compliance_signal", entity_id=row.id,
        event_type=f"compliance_signal.{to}",
        event_metadata={"venue_id": row.venue_id, **(metadata or {})},
    )
    return row
