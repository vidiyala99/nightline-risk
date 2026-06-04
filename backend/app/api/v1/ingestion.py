"""Real-time push ingestion endpoints.

Devices/integrations POST operational signals here and they flow through the
*same* spine as batch pulls (quality gate -> content-hash dedupe ->
IngestionRun audit -> rollup into the venue's score). No message-bus stub: a
posted signal moves the Savings-Score inputs synchronously, and the response
echoes the venue's new operational_data so the caller can see it move.

Raw domain payloads (pos/camera/staffing) are mapped to the engine's
score-weighted metrics in app.ingestion.webhook; integrations that already
aggregate their own metric can POST it directly to /signal.
"""
from fastapi import APIRouter, HTTPException

from app.database import get_session
from app.ingestion.base import NormalizedEvent
from app.ingestion.webhook import (
    camera_signals,
    ingest_signal,
    operational_snapshot,
    pos_signals,
    staffing_signals,
    venue_capacity,
)
from app.models import IngestionRun
from app.schemas.events import CameraEvent, OperationalSignal, POSEvent, StaffingEvent
from app.time import now_utc

router = APIRouter()


def _result(run: IngestionRun, operational_data: dict) -> dict:
    """Uniform push response: what the spine did + the venue's new score inputs."""
    return {
        "status": "accepted",
        "source_system": run.source_system,
        "loaded": run.loaded,
        "skipped": run.skipped,
        "rejected": run.rejected,
        "operational_data": operational_data,
    }


def _persist(venue_id: str, events: list[NormalizedEvent]) -> dict:
    """Run pushed events through the spine and return the push response."""
    from app.seed_data import VENUES

    with next(get_session()) as session:
        run = ingest_signal(session, events, venues_index=VENUES)
        snapshot = operational_snapshot(session, venue_id)
    return _result(run, snapshot)


@router.post("/ingest/{venue_id}/pos", status_code=202)
async def ingest_pos(venue_id: str, event: POSEvent):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    events = pos_signals(venue_id, event, occurred_at=event.timestamp)
    return _persist(venue_id, events)


@router.post("/ingest/{venue_id}/camera", status_code=202)
async def ingest_camera(venue_id: str, event: CameraEvent):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    from app.seed_data import VENUES

    with next(get_session()) as session:
        capacity = venue_capacity(session, venue_id, venues_index=VENUES)
        events = camera_signals(venue_id, event, occurred_at=event.timestamp, capacity=capacity)
        run = ingest_signal(session, events, venues_index=VENUES)
        snapshot = operational_snapshot(session, venue_id)
    return _result(run, snapshot)


@router.post("/ingest/{venue_id}/staffing", status_code=202)
async def ingest_staffing(venue_id: str, event: StaffingEvent):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    events = staffing_signals(venue_id, event, occurred_at=event.timestamp)
    return _persist(venue_id, events)


@router.post("/ingest/{venue_id}/signal", status_code=202)
async def ingest_generic_signal(venue_id: str, signal: OperationalSignal):
    """Push a pre-aggregated metric directly (the clean lane for an upstream
    integration that computes its own over_pour_rate / occupancy_ratio / etc.)."""
    occurred_at = signal.occurred_at or now_utc()
    event = NormalizedEvent(
        venue_id=venue_id,
        source_system=signal.source_system,
        event_type=signal.metric_name,
        metric_name=signal.metric_name,
        value=signal.value,
        occurred_at=occurred_at,
        external_ref=signal.external_ref or f"signal-{venue_id}-{signal.metric_name}-{occurred_at.isoformat()}",
        metadata=dict(signal.metadata),
    )
    return _persist(venue_id, [event])
