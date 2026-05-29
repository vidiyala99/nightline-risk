"""Phase B — venue CRUD migrated out of main.py into the v1/ pattern.

Routes preserve their URLs (/api/venues, /api/venues/{venue_id},
/api/venues/count, /api/portfolio) so the frontend doesn't need to
change. What this migration buys:

  - Consistent auth + audit + error-envelope contract with the rest
    of the v1/ routers (placement.py, policies.py, claims.py).
  - Route handlers no longer talk to SQLModel directly; mutations go
    through service helpers in this file that emit audit events.
  - One header import block instead of the legacy main.py soup.

The portfolio aggregation (`/api/portfolio`) lives here because it's
venue-scoped read; risk-score and live-state helpers remain in
main.py for now (they belong with the live-state subsystem and the
seed data, not in the venue CRUD module).
"""
from __future__ import annotations

import json as _json
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header
from sqlmodel import Session, func, select

from app.auth import (
    can_read_venue_floor,
    current_user_optional,
    require_broker,
    require_non_broker,
    require_venue_access,
)
from app.database import get_session
from app.live_state import live_state_manager
from app.models import IncidentRecord, Venue
from app.packet_core import _add_audit_event
from app.schemas.errors import error_response
from app.seed_data import VENUES
from app.underwriting.scoring import get_risk_score

router = APIRouter()


# ─── Shared helpers ─────────────────────────────────────────────────────


def _norm(s: str | None) -> str:
    """Normalize for dedupe comparison: trim, collapse whitespace, casefold."""
    return " ".join((s or "").strip().casefold().split())


def _venue_dedupe_key(name: str | None, address: str | None) -> tuple[str, str]:
    """A venue's identity for duplicate detection: (name, address) normalized.
    Same name at a different address is a distinct venue (e.g. a chain)."""
    return (_norm(name), _norm(address))


def _existing_venue_keys(session: Session) -> dict[str, tuple[str, str]]:
    """Map of venue id → dedupe key for every known venue (seed dict + DB).
    Address is parsed out of the venue_data JSON for DB-only rows."""
    keys: dict[str, tuple[str, str]] = {}
    for vid, vdata in VENUES.items():
        keys[vid] = _venue_dedupe_key(vdata.get("name"), vdata.get("address"))
    for v in session.exec(select(Venue)).all():
        if v.id in keys:
            continue
        try:
            data = _json.loads(v.venue_data) if v.venue_data else {}
        except (ValueError, TypeError):
            data = {}
        keys[v.id] = _venue_dedupe_key(v.name, data.get("address"))
    return keys


def _resolve_venue(venue_id: str, session: Session) -> dict:
    """Lookup order: VENUES seed dict → DB. Raises 404 on miss. Returns a
    mutable copy of the venue payload."""
    if venue_id in VENUES:
        return VENUES[venue_id]
    db_venue = session.get(Venue, venue_id)
    if db_venue is None:
        raise error_response(
            "venue_not_found",
            f"Venue {venue_id!r} not found",
            status_code=404,
        )
    try:
        data = _json.loads(db_venue.venue_data) if db_venue.venue_data else {}
    except (ValueError, TypeError):
        data = {}
    venue_data = {"name": db_venue.name, **data}
    VENUES[venue_id] = venue_data
    return venue_data


# ─── List + count ───────────────────────────────────────────────────────


@router.get("/venues")
def list_venues(
    source: Optional[str] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """All venues — both seeded and DB-only. No auth gate at the list
    level; the dashboard renders the same set for any logged-in user.
    Tenant-scoping is applied when drilling into a specific venue.

    Each row carries `source` ("book" | "prospect"). Real NYC venues seeded
    as leads are "prospect"; the underwritten demo book defaults to "book".
    `?source=book|prospect|all` filters server-side (default: all)."""
    result: list[dict] = [
        {"id": venue_id, **venue, "source": venue.get("source", "book")}
        for venue_id, venue in VENUES.items()
    ]
    db_venues = session.exec(select(Venue)).all()
    seed_ids = set(VENUES.keys())
    for v in db_venues:
        if v.id not in seed_ids:
            result.append({"id": v.id, "name": v.name, **v.model_dump(), "source": "book"})
    if source and source != "all":
        result = [r for r in result if r.get("source") == source]
    return result


@router.get("/venues/count")
def venue_count() -> dict:
    return {"count": len(VENUES)}


# ─── Create / Read / Update / Delete ────────────────────────────────────


@router.post("/venues", status_code=201)
def create_venue(
    payload: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
    _: None = Depends(require_non_broker),
) -> dict:
    name = (payload.get("name") or "").strip()
    if not name:
        raise error_response("venue_name_required", "Venue name is required", status_code=400)
    explicit_id = payload.get("id")
    address = payload.get("address", "")

    # Duplicate detection is keyed on (name, address), not id — closes the
    # old gap where the explicit-id (first-venue) path skipped the check and
    # every operator naming a venue "Bdubs" created a new row. Same name at a
    # different address is allowed (distinct venue) and gets a suffixed id.
    incoming_key = _venue_dedupe_key(name, address)
    existing_keys = _existing_venue_keys(session)
    for ex_id, ex_key in existing_keys.items():
        if ex_key == incoming_key and ex_id != explicit_id:
            raise error_response(
                "venue_duplicate",
                "A venue with this name and address already exists",
                status_code=409,
            )

    if explicit_id:
        venue_id = explicit_id
        is_upsert = venue_id in VENUES or session.get(Venue, venue_id) is not None
    else:
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "venue"
        venue_id = base
        suffix = 2
        while venue_id in existing_keys:
            venue_id = f"{base}-{suffix}"
            suffix += 1
        is_upsert = False

    venue_data = {
        "name": name,
        "capacity": int(payload.get("capacity", 300)),
        "venue_type": payload.get("venue_type", "bar"),
        "address": payload.get("address", ""),
        "current_carrier": "Surplus Lines",
        "renewal_date": payload.get("renewal_date", "2027-01-01"),
        "incident_count": 0,
        "compliance_items": 0,
        "security_level": "medium",
        "years_in_operation": int(payload.get("years_in_operation", 1)),
        "prior_carrier": "Surplus Lines",
        "infrastructure": [],
    }
    VENUES[venue_id] = venue_data
    db_venue = session.get(Venue, venue_id)
    if db_venue:
        db_venue.name = name
        db_venue.venue_data = _json.dumps(venue_data)
    else:
        session.add(Venue(id=venue_id, name=name, venue_data=_json.dumps(venue_data)))

    actor = current_user_optional(authorization)
    _add_audit_event(
        session=session,
        actor_id=(actor or {}).get("sub", "anonymous"),
        actor_type="user" if actor else "anonymous",
        entity_type="venue", entity_id=venue_id,
        event_type="venue.upserted" if is_upsert else "venue.created",
        event_metadata={
            "name": name,
            "capacity": venue_data["capacity"],
            "venue_type": venue_data["venue_type"],
        },
    )
    session.commit()
    return {"id": venue_id, **venue_data}


@router.get("/venues/{venue_id}")
def get_venue(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    require_venue_access(venue_id, authorization, session)
    venue = _resolve_venue(venue_id, session)
    return {"id": venue_id, **venue}


@router.patch("/venues/{venue_id}")
def update_venue(
    venue_id: str,
    payload: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
    _: None = Depends(require_non_broker),
) -> dict:
    user = require_venue_access(venue_id, authorization, session)
    venue = _resolve_venue(venue_id, session)
    editable = ["name", "address", "capacity", "venue_type", "years_in_operation", "security_level"]
    changed: dict[str, Any] = {}
    for field in editable:
        if field in payload:
            value = payload[field]
            if field in ("capacity", "years_in_operation"):
                value = int(value)
            if venue.get(field) != value:
                changed[field] = value
                venue[field] = value
    VENUES[venue_id] = venue
    db_venue = session.get(Venue, venue_id)
    if db_venue:
        db_venue.name = venue.get("name", db_venue.name)
        db_venue.venue_data = _json.dumps(venue)
        session.add(db_venue)
    if changed:
        _add_audit_event(
            session=session,
            actor_id=user["sub"], actor_type="user",
            entity_type="venue", entity_id=venue_id,
            event_type="venue.updated",
            event_metadata={"changed_fields": list(changed.keys())},
        )
    session.commit()
    return {"id": venue_id, **venue}


@router.delete("/venues/{venue_id}", status_code=200)
def delete_venue(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
    _: None = Depends(require_non_broker),
) -> dict:
    user = require_venue_access(venue_id, authorization, session)
    _resolve_venue(venue_id, session)
    incident_count = session.exec(
        select(func.count(IncidentRecord.id)).where(IncidentRecord.venue_id == venue_id)
    ).one()
    if incident_count > 0:
        raise error_response(
            "venue_has_incidents",
            f"Cannot delete venue — it has {incident_count} incident(s) on record.",
            status_code=409,
            details={"incident_count": incident_count},
        )
    VENUES.pop(venue_id, None)
    db_venue = session.get(Venue, venue_id)
    if db_venue:
        session.delete(db_venue)
    _add_audit_event(
        session=session,
        actor_id=user["sub"], actor_type="user",
        entity_type="venue", entity_id=venue_id,
        event_type="venue.deleted",
        event_metadata={},
    )
    session.commit()
    return {"deleted": venue_id}


# ─── Portfolio aggregation (broker-only) ────────────────────────────────


@router.get("/portfolio")
def get_portfolio(
    source: Optional[str] = None,
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
) -> list[dict]:
    """Single broker-facing rollup: every venue with risk score, live
    state, and an open-incident count. Used by the dashboard 'Book' widget.

    Each row carries `source` ("book" | "prospect"). Prospects are real NYC
    venues seeded as leads — they have NO live telemetry, so the live-state
    manager and open-incident query are short-circuited for them (their tier/
    score still come from the same absolute risk engine, computed from their
    generated attributes). `?source=book|prospect|all` filters (default: all)."""
    result: list[dict] = []
    for venue_id, venue_data in VENUES.items():
        vsource = venue_data.get("source", "book")
        if source and source != "all" and vsource != source:
            continue
        risk = get_risk_score(
            venue_id, VENUES, session=session, live_state_manager=live_state_manager,
        )
        if vsource == "prospect":
            # No live floor state for a lead — don't run the live engine.
            current_capacity: Optional[int] = 0
            open_count: Optional[int] = 0
            compliance_actions = 0
            has_degraded = False
        else:
            live = live_state_manager.get_state(venue_id, venue_data["capacity"], venue_data)
            open_count = session.exec(
                select(func.count(IncidentRecord.id))
                .where(IncidentRecord.venue_id == venue_id)
                .where(IncidentRecord.status == "open")
            ).one()
            # Live occupancy is operator-only floor data. Brokers see policy
            # artifacts but not the live shift state — null it so the book
            # matches the gated /venues/{id}/live detail view (no contradiction).
            current_capacity = (
                live.current_capacity
                if can_read_venue_floor(user, venue_id, session)
                else None
            )
            compliance_actions = len(live.compliance_queue)
            has_degraded = any(item.is_degraded for item in live.infrastructure)
        result.append({
            "id": venue_id,
            "name": venue_data["name"],
            "venue_type": venue_data.get("venue_type", ""),
            "address": venue_data.get("address", ""),
            "capacity": venue_data.get("capacity", 0),
            "current_capacity": current_capacity,
            "renewal_date": venue_data.get("renewal_date", ""),
            "current_carrier": venue_data.get("current_carrier", ""),
            "tier": risk["tier"],
            "total_score": risk["total_score"],
            "open_incidents": open_count,
            "compliance_actions": compliance_actions,
            "has_degraded_infra": has_degraded,
            "source": vsource,
            # Pitch fields — populated on prospects (estimated savings), null/[]
            # on book venues. The broker Market tool filters by borough, renders
            # carrier chips, and plots map pins from these, so they ship on every
            # row uniformly (book venues just carry empty values).
            "savings_low": venue_data.get("savings_low"),
            "savings_high": venue_data.get("savings_high"),
            "market_premium": venue_data.get("market_premium"),
            "borough": venue_data.get("borough"),
            "license_class": venue_data.get("license_class"),
            "lat": venue_data.get("lat"),
            "lng": venue_data.get("lng"),
            "likely_carriers": venue_data.get("likely_carriers", []),
        })
    return result
