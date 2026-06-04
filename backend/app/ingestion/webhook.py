"""Real-time push ingestion — the lane that makes "POST a signal -> Savings
Score inputs move" true, end to end, without a message-bus stub.

A pushed signal is persisted through the *same* spine as batch pulls
(`run_connector`): the data-quality gate, content-hash dedupe, the
`IngestionRun` audit row, and the rollup into `Venue.operational_data`. The
only difference from a batch pull is that pushed events are authoritative
rather than an incremental cursor read, so we run with `watermark=None` (no
freshness filtering).

It also holds the small, honest mappings from each raw source payload to the
normalized, score-weighted metrics the engine already understands:
  - camera  person_count / capacity        -> occupancy_ratio  (instantaneous)
  - pos     alcohol share of the order      -> over_pour_rate   (per-order proxy)
  - staffing caller-computed coverage ratio -> staffing_ratio   (roster context
             lives in the scheduling system, so a bare clock event scores nothing)
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from sqlmodel import Session

from app.ingestion.base import NormalizedEvent, OperationalConnector, run_connector
from app.ingestion.quality import is_valid_event
from app.ingestion.rollup import _latest_per_metric
from app.models import IngestionRun, Venue

# Venue-size fallback when a venue carries no capacity (matches scoring's
# reference room size, so an unsized venue normalizes to ratio 1.0 at capacity).
DEFAULT_CAPACITY = 800.0


class _InlineConnector(OperationalConnector):
    """Wraps already-normalized pushed events so they flow through the spine.
    There is no real extract — the events arrived over HTTP — so extract just
    yields them and transform passes them through."""

    def __init__(self, source_system: str, events: list[NormalizedEvent], *, venues_index: Optional[dict] = None):
        super().__init__(venues_index=venues_index)
        self.source_system = source_system
        self._events = events

    def extract(self):
        return [self._events]

    def transform(self, raw):
        return list(raw)


def ingest_signal(
    session: Session,
    events: list[NormalizedEvent],
    *,
    venues_index: Optional[dict] = None,
) -> IngestionRun:
    """Persist pushed operational events through the spine and return the run.

    Empty input still logs a no-op success run so the push is auditable. The
    source_system on the run is taken from the events (single-source per call)."""
    source = events[0].source_system if events else "push"
    connector = _InlineConnector(source, events, venues_index=venues_index)
    return run_connector(
        connector,
        session,
        watermark=None,  # pushed events are authoritative, not an incremental pull
        quality_filter=is_valid_event,
    )


def operational_snapshot(session: Session, venue_id: str) -> dict:
    """The venue's current score inputs (latest value per metric) — what the
    push response echoes back so the caller can see the score move."""
    metrics, _sources, _last = _latest_per_metric(session, venue_id)
    return metrics


def venue_capacity(session: Session, venue_id: str, *, venues_index: Optional[dict] = None) -> float:
    """Resolve a venue's capacity from the in-memory index, then the DB row,
    then the reference fallback — used to normalize a camera headcount."""
    if venues_index and venue_id in venues_index:
        cap = venues_index[venue_id].get("capacity")
        if cap:
            return float(cap)
    row = session.get(Venue, venue_id)
    if row is not None and row.venue_data:
        try:
            cap = json.loads(row.venue_data).get("capacity")
            if cap:
                return float(cap)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    return DEFAULT_CAPACITY


# --- raw payload -> normalized score metrics --------------------------------

def pos_signals(venue_id: str, event, *, occurred_at: datetime) -> list[NormalizedEvent]:
    """Alcohol share of the order as an over-pour proxy. A single order is a
    point reading, not a true windowed rate — labelled `proxy` in metadata."""
    items = event.payload.items
    total_qty = sum(i.quantity for i in items)
    alcohol_qty = sum(i.quantity for i in items if i.category.lower() == "alcohol")
    rate = round(alcohol_qty / total_qty, 4) if total_qty else 0.0
    return [
        NormalizedEvent(
            venue_id=venue_id,
            source_system="pos",
            event_type="over_pour",
            metric_name="over_pour_rate",
            value=rate,
            occurred_at=occurred_at,
            external_ref=f"pos-{event.payload.order_id}",
            metadata={"order_id": event.payload.order_id, "alcohol_qty": alcohol_qty, "proxy": "alcohol_share"},
        )
    ]


def camera_signals(venue_id: str, event, *, occurred_at: datetime, capacity: float) -> list[NormalizedEvent]:
    """Instantaneous occupancy = headcount / capacity (capped at the gate's
    upper bound). Aggression rides along in metadata for evidence, not scoring."""
    ratio = round(event.payload.person_count / capacity, 4) if capacity else 0.0
    ratio = min(ratio, 3.0)  # stay within METRIC_SPECS["occupancy_ratio"] bound
    return [
        NormalizedEvent(
            venue_id=venue_id,
            source_system="id_scanner",  # occupancy is a door/scanner-class signal
            event_type="occupancy",
            metric_name="occupancy_ratio",
            value=ratio,
            occurred_at=occurred_at,
            external_ref=f"cam-{event.event_id}",
            metadata={
                "zone": event.payload.zone_id,
                "person_count": event.payload.person_count,
                "aggression_score": event.payload.aggression_score,
            },
        )
    ]


def staffing_signals(venue_id: str, event, *, occurred_at: datetime) -> list[NormalizedEvent]:
    """A coverage ratio (actual / required) computed by the scheduling system.
    A bare clock-in/out has no level on its own, so it scores nothing."""
    ratio = getattr(event.payload, "staffing_ratio", None)
    if ratio is None:
        return []
    return [
        NormalizedEvent(
            venue_id=venue_id,
            source_system="staffing",
            event_type="staffing_level",
            metric_name="staffing_ratio",
            value=float(ratio),
            occurred_at=occurred_at,
            external_ref=f"staffing-{event.payload.staff_id}-{occurred_at.isoformat()}",
            metadata={"role": event.payload.role, "action": event.payload.action},
        )
    ]
