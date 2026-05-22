"""Phase B — venue operations: stream-event ingestion + live state + risk
score + premium quote.

URLs preserved:
  POST /api/venues/{venue_id}/events/stream     (high-volume async)
  POST /api/venues/{venue_id}/events/inject     (demo sync)
  GET  /api/venues/{venue_id}/live              (live floor telemetry)
  GET  /api/venues/{venue_id}/risk-score        (scoring snapshot)
  GET  /api/venues/{venue_id}/quote             (premium estimate)
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlmodel import Session

from app.auth import can_read_venue_floor, current_user_optional
from app.database import get_session
from app.live_state import live_state_manager
from app.schemas import LiveVenueState, StreamEvent
from app.seed_data import VENUES
from app.underwriting import get_premium_quote, get_risk_score

router = APIRouter()


# ─── Stream event ingestion ─────────────────────────────────────────────


@router.post("/venues/{venue_id}/events/stream", status_code=202)
def ingest_event_stream(
    venue_id: str,
    events: list[StreamEvent],
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    """High-volume ingestion — accepts immediately, processes asynchronously."""
    from app.main import _resolve_venue, simulate_event_queue
    venue_data = _resolve_venue(venue_id, session)
    background_tasks.add_task(simulate_event_queue, venue_id, events, venue_data)
    return {"status": "accepted", "message": f"Queued {len(events)} events for asynchronous processing"}


@router.post("/venues/{venue_id}/events/inject")
def inject_event_sync(
    venue_id: str,
    events: list[StreamEvent],
    session: Session = Depends(get_session),
):
    """Demo endpoint — synchronously processes events so the UI can refresh
    immediately. Production should use /events/stream instead."""
    from app.main import _resolve_venue
    venue_data = _resolve_venue(venue_id, session)
    live_state_manager.process_events(venue_id, events, venue_data)
    live = live_state_manager.get_state(venue_id, venue_data["capacity"], venue_data)
    return {
        "status": "processed",
        "events_count": len(events),
        "compliance_queue_length": len(live.compliance_queue),
    }


# ─── Live state + risk + quote ──────────────────────────────────────────


@router.get("/venues/{venue_id}/live", response_model=LiveVenueState)
def get_live_state(
    venue_id: str,
    session: Session = Depends(get_session),
    user: dict | None = Depends(current_user_optional),
) -> LiveVenueState:
    """Live floor telemetry. Operator-only: brokers + anonymous callers
    get summary fields (compliance_queue, premium_impact) with the
    floor-specific data zeroed out — keeps broker compliance views
    working without leaking the operator's live shift state."""
    from app.main import _resolve_venue
    venue = _resolve_venue(venue_id, session)
    state = live_state_manager.get_state(venue_id, venue["capacity"], venue)
    if not can_read_venue_floor(user, venue_id, session):
        state = state.model_copy(update={
            "current_capacity": 0,
            "infrastructure": [],
        })
    return state


@router.get("/venues/{venue_id}/risk-score")
def get_venue_risk_score(
    venue_id: str,
    session: Session = Depends(get_session),
) -> dict:
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    return get_risk_score(venue_id, VENUES, session=session, live_state_manager=live_state_manager)


@router.get("/venues/{venue_id}/quote")
def get_venue_quote(
    venue_id: str,
    session: Session = Depends(get_session),
) -> dict:
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    return get_premium_quote(venue_id, VENUES, session=session, live_state_manager=live_state_manager)
