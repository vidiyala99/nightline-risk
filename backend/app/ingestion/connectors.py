"""Concrete PR1 connectors.

- `PosConnector`: a simulated point-of-sale feed emitting per-venue over-pour
  / late-night alcohol-velocity signals. Deterministic per `(venue, as_of)`
  so a demo is reproducible and re-running the same window is idempotent.
- `NycOpenDataConnector`: wraps the existing NYC market snapshot as a
  master-data feed, upserting prospect `Venue` rows (same path as
  `scripts/seed_prospects`). Proves the spine wraps a genuine external feed.
"""
from __future__ import annotations

import json
import random
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlmodel import Session

from app.ingestion.base import (
    Connector,
    LoadResult,
    NormalizedEvent,
    OperationalConnector,
)
from app.models import Venue
from app.prospects import market_venue_to_venue_data
from app.time import now_utc
from scripts.nyc_market_lib import dedupe_rows


class PosConnector(OperationalConnector):
    """Simulated POS feed → one `over_pour_rate` signal per venue per window."""

    source_system = "pos"

    def __init__(
        self,
        venue_ids: list[str],
        *,
        as_of: Optional[datetime] = None,
        venues_index: Optional[dict] = None,
    ):
        super().__init__(venues_index=venues_index)
        self.venue_ids = venue_ids
        self.as_of = as_of or now_utc()

    def extract(self) -> Iterable[Any]:
        # One raw record per venue; the window is the connector's as_of.
        for vid in self.venue_ids:
            yield {"venue_id": vid, "as_of": self.as_of}

    def transform(self, raw: Any) -> list[NormalizedEvent]:
        vid = raw["venue_id"]
        as_of: datetime = raw["as_of"]
        # Deterministic per (venue, window): seeds reproducible demos and makes
        # the content_hash stable so re-running the same window dedupes.
        rng = random.Random(f"pos|{vid}|{as_of.isoformat()}")
        rate = round(rng.uniform(0.0, 1.0), 4)
        return [
            NormalizedEvent(
                venue_id=vid,
                source_system=self.source_system,
                event_type="over_pour",
                metric_name="over_pour_rate",
                value=rate,
                occurred_at=as_of,
                external_ref=f"pos-{vid}-{as_of.isoformat()}",
                metadata={"window": as_of.isoformat(), "simulated": True},
            )
        ]


class NycOpenDataConnector(Connector):
    """Master-data feed: NYC nightlife licensees → prospect `Venue` rows.

    Network-free by default — reads the committed market snapshot (the same
    artifact `seed_prospects` uses). `records` can be injected for tests."""

    source_system = "nyc_open_data"

    _BACKEND_SNAPSHOT = (
        Path(__file__).resolve().parents[2] / "app" / "data" / "nyc_market.json"
    )
    _FRONTEND_SNAPSHOT = (
        Path(__file__).resolve().parents[3] / "frontend" / "public" / "nyc_market.json"
    )

    def __init__(self, *, records: Optional[list[dict]] = None):
        self._records = records

    def _snapshot_path(self) -> Path:
        return (
            self._BACKEND_SNAPSHOT
            if self._BACKEND_SNAPSHOT.exists()
            else self._FRONTEND_SNAPSHOT
        )

    def extract(self) -> Iterable[Any]:
        if self._records is not None:
            return [self._records]
        path = self._snapshot_path()
        if not path.exists():
            return []
        data = json.loads(path.read_text(encoding="utf-8"))
        return [data.get("venues", [])]

    def transform(self, raw: Any) -> list[dict]:
        # raw is a batch (list of market venue rows); dedupe by name+address.
        return dedupe_rows(list(raw))

    def load(self, session: Session, rows: list[dict]) -> LoadResult:
        loaded = 0
        skipped = 0
        seen: set[str] = set()
        for mv in rows:
            vid = f"prospect-{mv['id']}"
            if vid in seen:
                skipped += 1
                continue
            seen.add(vid)
            if session.get(Venue, vid) is not None:
                skipped += 1
                continue
            vd = market_venue_to_venue_data(mv)
            session.add(Venue(id=vid, name=vd["name"], venue_data=json.dumps(vd)))
            loaded += 1
        return LoadResult(loaded=loaded, skipped=skipped)
