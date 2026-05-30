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
    Resolved rows are included so they contribute their reduced (0.2) weight.

    `starter_seed` onboarding nudges are EXCLUDED — they're a first-run prompt,
    not real risk, and the fusion engine has no weight for their provenance (it
    fails loud), so they must never reach the factor."""
    rows = session.exec(
        select(ComplianceSignal).where(ComplianceSignal.venue_id == venue_id)
    ).all()
    return [
        Signal(provenance=r.provenance, severity=r.severity, status=r.status)
        for r in rows
        if r.provenance != "starter_seed"
    ]


def spawn_incident_followup(
    session: Session, venue_id: str, incident_id: str, *, summary: str | None = None,
) -> ComplianceSignal | None:
    """Open a compliance follow-up task for a freshly-reported incident.

    Mirrors the camera-anomaly auto-signal in live_state.py but with
    provenance="operator_reported": the operator filed an incident, so they now
    owe a documented report / footage upload. The open task dents the compliance
    factor until resolved, so resolving it visibly raises the score — closing the
    operator loop. Idempotent per incident; capped so runaway incidents don't
    flood the queue. Returns the new row, or None if it already exists / cap hit.
    """
    from app.live_state import MAX_AUTO_GENERATED_COMPLIANCE_ITEMS  # local: avoid import cycle

    signal_id = f"INC_FOLLOWUP_{incident_id}"
    if session.get(ComplianceSignal, signal_id) is not None:
        return None  # idempotent — one follow-up per incident

    open_followups = session.exec(
        select(ComplianceSignal)
        .where(ComplianceSignal.venue_id == venue_id)
        .where(ComplianceSignal.status == "open")
        .where(ComplianceSignal.provenance == "operator_reported")
    ).all()
    if len(open_followups) >= MAX_AUTO_GENERATED_COMPLIANCE_ITEMS:
        return None

    row = ComplianceSignal(
        id=signal_id,
        venue_id=venue_id,
        title=f"FILE_REPORT_{incident_id[-6:].upper()}",
        description=(
            "File the internal incident report and upload verified footage to "
            "preserve claims defensibility."
        ),
        provenance="operator_reported",
        severity="high",
        status="open",
    )
    session.add(row)
    _add_audit_event(
        session=session, actor_id="incident_flow", actor_type="system",
        entity_type="compliance_signal", entity_id=signal_id,
        event_type="compliance_signal.open",
        event_metadata={
            "venue_id": venue_id, "incident_id": incident_id,
            "reason": "incident_followup", "incident_summary": summary,
        },
    )
    return row


def seed_starter_compliance_item(session: Session, venue_id: str) -> ComplianceSignal | None:
    """Seed ONE clearly-labeled starter task for a brand-new venue so the
    operator's queue isn't empty and the resolve-to-raise-the-score loop is
    demonstrable on day one. Idempotent. Its `starter_seed` provenance is
    excluded from the compliance factor (see `compliance_signals_for`), so it
    never dents the new venue's A-tier score. Returns the row, or None if it
    already exists."""
    signal_id = f"STARTER_{venue_id}"
    if session.get(ComplianceSignal, signal_id) is not None:
        return None
    row = ComplianceSignal(
        id=signal_id,
        venue_id=venue_id,
        title="WELCOME_FIRST_TASK",
        description=(
            "Starter task — upload your alcohol-service or security policy to see "
            "how clearing compliance lowers your premium."
        ),
        provenance="starter_seed",
        severity="low",
        status="open",
    )
    session.add(row)
    _add_audit_event(
        session=session, actor_id="venue_onboarding", actor_type="system",
        entity_type="compliance_signal", entity_id=signal_id,
        event_type="compliance_signal.open",
        event_metadata={"venue_id": venue_id, "reason": "starter_seed"},
    )
    return row


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
