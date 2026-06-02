"""Carrier underwriter desk — Phase 1 of the carrier persona.

Nightline's own underwriting desk (carrier role): see broker submissions awaiting
a decision, then quote-with-terms or decline. Gated `require_carrier` — distinct
from the broker, who places but does not underwrite.

  GET  /api/underwriting/queue                — quotes awaiting a decision
  POST /api/quotes/{quote_id}/underwrite      — render the underwriting decision
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.auth import require_carrier
from app.database import get_session
from app.models import CarrierQuote
from app.schemas.errors import error_response
from app.services.submissions import (
    PremiumBreakdownMismatchError,
    SubmissionsError,
)
from app.services.underwriting_desk import decision_dossier, request_info, underwrite_quote, underwriting_queue

router = APIRouter()


def _quote_to_dict(q: CarrierQuote) -> dict:
    return {
        "quote_id": q.id,
        "submission_id": q.submission_id,
        "carrier_id": q.carrier_id,
        "status": q.status,
        "premium_breakdown": q.premium_breakdown,
        "coverage_terms": q.coverage_terms,
        "decline_reason": q.decline_reason,
        "underwriter_name": q.underwriter_name,
        "info_request_note": q.info_request_note,
        "info_response_note": q.info_response_note,
    }


@router.get("/underwriting/queue")
def get_underwriting_queue(
    _user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> list[dict]:
    return underwriting_queue(session)


@router.post("/quotes/{quote_id}/underwrite")
def post_underwrite(
    quote_id: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    try:
        q = underwrite_quote(
            session,
            quote_id,
            decision=str(payload.get("decision", "")),
            underwriter_id=str(user.get("sub")),
            premium_breakdown=payload.get("premium_breakdown"),
            coverage_terms=payload.get("coverage_terms"),
            decline_reason=payload.get("decline_reason"),
        )
    except PremiumBreakdownMismatchError as e:
        raise error_response("premium_breakdown_mismatch", str(e), status_code=422)
    except SubmissionsError as e:
        raise error_response("underwriting_invalid", str(e), status_code=400)
    session.commit()
    session.refresh(q)
    return _quote_to_dict(q)


@router.post("/quotes/{quote_id}/request-info")
def post_request_info(
    quote_id: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    try:
        q = request_info(session, quote_id, note=str(payload.get("note", "")), underwriter_id=str(user.get("sub")))
    except SubmissionsError as e:
        raise error_response("request_info_invalid", str(e), status_code=400)
    session.commit()
    session.refresh(q)
    return _quote_to_dict(q)


@router.get("/underwriting/quotes/{quote_id}")
def get_decision_dossier(
    quote_id: str,
    _user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    d = decision_dossier(session, quote_id)
    if d is None:
        raise HTTPException(status_code=404, detail=f"Quote {quote_id} not found")
    return d
