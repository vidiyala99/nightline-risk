"""Service tests for the persisted broker-task overlay (Tier 1 #3).

The broker to-do feed (app/api/v1/tasks.py) is computed each request; this
overlay persists per-item intent (dismiss / snooze / done) keyed by the feed
item's stable id, plus broker-authored manual tasks. Mirrors the PolicyRequest
service conventions: typed lifecycle, audit on every transition, typed errors,
no commit in the service (router owns it).
"""
from datetime import date

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.lifecycles import InvalidTransitionError
from app.models import AuditEvent, BrokerTask
from app.services.broker_tasks import (
    BrokerTaskError,
    complete_task,
    create_manual_task,
    dismiss_task,
    overlays_by_key,
    reopen_task,
    snooze_task,
)


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_dismiss_creates_overlay_and_sets_status(session):
    t = dismiss_task(session, task_key="task-renewal-pol-1", actor_id="b1", kind="renewal")
    assert t.task_key == "task-renewal-pol-1"
    assert t.status == "dismissed"
    assert t.kind == "renewal"
    assert t.id.startswith("btask-")


def test_snooze_sets_until(session):
    until = date(2026, 7, 1)
    t = snooze_task(session, task_key="task-request-preq-1", actor_id="b1",
                    until=until, kind="request")
    assert t.status == "snoozed"
    assert t.snoozed_until == until


def test_second_action_reuses_same_overlay_row(session):
    snooze_task(session, task_key="k1", actor_id="b1", until=date(2026, 7, 1), kind="renewal")
    dismiss_task(session, task_key="k1", actor_id="b1")
    rows = session.exec(select(BrokerTask).where(BrokerTask.task_key == "k1")).all()
    assert len(rows) == 1          # overlay is get-or-create, not append
    assert rows[0].status == "dismissed"


def test_reopen_after_dismiss(session):
    dismiss_task(session, task_key="k1", actor_id="b1", kind="renewal")
    t = reopen_task(session, task_key="k1", actor_id="b1")
    assert t.status == "open"


def test_complete_task(session):
    t = complete_task(session, task_key="k1", actor_id="b1", kind="request")
    assert t.status == "done"


def test_overlays_by_key_indexes_rows(session):
    dismiss_task(session, task_key="k1", actor_id="b1", kind="renewal")
    snooze_task(session, task_key="k2", actor_id="b1", until=date(2026, 7, 1), kind="request")
    ov = overlays_by_key(session)
    assert set(ov.keys()) == {"k1", "k2"}
    assert ov["k1"].status == "dismissed"


def test_dismiss_emits_audit_event(session):
    t = dismiss_task(session, task_key="k1", actor_id="b1", kind="renewal")
    events = session.exec(select(AuditEvent).where(AuditEvent.entity_id == t.id)).all()
    assert any(e.event_type == "broker_task.dismissed" for e in events)


def test_create_manual_task_owns_its_key(session):
    t = create_manual_task(
        session, title="Call carrier re: Mirage", created_by="b1",
        note="follow up", due_date=date(2026, 6, 15),
    )
    assert t.kind == "manual"
    assert t.task_key == t.id
    assert t.status == "open"
    assert t.title == "Call carrier re: Mirage"


def test_illegal_transition_dismissed_to_snoozed_raises(session):
    dismiss_task(session, task_key="k1", actor_id="b1", kind="renewal")
    with pytest.raises(InvalidTransitionError):
        snooze_task(session, task_key="k1", actor_id="b1", until=date(2026, 7, 1))


def test_snooze_requires_until_date(session):
    with pytest.raises(BrokerTaskError, match="until"):
        snooze_task(session, task_key="k1", actor_id="b1", until=None, kind="renewal")
