from app.fastapi_compat import patch_starlette_router_for_fastapi

patch_starlette_router_for_fastapi()

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlmodel import Session, select
import time

from app.incident_flow import create_brawl_incident_flow
from app.schemas import Incident, IncidentCreate, IncidentFlowResponse, LiveVenueState, StreamEvent
from app.seed_data import VENUES
from app.database import create_db_and_tables, get_session
from app.live_state import live_state_manager
from app.models import AuditEvent, IncidentRecord, ReviewDecision, UnderwritingPacket, Venue
from app.packet_core import record_review_decision
from app.underwriting import get_premium_quote, get_risk_score


class ReviewDecisionCreate(BaseModel):
    reviewer_id: str
    decision: str
    override_reason: str | None = None
    notes: str | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    # Seed venues if they don't exist
    with next(get_session()) as session:
        for venue_id, venue_data in VENUES.items():
            if not session.get(Venue, venue_id):
                session.add(Venue(id=venue_id, name=venue_data["name"]))
        session.commit()
    yield

app = FastAPI(title="Third Space Risk OS", lifespan=lifespan)

from app.auth import router as auth_router
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])

from app.api.v1.ingestion import router as ingestion_router
app.include_router(ingestion_router, prefix="/api/v1", tags=["ingestion"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/venues")
def list_venues() -> list[dict]:
    return [{"id": venue_id, **venue} for venue_id, venue in VENUES.items()]


@app.get("/api/venues/{venue_id}/incidents", response_model=list[Incident])
def list_incidents(venue_id: str, session: Session = Depends(get_session)) -> list[Incident]:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    records = session.exec(
        select(IncidentRecord)
        .where(IncidentRecord.venue_id == venue_id)
        .order_by(IncidentRecord.created_at.desc())
    ).all()
    return [
        Incident(
            id=record.id,
            venue_id=record.venue_id,
            occurred_at=record.occurred_at,
            location=record.location,
            summary=record.summary,
            reported_by=record.reported_by,
            injury_observed=record.injury_observed,
            police_called=record.police_called,
            ems_called=record.ems_called,
        )
        for record in records
    ]


@app.post("/api/venues/{venue_id}/incidents", response_model=IncidentFlowResponse, status_code=201)
def create_incident(venue_id: str, payload: IncidentCreate, session: Session = Depends(get_session)) -> IncidentFlowResponse:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    return create_brawl_incident_flow(venue_id, payload, session)


@app.get("/api/incidents/{incident_id}/packets")
def list_incident_packets(incident_id: str, session: Session = Depends(get_session)) -> list[dict]:
    packets = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
    ).all()
    return [_packet_to_dict(packet) for packet in packets]


@app.get("/api/packets/{packet_id}")
def get_packet(packet_id: str, session: Session = Depends(get_session)) -> dict:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise HTTPException(status_code=404, detail="Packet not found")
    return _packet_to_dict(packet)


@app.post("/api/packets/{packet_id}/review-decisions", status_code=201)
def create_review_decision(
    packet_id: str,
    payload: ReviewDecisionCreate,
    session: Session = Depends(get_session),
) -> dict:
    try:
        decision = record_review_decision(
            session=session,
            packet_id=packet_id,
            reviewer_id=payload.reviewer_id,
            decision=payload.decision,
            override_reason=payload.override_reason,
            notes=payload.notes,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return _review_decision_to_dict(decision)


@app.get("/api/packets/{packet_id}/audit-events")
def list_packet_audit_events(packet_id: str, session: Session = Depends(get_session)) -> list[dict]:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise HTTPException(status_code=404, detail="Packet not found")
    events = session.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_id == packet_id)
        .order_by(AuditEvent.created_at)
    ).all()
    return [_audit_event_to_dict(event) for event in events]


def simulate_event_queue(venue_id: str, events: list[StreamEvent]):
    """
    Simulates asynchronous event processing (e.g., pushing to Kafka).
    This allows the main thread to return a 202 instantly during high traffic.
    """
    time.sleep(0.5)
    print(f"\n[QUEUE WORKER] Asynchronously processed {len(events)} events for venue {venue_id}")
    for event in events:
        print(f"  -> {event.event_type} | {event.event_id} | Payload: {event.payload}")


@app.post("/api/venues/{venue_id}/events/stream", status_code=202)
def ingest_event_stream(venue_id: str, events: list[StreamEvent], background_tasks: BackgroundTasks):
    """
    High-volume ingestion endpoint. 
    Accepts POS transactions, door scans, and camera metadata.
    """
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    
    # 1. Instantly accept the payload (Sub-50ms latency).
    # 2. Push the heavy processing to a background queue.
    background_tasks.add_task(simulate_event_queue, venue_id, events)
    
    return {"status": "accepted", "message": f"Queued {len(events)} events for asynchronous processing"}


def _packet_to_dict(packet: UnderwritingPacket) -> dict:
    return {
        "id": packet.id,
        "venue_id": packet.venue_id,
        "incident_id": packet.incident_id,
        "rubric_version_id": packet.rubric_version_id,
        "status": packet.status,
        "risk_signals": packet.risk_signals,
        "action_plan": packet.action_plan,
        "claims_timeline": packet.claims_timeline,
        "memo": packet.memo,
        "citation_ids": packet.citation_ids,
        "validation": packet.validation,
        "snapshot_hash": packet.snapshot_hash,
        "generated_at": packet.generated_at.isoformat(),
    }


def _review_decision_to_dict(decision: ReviewDecision) -> dict:
    return {
        "id": decision.id,
        "packet_id": decision.packet_id,
        "reviewer_id": decision.reviewer_id,
        "decision": decision.decision,
        "override_reason": decision.override_reason,
        "notes": decision.notes,
        "decided_at": decision.decided_at.isoformat(),
    }


def _audit_event_to_dict(event: AuditEvent) -> dict:
    return {
        "id": event.id,
        "actor_id": event.actor_id,
        "actor_type": event.actor_type,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "event_type": event.event_type,
        "metadata": event.event_metadata,
        "created_at": event.created_at.isoformat(),
    }


@app.get("/api/venues/{venue_id}/live", response_model=LiveVenueState)
def get_live_state(venue_id: str) -> LiveVenueState:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    return live_state_manager.get_state(venue_id, VENUES[venue_id]["capacity"])


@app.get("/api/venues/{venue_id}/risk-score")
def get_venue_risk_score(venue_id: str) -> dict:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    return get_risk_score(venue_id, VENUES)


@app.get("/api/venues/{venue_id}/quote")
def get_venue_quote(venue_id: str) -> dict:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    return get_premium_quote(venue_id, VENUES)


@app.post("/api/venues/{venue_id}/compliance/{item_id}/upload")
async def upload_compliance_evidence(venue_id: str, item_id: str, file: UploadFile = File(...)) -> dict:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    live_state_manager.resolve_compliance_item(venue_id, item_id)
    return {
        "status": "accepted",
        "item_id": item_id,
        "filename": file.filename,
    }
