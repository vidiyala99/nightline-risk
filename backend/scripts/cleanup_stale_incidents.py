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
from datetime import datetime

from sqlmodel import Session, select

from app.database import engine
from app.models import IncidentRecord
from app.packet_core import _add_audit_event
from app.time import as_utc, now_utc

_OPEN_STATUSES = {"open", "under_review"}


def _parse_dt(value) -> datetime | None:
    """See scripts/audit_incidents._parse_dt — same parse, kept local so each
    script stands alone."""
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive stale app-generated open incidents.")
    parser.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    parser.add_argument("--venue", default="", help="limit to a single venue_id")
    parser.add_argument("--days", type=int, default=60,
                        help="archive open incidents older than N days by occurred_at (default 60)")
    args = parser.parse_args()
    now = now_utc()

    with Session(engine) as session:
        stmt = select(IncidentRecord).where(IncidentRecord.status.in_(_OPEN_STATUSES))  # type: ignore[attr-defined]
        if args.venue:
            stmt = stmt.where(IncidentRecord.venue_id == args.venue)
        open_rows = session.exec(stmt).all()

        targets: list[tuple[IncidentRecord, float]] = []
        skipped_seed = skipped_undated = 0
        for r in open_rows:
            if (r.id or "").startswith("seed-"):
                skipped_seed += 1
                continue
            age = _age_days(r.occurred_at, now)
            if age is None:
                skipped_undated += 1
                continue
            if age <= args.days:
                continue
            targets.append((r, age))

        if not targets:
            print(f"No stale app-generated open incidents older than {args.days}d to archive. "
                  f"Nothing to do. (skipped {skipped_seed} seed, {skipped_undated} undated)")
            return 0

        per_venue: dict[str, int] = defaultdict(int)
        for r, _ in targets:
            per_venue[r.venue_id] += 1

        print(f"Found {len(targets)} stale open incident(s) older than {args.days}d "
              f"across {len(per_venue)} venue(s)  (preserving {skipped_seed} seed rows):")
        for venue_id in sorted(per_venue):
            print(f"  {venue_id:28} {per_venue[venue_id]:>4} -> closed_archived")

        if args.apply:
            for r, age in targets:
                r.status = "closed_archived"
                session.add(r)
                _add_audit_event(
                    session=session,
                    actor_id="cleanup_stale_incidents",
                    actor_type="system",
                    entity_type="incident",
                    entity_id=r.id,
                    event_type="incident.closed_archived",
                    event_metadata={
                        "reason": "stale_auto_archive",
                        "age_days": round(age, 1),
                        "venue_id": r.venue_id,
                        "threshold_days": args.days,
                    },
                )
            session.commit()
            print(f"\nApplied. Archived {len(targets)} incident(s). The next risk-score read "
                  f"reflects the change (no restart needed).")
        else:
            print("\nDry-run only. Re-run with --apply to archive.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
