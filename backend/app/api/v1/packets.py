"""Phase B — UnderwritingPacket reads + review decisions + audit-events.

Routes preserved:
  GET  /api/incidents/{incident_id}/packets
  GET  /api/packets
  GET  /api/packets/{packet_id}                — tenant-gated (Phase A)
  GET  /api/packets/{packet_id}/audit-events
  POST /api/packets/{packet_id}/review-decisions

The packet_to_dict + audit_event_to_dict + review-decision helpers are
imported from main.py to avoid duplicating the (substantial) packet
serialization logic. When Phase B fully drains main.py, those helpers
will move into a `services/packets.py` module.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from sqlmodel import Session, select

from app.auth import require_venue_access
from app.database import get_session
from app.models import AuditEvent, UnderwritingPacket
from app.packet_core import record_packet_opened
from app.schemas.errors import error_response

router = APIRouter()


def _packet_to_dict_lazy(packet, session: Session) -> dict:
    """Import lazily to avoid a circular import at module load (main.py
    imports this router; main.py defines _packet_to_dict)."""
    from app.main import _packet_to_dict
    return _packet_to_dict(packet, session)


def _audit_event_to_dict_lazy(event) -> dict:
    from app.main import _audit_event_to_dict
    return _audit_event_to_dict(event)


def _review_decision_to_dict_lazy(decision) -> dict:
    from app.main import _review_decision_to_dict
    return _review_decision_to_dict(decision)


# ─── Reads ──────────────────────────────────────────────────────────────


@router.get("/incidents/{incident_id}/packets")
def list_incident_packets(
    incident_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
    packets = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
    ).all()
    return [_packet_to_dict_lazy(packet, session) for packet in packets]


@router.get("/packets")
def list_packets(
    limit: int = 20,
    session: Session = Depends(get_session),
) -> list[dict]:
    """Most-recent underwriting packets across all incidents."""
    packets = session.exec(
        select(UnderwritingPacket)
        .order_by(UnderwritingPacket.generated_at.desc())
        .limit(limit)
    ).all()
    return [_packet_to_dict_lazy(packet, session) for packet in packets]


@router.get("/packets/{packet_id}")
def get_packet(
    packet_id: str,
    reviewer_id: str | None = None,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise error_response(
            "packet_not_found",
            f"Packet {packet_id!r} not found",
            status_code=404,
        )
    require_venue_access(packet.venue_id, authorization, session)
    if reviewer_id:
        record_packet_opened(session=session, packet_id=packet_id, reviewer_id=reviewer_id)
    return _packet_to_dict_lazy(packet, session)


@router.get("/packets/{packet_id}/audit-events")
def list_packet_audit_events(
    packet_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise error_response(
            "packet_not_found",
            f"Packet {packet_id!r} not found",
            status_code=404,
        )
    events = session.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_id == packet_id)
        .order_by(AuditEvent.created_at)
    ).all()
    return [_audit_event_to_dict_lazy(event) for event in events]


# ─── Review decisions ───────────────────────────────────────────────────


@router.post("/packets/{packet_id}/review-decisions", status_code=201)
def create_review_decision(
    packet_id: str,
    payload: dict,
    session: Session = Depends(get_session),
) -> dict:
    """Broker records an approve/block/request-more decision.

    Existing behavior: actor ID rides in the body; no JWT gate at the
    route level. The frontend enforces who-can-do-what; service
    validation guarantees domain invariants. Migrated as-is.
    """
    from app.main import ReviewDecisionCreate, record_review_decision

    body = ReviewDecisionCreate(**payload) if not isinstance(payload, ReviewDecisionCreate) else payload
    try:
        decision = record_review_decision(
            session=session,
            packet_id=packet_id,
            reviewer_id=body.reviewer_id,
            decision=body.decision,
            override_reason=body.override_reason,
            notes=body.notes,
        )
    except ValueError as e:
        raise error_response("review_decision_invalid", str(e), status_code=400)
    return _review_decision_to_dict_lazy(decision)
