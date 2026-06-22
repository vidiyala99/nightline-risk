from __future__ import annotations

from sqlmodel import Session, SQLModel, create_engine

from app.models import AgentRun, IncidentRecord
from app.services.agent_runs import list_runs, resolve_run_venue

BROKER = {"role": "broker", "sub": "u-broker"}


def _op(venue_id: str) -> dict:
    return {"role": "venue_operator", "sub": f"u-{venue_id}", "tenant_id": venue_id}


def _session() -> Session:
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _incident(session: Session, *, id: str, venue_id: str) -> IncidentRecord:
    inc = IncidentRecord(
        id=id, venue_id=venue_id, occurred_at="2026-06-01T00:00:00Z",
        location="floor", summary="s", reported_by="r",
        injury_observed=False, police_called=False, ems_called=False,
    )
    session.add(inc)
    session.flush()
    return inc


def _run(session: Session, *, entity_type=None, entity_id=None, id=None) -> AgentRun:
    run = AgentRun(
        id=id or f"arun-{entity_id or 'none'}", agent_name="risk_evaluator_agent",
        agent_kind="pipeline", contract_version="v1", provider="groq",
        model="m", input_hash="h", entity_type=entity_type, entity_id=entity_id,
        status="succeeded", outcome="success",
    )
    session.add(run)
    session.flush()
    return run


def test_resolve_run_venue_incident_returns_its_venue():
    s = _session()
    _incident(s, id="inc-1", venue_id="venue-A")
    run = _run(s, entity_type="incident", entity_id="inc-1")
    assert resolve_run_venue(run, s) == "venue-A"


def test_resolve_run_venue_null_entity_returns_none():
    s = _session()
    run = _run(s, entity_type=None, entity_id=None)
    assert resolve_run_venue(run, s) is None


def test_resolve_run_venue_missing_incident_returns_none():
    s = _session()
    run = _run(s, entity_type="incident", entity_id="inc-gone")
    assert resolve_run_venue(run, s) is None


def _seed_two_venues(s: Session) -> None:
    _incident(s, id="inc-A", venue_id="venue-A")
    _incident(s, id="inc-B", venue_id="venue-B")
    _run(s, entity_type="incident", entity_id="inc-A")
    _run(s, entity_type="incident", entity_id="inc-B")
    _run(s, entity_type=None, entity_id=None)  # null-entity run


def test_broker_sees_all_runs_including_null_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(BROKER, s)
    assert len(runs) == 3


def test_operator_sees_only_own_venue_and_not_null_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(_op("venue-A"), s)
    ids = {r.entity_id for r in runs}
    assert ids == {"inc-A"}  # not inc-B, not the null-entity run


def test_per_entity_history_filters_to_that_entity():
    s = _session()
    _seed_two_venues(s)
    runs = list_runs(BROKER, s, entity_type="incident", entity_id="inc-B")
    assert [r.entity_id for r in runs] == ["inc-B"]


def test_limit_is_clamped_and_applied():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    for i in range(5):
        _run(s, entity_type="incident", entity_id="inc-A", id=f"arun-{i}")
    assert len(list_runs(BROKER, s, limit=2)) == 2


from datetime import timedelta
from decimal import Decimal

from app.time import now_utc
from app.services.agent_runs import rollup


def _run_full(s, *, agent, entity_id, outcome, auto, cost, age_days=0):
    r = _run(
        s, entity_type="incident", entity_id=entity_id,
        id=f"arun-{agent}-{entity_id}-{outcome}-{auto}-{age_days}",
    )
    r.agent_name = agent
    r.outcome = outcome
    r.status = "fell_back" if outcome == "fallback" else "succeeded"
    r.auto_completed = auto
    r.cost_usd = Decimal(cost)
    r.created_at = now_utc() - timedelta(days=age_days)
    s.add(r)
    s.flush()
    return r


def test_rollup_groups_by_agent_with_cost_and_rates():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001000")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="fallback", auto=False, cost="0.002000")
    rows = rollup(BROKER, s)
    assert len(rows) == 1
    row = rows[0]
    assert row.agent_name == "risk"
    assert row.run_count == 2
    assert row.total_cost_usd == Decimal("0.003000")
    assert row.fallback_count == 1
    assert row.auto_count == 1
    assert row.escalated_count == 1


def test_rollup_default_window_excludes_old_runs():
    s = _session()
    _incident(s, id="inc-A", venue_id="venue-A")
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001", age_days=1)
    _run_full(s, agent="risk", entity_id="inc-A", outcome="success", auto=True, cost="0.001", age_days=30)
    rows = rollup(BROKER, s, window_days=7)
    assert rows[0].run_count == 1  # the 30-day-old run is excluded
    rows_all = rollup(BROKER, s, window_days=None)
    assert rows_all[0].run_count == 2


def test_rollup_zero_runs_returns_empty_list():
    s = _session()
    assert rollup(BROKER, s) == []
