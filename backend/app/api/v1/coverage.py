"""Coverage-advice API — the broker records, acknowledges, and actions the
clause-cited E&O advice trail produced by the coverage findings.

Mounted at /api by main.py. Broker-gated (the advice trail is the broker's own
E&O documentation). Error mapping mirrors the policy_requests / claims routers:
  - CoverageAdviceError → 400 (404 when the message says "not found")
  - InvalidTransitionError → 422 with the structured {error, message} envelope
"""
from __future__ import annotations

from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import CoverageAdviceRecord
from app.services.coverage_advice import (
    CoverageAdviceError,
    record_coverage_advice,
    transition_coverage_advice,
)

router = APIRouter()


class RecordAdviceBody(BaseModel):
    venue_id: str
    policy_id: str
    kind: str = Field(..., description="gap | exclusion_review | exclusion_bite")
    summary: str
    cited_node_ids: list[str] = Field(default_factory=list)
    loss_category: Optional[str] = None


class TransitionBody(BaseModel):
    to: str = Field(..., description="acknowledged | actioned | dismissed")
    note: Optional[str] = None


def _to_dict(r: CoverageAdviceRecord) -> dict:
    return {
        "id": r.id,
        "venue_id": r.venue_id,
        "policy_id": r.policy_id,
        "kind": r.kind,
        "loss_category": r.loss_category,
        "cited_node_ids": r.cited_node_ids,
        "summary": r.summary,
        "status": r.status,
        "actor_id": r.actor_id,
        "created_at": r.created_at.isoformat(),
        "updated_at": r.updated_at.isoformat(),
    }


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_transition", "message": str(e)},
        )
    if isinstance(e, CoverageAdviceError):
        msg = str(e)
        status = 404 if "not found" in msg else 400
        raise HTTPException(
            status_code=status,
            detail={"error": "coverage_advice_error", "message": msg},
        )
    raise e


@router.post("/coverage-advice", status_code=201, dependencies=[Depends(require_broker)])
def api_record_coverage_advice(
    body: RecordAdviceBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Broker freezes a coverage advice item (idempotent; starts 'surfaced')."""
    try:
        rec = record_coverage_advice(
            session,
            venue_id=body.venue_id,
            policy_id=body.policy_id,
            kind=body.kind,
            summary=body.summary,
            cited_node_ids=body.cited_node_ids,
            loss_category=body.loss_category,
            actor_id=user_id,
        )
        session.commit()
        return _to_dict(rec)
    except CoverageAdviceError as e:
        session.rollback()
        _map_service_error(e)


@router.post("/coverage-advice/{aid}/transition", dependencies=[Depends(require_broker)])
def api_transition_coverage_advice(
    aid: str,
    body: TransitionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Broker acknowledges / actions / dismisses an advice item — the E&O trail."""
    try:
        rec = transition_coverage_advice(
            session, advice_id=aid, to=body.to, actor_id=user_id, note=body.note,
        )
        session.commit()
        return _to_dict(rec)
    except (CoverageAdviceError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/venues/{venue_id}/coverage-advice", dependencies=[Depends(require_broker)])
def api_list_coverage_advice(
    venue_id: str,
    session: Session = Depends(get_session),
) -> list[dict]:
    """The venue's coverage-advice trail, newest first."""
    rows = session.exec(
        select(CoverageAdviceRecord)
        .where(CoverageAdviceRecord.venue_id == venue_id)
        .order_by(CoverageAdviceRecord.created_at.desc())
    ).all()
    return [_to_dict(r) for r in rows]
