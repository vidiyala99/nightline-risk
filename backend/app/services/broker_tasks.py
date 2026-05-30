"""BrokerTask service — persisted overlay on the broker to-do feed (Tier 1 #3).

The feed (app/api/v1/tasks.py) is computed each request from renewals +
pending PolicyRequests. This service persists per-item broker intent on top —
dismiss / snooze / done — keyed by the feed item's stable id (`task_key`),
plus broker-authored `manual` tasks. The read joins these overlays so the feed
hides dismissed/snoozed items without changing its shape.

Conventions mirror services/policy_requests.py:
  - typed lifecycle in app.lifecycles (BrokerTaskStatus / TRANSITIONS),
  - every state change goes through `_transition_broker_task`
    (assert_valid_transition + audit event),
  - typed BrokerTaskError for validation; InvalidTransitionError for illegal
    moves (router maps these to 400 / 422),
  - the router owns commit/rollback — this layer only flushes.
"""
from __future__ import annotations

from datetime import date
from typing import Optional
from uuid import uuid4

from sqlmodel import Session, select

from app.lifecycles import BROKER_TASK_TRANSITIONS, assert_valid_transition
from app.models import BrokerTask
from app.packet_core import _add_audit_event
from app.time import now_utc


class BrokerTaskError(Exception):
    """Base error for the broker-task service (validation / not-found)."""


# ─── lifecycle helper ──────────────────────────────────────────────────────


def _transition_broker_task(
    session: Session, task: BrokerTask, *, to: str, actor_id: str,
    metadata: Optional[dict] = None,
) -> BrokerTask:
    from_status = task.status
    assert_valid_transition(
        BROKER_TASK_TRANSITIONS, from_status, to, entity_name="BrokerTask",
    )
    task.status = to
    task.updated_at = now_utc()
    session.add(task)
    _add_audit_event(
        session=session, actor_id=actor_id, actor_type="user",
        entity_type="broker_task", entity_id=task.id,
        event_type=f"broker_task.{to}",
        event_metadata={"from": from_status, "to": to, "task_key": task.task_key,
                        **(metadata or {})},
    )
    return task


def _get_or_create_overlay(
    session: Session, *, task_key: str, kind: str, actor_id: str,
    ref_id: Optional[str] = None, venue_id: Optional[str] = None,
    title: str = "",
) -> BrokerTask:
    """Find the overlay row for a feed item, creating it (status='open') on
    first action so dismiss/snooze have a row to transition."""
    existing = session.exec(
        select(BrokerTask).where(BrokerTask.task_key == task_key)
    ).first()
    if existing is not None:
        return existing
    task = BrokerTask(
        id=f"btask-{uuid4().hex[:12]}",
        task_key=task_key, kind=kind or "overlay", status="open",
        ref_id=ref_id, venue_id=venue_id, title=title, created_by=actor_id,
    )
    session.add(task)
    session.flush()  # assign the row before the audit event references its id
    return task


def _set_state(
    session: Session, *, task_key: str, to: str, actor_id: str,
    kind: str = "", ref_id: Optional[str] = None, venue_id: Optional[str] = None,
    until: Optional[date] = None, metadata: Optional[dict] = None,
) -> BrokerTask:
    task = _get_or_create_overlay(
        session, task_key=task_key, kind=kind, actor_id=actor_id,
        ref_id=ref_id, venue_id=venue_id,
    )
    task.snoozed_until = until if to == "snoozed" else None
    return _transition_broker_task(
        session, task, to=to, actor_id=actor_id, metadata=metadata,
    )


# ─── broker actions ────────────────────────────────────────────────────────


def dismiss_task(
    session: Session, *, task_key: str, actor_id: str,
    kind: str = "", ref_id: Optional[str] = None, venue_id: Optional[str] = None,
) -> BrokerTask:
    """Hide a feed item the broker has chosen to ignore."""
    return _set_state(session, task_key=task_key, to="dismissed", actor_id=actor_id,
                      kind=kind, ref_id=ref_id, venue_id=venue_id)


def snooze_task(
    session: Session, *, task_key: str, actor_id: str, until: Optional[date],
    kind: str = "", ref_id: Optional[str] = None, venue_id: Optional[str] = None,
) -> BrokerTask:
    """Hide a feed item until `until`. Requires a date."""
    if until is None:
        raise BrokerTaskError("snooze requires an `until` date")
    return _set_state(session, task_key=task_key, to="snoozed", actor_id=actor_id,
                      until=until, kind=kind, ref_id=ref_id, venue_id=venue_id)


def complete_task(
    session: Session, *, task_key: str, actor_id: str,
    kind: str = "", ref_id: Optional[str] = None, venue_id: Optional[str] = None,
) -> BrokerTask:
    """Mark a feed item done."""
    return _set_state(session, task_key=task_key, to="done", actor_id=actor_id,
                      kind=kind, ref_id=ref_id, venue_id=venue_id)


def reopen_task(session: Session, *, task_key: str, actor_id: str) -> BrokerTask:
    """Bring a dismissed/snoozed/done item back to 'open'."""
    task = session.exec(
        select(BrokerTask).where(BrokerTask.task_key == task_key)
    ).first()
    if task is None:
        raise BrokerTaskError(f"No broker task overlay for {task_key!r}")
    return _transition_broker_task(session, task, to="open", actor_id=actor_id)


def create_manual_task(
    session: Session, *, title: str, created_by: str,
    note: str = "", due_date: Optional[date] = None,
    venue_id: Optional[str] = None,
) -> BrokerTask:
    """A broker-authored to-do that isn't derived from a computed feed item.
    Owns its own key (task_key == id) so it appears in the feed read."""
    if not title.strip():
        raise BrokerTaskError("manual task requires a title")
    tid = f"btask-{uuid4().hex[:12]}"
    task = BrokerTask(
        id=tid, task_key=tid, kind="manual", status="open",
        title=title, note=note, due_date=due_date, venue_id=venue_id,
        created_by=created_by,
    )
    session.add(task)
    session.flush()
    _add_audit_event(
        session=session, actor_id=created_by, actor_type="user",
        entity_type="broker_task", entity_id=tid,
        event_type="broker_task.created",
        event_metadata={"kind": "manual", "title": title},
    )
    return task


# ─── reads ─────────────────────────────────────────────────────────────────


def overlays_by_key(session: Session) -> dict[str, BrokerTask]:
    """All overlay rows indexed by task_key (one row per key by construction)."""
    rows = session.exec(select(BrokerTask)).all()
    return {r.task_key: r for r in rows}
