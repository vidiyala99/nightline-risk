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


def _run(session: Session, *, entity_type=None, entity_id=None) -> AgentRun:
    run = AgentRun(
        id=f"arun-{entity_id or 'none'}", agent_name="risk_evaluator_agent",
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
        r = _run(s, entity_type="incident", entity_id="inc-A")
        r.id = f"arun-{i}"
        s.add(r)
    s.flush()
    assert len(list_runs(BROKER, s, limit=2)) == 2
