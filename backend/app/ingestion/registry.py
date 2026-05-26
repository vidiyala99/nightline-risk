"""Source registry — maps a source key to a built connector.

Keeping construction in one place lets the runner, CLI, and lifespan tick all
resolve sources the same way. PR2 adds id_scanner + staffing here.
"""
from __future__ import annotations

from app.ingestion.base import Connector
from app.ingestion.connectors import NycOpenDataConnector, PosConnector

# Order matters for "all" runs (master data before operational, so freshly
# upserted prospects can pick up signals on the same pass in a future tick).
SOURCES: tuple[str, ...] = ("nyc_open_data", "pos")


def build_connector(source: str, *, venues: dict) -> Connector:
    """Construct the connector for `source`. `venues` is the in-memory index
    used both to enumerate operational targets and as the rollup write-back."""
    if source == "pos":
        return PosConnector(venue_ids=list(venues.keys()), venues_index=venues)
    if source == "nyc_open_data":
        return NycOpenDataConnector()
    raise KeyError(f"unknown ingestion source: {source!r}")
