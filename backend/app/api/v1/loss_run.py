"""Per-venue loss run — JSON view + CSV export.

  GET /api/venues/{venue_id}/loss-run       → JSON (claims history + totals)
  GET /api/venues/{venue_id}/loss-run.csv   → text/csv attachment

Venue-access gated (require_venue_access): brokers/admins pass for any venue;
the owning operator passes for their own. A loss run is a venue's own claims
history, so the operator legitimately sees theirs.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from fastapi.responses import PlainTextResponse
from sqlmodel import Session

from app.auth import require_venue_access
from app.database import get_session
from app.services.loss_run import loss_run_csv, venue_loss_run

router = APIRouter()


@router.get("/venues/{venue_id}/loss-run")
def get_loss_run(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    require_venue_access(venue_id, authorization, session)
    return venue_loss_run(session, venue_id)


@router.get("/venues/{venue_id}/loss-run.csv")
def get_loss_run_csv(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> PlainTextResponse:
    require_venue_access(venue_id, authorization, session)
    csv_text = loss_run_csv(session, venue_id)
    return PlainTextResponse(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="loss-run-{venue_id}.csv"'},
    )
