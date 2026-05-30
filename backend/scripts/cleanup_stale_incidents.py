"""Archive stale, app-generated open incidents that bloat the Safety Record.

A long-running demo accumulates `inc-` incidents (created through triage /
ingestion) that are never closed, dragging the live incident load — and the
Safety Record factor — toward the floor. This archives (status ->
`closed_archived`, NEVER deletes) OPEN/UNDER_REVIEW incidents that are BOTH:
  * app-generated  (id does NOT start with `seed-`), and
  * older than --days (default 60) by occurred_at.

Seed rows (`seed-…`) are always left untouched, so re-seeding stays the source
of truth. Archiving preserves history (archived rows still weigh 0.4× in
scoring) while dropping the "N open" display and lifting the score. Each change
emits an `incident.closed_archived` audit event.

Usage (from backend/):
    python -m scripts.cleanup_stale_incidents                       # dry-run, all venues
    python -m scripts.cleanup_stale_incidents --venue elsewhere-brooklyn
    python -m scripts.cleanup_stale_incidents --days 90 --apply

Against prod, use the Postgres PUBLIC url:
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.cleanup_stale_incidents --apply

Idempotent: re-running after --apply finds nothing left to archive.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict

from sqlmodel import Session

from app.database import engine
from app.services.incident_maintenance import (
    archive_stale_incidents,
    find_stale_incidents,
)
from app.time import now_utc


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive stale app-generated open incidents.")
    parser.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    parser.add_argument("--venue", default="", help="limit to a single venue_id")
    parser.add_argument("--days", type=int, default=60,
                        help="archive open incidents older than N days by occurred_at (default 60)")
    args = parser.parse_args()
    now = now_utc()
    venue = args.venue or None

    with Session(engine) as session:
        # Reuse the service's selection logic so the script and the runtime
        # cap stay in lock-step (single source of truth).
        targets = find_stale_incidents(
            session, venue_id=venue, older_than_days=args.days, now=now,
        )

        if not targets:
            print(f"No stale app-generated open incidents older than {args.days}d to archive. "
                  f"Nothing to do.")
            return 0

        per_venue: dict[str, int] = defaultdict(int)
        for r, _ in targets:
            per_venue[r.venue_id] += 1

        print(f"Found {len(targets)} stale open incident(s) older than {args.days}d "
              f"across {len(per_venue)} venue(s)  (seed rows preserved):")
        for venue_id in sorted(per_venue):
            print(f"  {venue_id:28} {per_venue[venue_id]:>4} -> closed_archived")

        if args.apply:
            archived = archive_stale_incidents(
                session, venue_id=venue, older_than_days=args.days, now=now,
            )
            session.commit()
            print(f"\nApplied. Archived {len(archived)} incident(s). The next risk-score read "
                  f"reflects the change (no restart needed).")
        else:
            print("\nDry-run only. Re-run with --apply to archive.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
