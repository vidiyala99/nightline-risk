"""Broker to-do feed — a proactive view over work that's currently pull-only.

Composes existing surfaces into one prioritized "needs your attention" list,
computed on each request:
  - Renewal reminders: active policies expiring within 90 days, bucketed by
    urgency (overdue / urgent ≤30 / soon ≤60 / upcoming ≤90).
  - Pending operator PolicyRequests: renewals/cancellations/COIs/changes
    awaiting a broker decision.

A persisted BrokerTask overlay (app/services/broker_tasks.py) layers per-item
broker intent on top WITHOUT changing the read shape: dismissed/snoozed/done
items are hidden, broker-authored `manual` tasks are merged in, and the action
endpoints (dismiss / snooze / complete / reopen / create) record the state.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, NoReturn, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import BrokerTask, Policy
from app.services.broker_tasks import (
    BrokerTaskError,
    complete_task,
    create_manual_task,
    dismiss_task,
    overlays_by_key,
    reopen_task,
    snooze_task,
)
from app.services.policy_requests import list_policy_requests

router = APIRouter()

RENEWAL_WINDOW_DAYS = 90


def _renewal_urgency(days_until: int) -> tuple[int, str]:
    """Return (sort_rank, label). Lower rank = more urgent / shown first."""
    if days_until <= 0:
        return (0, "overdue")
    if days_until <= 30:
        return (1, "urgent")
    if days_until <= 60:
        return (3, "soon")
    return (4, "upcoming")


# Pending requests slot between urgent (≤30d) and soon (≤60d) renewals —
# they need a decision now, but an overdue/urgent renewal outranks them.
_REQUEST_RANK = 2
# Manual broker tasks: dated ones sort by due date like renewals; undated ones
# sit just after pending requests.
_MANUAL_RANK = 2


def _kind_from_key(task_key: str) -> str:
    if task_key.startswith("task-renewal-"):
        return "renewal"
    if task_key.startswith("task-request-"):
        return "request"
    return "overlay"


def _visible(overlay: Optional[BrokerTask], today: date) -> tuple[bool, str]:
    """(visible?, effective_status) for a computed item given its overlay.
    A snooze whose date has passed reverts to visible/open."""
    if overlay is None:
        return True, "open"
    if overlay.status in ("dismissed", "done"):
        return False, overlay.status
    if overlay.status == "snoozed":
        if overlay.snoozed_until and overlay.snoozed_until > today:
            return False, "snoozed"
        return True, "open"
    return True, "open"


def _map_service_error(e: Exception) -> NoReturn:
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(status_code=422,
                            detail={"error": "invalid_transition", "message": str(e)})
    if isinstance(e, BrokerTaskError):
        msg = str(e)
        status = 404 if "no broker task" in msg.lower() else 400
        raise HTTPException(status_code=status,
                            detail={"error": "broker_task_error", "message": msg})
    raise e


# ─── Read ──────────────────────────────────────────────────────────────────


@router.get("/broker/tasks", dependencies=[Depends(require_broker)])
def broker_tasks(session: Session = Depends(get_session)) -> list[dict]:
    """Prioritized broker to-do feed with the persisted overlay applied."""
    today = date.today()
    cutoff = today + timedelta(days=RENEWAL_WINDOW_DAYS)
    overlays = overlays_by_key(session)
    tasks: list[dict] = []

    pols = session.exec(
        select(Policy)
        .where(Policy.status == "active")
        .where(Policy.expiration_date <= cutoff)
        .order_by(Policy.expiration_date)
    ).all()
    for p in pols:
        days_until = (p.expiration_date - today).days
        rank, urgency = _renewal_urgency(days_until)
        tasks.append({
            "id": f"task-renewal-{p.id}", "kind": "renewal", "urgency": urgency,
            "title": p.policy_number or p.id, "venue_id": p.venue_id,
            "due_date": p.expiration_date.isoformat(), "days_until": days_until,
            "ref_id": p.id, "_rank": rank, "_sort": days_until,
        })

    for r in list_policy_requests(session, status_in=["pending"]):
        tasks.append({
            "id": f"task-request-{r.id}", "kind": "request", "urgency": "action",
            "title": r.request_type, "venue_id": r.venue_id, "due_date": None,
            "note": r.note, "ref_id": r.id, "_rank": _REQUEST_RANK, "_sort": 0,
        })

    # Broker-authored manual tasks (task_key == id, not in the computed set).
    for ov in overlays.values():
        if ov.kind != "manual":
            continue
        days_until = (ov.due_date - today).days if ov.due_date else 0
        tasks.append({
            "id": ov.task_key, "kind": "manual", "urgency": "todo",
            "title": ov.title, "venue_id": ov.venue_id,
            "due_date": ov.due_date.isoformat() if ov.due_date else None,
            "note": ov.note, "ref_id": ov.id,
            "_rank": _MANUAL_RANK, "_sort": days_until,
        })

    # Apply overlay visibility + annotate status, then sort + strip sort keys.
    visible: list[dict] = []
    for t in tasks:
        show, status = _visible(overlays.get(t["id"]), today)
        if not show:
            continue
        t["status"] = status
        visible.append(t)

    visible.sort(key=lambda t: (t["_rank"], t["_sort"]))
    for t in visible:
        t.pop("_rank", None)
        t.pop("_sort", None)
    return visible


# ─── Overlay actions ─────────────────────────────────────────────────────────


class SnoozeBody(BaseModel):
    until: date


class ManualTaskBody(BaseModel):
    title: str
    note: str = ""
    due_date: Optional[date] = None
    venue_id: Optional[str] = None


def _task_to_dict(t: BrokerTask) -> dict[str, Any]:
    return {
        "id": t.id, "task_key": t.task_key, "kind": t.kind, "status": t.status,
        "ref_id": t.ref_id, "venue_id": t.venue_id, "title": t.title, "note": t.note,
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "snoozed_until": t.snoozed_until.isoformat() if t.snoozed_until else None,
        "created_at": t.created_at.isoformat(), "updated_at": t.updated_at.isoformat(),
    }


@router.post("/broker/tasks", status_code=201, dependencies=[Depends(require_broker)])
def api_create_manual_task(
    body: ManualTaskBody,
    user: dict = Depends(require_broker),
    session: Session = Depends(get_session),
) -> dict:
    """Create a broker-authored to-do."""
    try:
        task = create_manual_task(
            session, title=body.title, created_by=user.get("sub") or "broker",
            note=body.note, due_date=body.due_date, venue_id=body.venue_id,
        )
        session.commit()
        return _task_to_dict(task)
    except BrokerTaskError as e:
        session.rollback()
        _map_service_error(e)


@router.post("/broker/tasks/{task_key}/dismiss", dependencies=[Depends(require_broker)])
def api_dismiss_task(
    task_key: str, user: dict = Depends(require_broker),
    session: Session = Depends(get_session),
) -> dict:
    try:
        t = dismiss_task(session, task_key=task_key, actor_id=user.get("sub") or "broker",
                         kind=_kind_from_key(task_key))
        session.commit()
        return _task_to_dict(t)
    except (BrokerTaskError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/broker/tasks/{task_key}/snooze", dependencies=[Depends(require_broker)])
def api_snooze_task(
    task_key: str, body: SnoozeBody, user: dict = Depends(require_broker),
    session: Session = Depends(get_session),
) -> dict:
    try:
        t = snooze_task(session, task_key=task_key, actor_id=user.get("sub") or "broker",
                        until=body.until, kind=_kind_from_key(task_key))
        session.commit()
        return _task_to_dict(t)
    except (BrokerTaskError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/broker/tasks/{task_key}/complete", dependencies=[Depends(require_broker)])
def api_complete_task(
    task_key: str, user: dict = Depends(require_broker),
    session: Session = Depends(get_session),
) -> dict:
    try:
        t = complete_task(session, task_key=task_key, actor_id=user.get("sub") or "broker",
                          kind=_kind_from_key(task_key))
        session.commit()
        return _task_to_dict(t)
    except (BrokerTaskError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/broker/tasks/{task_key}/reopen", dependencies=[Depends(require_broker)])
def api_reopen_task(
    task_key: str, user: dict = Depends(require_broker),
    session: Session = Depends(get_session),
) -> dict:
    try:
        t = reopen_task(session, task_key=task_key, actor_id=user.get("sub") or "broker")
        session.commit()
        return _task_to_dict(t)
    except (BrokerTaskError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)
