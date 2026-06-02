"""FastAPI endpoints for Phase 3 claims integration.

Mounted at /api by main.py. All endpoints broker/admin-gated via
require_broker. Error mapping mirrors the placement / policies routers:

  - ClaimsError → 400
  - InvalidTransitionError → 422 with structured {error, message}
  - Service rollback on failure before re-raise
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker, require_venue_access
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import Claim, ClaimPayment, Policy, ReserveChange
from app.services.claims import (
    ClaimsError,
    attach_defense_package_to_claim,
    claims_for_policy,
    close_claim,
    file_fnol,
    list_claims,
    payments_for_claim,
    record_carrier_reserve,
    record_payment,
    reopen_claim,
    reserve_history_for_claim,
)


router = APIRouter()


# ─── Request/response models ────────────────────────────────────────────


class FileFnolBody(BaseModel):
    coverage_line: str = Field(..., min_length=1)
    date_of_loss: date
    incident_id: Optional[str] = None
    proposal_id: Optional[str] = None
    defense_package_id: Optional[str] = None
    carrier_claim_number: Optional[str] = None
    adjuster_name: Optional[str] = None
    adjuster_email: Optional[str] = None


class RecordReserveBody(BaseModel):
    new_reserve: Decimal
    change_reason: str = Field(..., min_length=1)
    received_from: str = Field(..., min_length=1)
    received_at: datetime


class RecordPaymentBody(BaseModel):
    amount: Decimal
    payment_type: str = Field(..., description="'indemnity' | 'expense' | 'recovery'")
    paid_on: date
    description: str = ""


class CloseClaimBody(BaseModel):
    disposition: str = Field(..., description="'paid' | 'denied' | 'dropped'")
    final_indemnity: Optional[Decimal] = None


class ReopenClaimBody(BaseModel):
    reason: str = Field(..., min_length=1)


class AttachDefensePackageBody(BaseModel):
    defense_package_id: str = Field(..., min_length=1)


def _claim_to_dict(c: Claim) -> dict:
    return {
        "id": c.id,
        "policy_id": c.policy_id,
        "incident_id": c.incident_id,
        "proposal_id": c.proposal_id,
        "carrier_claim_number": c.carrier_claim_number,
        "coverage_line": c.coverage_line,
        "status": c.status,
        "date_of_loss": c.date_of_loss.isoformat(),
        "fnol_submitted_at": c.fnol_submitted_at.isoformat(),
        "current_reserve": str(c.current_reserve),
        "indemnity_paid_to_date": str(c.indemnity_paid_to_date),
        "expense_paid_to_date": str(c.expense_paid_to_date),
        "recoveries_to_date": str(c.recoveries_to_date),
        "final_indemnity": str(c.final_indemnity) if c.final_indemnity is not None else None,
        "total_incurred": str(c.total_incurred) if c.total_incurred is not None else None,
        "closed_at": c.closed_at.isoformat() if c.closed_at else None,
        "reopened_at": c.reopened_at.isoformat() if c.reopened_at else None,
        "reopen_count": c.reopen_count,
        "adjuster_name": c.adjuster_name,
        "adjuster_email": c.adjuster_email,
        "defense_package_id": c.defense_package_id,
        "coverage_decision": c.coverage_decision,
        "coverage_rationale": c.coverage_rationale,
        "snapshot_hash": c.snapshot_hash,
    }


def _payment_to_dict(p: ClaimPayment) -> dict:
    return {
        "id": p.id,
        "claim_id": p.claim_id,
        "payment_type": p.payment_type,
        "amount": str(p.amount),
        "paid_on": p.paid_on.isoformat(),
        "description": p.description,
        "recorded_by": p.recorded_by,
        "recorded_at": p.recorded_at.isoformat(),
    }


def _reserve_change_to_dict(r: ReserveChange) -> dict:
    return {
        "id": r.id,
        "claim_id": r.claim_id,
        "from_amount": str(r.from_amount),
        "to_amount": str(r.to_amount),
        "change_reason": r.change_reason,
        "received_from": r.received_from,
        "received_at": r.received_at.isoformat(),
        "recorded_by": r.recorded_by,
        "recorded_at": r.recorded_at.isoformat(),
    }


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_transition", "message": str(e)},
        )
    if isinstance(e, ClaimsError):
        raise HTTPException(status_code=400, detail=str(e))
    raise e


# ─── Claims ──────────────────────────────────────────────────────────────


@router.post("/policies/{pid}/claims", status_code=201, dependencies=[Depends(require_broker)])
def api_file_fnol(
    pid: str,
    body: FileFnolBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        claim = file_fnol(
            session,
            policy_id=pid,
            coverage_line=body.coverage_line,
            date_of_loss=body.date_of_loss,
            incident_id=body.incident_id,
            proposal_id=body.proposal_id,
            defense_package_id=body.defense_package_id,
            carrier_claim_number=body.carrier_claim_number,
            adjuster_name=body.adjuster_name,
            adjuster_email=body.adjuster_email,
            filed_by=user_id,
        )
        session.commit()
        return _claim_to_dict(claim)
    except (ClaimsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/policies/{pid}/claims", dependencies=[Depends(require_broker)])
def api_list_claims_for_policy(
    pid: str,
    status: Optional[str] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    if session.get(Policy, pid) is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    if status is None:
        status_in = None
    elif status == "all":
        status_in = ["all"]
    else:
        status_in = [s.strip() for s in status.split(",")]
    rows = claims_for_policy(session, pid, status_in=status_in)
    return [_claim_to_dict(c) for c in rows]


@router.get("/claims", dependencies=[Depends(require_broker)])
def api_list_claims(
    status: Optional[str] = None,
    venue_id: Optional[str] = None,
    carrier_id: Optional[str] = None,
    open_only: bool = False,
    session: Session = Depends(get_session),
) -> list[dict]:
    """Cross-policy carrier-claim list. Drives the broker's top-level
    portfolio page (/claims on web) and the mobile "Carrier Claims"
    tab badge.

    Query params:
      status      Comma-separated ClaimStatus values, or "all" to
                  drop the filter entirely. Default: all.
      venue_id    Filter by Policy.venue_id (joined).
      carrier_id  Filter by Policy.carrier_id (joined).
      open_only   Shortcut: only non-closed claims. Mutually exclusive
                  with `status`; raises 400 if both are provided.

    Note on route ordering: this is registered BEFORE
    GET /api/claims/{cid} so FastAPI's path resolver disambiguates
    literal "/claims" against the {cid} path-param route.
    """
    if status is None:
        status_in = None
    elif status == "all":
        status_in = ["all"]
    else:
        status_in = [s.strip() for s in status.split(",")]

    try:
        rows = list_claims(
            session,
            status_in=status_in,
            venue_id=venue_id,
            carrier_id=carrier_id,
            open_only=open_only,
        )
    except ClaimsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return [_claim_to_dict(c) for c in rows]


@router.get("/venues/{venue_id}/claims")
def api_list_venue_claims(
    venue_id: str,
    open_only: bool = False,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Venue-scoped, read-only carrier-claim list — the operator's
    closed-loop view.

    Kills the post-incident black box: an operator reports an incident,
    a broker files it as a Claim, and *this* is where the operator sees
    that it became a real claim (status + reserve + carrier claim #).

    Auth is the broad venue gate (`require_venue_access`), so it admits:
      - the venue's own operator (their tenant or an extra_venue_ids row),
      - any broker/admin (cross-venue portfolio access).
    Anonymous → 401, other-venue operator → 403.

    Read-only by design: every claim *mutation* stays on the
    broker-gated /claims* routes. This is purely a window.
    """
    require_venue_access(venue_id, authorization, session)
    rows = list_claims(session, venue_id=venue_id, open_only=open_only)
    return [_claim_to_dict(c) for c in rows]


@router.get("/claims/{cid}", dependencies=[Depends(require_broker)])
def api_claim_detail(cid: str, session: Session = Depends(get_session)) -> dict:
    c = session.get(Claim, cid)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Claim {cid} not found")
    payments = payments_for_claim(session, cid)
    reserves = reserve_history_for_claim(session, cid)
    return {
        **_claim_to_dict(c),
        "payments": [_payment_to_dict(p) for p in payments],
        "reserve_changes": [_reserve_change_to_dict(r) for r in reserves],
    }


# ─── Reserves ───────────────────────────────────────────────────────────


@router.post("/claims/{cid}/carrier-reserve", dependencies=[Depends(require_broker)])
def api_record_carrier_reserve(
    cid: str,
    body: RecordReserveBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        c = record_carrier_reserve(
            session, cid,
            new_reserve=body.new_reserve,
            change_reason=body.change_reason,
            received_from=body.received_from,
            received_at=body.received_at,
            recorded_by=user_id,
        )
        session.commit()
        return _claim_to_dict(c)
    except (ClaimsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/claims/{cid}/reserve-history", dependencies=[Depends(require_broker)])
def api_reserve_history(cid: str, session: Session = Depends(get_session)) -> list[dict]:
    if session.get(Claim, cid) is None:
        raise HTTPException(status_code=404, detail=f"Claim {cid} not found")
    rows = reserve_history_for_claim(session, cid)
    return [_reserve_change_to_dict(r) for r in rows]


# ─── Payments ───────────────────────────────────────────────────────────


@router.post("/claims/{cid}/payments", status_code=201, dependencies=[Depends(require_broker)])
def api_record_payment(
    cid: str,
    body: RecordPaymentBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        p = record_payment(
            session, cid,
            amount=body.amount,
            payment_type=body.payment_type,
            paid_on=body.paid_on,
            description=body.description,
            recorded_by=user_id,
        )
        session.commit()
        return _payment_to_dict(p)
    except (ClaimsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/claims/{cid}/payments", dependencies=[Depends(require_broker)])
def api_list_payments(cid: str, session: Session = Depends(get_session)) -> list[dict]:
    if session.get(Claim, cid) is None:
        raise HTTPException(status_code=404, detail=f"Claim {cid} not found")
    rows = payments_for_claim(session, cid)
    return [_payment_to_dict(p) for p in rows]


# ─── Close / Reopen ─────────────────────────────────────────────────────


@router.post("/claims/{cid}/close", dependencies=[Depends(require_broker)])
def api_close_claim(
    cid: str,
    body: CloseClaimBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        c = close_claim(
            session, cid,
            disposition=body.disposition,
            final_indemnity=body.final_indemnity,
            closed_by=user_id,
        )
        session.commit()
        return _claim_to_dict(c)
    except (ClaimsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/claims/{cid}/reopen", dependencies=[Depends(require_broker)])
def api_reopen_claim(
    cid: str,
    body: ReopenClaimBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        c = reopen_claim(
            session, cid,
            reason=body.reason,
            reopened_by=user_id,
        )
        session.commit()
        return _claim_to_dict(c)
    except (ClaimsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


# ─── Defense package ────────────────────────────────────────────────────


@router.post("/claims/{cid}/defense-package", dependencies=[Depends(require_broker)])
def api_attach_defense_package(
    cid: str,
    body: AttachDefensePackageBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        c = attach_defense_package_to_claim(
            session, cid,
            defense_package_id=body.defense_package_id,
            attached_by=user_id,
        )
        session.commit()
        return _claim_to_dict(c)
    except ClaimsError as e:
        session.rollback()
        _map_service_error(e)
