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
from app.seed_data import STREAM_EVENTS, VENUES
from app.services.compliance_signals import spawn_incident_followup
from app.services.incident_maintenance import enforce_open_incident_cap
from app.knowledge_sources import load_knowledge_sources_for_venue
from app.underwriting.scoring import incident_delta_tracker


def create_brawl_incident_flow(
    venue_id: str,
    payload: IncidentCreate,
    session: Session,
    *,
    reported_by_staff_id: str | None = None,
) -> IncidentFlowResponse:
    venue_data = VENUES[venue_id]
    incident = Incident(
        id=f"inc-{venue_id}-{uuid4().hex[:12]}",
        venue_id=venue_id,
        **payload.model_dump(),
    )
    knowledge_sources = load_knowledge_sources_for_venue(session, venue_id)
    agent_result = execute_underwriting_packet_agents(
        venue_id=venue_id,
        venue=venue_data,
        incident=payload,
        knowledge_sources=knowledge_sources,
        stream_events=STREAM_EVENTS,
        session=session,
        entity_id=incident.id,
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
        status="open",
        incident_category=incident.incident_category,
        # A&B / liquor structured facts come straight off the payload — the
        # intermediate Incident schema doesn't carry them, so reading from
        # `incident` here would silently drop weapon/injury/witnesses (7c).
        parties=payload.parties,
        witnesses=payload.witnesses,
        security_response=payload.security_response,
        weapon_involved=payload.weapon_involved,
        refused_service_or_overserved=payload.refused_service_or_overserved,
        injury_detail=payload.injury_detail,
        reported_by_staff_id=reported_by_staff_id,
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

    packet = create_packet_snapshot(
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

    # Open a compliance follow-up for the incident the operator just filed, so
    # it surfaces in their compliance queue and dents the compliance factor
    # until they document it — resolving it then visibly raises the score
    # (closing the operator loop). After the snapshot (which commits) so a
    # snapshot failure leaves no orphan task; its own commit persists the row.
    # Idempotent + capped; see the service.
    if spawn_incident_followup(session, venue_id, incident.id, summary=payload.summary) is not None:
        session.commit()

    # Bump the live risk delta AFTER the packet snapshot succeeds, so a
    # citation-validation failure (or any other downstream error) does NOT
    # leave us with a moved score and no audit trail. The curated 12-month
    # baseline in VENUES is preserved; new incidents accumulate on top of it
    # until the next quote cycle.
    incident_delta_tracker.bump_incident(venue_id)

    # Bound the venue's open app-generated backlog so a long-running demo can't
    # accumulate unbounded open incidents that saturate the Safety Record
    # (backlog #37). Archives the oldest beyond the cap; no-op under the cap.
    if enforce_open_incident_cap(session, venue_id, protect_ids={incident.id}):
        session.commit()

    # Recommendation-gated routing: high-confidence "file" incidents land in the
    # broker inbox automatically. Idempotent; borderline/no-file create nothing.
    from app.claim_routing import maybe_auto_route_incident
    maybe_auto_route_incident(session, packet=packet, operator_id=incident.reported_by or "operator")

    return IncidentFlowResponse(
        incident=incident,
        risk_signal=agent_result.risk_signal,
        action_plan=agent_result.action_plan,
        claims_timeline=agent_result.claims_timeline,
        claims_timeline_meta=agent_result.claims_timeline_meta,
        underwriting_memo=agent_result.underwriting_memo,
    )
