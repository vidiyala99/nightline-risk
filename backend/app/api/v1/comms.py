# backend/app/api/v1/comms.py
"""Comms-connector HTTP surface: trigger ingestion, read the review queue, and
resolve (confirm/correct/dismiss) low-confidence items. Broker-wide; operators
are scoped to their own venue."""
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import can_access_venue, current_user_optional, require_broker
from app.database import get_session
from app.ingestion.comms.connector import run_comms
from app.ingestion.comms.router import _create_compliance, _create_incident
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem, Venue
from app.packet_core import _add_audit_event

router = APIRouter()


class IngestBody(BaseModel):
    source: str = "all"          # slack | tickets | sms | all


class ResolveBody(BaseModel):
    decision: str                 # confirm | correct | dismiss
    kind: str | None = None       # required for "correct": incident | compliance | noise


def _all_venue_ids(session: Session) -> list[str]:
    return [v.id for v in session.exec(select(Venue)).all()]


@router.post("/comms/ingest")
def comms_ingest(
    body: IngestBody,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    return run_comms(body.source, session, venue_ids=_all_venue_ids(session))


@router.get("/comms/review")
def comms_review(
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    user = current_user_optional(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    q = select(CommsReviewItem).where(CommsReviewItem.status == "pending")
    rows = session.exec(q).all()
    if user.get("role") not in ("broker", "admin"):
        rows = [r for r in rows if can_access_venue(user, r.venue_id, session)]
    return [
        {"id": r.id, "venue_id": r.venue_id, "source": r.source, "raw_text": r.raw_text,
         "proposed_kind": r.proposed_kind, "confidence": r.confidence, "rationale": r.rationale}
        for r in rows
    ]


@router.post("/comms/review/{review_id}/resolve")
def comms_resolve(
    review_id: str,
    body: ResolveBody,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    user = current_user_optional(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    row = session.get(CommsReviewItem, review_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Review item not found")
    if not can_access_venue(user, row.venue_id, session):
        raise HTTPException(status_code=403, detail="No access to this venue")

    kind = row.proposed_kind if body.decision == "confirm" else body.kind
    if body.decision == "correct" and kind not in ("incident", "compliance", "noise"):
        raise HTTPException(status_code=400, detail={"error": "comms_error", "message": "correct needs a valid kind"})

    item = CommsItem(source=row.source, venue_id=row.venue_id, external_id=row.external_id,
                     text=row.raw_text, occurred_at=row.occurred_at, author=row.author)
    classification = CommsClassification(kind=kind or "noise", confidence=1.0, fields=row.fields)

    created = None
    if body.decision != "dismiss" and kind == "incident":
        created = _create_incident(session, item, classification).id
    elif body.decision != "dismiss" and kind == "compliance":
        created = _create_compliance(session, item, classification).id

    row.status = "dismissed" if body.decision == "dismiss" else ("confirmed" if body.decision == "confirm" else "corrected")
    row.resolved_by = user.get("sub")
    row.resolved_kind = kind
    session.add(row)
    _add_audit_event(
        session=session, actor_id=user.get("sub") or "unknown", actor_type="user",
        entity_type="comms_review", entity_id=row.id,
        event_type=f"comms_review.{body.decision}",
        event_metadata={"venue_id": row.venue_id, "resolved_kind": kind, "created": created},
    )
    session.commit()
    return {"status": row.status, "resolved_kind": kind, "created": created}
