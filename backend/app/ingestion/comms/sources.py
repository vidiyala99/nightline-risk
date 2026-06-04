# backend/app/ingestion/comms/sources.py
"""Communication/workflow sources behind a single MCP-client seam.

v1 ships SIMULATED, network-free sources (deterministic per day, mirroring
PosConnector). The real implementation is a thin MCP client behind the same
`list_items` interface — swapping sim->real changes only this file.
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from app.ingestion.comms.types import CommsItem
from app.time import now_utc

# (text, expected_kind) — expected_kind doubles as the eval label set (Task 2).
SAMPLE_FEED: dict[str, list[tuple[str, str]]] = {
    "slack": [
        # 2 incident cues (punch + cops) → confidence 0.90 → clears AUTO_CREATE_THRESHOLD
        ("Two patrons throwing punches at the front door, cops called", "incident"),
        ("Can someone restock the bar napkins before doors", "noise"),
        # 2 compliance cues (exit sign + blocked) → confidence 0.90 → clears AUTO_CREATE_THRESHOLD
        ("Exit sign by stairwell B is out and the path is blocked", "compliance"),
    ],
    "tickets": [
        ("Guest slipped on a spilled drink near booth 4, EMS was called", "incident"),
        ("Fire extinguisher tag expired in the kitchen", "compliance"),
        ("Office wifi is down", "noise"),
    ],
    "sms": [
        ("Fight outside, cops on the way", "incident"),
        ("Running 10 min late for my shift", "noise"),
        # 2 compliance cues (first aid + expired) → confidence 0.90
        ("First aid kit is empty and the permit expired", "compliance"),
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


_SIMULATED = {"slack": SlackSource, "tickets": TicketSource, "sms": TextSource}


def build_comms_source(
    source: str, venue_ids: list[str], *, as_of: Optional[datetime] = None
) -> CommsSource:
    """Pick the source backend per `source`, env-gated (mirrors STORAGE_BACKEND):
    if `COMMS_MCP_<SOURCE>_SSE_URL` is set, use the real MCP client; otherwise
    fall back to the simulated source. Absent config → simulated."""
    sse_url = os.getenv(f"COMMS_MCP_{source.upper()}_SSE_URL")
    if sse_url:
        # Imported lazily to keep the sim path free of the mcp_source module.
        from app.ingestion.comms.mcp_source import McpCommsSource

        return McpCommsSource(source, venue_ids, sse_url=sse_url, as_of=as_of)
    sim = _SIMULATED[source]
    return sim(venue_ids, as_of=as_of) if as_of else sim(venue_ids)
