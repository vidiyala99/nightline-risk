"""PR2 — instrument the live 5-agent underwriting pipeline into the ledger.

After this, every incident that flows through `UnderwritingPacketAgentRuntime.
execute` leaves a durable `AgentRun` row per agent (retrieval, risk-evaluator,
customer-action, claims-timeline, underwriter-memo). The `session`/`entity_id`
kwargs are OPTIONAL — a session-less caller (including the 62 pricing cells)
records nothing and behaves exactly as before.
"""
from sqlmodel import SQLModel, Session, create_engine, select

from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.models import AgentRun
from app.schemas import IncidentCreate


PIPELINE_AGENTS = {
    "retrieval_agent",
    "risk_evaluator_agent",
    "customer_action_agent",
    "claims_timeline_agent",
    "underwriter_memo_agent",
}


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _incident() -> IncidentCreate:
    return IncidentCreate(
        occurred_at="2026-06-16T02:00:00Z",
        location="Main floor near the bar",
        summary="Brawl broke out between two patrons near the bar",
        reported_by="Floor Manager",
        injury_observed=True,
        police_called=True,
        ems_called=False,
    )


def _execute(runtime: UnderwritingPacketAgentRuntime, session, entity_id):
    return runtime.execute(
        venue_id="v1",
        venue={},
        incident=_incident(),
        knowledge_sources=[],
        stream_events=[],
        session=session,
        entity_id=entity_id,
    )


def test_execute_records_one_run_per_agent():
    session = _session()
    result = _execute(UnderwritingPacketAgentRuntime(), session, entity_id="inc-1")

    runs = session.exec(select(AgentRun)).all()
    assert {r.agent_name for r in runs} == PIPELINE_AGENTS
    assert len(runs) == 5
    for r in runs:
        assert r.agent_kind == "pipeline"
        assert r.entity_type == "incident"
        assert r.entity_id == "inc-1"
        assert r.input_hash  # provenance fingerprint stamped
    # In the keyless test env every agent runs its deterministic path → success.
    assert {r.status for r in runs} == {"succeeded"}
    # The pipeline still returns its normal result alongside the ledger rows.
    assert result.risk_signal is not None
    assert len(result.execution_trace) == 5


def test_execute_without_session_records_nothing():
    session = _session()  # used only to read; not passed into execute
    runtime = UnderwritingPacketAgentRuntime()
    result = runtime.execute(
        venue_id="v1",
        venue={},
        incident=_incident(),
        knowledge_sources=[],
        stream_events=[],
    )
    assert result.risk_signal is not None  # behaves exactly as before
    assert session.exec(select(AgentRun)).all() == []  # no ledger writes


def test_memo_fallback_records_fell_back():
    class _RaisingMemoProvider:
        provider_name = "grok"

        def draft_memo(self, **kwargs):
            raise RuntimeError("grok 429 rate limited")

    session = _session()
    runtime = UnderwritingPacketAgentRuntime(memo_provider=_RaisingMemoProvider())
    _execute(runtime, session, entity_id="inc-2")

    memo_run = session.exec(
        select(AgentRun).where(AgentRun.agent_name == "underwriter_memo_agent")
    ).one()
    assert memo_run.status == "fell_back"
    assert memo_run.outcome == "fallback"
    assert memo_run.fallback_reason is not None
    assert "grok" in memo_run.fallback_reason

    # The other four agents are unaffected and still succeed.
    others = session.exec(
        select(AgentRun).where(AgentRun.agent_name != "underwriter_memo_agent")
    ).all()
    assert len(others) == 4
    assert {r.status for r in others} == {"succeeded"}
