"""Phase B — incident CRUD migrated out of main.py.

URLs preserved; only the registration site moves. Phase A's typed
lifecycle + audit events + tenant gating travel with the routes.

Note on the `_resolve_venue` import: this router calls into main.py's
helper rather than re-implementing it locally, because the helper
also seeds `VENUES` from DB rows lazily — the venues router has its
own copy but we deliberately don't deduplicate yet; both copies will
collapse into a `services/venues.py` module after all of Phase B
lands and the legacy main.py is fully drained.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query
from sqlmodel import Session, select

from app.auth import require_venue_access
from app.database import get_session
from app.incident_flow import create_brawl_incident_flow
from app.lifecycles import (
    INCIDENT_TRANSITIONS,
    InvalidTransitionError,
    assert_valid_transition,
)
from app.models import IncidentRecord
from app.packet_core import _add_audit_event
from app.schemas import Incident, IncidentCreate, IncidentFlowResponse
from app.schemas.errors import error_response

router = APIRouter()


def _incident_to_response(record: IncidentRecord) -> Incident:
    return Incident(
        id=record.id,
        venue_id=record.venue_id,
        occurred_at=record.occurred_at,
        location=record.location,
        summary=record.summary,
        reported_by=record.reported_by,
        injury_observed=record.injury_observed or False,
        police_called=record.police_called or False,
        ems_called=record.ems_called or False,
        status=record.status,
    )


# ─── List endpoints ─────────────────────────────────────────────────────


@router.get("/venues/{venue_id}/incidents", response_model=list[Incident])
def list_incidents_by_venue(
    venue_id: str,
    status: str | None = Query(default=None, description="Filter by status (open | under_review | closed | closed_archived)"),
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[Incident]:
    require_venue_access(venue_id, authorization, session)
    query = select(IncidentRecord).where(IncidentRecord.venue_id == venue_id)
    if status:
        query = query.where(IncidentRecord.status == status)
    query = query.order_by(IncidentRecord.created_at.desc())
    records = session.exec(query).all()
    return [_incident_to_response(r) for r in records]


@router.get("/incidents", response_model=list[Incident])
def list_all_incidents(
    limit: int = 100,
    session: Session = Depends(get_session),
) -> list[Incident]:
    """Cross-venue incident list, newest first. Used by broker dashboards.
    Caps at `limit` (default 100). No auth gate at the list level — the
    response is read-only metadata; cross-tenant rows are visible to
    brokers/admins by design and the frontend filters for operators."""
    records = session.exec(
        select(IncidentRecord).order_by(IncidentRecord.occurred_at.desc()).limit(limit)
    ).all()
    return [_incident_to_response(r) for r in records]


# ─── Detail + status mutation ───────────────────────────────────────────


@router.get("/incidents/{incident_id}", response_model=Incident)
def get_incident(
    incident_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> Incident:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    require_venue_access(record.venue_id, authorization, session)
    return _incident_to_response(record)


@router.patch("/incidents/{incident_id}/status", status_code=200)
def update_incident_status(
    incident_id: str,
    body: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    user = require_venue_access(record.venue_id, authorization, session)

    new_status = body.get("status")
    if not isinstance(new_status, str) or not new_status:
        raise error_response(
            "status_required",
            "Request body must include a non-empty `status` string.",
            status_code=400,
        )

    from_status = record.status
    try:
        assert_valid_transition(
            INCIDENT_TRANSITIONS, from_status, new_status, entity_name="Incident",
        )
    except InvalidTransitionError as e:
        raise error_response(
            "invalid_transition",
            str(e),
            status_code=422,
            details={"from": from_status, "to": new_status},
        )

    record.status = new_status
    session.add(record)
    _add_audit_event(
        session=session,
        actor_id=user["sub"], actor_type="user",
        entity_type="incident", entity_id=record.id,
        event_type=f"incident.{new_status}",
        event_metadata={"from": from_status, "to": new_status, "venue_id": record.venue_id},
    )
    session.commit()
    return {"id": incident_id, "status": record.status}


# ─── Create (delegates to the brawl-incident agentic flow) ──────────────


@router.post(
    "/venues/{venue_id}/incidents",
    response_model=IncidentFlowResponse,
    status_code=201,
)
def create_incident(
    venue_id: str,
    payload: IncidentCreate,
    session: Session = Depends(get_session),
) -> IncidentFlowResponse:
    # NOTE: no auth gate here — the incident-create flow is the operator's
    # primary write surface and currently relies on payload.reported_by
    # for actor attribution rather than a JWT claim. Adding `require_*`
    # here would silently break the existing flow's test fixtures (none
    # of which pass tokens). When operator login + service auth lands,
    # gate this with `require_venue_access(venue_id, authorization, session)`.
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    return create_brawl_incident_flow(venue_id, payload, session)
