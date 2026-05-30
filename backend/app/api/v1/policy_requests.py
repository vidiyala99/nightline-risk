"""FastAPI endpoints for operator→broker PolicyRequest objects (Tier 1 #1).

Mounted at /api by main.py.

Gating, by who acts in the real workflow:
  - create / cancel are operator-initiated → tenant-gated via
    require_venue_access(policy.venue_id, ...). Brokers (cross-venue) pass
    the same gate, which is harmless — the meaningful gate is the decision.
  - decide is broker-only → require_broker.

Error mapping mirrors the claims / policies routers:
  - PolicyRequestError → 400 (or 404 when the message says "not found")
  - InvalidTransitionError → 422 with the structured {error, message} envelope
  - service rollback on failure before re-raise
"""
from __future__ import annotations

from typing import Any, NoReturn, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker, require_venue_access
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import Policy, PolicyRequest
from app.services.policy_requests import (
    PolicyRequestError,
    cancel_policy_request,
    create_policy_request,
    decide_policy_request,
    list_policy_requests,
)


router = APIRouter()


# ─── Request/response models ────────────────────────────────────────────


class CreatePolicyRequestBody(BaseModel):
    request_type: str = Field(..., description="renewal | cancellation | coi | coverage_change")
    note: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


class DecideBody(BaseModel):
    decision: str = Field(..., description="approved | declined")
    decision_note: Optional[str] = None


def _request_to_dict(r: PolicyRequest) -> dict:
    return {
        "id": r.id,
        "policy_id": r.policy_id,
        "venue_id": r.venue_id,
        "request_type": r.request_type,
        "status": r.status,
        "requested_by": r.requested_by,
        "note": r.note,
        "payload": r.payload,
        "decided_by": r.decided_by,
        "decision_note": r.decision_note,
        "decided_at": r.decided_at.isoformat() if r.decided_at else None,
        "result_entity_type": r.result_entity_type,
        "result_entity_id": r.result_entity_id,
        "created_at": r.created_at.isoformat(),
        "updated_at": r.updated_at.isoformat(),
    }


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_transition", "message": str(e)},
        )
    if isinstance(e, PolicyRequestError):
        msg = str(e)
        status = 404 if "not found" in msg else 400
        raise HTTPException(
            status_code=status,
            detail={"error": "policy_request_error", "message": msg},
        )
    raise e


# ─── Create + decide + cancel ─────────────────────────────────────────────


@router.post("/policies/{pid}/requests", status_code=201)
def api_create_policy_request(
    pid: str,
    body: CreatePolicyRequestBody,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Operator raises a service request against their policy."""
    policy = session.get(Policy, pid)
    if policy is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    user = require_venue_access(policy.venue_id, authorization, session)
    try:
        req = create_policy_request(
            session,
            policy_id=pid,
            request_type=body.request_type,
            requested_by=user.get("sub") or "unknown",
            note=body.note,
            payload=body.payload,
        )
        session.commit()
        return _request_to_dict(req)
    except PolicyRequestError as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policy-requests/{rid}/decide", dependencies=[Depends(require_broker)])
def api_decide_policy_request(
    rid: str,
    body: DecideBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Broker approves or declines a pending request."""
    try:
        req = decide_policy_request(
            session,
            request_id=rid,
            decision=body.decision,
            decided_by=user_id,
            decision_note=body.decision_note,
        )
        session.commit()
        return _request_to_dict(req)
    except (PolicyRequestError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policy-requests/{rid}/cancel")
def api_cancel_policy_request(
    rid: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Operator withdraws their own still-pending request."""
    req = session.get(PolicyRequest, rid)
    if req is None:
        raise HTTPException(status_code=404, detail=f"PolicyRequest {rid} not found")
    user = require_venue_access(req.venue_id, authorization, session)
    try:
        updated = cancel_policy_request(
            session, request_id=rid, cancelled_by=user.get("sub") or "unknown",
        )
        session.commit()
        return _request_to_dict(updated)
    except (PolicyRequestError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


# ─── Reads ──────────────────────────────────────────────────────────────


@router.get("/policy-requests")
def api_list_policy_requests(
    venue_id: Optional[str] = None,
    policy_id: Optional[str] = None,
    status: Optional[str] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """Cross-venue request list (broker queue). No hard gate at the route
    level — the frontend filters by tenant for operators and shows all for
    brokers, matching the claim-proposals list. Optional filters scope
    server-side."""
    status_in = [s.strip() for s in status.split(",")] if status else None
    rows = list_policy_requests(
        session, venue_id=venue_id, policy_id=policy_id, status_in=status_in,
    )
    return [_request_to_dict(r) for r in rows]


@router.get("/policies/{pid}/requests")
def api_list_requests_for_policy(
    pid: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Requests against a single policy. Tenant-gated to the policy's venue."""
    policy = session.get(Policy, pid)
    if policy is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    require_venue_access(policy.venue_id, authorization, session)
    rows = list_policy_requests(session, policy_id=pid)
    return [_request_to_dict(r) for r in rows]
