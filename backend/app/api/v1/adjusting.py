"""Carrier claims adjudication — adjuster desk (carrier persona, Phase 2).
All routes carrier-gated. The broker's /api/claims/* relay routes are untouched."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.auth import require_carrier
from app.database import get_session
from app.schemas.errors import error_response
from app.services.claims import ClaimsError
from app.services.adjusting import (
    adjuster_queue,
    adjust_reserve,
    approve_payment,
    close_claim_as_carrier,
    decide_coverage,
    reserve_hint,
)
from app.lifecycles import InvalidTransitionError
from app.models import Claim, ClaimPayment, Policy, ReserveChange

router = APIRouter()


def _incident_report(session, claim) -> dict | None:
    """The AI incident report + numbers behind this claim (risk signal, memo,
    expected-payout recommendation, evidence). Failure-isolated → None."""
    try:
        from app.models import UnderwritingPacket
        from sqlmodel import select as _select
        from app.claim_routing import recommendation_for_packet
        from app.claim_recommendation import recommendation_to_dict
        packet = None
        if claim.defense_package_id:
            packet = session.get(UnderwritingPacket, claim.defense_package_id)
        if packet is None and claim.incident_id:
            packet = session.exec(
                _select(UnderwritingPacket).where(UnderwritingPacket.incident_id == claim.incident_id)
            ).first()
        if packet is None:
            return None
        rs = packet.risk_signals or {}
        rec = None
        try:
            rec = recommendation_to_dict(recommendation_for_packet(session, packet))
        except Exception:
            rec = None
        return {
            "packet_id": packet.id,
            "severity": rs.get("severity"),
            "confidence": rs.get("confidence"),
            "explanation": rs.get("explanation"),
            "memo_summary": (packet.memo or {}).get("summary"),
            "recommendation": rec,                 # expected_payout numbers etc.
            "citation_count": len(packet.citation_ids or []),
            "corroboration_status": packet.corroboration_status,
        }
    except Exception:
        return None


def _venue_name(session, venue_id):
    from app.seed_data import VENUES
    if not venue_id:
        return None
    from app.models import Venue
    row = session.get(Venue, venue_id)
    if row and getattr(row, "name", None):
        return row.name
    return VENUES.get(venue_id, {}).get("name", venue_id)


def _claim_out(c: Claim) -> dict:
    return {
        "id": c.id,
        "status": c.status,
        "coverage_line": c.coverage_line,
        "coverage_decision": c.coverage_decision,
        "coverage_rationale": c.coverage_rationale,
        "current_reserve": str(c.current_reserve),
        "indemnity_paid_to_date": str(c.indemnity_paid_to_date),
        "expense_paid_to_date": str(c.expense_paid_to_date),
        "recoveries_to_date": str(c.recoveries_to_date),
    }


@router.get("/adjusting/queue")
def get_adjuster_queue(
    _u: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> list[dict]:
    return adjuster_queue(session)


@router.get("/adjusting/claims/{cid}")
def get_adjuster_claim(
    cid: str,
    _u: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    c = session.get(Claim, cid)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Claim {cid} not found")
    payments = session.exec(select(ClaimPayment).where(ClaimPayment.claim_id == cid)).all()
    reserves = session.exec(select(ReserveChange).where(ReserveChange.claim_id == cid)).all()
    pol = session.get(Policy, c.policy_id) if c.policy_id else None
    return {
        "claim": _claim_out(c),
        "venue_id": pol.venue_id if pol else None,
        "venue_name": _venue_name(session, pol.venue_id if pol else None),
        "incident_report": _incident_report(session, c),
        "date_of_loss": c.date_of_loss.isoformat() if c.date_of_loss else None,
        "payments": [
            {
                "id": p.id,
                "payment_type": p.payment_type,
                "amount": str(p.amount),
                "paid_on": p.paid_on.isoformat(),
                "description": p.description,
            }
            for p in payments
        ],
        "reserve_history": [
            {
                "id": r.id,
                "from_amount": str(r.from_amount),
                "to_amount": str(r.to_amount),
                "change_reason": r.change_reason,
                "received_at": r.received_at.isoformat(),
            }
            for r in reserves
        ],
        "reserve_hint": reserve_hint(session, c),
    }


def _act(fn):
    try:
        return fn()
    except InvalidTransitionError as e:
        raise error_response("invalid_transition", str(e), status_code=422)
    except ClaimsError as e:
        raise error_response("claims_invalid", str(e), status_code=400)


@router.post("/adjusting/claims/{cid}/decide-coverage")
def post_decide_coverage(
    cid: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    c = _act(
        lambda: decide_coverage(
            session,
            cid,
            decision=str(payload.get("decision", "")),
            rationale=str(payload.get("rationale", "")),
            adjuster_id=str(user.get("sub")),
        )
    )
    session.commit()
    session.refresh(c)
    return _claim_out(c)


@router.post("/adjusting/claims/{cid}/reserve")
def post_reserve(
    cid: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    c = _act(
        lambda: adjust_reserve(
            session,
            cid,
            new_reserve=Decimal(str(payload.get("new_reserve", "0"))),
            change_reason=str(payload.get("change_reason", "")),
            adjuster_id=str(user.get("sub")),
        )
    )
    session.commit()
    session.refresh(c)
    return _claim_out(c)


@router.post("/adjusting/claims/{cid}/payment")
def post_payment(
    cid: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    _act(
        lambda: approve_payment(
            session,
            cid,
            amount=Decimal(str(payload.get("amount", "0"))),
            payment_type=str(payload.get("payment_type", "")),
            paid_on=date.fromisoformat(str(payload.get("paid_on"))),
            description=str(payload.get("description", "")),
            adjuster_id=str(user.get("sub")),
        )
    )
    session.commit()
    return _claim_out(session.get(Claim, cid))


@router.post("/adjusting/claims/{cid}/close")
def post_close(
    cid: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    fi = payload.get("final_indemnity")
    c = _act(
        lambda: close_claim_as_carrier(
            session,
            cid,
            disposition=str(payload.get("disposition", "")),
            final_indemnity=Decimal(str(fi)) if fi is not None else None,
            adjuster_id=str(user.get("sub")),
        )
    )
    session.commit()
    session.refresh(c)
    return _claim_out(c)
