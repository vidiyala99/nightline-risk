import hashlib
import json
from datetime import datetime
from uuid import uuid4

from sqlmodel import Session, select

from app.models import (
    AuditEvent,
    CitationRecord,
    ReviewDecision,
    RubricVersion,
    SourceRecord,
    UnderwritingPacket,
)
from app.schemas import Citation, IncidentCreate


class PacketCitationValidationError(ValueError):
    pass


def create_packet_snapshot(
    *,
    session: Session,
    venue_id: str,
    incident_id: str,
    incident: IncidentCreate,
    risk_signal: dict,
    action_plan: list,
    claims_timeline: list,
    underwriting_memo: dict,
    citations: list[Citation],
    rubric_version: str,
) -> UnderwritingPacket:
    rubric = _ensure_rubric_version(session, rubric_version)
    packet_id = f"pkt-{uuid4().hex[:12]}"
    citation_ids: list[str] = []

    for index, citation in enumerate(citations):
        source = _ensure_source_record(
            session=session,
            venue_id=venue_id,
            incident_id=incident_id,
            citation=citation,
        )
        citation_id = f"cit-{uuid4().hex[:12]}"
        citation_record = CitationRecord(
            id=citation_id,
            packet_id=packet_id,
            source_id=source.id,
            claim_id=f"risk_signal:{risk_signal.get('type', 'unknown')}:{index}",
            citation_type=citation.source_type,
            field_path="excerpt",
            excerpt=citation.excerpt,
            validation_status="valid",
        )
        session.add(citation_record)
        citation_ids.append(citation_id)

    validation = {
        "status": "valid",
        "citation_count": len(citation_ids),
        "validated_at": _utc_iso(),
    }
    packet_body = {
        "incident_id": incident_id,
        "venue_id": venue_id,
        "incident": incident.model_dump(),
        "rubric_version_id": rubric.id,
        "risk_signals": risk_signal,
        "action_plan": action_plan,
        "claims_timeline": claims_timeline,
        "memo": underwriting_memo,
        "citation_ids": citation_ids,
        "validation": validation,
    }
    packet = UnderwritingPacket(
        id=packet_id,
        venue_id=venue_id,
        incident_id=incident_id,
        rubric_version_id=rubric.id,
        status=_packet_status(risk_signal, underwriting_memo),
        risk_signals=risk_signal,
        action_plan=action_plan,
        claims_timeline=claims_timeline,
        memo=underwriting_memo,
        citation_ids=citation_ids,
        validation=validation,
        snapshot_hash=_snapshot_hash(packet_body),
    )
    session.add(packet)
    _add_audit_event(
        session=session,
        actor_id="system",
        actor_type="system",
        entity_type="underwriting_packet",
        entity_id=packet.id,
        event_type="packet.generated",
        event_metadata={
            "incident_id": incident_id,
            "rubric_version_id": rubric.id,
            "citation_count": len(citation_ids),
            "validation_status": validation["status"],
        },
    )
    session.commit()
    session.refresh(packet)
    return packet


def record_review_decision(
    *,
    session: Session,
    packet_id: str,
    reviewer_id: str,
    decision: str,
    override_reason: str | None,
    notes: str | None,
) -> ReviewDecision:
    normalized_decision = decision.lower()
    if normalized_decision in {"rejected", "request_more_information"} and not override_reason:
        raise ValueError("override_reason is required for rejected or request_more_information decisions")

    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise ValueError(f"Packet not found: {packet_id}")

    decision_record = ReviewDecision(
        id=f"rev-{uuid4().hex[:12]}",
        packet_id=packet_id,
        reviewer_id=reviewer_id,
        decision=normalized_decision,
        override_reason=override_reason,
        notes=notes,
    )
    packet.status = _status_for_review_decision(normalized_decision)
    session.add(decision_record)
    session.add(packet)
    _add_audit_event(
        session=session,
        actor_id=reviewer_id,
        actor_type="underwriter",
        entity_type="underwriting_packet",
        entity_id=packet_id,
        event_type="packet.review_decision_recorded",
        event_metadata={
            "decision": normalized_decision,
            "override_reason": override_reason,
        },
    )
    session.commit()
    session.refresh(decision_record)
    return decision_record


def _ensure_source_record(
    *,
    session: Session,
    venue_id: str,
    incident_id: str,
    citation: Citation,
) -> SourceRecord:
    existing = session.get(SourceRecord, citation.source_id)
    if existing is not None:
        if existing.venue_id != venue_id:
            raise PacketCitationValidationError(
                f"Citation source {citation.source_id} does not belong to venue {venue_id}"
            )
        return existing

    source = SourceRecord(
        id=citation.source_id,
        venue_id=venue_id,
        incident_id=None,
        source_type=citation.source_type,
        excerpt=citation.excerpt,
        content_hash=_snapshot_hash(
            {
                "source_id": citation.source_id,
                "source_type": citation.source_type,
                "excerpt": citation.excerpt,
            }
        ),
    )
    session.add(source)
    return source


def _ensure_rubric_version(session: Session, rubric_version: str) -> RubricVersion:
    rubric = session.get(RubricVersion, rubric_version)
    if rubric is not None:
        return rubric

    rubric = RubricVersion(
        id=rubric_version,
        name="Third Space deterministic demo rubric",
        version=rubric_version,
        rules={"mode": "deterministic", "requires_citations": True},
        prohibited_fields=[],
    )
    session.add(rubric)
    return rubric


def _add_audit_event(
    *,
    session: Session,
    actor_id: str,
    actor_type: str,
    entity_type: str,
    entity_id: str,
    event_type: str,
    event_metadata: dict,
) -> None:
    session.add(
        AuditEvent(
            id=f"aud-{uuid4().hex[:12]}",
            actor_id=actor_id,
            actor_type=actor_type,
            entity_type=entity_type,
            entity_id=entity_id,
            event_type=event_type,
            event_metadata=event_metadata,
        )
    )


def _packet_status(risk_signal: dict, underwriting_memo: dict) -> str:
    statuses = {
        str(risk_signal.get("review_status", "")).lower(),
        str(underwriting_memo.get("review_status", "")).lower(),
    }
    if "blocked" in statuses:
        return "invalid"
    if "needs_review" in statuses or "draft" in statuses:
        return "needs_review"
    if "approved" in statuses:
        return "approved"
    return "needs_review"


def _status_for_review_decision(decision: str) -> str:
    if decision == "approved":
        return "approved"
    if decision == "rejected":
        return "rejected"
    return "needs_review"


def _snapshot_hash(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _utc_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"
