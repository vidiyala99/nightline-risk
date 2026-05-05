from sqlmodel import Session
from uuid import uuid4

from app.agents.runtime import execute_underwriting_packet_agents
from app.schemas import (
    Incident,
    IncidentCreate,
    IncidentFlowResponse,
)
from app.models import IncidentRecord, IncidentEvaluation
from app.packet_core import create_packet_snapshot
from app.seed_data import KNOWLEDGE_SOURCES, STREAM_EVENTS, VENUES


def create_brawl_incident_flow(venue_id: str, payload: IncidentCreate, session: Session) -> IncidentFlowResponse:
    incident = Incident(
        id=f"inc-{venue_id}-{uuid4().hex[:12]}",
        venue_id=venue_id,
        **payload.model_dump(),
    )
    agent_result = execute_underwriting_packet_agents(
        venue_id=venue_id,
        venue=VENUES[venue_id],
        incident=payload,
        knowledge_sources=KNOWLEDGE_SOURCES,
        stream_events=STREAM_EVENTS,
    )

    # Persist to database
    db_incident = IncidentRecord(
        id=incident.id,
        venue_id=incident.venue_id,
        occurred_at=incident.occurred_at,
        location=incident.location,
        summary=incident.summary,
        reported_by=incident.reported_by,
        injury_observed=incident.injury_observed,
        police_called=incident.police_called,
        ems_called=incident.ems_called,
    )
    
    db_eval = IncidentEvaluation(
        incident_id=incident.id,
        risk_signal=agent_result.risk_signal.model_dump(),
        action_plan=[item.model_dump() for item in agent_result.action_plan],
        underwriting_memo=agent_result.underwriting_memo.model_dump(),
        claims_timeline=[item.model_dump() for item in agent_result.claims_timeline],
    )
    
    session.add(db_incident)
    session.add(db_eval)
    session.flush()

    create_packet_snapshot(
        session=session,
        venue_id=venue_id,
        incident_id=incident.id,
        incident=payload,
        risk_signal=agent_result.risk_signal.model_dump(),
        action_plan=[item.model_dump() for item in agent_result.action_plan],
        claims_timeline=[item.model_dump() for item in agent_result.claims_timeline],
        underwriting_memo=agent_result.underwriting_memo.model_dump(),
        citations=agent_result.citations,
        rubric_version="demo-rubric-v1",
    )

    return IncidentFlowResponse(
        incident=incident,
        risk_signal=agent_result.risk_signal,
        action_plan=agent_result.action_plan,
        claims_timeline=agent_result.claims_timeline,
        underwriting_memo=agent_result.underwriting_memo,
    )
