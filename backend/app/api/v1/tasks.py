"""Broker to-do feed — a proactive view over work that's currently pull-only.

Composes two existing surfaces into one prioritized "needs your attention"
list, computed (not persisted) on each request:
  - Renewal reminders: active policies expiring within 90 days, bucketed by
    urgency (overdue / urgent ≤30 / soon ≤60 / upcoming ≤90).
  - Pending operator PolicyRequests: renewals/cancellations/COIs/changes
    awaiting a broker decision.

This is the lightweight foundation for the roadmap's task/diary surface; a
persisted BrokerTask with dismiss/snooze can layer on later without changing
the read shape.
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.models import Policy
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


@router.get("/broker/tasks", dependencies=[Depends(require_broker)])
def broker_tasks(session: Session = Depends(get_session)) -> list[dict]:
    """Prioritized broker to-do feed (renewal reminders + pending requests)."""
    today = date.today()
    cutoff = today + timedelta(days=RENEWAL_WINDOW_DAYS)
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
            "id": f"task-renewal-{p.id}",
            "kind": "renewal",
            "urgency": urgency,
            "title": p.policy_number or p.id,
            "venue_id": p.venue_id,
            "due_date": p.expiration_date.isoformat(),
            "days_until": days_until,
            "ref_id": p.id,
            "_rank": rank,
            "_sort": days_until,
        })

    for r in list_policy_requests(session, status_in=["pending"]):
        tasks.append({
            "id": f"task-request-{r.id}",
            "kind": "request",
            "urgency": "action",
            "title": r.request_type,
            "venue_id": r.venue_id,
            "due_date": None,
            "note": r.note,
            "ref_id": r.id,
            "_rank": _REQUEST_RANK,
            "_sort": 0,
        })

    tasks.sort(key=lambda t: (t["_rank"], t["_sort"]))
    for t in tasks:
        t.pop("_rank", None)
        t.pop("_sort", None)
    return tasks
