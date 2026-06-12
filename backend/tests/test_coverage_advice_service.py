"""CoverageAdviceRecord service — the broker E&O documentation artifact.

A clause-cited coverage advice item (gap / exclusion) that the broker surfaced,
then acknowledged and actioned. The acknowledge/action transition IS the
"I advised, on this clause, at this time" record that defuses a failure-to-inform
E&O claim, so the lifecycle + audit trail are the whole point."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import SQLModel, Session, create_engine, select

import app.models  # noqa: F401
from app.models import AuditEvent, CoverageAdviceRecord, Policy
from app.lifecycles import InvalidTransitionError
from app.services.coverage_advice import (
    CoverageAdviceError,
    record_coverage_advice,
    transition_coverage_advice,
)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _policy(session: Session, pid: str = "pol-1", venue_id: str = "v1") -> Policy:
    p = Policy(
        id=pid, submission_id="s1", bound_quote_id="q1", venue_id=venue_id,
        carrier_id="c1", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("0"), commission_amount=Decimal("0"),
        commission_rate=Decimal("0"), coverage_lines=["gl"],
    )
    session.add(p)
    session.commit()
    return p


def _record(session: Session, **over):
    kw = dict(
        venue_id="v1", policy_id="pol-1", kind="exclusion_review",
        summary="A&B excluded but it's the venue's top loss.",
        cited_node_ids=["node-ab", "node-liq"], loss_category="assault_battery",
        actor_id="user-broker-1",
    )
    kw.update(over)
    return record_coverage_advice(session, **kw)


def test_record_creates_surfaced_item_with_hashed_id():
    s = _fresh_session()
    _policy(s)
    rec = _record(s)
    s.commit()
    assert rec.id.startswith("covadvice-")
    assert rec.status == "surfaced"
    assert rec.venue_id == "v1"
    assert rec.policy_id == "pol-1"
    assert rec.kind == "exclusion_review"
    assert sorted(rec.cited_node_ids) == ["node-ab", "node-liq"]


def test_record_is_idempotent_on_same_inputs():
    s = _fresh_session()
    _policy(s)
    a = _record(s)
    s.commit()
    b = _record(s)
    s.commit()
    assert a.id == b.id
    assert len(s.exec(select(CoverageAdviceRecord)).all()) == 1


def test_record_id_is_stable_under_node_id_reordering():
    """node_ids are sorted before hashing — Postgres list-order drift must not
    mint a duplicate advice row."""
    s = _fresh_session()
    _policy(s)
    a = _record(s, cited_node_ids=["node-ab", "node-liq"])
    s.commit()
    b = _record(s, cited_node_ids=["node-liq", "node-ab"])
    s.commit()
    assert a.id == b.id


def test_record_rejects_unknown_kind():
    s = _fresh_session()
    _policy(s)
    with pytest.raises(CoverageAdviceError):
        _record(s, kind="not_a_kind")


def test_record_rejects_missing_policy():
    s = _fresh_session()
    with pytest.raises(CoverageAdviceError):
        _record(s, policy_id="nope")


def test_acknowledge_then_action_transitions_and_audits():
    s = _fresh_session()
    _policy(s)
    rec = _record(s)
    s.commit()

    transition_coverage_advice(s, advice_id=rec.id, to="acknowledged", actor_id="user-broker-1")
    s.commit()
    assert s.get(CoverageAdviceRecord, rec.id).status == "acknowledged"

    transition_coverage_advice(s, advice_id=rec.id, to="actioned", actor_id="user-broker-1")
    s.commit()
    rec2 = s.get(CoverageAdviceRecord, rec.id)
    assert rec2.status == "actioned"
    assert rec2.actor_id == "user-broker-1"

    events = s.exec(
        select(AuditEvent).where(AuditEvent.entity_id == rec.id)
    ).all()
    types = {e.event_type for e in events}
    assert "coverage_advice.acknowledged" in types
    assert "coverage_advice.actioned" in types


def test_cannot_skip_straight_to_actioned():
    s = _fresh_session()
    _policy(s)
    rec = _record(s)
    s.commit()
    with pytest.raises(InvalidTransitionError):
        transition_coverage_advice(s, advice_id=rec.id, to="actioned", actor_id="b1")


def test_dismissed_is_terminal():
    s = _fresh_session()
    _policy(s)
    rec = _record(s)
    s.commit()
    transition_coverage_advice(s, advice_id=rec.id, to="dismissed", actor_id="b1")
    s.commit()
    with pytest.raises(InvalidTransitionError):
        transition_coverage_advice(s, advice_id=rec.id, to="acknowledged", actor_id="b1")


def test_transition_unknown_id_raises_not_found():
    s = _fresh_session()
    with pytest.raises(CoverageAdviceError):
        transition_coverage_advice(s, advice_id="covadvice-missing", to="acknowledged", actor_id="b1")
