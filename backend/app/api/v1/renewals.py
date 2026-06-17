"""FastAPI endpoints for Phase 4 renewals. Mounted at /api by main.py.
Broker-gated. Error mapping mirrors the claims/policies routers:
  RenewalsError -> 400, InvalidTransitionError -> 422."""
from __future__ import annotations

from decimal import Decimal

from datetime import date, timedelta
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import Policy
from app.money import usd_to_json
from app.services.renewals import (
    RenewalsError,
    build_experience_years_for_policy,
    create_renewal,
    find_live_renewal,
)
from app.underwriting.experience_rating import compute_experience_mod

router = APIRouter()


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_transition", "message": str(e)},
        )
    if isinstance(e, RenewalsError):
        raise HTTPException(
            status_code=400,
            detail={"error": "renewals_error", "message": str(e)},
        )
    raise e


class RenewBody(BaseModel):
    effective_date: date


@router.get("/renewals/due", dependencies=[Depends(require_broker)])
def renewals_due(
    within_days: int = 60,
    session: Session = Depends(get_session),
) -> list[dict]:
    cutoff = date.today() + timedelta(days=within_days)
    rows = session.exec(
        select(Policy)
        .where(Policy.status == "active")
        .where(Policy.expiration_date <= cutoff)
        .order_by(Policy.expiration_date)
    )
    out: list[dict] = []
    for pol in rows:
        # A policy with a renewal already in flight (or already bound) is no
        # longer "due" — it's being worked. Surfacing it would nag the broker
        # forever and invite a duplicate renewal.
        if find_live_renewal(session, pol.id) is not None:
            continue
        years = build_experience_years_for_policy(
            session, pol.id,
            annual_premium=pol.annual_premium,
            years_back=0,
        )
        mod = compute_experience_mod(years)
        out.append({
            "policy_id": pol.id,
            "policy_number": pol.policy_number,
            "venue_id": pol.venue_id,
            "expiration_date": pol.expiration_date.isoformat(),
            "annual_premium": usd_to_json(pol.annual_premium),
            "loss_ratio": str(mod.experience_lr),
            "claim_count": mod.claim_count,
            "credibility_z": str(mod.credibility_z.quantize(Decimal("0.0001"))),
            "projected_loss_adjustment": str(mod.mod),
        })
    return out


@router.post(
    "/policies/{policy_id}/renew",
    status_code=201,
    dependencies=[Depends(require_broker)],
)
def renew_policy(
    policy_id: str,
    body: RenewBody,
    session: Session = Depends(get_session),
    actor_id: str = Depends(_broker_user_id),
) -> dict:
    try:
        prior = session.get(Policy, policy_id)
        if prior is None:
            raise HTTPException(status_code=404, detail=f"Policy {policy_id} not found")
        years = build_experience_years_for_policy(
            session, policy_id,
            annual_premium=prior.annual_premium,
            years_back=0,
        )
        mod = compute_experience_mod(years)
        sub = create_renewal(
            session,
            policy_id,
            effective_date=body.effective_date,
            actor_id=actor_id,
        )
        session.commit()
        session.refresh(sub)
    except (RenewalsError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)

    return {
        "submission": {
            "id": sub.id,
            "venue_id": sub.venue_id,
            "status": sub.status,
            "prior_policy_id": sub.prior_policy_id,
            "coverage_lines": sub.coverage_lines,
            "requested_limits": sub.requested_limits,
            "effective_date": sub.effective_date.isoformat(),
        },
        "yoy_context": {
            "prior_policy_id": policy_id,
            "prior_annual_premium": usd_to_json(prior.annual_premium),
            "prior_coverage_lines": prior.coverage_lines,
            "loss_ratio": str(mod.experience_lr),
            "claim_count": mod.claim_count,
            "credibility_z": str(mod.credibility_z.quantize(Decimal("0.0001"))),
            "loss_adjustment": str(mod.mod),
        },
    }
