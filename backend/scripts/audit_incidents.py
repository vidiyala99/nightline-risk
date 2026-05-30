"""Audit IncidentRecord rows per venue — counts, status mix, open-incident age.

Read-only. Run this to understand *why* a venue's Safety Record factor is low
before touching anything: a venue showing "29 open" almost always has a pile of
stale, app-generated (`inc-` id prefix) incidents that were never closed, as
opposed to its handful of seeded (`seed-` id prefix) rows. The recency-decayed
scoring (app/underwriting/scoring.py) keys off `occurred_at`, so the open-age
buckets below predict how much each venue's open incidents drag the score.

Usage (from backend/):
    python -m scripts.audit_incidents                      # all venues
    python -m scripts.audit_incidents --venue elsewhere-brooklyn

Against prod, use the Postgres PUBLIC url (railway run injects the internal
host, which won't resolve locally):
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.audit_incidents
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import datetime

from sqlmodel import Session, select

from app.database import engine
from app.models import IncidentRecord
from app.time import as_utc, now_utc

_OPEN_STATUSES = {"open", "under_review"}


def _parse_dt(value) -> datetime | None:
    """Parse a (possibly datetime-coerced) occurred_at into tz-aware UTC.

    occurred_at is declared `str` but the seed loader stores a datetime, so the
    column round-trips as either an ISO 'T' string (app rows) or a space-
    separated one (str(datetime)); fromisoformat handles both. 'Z' suffixes are
    normalized for older runtimes."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return as_utc(value)
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return as_utc(datetime.fromisoformat(s))
    except ValueError:
        return None


def _age_days(occurred_at, now: datetime) -> float | None:
    when = _parse_dt(occurred_at)
    if when is None:
        return None
    return max(0.0, (now - when).total_seconds() / 86400.0)


def _is_seed(incident_id: str | None) -> bool:
    return (incident_id or "").startswith("seed-")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit incident rows per venue (read-only).")
    parser.add_argument("--venue", default="", help="limit to a single venue_id")
    args = parser.parse_args()
    now = now_utc()

    with Session(engine) as session:
        stmt = select(IncidentRecord)
        if args.venue:
            stmt = stmt.where(IncidentRecord.venue_id == args.venue)
        rows = session.exec(stmt).all()

    if not rows:
        print("No incidents found.")
        return 0

    by_venue: dict[str, list[IncidentRecord]] = defaultdict(list)
    for r in rows:
        by_venue[r.venue_id].append(r)

    header = (
        f"{'VENUE':28} {'TOT':>4} {'OPEN':>5} {'REV':>4} {'CLSD':>5} {'ARCH':>5} "
        f"| open age 0-30/30-90/90+ | seed/app"
    )
    print(header)
    print("-" * len(header))
    for venue_id in sorted(by_venue):
        items = by_venue[venue_id]
        c: dict[str, int] = defaultdict(int)
        for r in items:
            c[r.status] += 1
        b0 = b1 = b2 = bx = 0
        for r in items:
            if r.status not in _OPEN_STATUSES:
                continue
            age = _age_days(r.occurred_at, now)
            if age is None:
                bx += 1
            elif age <= 30:
                b0 += 1
            elif age <= 90:
                b1 += 1
            else:
                b2 += 1
        seed_n = sum(1 for r in items if _is_seed(r.id))
        app_n = len(items) - seed_n
        buckets = f"{b0}/{b1}/{b2}" + (f" (+{bx}?)" if bx else "")
        print(
            f"{venue_id:28} {len(items):>4} {c['open']:>5} {c['under_review']:>4} "
            f"{c['closed']:>5} {c['closed_archived']:>5} | {buckets:>14} | {seed_n}/{app_n}"
        )
    print("\nLegend: open-age buckets count OPEN+UNDER_REVIEW incidents by days since occurred_at.")
    print("        seed/app = rows with a `seed-` id vs app-generated (`inc-`) rows.")
    print("        High 90+ or high app counts => candidates for `cleanup_stale_incidents`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
