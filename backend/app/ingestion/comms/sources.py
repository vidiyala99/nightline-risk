# backend/app/ingestion/comms/sources.py
"""Communication/workflow sources behind a single MCP-client seam.

v1 ships SIMULATED, network-free sources (deterministic per day, mirroring
PosConnector). The real implementation is a thin MCP client behind the same
`list_items` interface — swapping sim->real changes only this file.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from app.ingestion.comms.types import CommsItem
from app.time import now_utc

# (text, expected_kind) — expected_kind doubles as the eval label set (Task 2).
SAMPLE_FEED: dict[str, list[tuple[str, str]]] = {
    "slack": [
        ("Two patrons throwing punches at the front door, security broke it up", "incident"),
        ("Can someone restock the bar napkins before doors", "noise"),
        ("Exit sign by stairwell B is out again", "compliance"),
    ],
    "tickets": [
        ("Guest slipped on a spilled drink near booth 4, EMS was called", "incident"),
        ("Fire extinguisher tag expired in the kitchen", "compliance"),
        ("Office wifi is down", "noise"),
    ],
    "sms": [
        ("Fight outside, cops on the way", "incident"),
        ("Running 10 min late for my shift", "noise"),
        ("First aid kit is empty", "compliance"),
    ],
}


class CommsSource(ABC):
    source: str

    @abstractmethod
    def list_items(self, *, since: Optional[datetime] = None) -> list[CommsItem]:
        """Return raw items (optionally newer than `since`)."""


class _SimulatedSource(CommsSource):
    def __init__(self, source: str, venue_ids: list[str], *, as_of: Optional[datetime] = None):
        self.source = source
        self.venue_ids = venue_ids
        self.as_of = as_of or now_utc()

    def list_items(self, *, since: Optional[datetime] = None) -> list[CommsItem]:
        items: list[CommsItem] = []
        day = self.as_of.date().isoformat()
        for vid in self.venue_ids:
            for idx, (text, _label) in enumerate(SAMPLE_FEED[self.source]):
                items.append(
                    CommsItem(
                        source=self.source,
                        venue_id=vid,
                        external_id=f"{self.source}-{vid}-{idx}-{day}",
                        text=text,
                        occurred_at=self.as_of,
                        author="floor-staff",
                    )
                )
        return items


class SlackSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("slack", venue_ids, **kw)


class TicketSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("tickets", venue_ids, **kw)


class TextSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("sms", venue_ids, **kw)
