"""Seed the real NYC nightlife venues as scored *prospects* so the broker
profile shows a real, populated market (not just the 18 demo book venues).

Reads the committed snapshot at frontend/public/nyc_market.json (produced by
scripts/build_nyc_market.py) and writes one `Venue` row per venue, id'd
`prospect-<market_id>`, with venue_data from app.prospects (source="prospect"
+ deterministic scoring attributes). Also registers them into the in-memory
VENUES dict so an in-process run is live immediately; a fresh server picks
them up via the startup hydration that loads Venue.venue_data into VENUES.

Idempotent: skips if any prospect-* Venue already exists.

Run from the backend directory:
    python -m scripts.seed_prospects
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from sqlmodel import Session, select

from app.database import engine
from app.models import Venue
from app.prospects import market_venue_to_venue_data
from app.seed_data import VENUES

# Prefer the copy that ships with the backend (so it's present on Railway,
# which deploys only backend/); fall back to the frontend source in dev.
_BACKEND_SNAPSHOT = Path(__file__).resolve().parent.parent / "app" / "data" / "nyc_market.json"
_FRONTEND_SNAPSHOT = (
    Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "nyc_market.json"
)
SNAPSHOT_PATH = _BACKEND_SNAPSHOT if _BACKEND_SNAPSHOT.exists() else _FRONTEND_SNAPSHOT


def _has_prospects(session: Session) -> bool:
    row = session.exec(
        select(Venue).where(Venue.id.like("prospect-%"))  # type: ignore[attr-defined]
    ).first()
    return row is not None


def seed_prospects() -> int:
    if not SNAPSHOT_PATH.exists():
        print(f"[seed] snapshot not found at {SNAPSHOT_PATH}; run build_nyc_market first.")
        return 0

    data = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    market_venues = data.get("venues", [])

    with Session(engine) as session:
        if _has_prospects(session):
            print("[seed] skipped: prospects already seeded")
            return 0

        created = 0
        for mv in market_venues:
            vid = f"prospect-{mv['id']}"
            vd = market_venue_to_venue_data(mv)
            session.add(Venue(id=vid, name=vd["name"], venue_data=json.dumps(vd)))
            VENUES[vid] = vd
            created += 1
        session.commit()
        print(f"[seed] created {created} prospect venues")
        return created


if __name__ == "__main__":
    sys.exit(0 if seed_prospects() >= 0 else 1)
