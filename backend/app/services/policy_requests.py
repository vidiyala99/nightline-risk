"""PolicyRequest service — operator→broker policy service requests (Tier 1 #1).

An operator can't transact policy lifecycle directly (bind / cancel / renew /
COI are broker-gated). This service is the structured way for them to *ask*:
the operator raises a request, it lands in the broker's queue, and the broker
approves or declines it. The operator may withdraw a still-pending request.

Conceptually mirrors ClaimProposal (propose→decide), but built to the modern
broker-platform conventions:
  - typed lifecycle in app.lifecycles (PolicyRequestStatus / TRANSITIONS),
  - every state change goes through `_transition_policy_request`, which calls
    `assert_valid_transition` and emits an audit event,
  - typed `PolicyRequestError` for validation; `InvalidTransitionError` for
    illegal lifecycle moves (router maps these to 400 / 422 respectively),
  - the router owns commit/rollback — this layer only flushes.
"""
from __future__ import annotations

from typing import Optional
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import (
    POLICY_REQUEST_TRANSITIONS,
    assert_valid_transition,
)
from app.models import Policy, PolicyRequest
from app.packet_core import _add_audit_event
from app.time import now_utc


# ─── Errors + allowed values ──────────────────────────────────────────────


class PolicyRequestError(Exception):
    """Base error for the policy-request service (validation / not-found)."""


VALID_REQUEST_TYPES: frozenset[str] = frozenset(
    {"renewal", "cancellation", "coi", "coverage_change"}
)

# Broker decisions are the two non-terminal-by-operator outcomes. Cancellation
# is operator-only and goes through cancel_policy_request, not decide.
VALID_DECISIONS: frozenset[str] = frozenset({"approved", "declined"})


# ─── Lifecycle helper ──────────────────────────────────────────────────────


def _transition_policy_request(
    session: Session,
    req: PolicyRequest,
    *,
    to: str,
    actor_id: str,
    metadata: Optional[dict] = None,
) -> PolicyRequest:
    from_status = req.status
    assert_valid_transition(
        POLICY_REQUEST_TRANSITIONS, from_status, to, entity_name="PolicyRequest"
    )
    req.status = to
    req.updated_at = now_utc()
    session.add(req)
    _add_audit_event(
        session=session,
        actor_id=actor_id, actor_type="user",
        entity_type="policy_request", entity_id=req.id,
        event_type=f"policy_request.{to}",
        event_metadata={"from": from_status, "to": to, **(metadata or {})},
    )
    return req


# ─── create ─────────────────────────────────────────────────────────────────


def create_policy_request(
    session: Session,
    *,
    policy_id: str,
    request_type: str,
    requested_by: str,
    note: str = "",
    payload: Optional[dict] = None,
) -> PolicyRequest:
    """Operator raises a request against an in-force policy. Starts 'pending'."""
    if request_type not in VALID_REQUEST_TYPES:
        raise PolicyRequestError(
            f"Invalid request_type {request_type!r}. "
            f"Must be one of: {sorted(VALID_REQUEST_TYPES)}"
        )
    policy = session.get(Policy, policy_id)
    if policy is None:
        raise PolicyRequestError(f"Policy {policy_id!r} not found")

    req = PolicyRequest(
        id=f"preq-{uuid4().hex[:12]}",
        policy_id=policy_id,
        venue_id=policy.venue_id,
        request_type=request_type,
        status="pending",
        requested_by=requested_by,
        note=note,
        payload=payload or {},
    )
    session.add(req)
    session.flush()  # assign the row before the audit event references its id
    _add_audit_event(
        session=session,
        actor_id=requested_by, actor_type="user",
        entity_type="policy_request", entity_id=req.id,
        event_type="policy_request.pending",
        event_metadata={"request_type": request_type, "policy_id": policy_id},
    )
    return req


# ─── decide (broker) ──────────────────────────────────────────────────────


def decide_policy_request(
    session: Session,
    *,
    request_id: str,
    decision: str,
    decided_by: str,
    decision_note: Optional[str] = None,
) -> PolicyRequest:
    """Broker approves or declines a pending request."""
    if decision not in VALID_DECISIONS:
        raise PolicyRequestError(
            f"Invalid decision {decision!r}. Must be one of: {sorted(VALID_DECISIONS)}"
        )
    req = session.get(PolicyRequest, request_id)
    if req is None:
        raise PolicyRequestError(f"PolicyRequest {request_id!r} not found")

    _transition_policy_request(
        session, req, to=decision, actor_id=decided_by,
        metadata={"decision_note": decision_note} if decision_note else None,
    )
    req.decided_by = decided_by
    req.decision_note = decision_note
    req.decided_at = now_utc()
    session.add(req)
    return req


# ─── cancel (operator) ──────────────────────────────────────────────────────


def cancel_policy_request(
    session: Session,
    *,
    request_id: str,
    cancelled_by: str,
) -> PolicyRequest:
    """Operator withdraws their own still-pending request."""
    req = session.get(PolicyRequest, request_id)
    if req is None:
        raise PolicyRequestError(f"PolicyRequest {request_id!r} not found")
    _transition_policy_request(
        session, req, to="cancelled", actor_id=cancelled_by,
    )
    return req


# ─── list ─────────────────────────────────────────────────────────────────


def list_policy_requests(
    session: Session,
    *,
    venue_id: Optional[str] = None,
    policy_id: Optional[str] = None,
    status_in: Optional[list[str]] = None,
) -> list[PolicyRequest]:
    """Filtered list, newest first. Brokers see all; operators scope by venue."""
    stmt = select(PolicyRequest).order_by(PolicyRequest.created_at.desc())
    if venue_id:
        stmt = stmt.where(PolicyRequest.venue_id == venue_id)
    if policy_id:
        stmt = stmt.where(PolicyRequest.policy_id == policy_id)
    if status_in:
        stmt = stmt.where(PolicyRequest.status.in_(status_in))  # type: ignore[attr-defined]
    return list(session.exec(stmt).all())
