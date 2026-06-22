from __future__ import annotations

from sqlmodel import Session, SQLModel, create_engine

from app.models import AgentRun, IncidentRecord
from app.services.agent_runs import resolve_run_venue


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
