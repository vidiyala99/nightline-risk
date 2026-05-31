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

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlmodel import Session, func, select

from app.auth import can_access_venue, require_venue_access, verify_token
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


@router.get("/venues/{venue_id}/incidents/counts")
def incident_counts_by_venue(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Status-bucketed incident counts for a venue. Used by the Risk Profile's
    'Safety Record' factor row to show total + 'N open' chip without paying
    the cost of fetching every row. `total` here MUST equal the unfiltered
    `list_incidents_by_venue` length and the scoring engine's `incident_count`
    input — these are the same `IncidentRecord.venue_id == ?` COUNT(*).
    """
    require_venue_access(venue_id, authorization, session)
    rows = session.exec(
        select(IncidentRecord.status, func.count(IncidentRecord.id))
        .where(IncidentRecord.venue_id == venue_id)
        .group_by(IncidentRecord.status)
    ).all()
    buckets: dict[str, int] = {
        "open": 0,
        "under_review": 0,
        "closed": 0,
        "closed_archived": 0,
    }
    total = 0
    for row in rows:
        status_value, count_value = row if isinstance(row, tuple) else (row[0], row[1])
        count_int = int(count_value or 0)
        total += count_int
        if status_value in buckets:
            buckets[status_value] = count_int
    return {**buckets, "total": total}


@router.get("/incidents", response_model=list[Incident])
def list_all_incidents(
    limit: int = 100,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[Incident]:
    """Cross-venue incident list, newest first. Used by broker dashboards.
    Caps at `limit` (default 100).

    Role-aware: brokers/admins see the whole portfolio; a venue_operator sees
    only rows for venues they own (`tenant_id` + `extra_venue_ids`). Anonymous
    callers are rejected. This is the server-side counterpart to the frontend's
    client-side filtering — defense in depth so a hand-crafted operator request
    can't read other venues' incident metadata.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={
            "error": "auth_required",
            "message": "Authentication required",
        })
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail={
            "error": "auth_invalid",
            "message": "Invalid or expired token",
        })
    records = session.exec(
        select(IncidentRecord).order_by(IncidentRecord.occurred_at.desc()).limit(limit)
    ).all()
    if user.get("role") not in ("broker", "admin"):
        # Operator scoping. Filter post-query against the audited helper rather
        # than reimplementing the extra_venue_ids lookup; at demo scale the only
        # cost is that an operator whose rows sit beyond the `limit` newest
        # cross-venue rows may see fewer — acceptable for a metadata list the
        # operator UI reaches via the venue-scoped endpoint anyway.
        records = [r for r in records if can_access_venue(user, r.venue_id, session)]
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


# ─── Claim-status chain ─────────────────────────────────────────────────


@router.get("/incidents/{incident_id}/claim-status")
def incident_claim_status(
    incident_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    """Resolve the full chain: incident → latest packet → latest ClaimProposal
    → linked Claim. Returns a single summary dict so the frontend can gate
    UI panels (e.g. 'File with carrier') without stitching 3 round-trips.
    """
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise error_response(
            "incident_not_found",
            f"Incident {incident_id!r} not found",
            status_code=404,
        )
    require_venue_access(record.venue_id, authorization, session)

    from app.models import Claim, ClaimProposal, UnderwritingPacket

    packet = session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == incident_id)
    ).first()

    proposal = None
    if packet is not None:
        proposal = session.exec(
            select(ClaimProposal)
            .where(ClaimProposal.packet_id == packet.id)
            .order_by(ClaimProposal.proposed_at.desc())
        ).first()

    claim = None
    if proposal is not None:
        claim = session.exec(
            select(Claim).where(Claim.proposal_id == proposal.id)
        ).first()
    if claim is None:
        claim = session.exec(
            select(Claim).where(Claim.incident_id == incident_id)
        ).first()

    return {
        "incident_status": record.status,
        "proposal": {
            "exists": proposal is not None,
            "state": proposal.state if proposal else None,
        },
        "claim": {
            "exists": claim is not None,
            "status": claim.status if claim else None,
        },
    }


# ─── Create (delegates to the brawl-incident agentic flow) ──────────────


@router.post(
    "/venues/{venue_id}/incidents",
    response_model=IncidentFlowResponse,
    status_code=201,
)
def create_incident(
    venue_id: str,
    payload: IncidentCreate,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> IncidentFlowResponse:
    # Operator-write gate: only the owning operator + brokers/admins may file
    # an incident for a venue (401 unauth, 403 wrong venue). Actor attribution
    # still rides in payload.reported_by — the token is purely the access gate.
    require_venue_access(venue_id, authorization, session)
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    return create_brawl_incident_flow(venue_id, payload, session)
