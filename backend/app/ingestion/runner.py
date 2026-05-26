"""The single entry point both the CLI and the in-process tick call.

`run(source|"all", session)` resolves each source's last watermark from the
`IngestionRun` log (so pulls are incremental), builds the connector, and runs
it through the spine. Returns the `IngestionRun` rows for reporting.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.ingestion.base import run_connector
from app.ingestion.registry import SOURCES, build_connector
from app.models import IngestionRun


def _latest_watermark(session: Session, source: str) -> Optional[datetime]:
    row = session.exec(
        select(IngestionRun)
        .where(IngestionRun.source_system == source)
        .where(IngestionRun.status == "success")
        .order_by(IngestionRun.started_at.desc())  # type: ignore[attr-defined]
    ).first()
    return row.watermark if row else None


def run(
    source: str,
    session: Session,
    *,
    venues: Optional[dict] = None,
    dry_run: bool = False,
) -> list[IngestionRun]:
    """Run one source or "all". `venues` defaults to the live in-memory index."""
    if venues is None:
        from app.seed_data import VENUES

        venues = VENUES

    sources = SOURCES if source == "all" else (source,)
    runs: list[IngestionRun] = []
    for src in sources:
        connector = build_connector(src, venues=venues)  # raises KeyError if unknown
        watermark = _latest_watermark(session, src)
        runs.append(
            run_connector(connector, session, watermark=watermark, dry_run=dry_run)
        )
    return runs
