"""FastAPI endpoints for the Phase 1 broker placement workflow.

Mounted at `/api` (NOT `/api/v1/`) by main.py — the plan's URL contract is
`/api/submissions/...`. All endpoints require broker/admin role via the
existing `require_broker` dependency; producer-role gating arrives in a
later RBAC commit.

Endpoints (in plan order):
  POST   /api/submissions                          create_submission
  GET    /api/submissions                          list_submissions
  GET    /api/submissions/transitions              transition matrix
  GET    /api/submissions/{sid}                    submission detail w/ quotes
  POST   /api/submissions/{sid}/submit             submit_to_market
  POST   /api/submissions/{sid}/withdraw           withdraw_submission

  POST   /api/quotes/{qid}/record-response         carrier reply (broker entry)
  POST   /api/quotes/{qid}/select                  select_quote
  POST   /api/quotes/{qid}/build-indicative        broker-path quote engine

  GET    /api/carriers                             list seed carriers
  GET    /api/carriers/{cid}                       carrier detail

  POST   /api/submissions/{sid}/acord/125          ACORD-style preview
  POST   /api/submissions/{sid}/acord/126          ACORD-style preview

A note on the ACORD endpoints: the plan flags ACORD form distribution as
copyright-protected (license required from ACORD Corp). The endpoints
generate ACORD-STYLE preview HTML labeled "Preview only. Not for
redistribution as an ACORD certificate." Production ship requires
licensing; this implementation is for the demo + portfolio.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import require_broker, verify_token
from app.database import get_session
from app.lifecycles import (
    SUBMISSION_TRANSITIONS,
    InvalidTransitionError,
    transition_table_to_json,
)
from app.models import Carrier, CarrierQuote, Submission
from app.services.submissions import (
    OutOfAppetiteError,
    PremiumBreakdownMismatchError,
    SubmissionsError,
    create_submission,
    list_submissions,
    mark_submission_declined,
    mark_submission_lost,
    record_carrier_response,
    select_quote,
    submit_to_market,
    update_submission,
    withdraw_submission,
)
from app.services.carriers import carrier_detail
from app.services.underwriting_desk import respond_to_info_request
from app.underwriting.pricing import (
    CARRIER_RATES,
    build_quote_for_carrier,
)


router = APIRouter()


# ─── Helpers ─────────────────────────────────────────────────────────────

def _broker_user_id(authorization: Optional[str] = Header(None)) -> str:
    """Returns the user_id for the authenticated broker/admin. `require_broker`
    is a separate dependency that 401/403s; this one extracts the user id
    from the same header for use as `actor_id` on audit events."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    decoded = verify_token(authorization.split(" ")[1])
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid token")
    return decoded.get("sub") or "unknown"


# ─── Request/response models ────────────────────────────────────────────

class CreateSubmissionBody(BaseModel):
    venue_id: str
    effective_date: date
    coverage_lines: list[str]
    requested_limits: dict = {}
    producer_id: Optional[str] = None
    notes: str = ""


class UpdateSubmissionBody(BaseModel):
    # All optional — only the fields provided are changed. Editing is allowed
    # only while the submission is still 'open' (service enforces this).
    effective_date: Optional[date] = None
    coverage_lines: Optional[list[str]] = None
    requested_limits: Optional[dict] = None
    producer_id: Optional[str] = None
    notes: Optional[str] = None


class SubmitToMarketBody(BaseModel):
    target_carriers: list[str]
    allow_out_of_appetite: bool = False


class WithdrawBody(BaseModel):
    reason: str


class RecordResponseBody(BaseModel):
    status: str                           # quoted | declined | expired | withdrawn
    premium_breakdown: Optional[dict] = None
    coverage_terms: Optional[dict] = None
    decline_reason: Optional[str] = None
    expires_at: Optional[datetime] = None
    underwriter_name: Optional[str] = None


def _submission_to_dict(sub: Submission) -> dict:
    return {
        "id": sub.id,
        "venue_id": sub.venue_id,
        "assigned_producer_id": sub.assigned_producer_id,
        "status": sub.status,
        "effective_date": sub.effective_date.isoformat(),
        "coverage_lines": sub.coverage_lines,
        "requested_limits": sub.requested_limits,
        "prior_policy_id": sub.prior_policy_id,
        "notes": sub.notes,
        "submitted_at": sub.submitted_at.isoformat() if sub.submitted_at else None,
        "bound_at": sub.bound_at.isoformat() if sub.bound_at else None,
        "created_at": sub.created_at.isoformat(),
        "updated_at": sub.updated_at.isoformat(),
    }


def _quote_to_dict(q: CarrierQuote) -> dict:
    return {
        "id": q.id,
        "submission_id": q.submission_id,
        "carrier_id": q.carrier_id,
        "status": q.status,
        "is_selected": q.is_selected,
        "requested_at": q.requested_at.isoformat(),
        "responded_at": q.responded_at.isoformat() if q.responded_at else None,
        "expires_at": q.expires_at.isoformat() if q.expires_at else None,
        "decline_reason": q.decline_reason,
        "premium_breakdown": q.premium_breakdown,
        "coverage_terms": q.coverage_terms,
        "underwriter_name": q.underwriter_name,
    }


def _carrier_to_dict(c: Carrier) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "market_type": c.market_type,
        "naic_code": c.naic_code,
        "appetite": c.appetite,
        "am_best_rating": c.am_best_rating,
        "contact_email": c.contact_email,
    }


# ─── Submissions ────────────────────────────────────────────────────────

@router.post("/submissions", status_code=201, dependencies=[Depends(require_broker)])
def api_create_submission(
    body: CreateSubmissionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        sub = create_submission(
            session,
            venue_id=body.venue_id,
            effective_date=body.effective_date,
            coverage_lines=body.coverage_lines,
            requested_limits=body.requested_limits,
            producer_id=body.producer_id,
            notes=body.notes,
            actor_id=user_id,
        )
        session.commit()
        return _submission_to_dict(sub)
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/submissions/{sid}", dependencies=[Depends(require_broker)])
def api_update_submission(
    sid: str,
    body: UpdateSubmissionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Edit a draft (open) submission's terms before it goes to market."""
    try:
        sub = update_submission(
            session,
            sid,
            actor_id=user_id,
            effective_date=body.effective_date,
            coverage_lines=body.coverage_lines,
            requested_limits=body.requested_limits,
            producer_id=body.producer_id,
            notes=body.notes,
        )
        session.commit()
        return _submission_to_dict(sub)
    except SubmissionsError as e:
        session.rollback()
        # "Unknown submission" → 404; "is <status>; only open" → 409 (conflict).
        msg = str(e)
        if "Unknown submission" in msg:
            raise HTTPException(status_code=404, detail=msg)
        if "can be edited" in msg:
            raise HTTPException(status_code=409, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@router.get("/submissions", dependencies=[Depends(require_broker)])
def api_list_submissions(
    status: Optional[str] = None,
    producer_id: Optional[str] = None,
    venue_id: Optional[str] = None,
    days_in_market_min: Optional[int] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """List submissions. `status` is comma-separated for multi-status filter:
    `?status=in_market,quoting`. Without a status filter, returns only
    non-terminal submissions (kanban view default)."""
    status_in = [s.strip() for s in status.split(",")] if status else None
    rows = list_submissions(
        session,
        status_in=status_in,
        producer_id=producer_id,
        venue_id=venue_id,
        days_in_market_min=days_in_market_min,
    )
    return [_submission_to_dict(r) for r in rows]


@router.get("/submissions/transitions")
def api_submission_transitions() -> dict:
    """Surface the lifecycle transition matrix so the frontend kanban can
    disable invalid drop targets client-side. Public — no auth required;
    this is a static contract, not user data."""
    return transition_table_to_json(SUBMISSION_TRANSITIONS)


@router.get("/submissions/{sid}", dependencies=[Depends(require_broker)])
def api_submission_detail(sid: str, session: Session = Depends(get_session)) -> dict:
    sub = session.get(Submission, sid)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"Submission {sid} not found")
    quotes = session.exec(
        select(CarrierQuote).where(CarrierQuote.submission_id == sid)
    ).all()
    return {
        **_submission_to_dict(sub),
        "quotes": [_quote_to_dict(q) for q in quotes],
    }


@router.post("/submissions/{sid}/submit", dependencies=[Depends(require_broker)])
def api_submit_to_market(
    sid: str,
    body: SubmitToMarketBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        result = submit_to_market(
            session,
            sid,
            target_carriers=body.target_carriers,
            submitted_by=user_id,
            allow_out_of_appetite=body.allow_out_of_appetite,
        )
        session.commit()
        return {
            "submission": _submission_to_dict(result.submission),
            "quotes_created": [_quote_to_dict(q) for q in result.quotes_created],
            "rejected_carriers": result.rejected_carriers,
        }
    except OutOfAppetiteError as e:
        session.rollback()
        raise HTTPException(status_code=422, detail={"error": "out_of_appetite", "message": str(e)})
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/submissions/{sid}/withdraw", dependencies=[Depends(require_broker)])
def api_withdraw_submission(
    sid: str,
    body: WithdrawBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        sub = withdraw_submission(session, sid, reason=body.reason, withdrawn_by=user_id)
        session.commit()
        return _submission_to_dict(sub)
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def _terminal_submission_response(
    fn, session: Session, sid: str, reason: str, actor_id: str
) -> dict:
    """Shared body for the decline/lose routes. Maps the lifecycle's two
    failure modes: an unknown/already-terminal submission → 400
    (SubmissionsError); an illegal from-state → 422 (InvalidTransitionError),
    matching the policies router's convention."""
    try:
        sub = fn(session, sid, reason=reason, actor_id=actor_id)
        session.commit()
        return _submission_to_dict(sub)
    except InvalidTransitionError as e:
        session.rollback()
        raise HTTPException(
            status_code=422, detail={"error": "invalid_transition", "message": str(e)}
        )
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/submissions/{sid}/decline", dependencies=[Depends(require_broker)])
def api_decline_submission(
    sid: str,
    body: WithdrawBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """All targeted carriers declined to quote → terminal 'declined'."""
    return _terminal_submission_response(
        mark_submission_declined, session, sid, body.reason, user_id
    )


@router.post("/submissions/{sid}/lose", dependencies=[Depends(require_broker)])
def api_lose_submission(
    sid: str,
    body: WithdrawBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Venue bound coverage elsewhere → terminal 'lost'."""
    return _terminal_submission_response(
        mark_submission_lost, session, sid, body.reason, user_id
    )


# ─── Quotes ─────────────────────────────────────────────────────────────

@router.post("/quotes/{qid}/record-response", dependencies=[Depends(require_broker)])
def api_record_carrier_response(
    qid: str,
    body: RecordResponseBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        q = record_carrier_response(
            session,
            qid,
            status=body.status,
            premium_breakdown=body.premium_breakdown,
            coverage_terms=body.coverage_terms,
            decline_reason=body.decline_reason,
            expires_at=body.expires_at,
            underwriter_name=body.underwriter_name,
            recorded_by=user_id,
        )
        session.commit()
        return _quote_to_dict(q)
    except PremiumBreakdownMismatchError as e:
        session.rollback()
        raise HTTPException(status_code=422, detail={"error": "premium_math_mismatch", "message": str(e)})
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/quotes/{qid}/select", dependencies=[Depends(require_broker)])
def api_select_quote(
    qid: str,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        q = select_quote(session, qid, selected_by=user_id)
        session.commit()
        return _quote_to_dict(q)
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/quotes/{qid}/build-indicative", dependencies=[Depends(require_broker)])
def api_build_indicative_quote(
    qid: str,
    session: Session = Depends(get_session),
) -> dict:
    """Run the broker-path quote engine on a CarrierQuote that's still
    waiting for the carrier's response. Returns the pricing engine's
    indicative number for the broker comparison view — the broker can
    still overwrite with the real carrier number via record-response.

    Does NOT persist; this is a read-only computation."""
    from app.seed_data import VENUES
    from app.underwriting.scoring import get_risk_score
    q = session.get(CarrierQuote, qid)
    if q is None:
        raise HTTPException(status_code=404, detail=f"Quote {qid} not found")
    sub = session.get(Submission, q.submission_id)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"Submission {q.submission_id} missing")
    carrier = session.get(Carrier, q.carrier_id)
    if carrier is None:
        raise HTTPException(status_code=404, detail=f"Carrier {q.carrier_id} missing")
    if sub.venue_id not in VENUES:
        raise HTTPException(status_code=400, detail=f"Unknown venue {sub.venue_id}")

    venue = {**VENUES[sub.venue_id], "id": sub.venue_id}
    risk = get_risk_score(sub.venue_id, VENUES, session=session)

    # Renewal pricing: if this submission renews a prior policy, re-price
    # using that term's realized losses (Phase 4 experience rating).
    loss_adjustment = None
    if sub.prior_policy_id:
        from app.services.renewals import compute_loss_experience
        from app.underwriting.pricing import loss_adjustment_from_loss_ratio
        exp = compute_loss_experience(session, sub.prior_policy_id)
        loss_adjustment = loss_adjustment_from_loss_ratio(exp.loss_ratio)

    full_quote = build_quote_for_carrier(
        venue=venue,
        coverage_lines=sub.coverage_lines,
        carrier_id=carrier.id,
        market_type=carrier.market_type,
        risk_score=risk,
        requested_limits=sub.requested_limits,
        loss_adjustment=loss_adjustment,
    )
    return full_quote.to_json_dict()


# ─── Carriers ───────────────────────────────────────────────────────────

@router.get("/carriers", dependencies=[Depends(require_broker)])
def api_list_carriers(session: Session = Depends(get_session)) -> list[dict]:
    rows = session.exec(select(Carrier).order_by(Carrier.name)).all()
    return [_carrier_to_dict(c) for c in rows]


@router.get("/carriers/{cid}", dependencies=[Depends(require_broker)])
def api_carrier_detail(cid: str, session: Session = Depends(get_session)) -> dict:
    c = session.get(Carrier, cid)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Carrier {cid} not found")
    body = _carrier_to_dict(c)
    # Book rollup + policy list (the money this carrier is doing in our book) —
    # additive keys so existing consumers of this shape are unaffected.
    detail = carrier_detail(session, cid)
    body["book"] = detail["book"]
    body["policies"] = detail["policies"]
    # Include the rate table override values (multipliers, fee, commission)
    # so the broker UI can show "Markel charges 1.10x for liquor lines" etc.
    if cid in CARRIER_RATES:
        rates = CARRIER_RATES[cid]
        body["rate_overrides"] = {
            "venue_multipliers": {k: str(v) for k, v in rates.get("venue_multipliers", {}).items()},
            "line_multipliers": {k: str(v) for k, v in rates.get("line_multipliers", {}).items()},
            "policy_fee": str(rates.get("policy_fee", "")),
            "commission_rate": str(rates.get("commission_rate", "")),
        }
    return body


# ─── ACORD-style previews (NOT licensed ACORD distribution) ─────────────

ACORD_DISCLAIMER = (
    "Preview only. Not for redistribution as an ACORD certificate. "
    "Production use requires an ACORD license from acord.org."
)


@router.post("/submissions/{sid}/acord/125", dependencies=[Depends(require_broker)])
def api_acord_125_preview(sid: str, session: Session = Depends(get_session)) -> dict:
    """ACORD-style 125 (Commercial Insurance Application — Applicant) preview.
    Returns a structured dict the frontend renders as an ACORD-style form
    with the required disclaimer footer."""
    sub = session.get(Submission, sid)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"Submission {sid} not found")
    from app.seed_data import VENUES
    venue = VENUES.get(sub.venue_id, {})
    return {
        "form_type": "ACORD 125 (style preview)",
        "disclaimer": ACORD_DISCLAIMER,
        "applicant": {
            "name": venue.get("name", ""),
            "address": venue.get("address", ""),
            "venue_type": venue.get("venue_type", ""),
            "capacity": venue.get("capacity"),
            "years_in_operation": venue.get("years_in_operation"),
        },
        "policy_information": {
            "effective_date": sub.effective_date.isoformat(),
            "coverage_lines_requested": sub.coverage_lines,
            "requested_limits": sub.requested_limits,
        },
        "submission_id": sub.id,
    }


@router.post("/submissions/{sid}/acord/126", dependencies=[Depends(require_broker)])
def api_acord_126_preview(sid: str, session: Session = Depends(get_session)) -> dict:
    """ACORD-style 126 (Commercial General Liability Section) preview."""
    sub = session.get(Submission, sid)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"Submission {sid} not found")
    from app.seed_data import VENUES
    venue = VENUES.get(sub.venue_id, {})
    return {
        "form_type": "ACORD 126 (style preview)",
        "disclaimer": ACORD_DISCLAIMER,
        "applicant_name": venue.get("name", ""),
        "general_liability": {
            "limits_requested": sub.requested_limits.get("gl", {}),
            "incident_history": {
                "incident_count": venue.get("incident_count"),
                "prior_carrier": venue.get("prior_carrier"),
            },
            "security_level": venue.get("security_level"),
        },
        "submission_id": sub.id,
    }


@router.post("/quotes/{qid}/info-response", dependencies=[Depends(require_broker)])
def api_info_response(qid: str, payload: dict, session: Session = Depends(get_session)) -> dict:
    try:
        q = respond_to_info_request(session, qid, note=str(payload.get("note", "")), responder_id="broker")
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    session.commit()
    session.refresh(q)
    return _quote_to_dict(q)
