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

from app.auth import can_access_venue, require_staff, require_venue_access, verify_token
from app.database import get_session
from app.incident_flow import create_brawl_incident_flow
from app.lifecycles import (
    INCIDENT_STATUS_PRIORITY,
    INCIDENT_TRANSITIONS,
    InvalidTransitionError,
    assert_valid_transition,
    status_priority_case,
)
from app.models import Claim, ClaimProposal, IncidentRecord, UnderwritingPacket
from app.packet_core import _add_audit_event
from app.schemas import Incident, IncidentCreate, IncidentFlowResponse
from app.schemas.errors import error_response
from app.services.incident_feed import incident_status_feed

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
        incident_category=record.incident_category,
        reported_by_staff_id=record.reported_by_staff_id,
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
    # Actionable-first: open → under_review → closed, recency breaks ties.
    # The operator "Tonight's floor" view is a triage queue, not a chronological
    # feed, so status priority leads (matches lib/sort.ts on the client).
    query = query.order_by(
        status_priority_case(IncidentRecord.status, INCIDENT_STATUS_PRIORITY).desc(),
        IncidentRecord.created_at.desc(),
    )
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
        select(IncidentRecord).order_by(
            status_priority_case(IncidentRecord.status, INCIDENT_STATUS_PRIORITY).desc(),
            IncidentRecord.occurred_at.desc(),
        ).limit(limit)
    ).all()
    if user.get("role") not in ("broker", "admin"):
        # Operator scoping. Filter post-query against the audited helper rather
        # than reimplementing the extra_venue_ids lookup; at demo scale the only
        # cost is that an operator whose rows sit beyond the `limit` newest
        # cross-venue rows may see fewer — acceptable for a metadata list the
        # operator UI reaches via the venue-scoped endpoint anyway.
        records = [r for r in records if can_access_venue(user, r.venue_id, session)]
    return [_incident_to_response(r) for r in records]


# ─── Staff: my own reports ──────────────────────────────────────────────
# Declared BEFORE /incidents/{incident_id} so "/incidents/mine" isn't captured
# as an incident_id path param.


@router.get("/incidents/mine", response_model=list[Incident])
def list_my_incidents(
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[Incident]:
    """Floor staff see only the incidents they themselves reported (least
    privilege). Operators/brokers use the venue/portfolio lists instead."""
    user = require_staff(authorization)
    records = session.exec(
        select(IncidentRecord)
        .where(IncidentRecord.reported_by_staff_id == user["sub"])
        .order_by(IncidentRecord.created_at.desc())
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


# A claim is "in flight" while it can still resolve to a payout — closing the
# incident must not abandon it. The carrier-side Claim is authoritative once it
# exists; otherwise the proposal state decides. Resolved proposal states are the
# only ones that free the incident to close.
_RESOLVED_PROPOSAL_STATES = frozenset({"rejected_by_broker", "paid", "denied"})
_CLOSED_CLAIM_STATUSES = frozenset({"closed_paid", "closed_denied", "closed_dropped"})
_CLOSING_INCIDENT_STATUSES = frozenset({"closed", "closed_archived"})


def _incident_claim_in_flight(session: Session, incident_id: str) -> str | None:
    """Return a human label for an in-flight claim on this incident, or None.

    Resolves incident → latest packet → latest proposal → claim, mirroring
    incident_claim_status. A linked Claim is authoritative when present; else the
    proposal state decides.
    """
    packet = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
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
        claim = session.exec(select(Claim).where(Claim.proposal_id == proposal.id)).first()
    if claim is None:
        claim = session.exec(select(Claim).where(Claim.incident_id == incident_id)).first()

    if claim is not None:
        return None if claim.status in _CLOSED_CLAIM_STATUSES else f"claim {claim.status}"
    if proposal is not None:
        return None if proposal.state in _RESOLVED_PROPOSAL_STATES else f"proposal {proposal.state}"
    return None


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

    # Don't let an operator close/archive an incident out from under a live
    # claim — the proposal/claim could still pay out. They resolve it with the
    # broker first, then close. (Re-opening or moving to review is always fine.)
    if new_status in _CLOSING_INCIDENT_STATUSES:
        in_flight = _incident_claim_in_flight(session, incident_id)
        if in_flight is not None:
            raise error_response(
                "claim_in_flight",
                "Resolve this incident's claim with your broker before closing it.",
                status_code=422,
                details={"claim": in_flight},
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

    packet = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
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


# ─── Venue incident-status feed ─────────────────────────────────────────


@router.get("/venues/{venue_id}/incident-status-feed")
def venue_incident_status_feed(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Per-incident status chain for a venue's incidents, newest first.
    Resolves incident -> latest packet -> latest proposal -> claim in one call so
    the operator home renders a report feed without an N+1 of /claim-status hits.
    Venue-gated (operators see only their own venue)."""
    require_venue_access(venue_id, authorization, session)
    return incident_status_feed(session, venue_id)


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
    # Write gate. Floor staff (role="staff") may file for THEIR OWN venue and the
    # incident is attributed to their user id; operators/brokers go through the
    # venue gate (401 unauth, 403 wrong venue). Free-text payload.reported_by
    # still rides along for display.
    decoded = (
        verify_token(authorization.split(" ", 1)[1])
        if authorization and authorization.startswith("Bearer ")
        else None
    )
    reported_by_staff_id: str | None = None
    if decoded and decoded.get("role") == "staff":
        if decoded.get("tenant_id") != venue_id:
            raise HTTPException(status_code=403, detail={
                "error": "venue_access_denied",
                "message": "Staff can only report for their own venue",
            })
        reported_by_staff_id = decoded.get("sub")
    else:
        require_venue_access(venue_id, authorization, session)
    from app.main import _resolve_venue
    _resolve_venue(venue_id, session)
    return create_brawl_incident_flow(
        venue_id, payload, session, reported_by_staff_id=reported_by_staff_id
    )
