"""CLI entry point for the ingestion spine.

    python -m scripts.run_ingest <source|all> [--dry-run]

Schedulable as a Railway cron. Hydrates the in-memory VENUES index from the
DB first (so operational connectors cover book + prospect venues), then runs
the requested source(s) through the spine and prints the run summary.
"""
from __future__ import annotations

import argparse
import json
import sys

from sqlmodel import Session, select

from app.database import create_db_and_tables, engine
from app.ingestion.registry import SOURCES
from app.ingestion.runner import run
from app.models import Venue
from app.seed_data import VENUES


def _hydrate_venues(session: Session) -> None:
    for v in session.exec(select(Venue)).all():
        if v.id not in VENUES and v.venue_data:
            try:
                VENUES[v.id] = json.loads(v.venue_data)
            except Exception:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a venue operational-data ingestion connector.")
    parser.add_argument("source", help=f"one of: {', '.join(SOURCES)}, or 'all'")
    parser.add_argument("--dry-run", action="store_true", help="extract+transform without persisting")
    args = parser.parse_args(argv)

    create_db_and_tables()
    with Session(engine) as session:
        _hydrate_venues(session)
        try:
            runs = run(args.source, session, venues=VENUES, dry_run=args.dry_run)
        except KeyError as exc:
            print(f"[ingest] {exc}")
            return 2

    mode = " (dry-run)" if args.dry_run else ""
    for r in runs:
        print(
            f"[ingest]{mode} {r.source_system}: status={r.status} "
            f"extracted={r.extracted} loaded={r.loaded} skipped={r.skipped} "
            f"rejected={r.rejected} watermark={r.watermark}"
            + (f" error={r.error}" if r.error else "")
        )
    return 0 if all(r.status == "success" for r in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
