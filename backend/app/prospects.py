"""Turn real NYC market venues into scored *prospects* for the broker profile.

A prospect is a real NYC nightlife licensee (from frontend/public/nyc_market.json)
surfaced in the broker's book as a lead — visually distinct from underwritten
venues, but carrying deterministically-generated operational/risk attributes so
it flows through the SAME absolute risk engine (app.underwriting.scoring) as a
real venue. No special-casing in scoring; only the live-telemetry path is
short-circuited downstream (prospects have no live floor state).

Determinism: every generated field is seeded by the venue id (random.Random(id)),
so a demo is byte-for-byte reproducible across runs and machines — matching the
project's snapshot/hash ethos. Generated figures are estimates and are labeled as
such wherever surfaced.
"""
from __future__ import annotations

import json
import random
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session

SECURITY_LEVELS = ("high", "medium", "low")

# Weighted so most real venues look reasonably insurable (skew to fewer
# incidents / better security), with a long tail of riskier ones.
_INCIDENT_WEIGHTS = [0, 0, 0, 1, 1, 2, 2, 3, 4, 6]
_COMPLIANCE_WEIGHTS = [0, 0, 0, 1, 1, 2, 3]
_SECURITY_WEIGHTS = ["high", "high", "medium", "medium", "medium", "low"]


def market_venue_to_venue_data(mv: dict[str, Any]) -> dict[str, Any]:
    """Map a nyc_market.json venue → a `venue_data` dict for a prospect Venue.

    Carries the market estimate (premium / savings / likely carriers) for the
    pitch, plus generated scoring attributes the absolute engine reads.
    """
    rng = random.Random(str(mv["id"]))

    incident_count = rng.choice(_INCIDENT_WEIGHTS)
    compliance_items = rng.choice(_COMPLIANCE_WEIGHTS)
    security_level = rng.choice(_SECURITY_WEIGHTS)
    years_in_operation = rng.randint(1, 25)
    capacity = rng.randint(80, 1500)

    carriers = mv.get("likely_carriers", []) or []
    current_carrier = carriers[0]["name"] if carriers else "Unplaced"
    # Renewal sometime in the next 12 months (deterministic).
    renewal = date.today() + timedelta(days=rng.randint(20, 360))

    return {
        "source": "prospect",
        # ── display ──
        "name": mv["name"],
        "address": mv.get("address", ""),
        "borough": mv.get("borough", ""),
        "lat": mv.get("lat"),
        "lng": mv.get("lng"),
        "license_class": mv.get("license_class", ""),
        "venue_type": mv.get("venue_type", ""),
        # ── market estimate (pitch: what the operator would save) ──
        "market_premium": mv.get("market_premium"),
        "ts_low": mv.get("ts_low"),
        "ts_high": mv.get("ts_high"),
        "savings_low": mv.get("savings_low"),
        "savings_high": mv.get("savings_high"),
        "savings_mid": mv.get("savings_mid"),
        "likely_carriers": carriers,
        # ── generated operational/risk attributes (estimated) ──
        "capacity": capacity,
        "current_carrier": current_carrier,
        "renewal_date": renewal.isoformat(),
        "incident_count": incident_count,
        "compliance_items": compliance_items,
        "security_level": security_level,
        "years_in_operation": years_in_operation,
        "prior_carrier": current_carrier,
    }


def convert_prospect_to_book(session: Session, venue_id: str) -> bool:
    """Promote a prospect venue to the book (called when a quote binds).

    Flips `source` → "book" on both the in-memory VENUES entry and the DB
    Venue row, and emits a `venue.converted_to_book` audit event. Idempotent:
    a no-op (returns False) if the venue is already book or unknown. Runs in
    the caller's transaction — the API layer commits.
    """
    from app.models import Venue
    from app.packet_core import _add_audit_event
    from app.seed_data import VENUES

    mem = VENUES.get(venue_id)
    row = session.get(Venue, venue_id)
    row_data = json.loads(row.venue_data) if (row and row.venue_data) else None

    current = (mem or row_data or {}).get("source", "book")
    if current != "prospect":
        return False

    if mem is not None:
        mem["source"] = "book"
    if row is not None and row_data is not None:
        row_data["source"] = "book"
        row.venue_data = json.dumps(row_data)
        session.add(row)

    _add_audit_event(
        session=session,
        actor_id="system", actor_type="user",
        entity_type="venue", entity_id=venue_id,
        event_type="venue.converted_to_book", event_metadata={},
    )
    return True
