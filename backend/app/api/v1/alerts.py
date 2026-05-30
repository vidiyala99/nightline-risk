"""Operator alerts — list + feedback. Thin router over the alert_dispatcher
service (get_venue_alerts + record_feedback), which already existed but had no
HTTP home, so the web /alerts confirm / false-alarm buttons 404'd.

URLs match what frontend/src/app/alerts/page.tsx actually calls:
  GET  /api/venues/{venue_id}/alerts
  POST /api/alerts/{alert_id}/feedback        body: {"feedback": "confirmed"|"false_alarm"}

Both venue-access gated: the operator owns their venue's alerts; brokers/admins
pass. The feedback route resolves the venue from the AlertEvent so the gate
works even though the URL isn't venue-scoped.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from sqlmodel import Session

from app.auth import require_venue_access
from app.database import get_session
from app.models import AlertEvent
from app.schemas.errors import error_response
from app.services.alert_dispatcher import get_venue_alerts, record_feedback

router = APIRouter()

_VALID_FEEDBACK = {"confirmed", "false_alarm"}


def _alert_to_dict(a: AlertEvent) -> dict:
    return {
        "id": a.id,
        "venue_id": a.venue_id,
        "camera_id": a.camera_id,
        "zone": a.zone,
        "event_type": a.event_type,
        "severity": a.severity,
        "confidence": a.confidence,
        "description": a.description,
        "feedback": a.feedback,
        "detected_at": a.detected_at.isoformat() if a.detected_at else None,
    }


@router.get("/venues/{venue_id}/alerts")
def list_venue_alerts(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    require_venue_access(venue_id, authorization, session)
    return [_alert_to_dict(a) for a in get_venue_alerts(venue_id, session)]


@router.post("/alerts/{alert_id}/feedback")
def submit_alert_feedback(
    alert_id: str,
    payload: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    # Entity-404 precedes auth (the gate needs the alert's venue_id anyway).
    alert = session.get(AlertEvent, alert_id)
    if alert is None:
        raise error_response("alert_not_found", f"Alert {alert_id!r} not found", status_code=404)
    require_venue_access(alert.venue_id, authorization, session)
    feedback = (payload or {}).get("feedback")
    if feedback not in _VALID_FEEDBACK:
        raise error_response(
            "invalid_feedback",
            f"feedback must be one of {sorted(_VALID_FEEDBACK)}",
            status_code=400,
        )
    updated = record_feedback(alert_id, feedback, session)
    return _alert_to_dict(updated or alert)
