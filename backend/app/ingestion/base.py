"""Connector framework + uniform run wrapper for the ingestion spine.

A `Connector` is a three-stage pipeline (extract → transform → load).
`run_connector` wraps any connector with the cross-cutting concerns that
must behave identically for every source: watermark filtering (incremental
pulls), a data-quality gate, content-hash dedupe at load, rollup, and an
`IngestionRun` log row that doubles as the incremental cursor.
"""
from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Iterable, Optional
from uuid import uuid4

from sqlmodel import Session, select

from app.models import IngestionRun, VenueOperationalEvent
from app.time import as_utc, now_utc


@dataclass
class NormalizedEvent:
    """A source-agnostic operational signal, the unit every connector emits."""
    venue_id: str
    source_system: str
    event_type: str
    metric_name: str
    value: float
    occurred_at: datetime
    external_ref: Optional[str] = None
    metadata: dict = field(default_factory=dict)

    @property
    def content_hash(self) -> str:
        """SHA-256 over the event's logical identity — the dedupe key.

        Two extractions of the same real event must hash identically, so the
        identity excludes ingestion-time fields (ingested_at) and the mutable
        metadata blob. Includes external_ref so two distinct source records
        with otherwise-identical fields are not collapsed.
        """
        identity = {
            "venue_id": self.venue_id,
            "source_system": self.source_system,
            "metric_name": self.metric_name,
            "occurred_at": self.occurred_at.isoformat(),
            "external_ref": self.external_ref or "",
        }
        canonical = json.dumps(identity, sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class LoadResult:
    loaded: int = 0
    skipped: int = 0


class Connector(ABC):
    """Extract → transform → load. Operational connectors load
    `VenueOperationalEvent` rows (via `load_operational_events`); the
    master-data connector overrides `load` to upsert `Venue` prospects."""

    source_system: str

    @abstractmethod
    def extract(self) -> Iterable[Any]:
        """Yield raw source records/batches. No transformation here."""

    @abstractmethod
    def transform(self, raw: Any) -> list[NormalizedEvent]:
        """Map one raw record/batch to normalized events."""

    @abstractmethod
    def load(self, session: Session, events: list[NormalizedEvent]) -> LoadResult:
        """Persist normalized events; return loaded/skipped counts."""

    def rollup(self, session: Session, events: list[NormalizedEvent]) -> None:
        """Optional post-load aggregation (operational connectors override)."""
        return None


class OperationalConnector(Connector):
    """Base for connectors that emit `VenueOperationalEvent` rows. Supplies the
    standard dedupe-load and the rollup that pushes the new values into the
    risk score. Subclasses implement only `extract` + `transform`."""

    def __init__(self, *, venues_index: Optional[dict] = None):
        self.venues_index = venues_index

    def load(self, session: Session, events: list[NormalizedEvent]) -> LoadResult:
        return load_operational_events(session, events)

    def rollup(self, session: Session, events: list[NormalizedEvent]) -> None:
        venue_ids = sorted({e.venue_id for e in events})
        if not venue_ids:
            return
        from app.ingestion.rollup import rollup_operational_data

        rollup_operational_data(session, venue_ids, venues_index=self.venues_index)


def load_operational_events(
    session: Session, events: list[NormalizedEvent]
) -> LoadResult:
    """Insert events as `VenueOperationalEvent` rows, skipping any whose
    `content_hash` already exists. This is what makes ingestion idempotent."""
    loaded = 0
    skipped = 0
    seen_this_batch: set[str] = set()
    for ev in events:
        h = ev.content_hash
        if h in seen_this_batch:
            skipped += 1
            continue
        existing = session.exec(
            select(VenueOperationalEvent).where(
                VenueOperationalEvent.content_hash == h
            )
        ).first()
        if existing is not None:
            skipped += 1
            seen_this_batch.add(h)
            continue
        session.add(
            VenueOperationalEvent(
                id=f"voe-{uuid4().hex[:12]}",
                venue_id=ev.venue_id,
                source_system=ev.source_system,
                event_type=ev.event_type,
                metric_name=ev.metric_name,
                value=ev.value,
                occurred_at=ev.occurred_at,
                content_hash=h,
                external_ref=ev.external_ref,
                event_metadata=dict(ev.metadata),
            )
        )
        seen_this_batch.add(h)
        loaded += 1
    return LoadResult(loaded=loaded, skipped=skipped)


def run_connector(
    connector: Connector,
    session: Session,
    *,
    watermark: Optional[datetime] = None,
    quality_filter: Optional[Callable[[NormalizedEvent], bool]] = None,
    dry_run: bool = False,
) -> IngestionRun:
    """Run one connector end-to-end and return its `IngestionRun` log row.

    Order: extract → transform → watermark filter → quality filter → load
    (dedupe) → rollup → log. On any exception the run is recorded with
    status='error'. In dry-run mode nothing is persisted.
    """
    run = IngestionRun(
        id=f"ingest-{uuid4().hex[:12]}",
        source_system=connector.source_system,
        status="running",
    )
    try:
        all_events: list[NormalizedEvent] = []
        for raw in connector.extract():
            all_events.extend(connector.transform(raw))
        run.extracted = len(all_events)

        # Incremental: drop anything we've already advanced past. Master-data
        # items (no occurred_at) carry no timeline and always pass. SQLite
        # strips tzinfo on read, so the watermark may be naive while fresh
        # events are tz-aware — normalize both via as_utc before comparing.
        def _occurred_at(item: Any) -> Optional[datetime]:
            return as_utc(getattr(item, "occurred_at", None))

        wm = as_utc(watermark)

        def _is_fresh(item: Any) -> bool:
            if wm is None:
                return True
            oa = _occurred_at(item)
            return oa is None or oa > wm

        fresh = [e for e in all_events if _is_fresh(e)]

        # Data-quality gate.
        accepted: list[NormalizedEvent] = []
        for e in fresh:
            if quality_filter is None or quality_filter(e):
                accepted.append(e)
            else:
                run.rejected += 1

        if not dry_run:
            result = connector.load(session, accepted)
            connector.rollup(session, accepted)
            run.loaded = result.loaded
            run.skipped = result.skipped

        # Advance the cursor to the newest event we saw this run (even ones
        # we rejected — re-pulling them won't help), never going backwards.
        seen_times = [oa for oa in (_occurred_at(e) for e in fresh) if oa is not None]
        seen_max = max(seen_times, default=None)
        run.watermark = max([w for w in (wm, seen_max) if w is not None], default=None)
        run.status = "success"
    except Exception as exc:  # pragma: no cover - defensive run-log path
        run.status = "error"
        run.error = str(exc)

    run.finished_at = now_utc()
    if not dry_run:
        session.add(run)
        session.commit()
        # Commit expires attributes, and a later run's commit would re-expire
        # this one. Refresh to repopulate, then expunge so the returned object
        # is fully readable after the session closes (the CLI prints it there).
        session.refresh(run)
        session.expunge(run)
    return run
