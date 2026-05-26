"""Roll up ingested operational events into the venue's scoring inputs.

Takes the latest `value` per `(venue, metric_name)` and writes it under
`Venue.venue_data["operational_data"]` in BOTH places the score reads from:
the durable `Venue.venue_data` JSON string (picked up by a fresh server's
startup hydration) and the in-memory `VENUES` dict (so a running process
reflects the new score immediately). This is the step that makes "ingest
data → score moves" true without a restart.
"""
from __future__ import annotations

import json
from typing import Optional

from sqlmodel import Session, select

from app.models import Venue, VenueOperationalEvent


def _latest_per_metric(
    session: Session, venue_id: str
) -> tuple[dict[str, float], set[str], Optional[str]]:
    """Return ({metric: latest_value}, {sources}, last_occurred_at_iso)."""
    rows = session.exec(
        select(VenueOperationalEvent).where(
            VenueOperationalEvent.venue_id == venue_id
        )
    ).all()
    if not rows:
        return {}, set(), None

    latest: dict[str, VenueOperationalEvent] = {}
    for r in rows:
        cur = latest.get(r.metric_name)
        if cur is None or r.occurred_at > cur.occurred_at:
            latest[r.metric_name] = r

    metrics = {name: ev.value for name, ev in latest.items()}
    sources = {ev.source_system for ev in latest.values()}
    last_at = max(ev.occurred_at for ev in latest.values()).isoformat()
    return metrics, sources, last_at


def rollup_operational_data(
    session: Session,
    venue_ids: list[str],
    *,
    venues_index: Optional[dict] = None,
) -> None:
    """For each venue, recompute `operational_data` and write it to the DB
    `Venue.venue_data` JSON string and (if provided) the in-memory index."""
    for venue_id in venue_ids:
        metrics, sources, last_at = _latest_per_metric(session, venue_id)
        if not metrics:
            continue

        operational_data = {
            **metrics,
            "last_ingest_at": last_at,
            "sources": sorted(sources),
        }

        row = session.get(Venue, venue_id)
        if row is not None:
            vd = json.loads(row.venue_data) if row.venue_data else {"name": row.name}
            vd["operational_data"] = operational_data
            row.venue_data = json.dumps(vd)
            session.add(row)

        if venues_index is not None and venue_id in venues_index:
            venues_index[venue_id]["operational_data"] = operational_data
