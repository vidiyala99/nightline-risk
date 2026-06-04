"""Surplus-lines compliance HTTP surface. Broker-wide; operators scoped to
their own venue. Error mapping: SurplusLinesError -> 400,
InvalidTransitionError -> 422."""
from __future__ import annotations

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.lifecycles import (
    SL_FILING_TRANSITIONS,
    InvalidTransitionError,
    transition_table_to_json,
)
from app.models import SurplusLinesFiling
from app.services.surplus_lines import (
    SurplusLinesError,
    confirm_filing,
    file_filing,
    filings_needing_attention,
    record_declination,
    void_filing,
)

router = APIRouter()


class DeclinationBody(BaseModel):
    submission_id: str
    carrier_name: str
    reason: str
    declined_at: str           # ISO date
    carrier_naic: str | None = None


class ConfirmBody(BaseModel):
    transaction_id: str


class VoidBody(BaseModel):
    reason: str


def _map_error(exc: Exception) -> NoReturn:
    if isinstance(exc, InvalidTransitionError):
        raise HTTPException(status_code=422, detail={"error": "invalid_transition", "message": str(exc)})
    if isinstance(exc, SurplusLinesError):
        raise HTTPException(status_code=400, detail={"error": "surplus_lines_error", "message": str(exc)})
    raise exc


def _filing_json(f: SurplusLinesFiling) -> dict:
    return {
        "id": f.id, "policy_id": f.policy_id, "venue_id": f.venue_id,
        "state": f.state, "status": f.status,
        "taxable_premium": str(f.taxable_premium),
        "surplus_lines_tax": str(f.surplus_lines_tax),
        "stamping_fee": str(f.stamping_fee),
        "total_charges": str(f.total_charges),
        "filing_deadline": f.filing_deadline.isoformat(),
        "diligent_search_complete": f.diligent_search_complete,
        "export_list_exempt": f.export_list_exempt,
        "transaction_id": f.transaction_id,
        "documents": list((f.documents or {}).keys()),
    }


@router.get("/surplus-lines/transitions")
def sl_transitions(_: dict = Depends(require_broker)):
    return transition_table_to_json(SL_FILING_TRANSITIONS)


@router.get("/surplus-lines/filings")
def list_filings(
    status: str | None = None,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    q = select(SurplusLinesFiling)
    if status:
        q = q.where(SurplusLinesFiling.status == status)
    return [_filing_json(f) for f in session.exec(q).all()]


@router.get("/surplus-lines/attention")
def attention(session: Session = Depends(get_session), _: dict = Depends(require_broker)):
    return filings_needing_attention(session)


@router.get("/surplus-lines/filings/{filing_id}")
def get_filing(
    filing_id: str,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    f = session.get(SurplusLinesFiling, filing_id)
    if f is None:
        raise HTTPException(status_code=404, detail="Filing not found")
    return _filing_json(f)


@router.post("/surplus-lines/declinations")
def add_declination(
    body: DeclinationBody,
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
):
    from datetime import date as _date
    d = record_declination(
        session, body.submission_id, carrier_name=body.carrier_name,
        reason=body.reason, declined_at=_date.fromisoformat(body.declined_at),
        carrier_naic=body.carrier_naic, recorded_by=user.get("sub"),
    )
    session.commit()
    return {"id": d.id, "submission_id": d.submission_id}


def _act(session, user, action, *args, **kwargs):
    try:
        row = action(session, *args, actor_id=user.get("sub", "unknown"), **kwargs)
        session.commit()
        return _filing_json(row)
    except (SurplusLinesError, InvalidTransitionError) as exc:
        session.rollback()
        _map_error(exc)


@router.post("/surplus-lines/filings/{filing_id}/file")
def post_file(filing_id: str, session: Session = Depends(get_session),
              user: dict = Depends(require_broker)):
    return _act(session, user, file_filing, filing_id)


@router.post("/surplus-lines/filings/{filing_id}/confirm")
def post_confirm(filing_id: str, body: ConfirmBody, session: Session = Depends(get_session),
                 user: dict = Depends(require_broker)):
    return _act(session, user, confirm_filing, filing_id, transaction_id=body.transaction_id)


@router.post("/surplus-lines/filings/{filing_id}/void")
def post_void(filing_id: str, body: VoidBody, session: Session = Depends(get_session),
              user: dict = Depends(require_broker)):
    return _act(session, user, void_filing, filing_id, reason=body.reason)


@router.get("/surplus-lines/filings/{filing_id}/documents/{kind}")
def get_document(
    filing_id: str, kind: str,
    session: Session = Depends(get_session),
    _: dict = Depends(require_broker),
):
    f = session.get(SurplusLinesFiling, filing_id)
    if f is None or kind not in (f.documents or {}):
        raise HTTPException(status_code=404, detail="Document not found")
    from app.storage import get_storage
    data = get_storage().read(f.documents[kind])
    return Response(content=data, media_type="application/pdf")
