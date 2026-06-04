# backend/app/ingestion/comms/router.py
"""Turn a (CommsItem, CommsClassification) into the right record, per the gate.
Services don't commit — the runner/API owns the transaction."""
from __future__ import annotations

from uuid import uuid4

from sqlmodel import Session

from app.ingestion.comms.gate import decide
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem, ComplianceSignal, IncidentRecord
from app.packet_core import _add_audit_event


def _create_incident(session: Session, item: CommsItem, c: CommsClassification) -> IncidentRecord:
    inc = IncidentRecord(
        # deterministic id embeds the source external_id so re-ingesting the same
        # message can't create a duplicate incident (see connector dedupe).
        id=f"inc-comms-{item.source}-{item.external_id}",
        venue_id=item.venue_id,
        occurred_at=item.occurred_at.isoformat(),
        location=f"Reported via {item.source}",
        summary=item.text.strip() or "(no details)",
        reported_by=item.author or item.source,
        injury_observed=False, police_called=False, ems_called=False,
        status="open",
        incident_category=c.fields.get("category"),
    )
    session.add(inc)
    session.flush()
    return inc


def _create_compliance(session: Session, item: CommsItem, c: CommsClassification) -> ComplianceSignal:
    sig_id = f"COMMS_{item.source}_{item.external_id}"
    existing = session.get(ComplianceSignal, sig_id)
    if existing is not None:
        return existing
    row = ComplianceSignal(
        id=sig_id, venue_id=item.venue_id,
        title=f"{item.source.upper()}_FLAG",
        description=item.text.strip() or "(no details)",
        provenance=f"comms_{item.source}", severity="medium", status="open",
    )
    session.add(row)
    _add_audit_event(
        session=session, actor_id="comms_connector", actor_type="system",
        entity_type="compliance_signal", entity_id=sig_id,
        event_type="compliance_signal.open",
        event_metadata={"venue_id": item.venue_id, "reason": "comms_ingest", "source": item.source},
    )
    return row


def _create_review(session: Session, item: CommsItem, c: CommsClassification) -> CommsReviewItem:
    rv = CommsReviewItem(
        id=f"cr-{uuid4().hex[:12]}",
        venue_id=item.venue_id, source=item.source, external_id=item.external_id,
        raw_text=item.text, author=item.author, occurred_at=item.occurred_at,
        proposed_kind=c.kind, confidence=c.confidence, rationale=c.rationale,
        fields=dict(c.fields), status="pending",
    )
    session.add(rv)
    session.flush()
    return rv


def route(session: Session, item: CommsItem, classification: CommsClassification) -> dict:
    decision = decide(classification)
    if decision == "drop":
        return {"action": "noise"}
    if decision == "review":
        rv = _create_review(session, item, classification)
        return {"action": "review", "review_id": rv.id}
    if classification.kind == "incident":
        inc = _create_incident(session, item, classification)
        return {"action": "incident", "incident_id": inc.id}
    sig = _create_compliance(session, item, classification)
    return {"action": "compliance", "signal_id": sig.id}
