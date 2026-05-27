"""Observability for the operational-data ingestion spine.

  GET /api/ingestion/runs   (broker/admin)  — recent IngestionRun log rows

Surfaces the run history the runner writes: per-run counts (extracted/loaded/
skipped/rejected), status, watermark, and any error — so a broker can see what
the connectors pulled and whether anything was rejected by the quality gate.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.auth import require_broker
from app.database import get_session
from app.models import IngestionRun
from app.time import as_utc

router = APIRouter()


def _serialize(run: IngestionRun) -> dict:
    def _iso(dt):
        dt = as_utc(dt)
        return dt.isoformat() if dt else None

    return {
        "id": run.id,
        "source_system": run.source_system,
        "status": run.status,
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
        "extracted": run.extracted,
        "loaded": run.loaded,
        "skipped": run.skipped,
        "rejected": run.rejected,
        "rejected_reasons": json.loads(run.rejected_reasons) if run.rejected_reasons else {},
        "watermark": _iso(run.watermark),
        "error": run.error,
    }


@router.get("/ingestion/runs", dependencies=[Depends(require_broker)])
def list_ingestion_runs(
    limit: int = Query(50, ge=1, le=200),
    source: str | None = Query(None),
    session: Session = Depends(get_session),
):
    """Most-recent-first ingestion runs, optionally filtered by source."""
    stmt = select(IngestionRun)
    if source:
        stmt = stmt.where(IngestionRun.source_system == source)
    stmt = stmt.order_by(IngestionRun.started_at.desc()).limit(limit)  # type: ignore[attr-defined]
    return [_serialize(r) for r in session.exec(stmt).all()]
