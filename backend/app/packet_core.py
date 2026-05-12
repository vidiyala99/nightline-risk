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
    # Ensure the rubric exists and is flushed so the FK on UnderwritingPacket holds.
    rubric = _ensure_rubric_version(session, rubric_version)
    session.flush()

    packet_id = f"pkt-{uuid4().hex[:12]}"

    # Insert the parent UnderwritingPacket BEFORE any CitationRecords.
    # SQLAlchemy's flush ordering relies on ORM relationships, and these
    # tables only have column-level FKs — so on Postgres, child INSERTs
    # can otherwise be sent before the parent row exists. We finalize
    # citation_ids and validation on the packet after the children are built.
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
        citation_ids=[],
        validation={},
        snapshot_hash="",
    )
    session.add(packet)
    session.flush()

    citation_ids: list[str] = []
    invalid_citations: list[str] = []
    for index, citation in enumerate(citations):
        source = _ensure_source_record(
            session=session,
            venue_id=venue_id,
            incident_id=incident_id,
            citation=citation,
        )
        # Source FK on CitationRecord requires the SourceRecord row to exist.
        session.flush()
        validation_status, failure_reason = _validate_citation(
            source=source,
            venue_id=venue_id,
            excerpt=citation.excerpt,
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
            validation_status=validation_status,
        )
        session.add(citation_record)
        citation_ids.append(citation_id)
        if validation_status == "invalid":
            invalid_citations.append(f"{citation.source_id}: {failure_reason}")

    overall_status = "invalid" if invalid_citations else "valid"
    validation = {
        "status": overall_status,
        "citation_count": len(citation_ids),
        "invalid_count": len(invalid_citations),
        "failures": invalid_citations,
        "validated_at": _utc_iso(),
    }
    if invalid_citations:
        _add_audit_event(
            session=session,
            actor_id="system",
            actor_type="system",
            entity_type="underwriting_packet",
            entity_id=packet_id,
            event_type="packet.validation_failed",
            event_metadata={"failures": invalid_citations},
        )
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
    packet.citation_ids = citation_ids
    packet.validation = validation
    packet.snapshot_hash = _snapshot_hash(packet_body)
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


def regenerate_packet_with_corroboration(
    *,
    session: Session,
    prior_packet: UnderwritingPacket,
    incident: IncidentCreate,
    corroboration_summary: str,
    corroboration_status: str,
    corroboration_flags: list[str],
    confidence_adjustment: float,
    evidence_analysis_ids: list[str],
) -> UnderwritingPacket:
    """Produce a v2 packet incorporating vision corroboration without mutating v1.

    The prior packet's snapshot_hash and content remain intact for audit defense;
    v2 is a new row whose audit event links back to the parent.
    """
    base_confidence = prior_packet.risk_signals.get("confidence", 0.78)
    new_confidence = min(round(base_confidence + confidence_adjustment, 2), 0.99)
    updated_risk_signals = {**prior_packet.risk_signals, "confidence": new_confidence}

    visual_section = (
        f"\n\nVisual Evidence Analysis ({len(evidence_analysis_ids)} file(s) processed): "
        f"{corroboration_summary} "
        f"Corroboration status: {corroboration_status}. "
        f"Flags: {'; '.join(corroboration_flags)}."
    )
    updated_memo = {
        **prior_packet.memo,
        "summary": prior_packet.memo.get("summary", "") + visual_section,
    }

    prior_citations = session.exec(
        select(CitationRecord).where(CitationRecord.packet_id == prior_packet.id)
    ).all()
    citations = [
        Citation(
            source_id=c.source_id,
            source_type=c.citation_type,
            excerpt=c.excerpt,
        )
        for c in prior_citations
    ]

    new_packet = create_packet_snapshot(
        session=session,
        venue_id=prior_packet.venue_id,
        incident_id=prior_packet.incident_id,
        incident=incident,
        risk_signal=updated_risk_signals,
        action_plan=prior_packet.action_plan,
        claims_timeline=prior_packet.claims_timeline,
        underwriting_memo=updated_memo,
        citations=citations,
        rubric_version=prior_packet.rubric_version_id,
    )

    _add_audit_event(
        session=session,
        actor_id="system",
        actor_type="system",
        entity_type="underwriting_packet",
        entity_id=new_packet.id,
        event_type="packet.regenerated_with_vision",
        event_metadata={
            "parent_packet_id": prior_packet.id,
            "evidence_analysis_ids": evidence_analysis_ids,
            "confidence_adjustment": confidence_adjustment,
            "corroboration_status": corroboration_status,
        },
    )
    session.commit()
    session.refresh(new_packet)
    return new_packet


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


def record_packet_opened(*, session: Session, packet_id: str, reviewer_id: str) -> None:
    """Emit an audit event when an underwriter opens a packet for review."""
    _add_audit_event(
        session=session,
        actor_id=reviewer_id,
        actor_type="underwriter",
        entity_type="underwriting_packet",
        entity_id=packet_id,
        event_type="packet.opened",
        event_metadata={"reviewer_id": reviewer_id},
    )
    session.commit()


def _validate_citation(
    *,
    source: "SourceRecord",
    venue_id: str,
    excerpt: str,
) -> tuple[str, str]:
    """
    Validate a citation against the trust invariants:
    - Source must belong to the same venue
    - Excerpt must be non-empty
    - Source must have content (excerpt in DB)
    Returns (validation_status, failure_reason).
    """
    if source.venue_id != venue_id and source.venue_id != "*":
        return "invalid", f"source venue mismatch: {source.venue_id} != {venue_id}"
    if not excerpt or not excerpt.strip():
        return "invalid", "excerpt is empty"
    if not source.excerpt or not source.excerpt.strip():
        return "invalid", "source has no stored excerpt to validate against"
    return "valid", ""


def _ensure_source_record(
    *,
    session: Session,
    venue_id: str,
    incident_id: str,
    citation: Citation,
) -> SourceRecord:
    existing = session.get(SourceRecord, citation.source_id)
    if existing is not None:
        # Allow shared sources (venue_id="*") for any venue
        if existing.venue_id != venue_id and existing.venue_id != "*":
            raise PacketCitationValidationError(
                f"Citation source {citation.source_id} does not belong to venue {venue_id}"
            )
        return existing

    # Shared sources (prefixed with "shared-") are stored with venue_id="*"
    source_venue_id = "*" if citation.source_id.startswith("shared-") else venue_id
    source = SourceRecord(
        id=citation.source_id,
        venue_id=source_venue_id,
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
