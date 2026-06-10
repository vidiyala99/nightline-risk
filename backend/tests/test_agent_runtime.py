from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.incident_flow import create_brawl_incident_flow
from app.models import AuditEvent, CitationRecord, IncidentRecord, SourceRecord, UnderwritingPacket, Venue
from app.seed_data import KNOWLEDGE_SOURCES, STREAM_EVENTS, VENUES
from app.schemas import IncidentCreate


DEMO_INCIDENT = IncidentCreate(
    occurred_at="2026-05-02T23:13:00Z",
    location="rear bar",
    summary="Two patrons began fighting near the rear bar during a sold-out DJ event.",
    reported_by="shift-lead",
    injury_observed=False,
    police_called=False,
    ems_called=False,
)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Venue(id="elsewhere-brooklyn", name=VENUES["elsewhere-brooklyn"]["name"]))
        session.commit()
        yield session


def test_agent_runtime_executes_all_underwriting_packet_steps():
    from app.agents.runtime import execute_underwriting_packet_agents

    result = execute_underwriting_packet_agents(
        venue_id="elsewhere-brooklyn",
        venue=VENUES["elsewhere-brooklyn"],
        incident=DEMO_INCIDENT,
        knowledge_sources=KNOWLEDGE_SOURCES,
        stream_events=STREAM_EVENTS,
    )

    assert [step.agent_name for step in result.execution_trace] == [
        "retrieval_agent",
        "risk_evaluator_agent",
        "customer_action_agent",
        "claims_timeline_agent",
        "underwriter_memo_agent",
    ]
    assert all(step.execution_mode == "deterministic" for step in result.execution_trace)
    assert all(step.contract_path.endswith(".md") for step in result.execution_trace)
    assert result.risk_signal.severity == "medium"
    assert result.risk_signal.review_status == "needs_review"
    assert result.action_plan[0].title == "Preserve incident evidence"
    assert result.claims_timeline[-1].source == "venue:incident-report"
    assert result.underwriting_memo.review_status == "draft"


def test_agent_runtime_fails_when_required_contract_is_missing():
    from app.agents.runtime import AgentContractError, UnderwritingPacketAgentRuntime

    runtime = UnderwritingPacketAgentRuntime(contracts_dir=Path("tests") / "missing-agent-contracts")

    with pytest.raises(AgentContractError, match="retrieval_agent.md"):
        runtime.execute(
            venue_id="elsewhere-brooklyn",
            venue=VENUES["elsewhere-brooklyn"],
            incident=DEMO_INCIDENT,
            knowledge_sources=KNOWLEDGE_SOURCES,
            stream_events=STREAM_EVENTS,
        )


def test_incident_flow_uses_agent_orchestration(monkeypatch, db_session):
    import app.incident_flow as incident_flow

    calls = []
    real_execute = incident_flow.execute_underwriting_packet_agents

    def tracking_execute(*args, **kwargs):
        calls.append(kwargs["venue_id"])
        return real_execute(*args, **kwargs)

    monkeypatch.setattr(incident_flow, "execute_underwriting_packet_agents", tracking_execute)

    response = create_brawl_incident_flow("elsewhere-brooklyn", DEMO_INCIDENT, db_session)

    assert calls == ["elsewhere-brooklyn"]
    assert response.risk_signal.severity == "medium"


def test_incident_flow_creates_durable_packet_records(db_session):
    response = create_brawl_incident_flow("elsewhere-brooklyn", DEMO_INCIDENT, db_session)

    packets = db_session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == response.incident.id)
    ).all()
    sources = db_session.exec(select(SourceRecord)).all()
    citations = db_session.exec(select(CitationRecord)).all()
    audit_events = db_session.exec(select(AuditEvent).where(AuditEvent.entity_id == packets[0].id)).all()

    assert len(packets) == 1
    assert packets[0].status == "needs_review"
    assert packets[0].snapshot_hash
    assert len(sources) >= 3
    assert len(citations) >= 3
    assert [event.event_type for event in audit_events] == ["packet.generated"]


def test_incident_flow_persists_assault_and_battery_fields(db_session):
    """A&B / liquor structured facts on the payload must survive to the
    persisted IncidentRecord. They feed evidence-defensibility (weapon,
    injury detail, witnesses) — silently dropping them guts the core product
    claim. See backlog item 0 / 7c."""
    payload = IncidentCreate(
        occurred_at="2026-05-02T23:13:00Z",
        location="rear bar",
        summary="Patron struck another with a bottle after being over-served.",
        reported_by="shift-lead",
        injury_observed=True,
        police_called=True,
        ems_called=True,
        incident_category="assault_battery",
        parties=[{"role": "aggressor", "name": "John D."}],
        witnesses=[{"name": "Bartender A."}],
        security_response=[{"action": "ejected", "at": "2026-05-02T23:15:00Z"}],
        weapon_involved=True,
        refused_service_or_overserved="overserved",
        injury_detail="laceration above left eye",
    )

    response = create_brawl_incident_flow("elsewhere-brooklyn", payload, db_session)

    row = db_session.exec(
        select(IncidentRecord).where(IncidentRecord.id == response.incident.id)
    ).one()
    assert row.incident_category == "assault_battery"
    assert row.parties == [{"role": "aggressor", "name": "John D."}]
    assert row.witnesses == [{"name": "Bartender A."}]
    assert row.security_response == [{"action": "ejected", "at": "2026-05-02T23:15:00Z"}]
    assert row.weapon_involved is True
    assert row.refused_service_or_overserved == "overserved"
    assert row.injury_detail == "laceration above left eye"
