import os
import weakref
from sqlmodel import create_engine, Session, SQLModel
from dotenv import load_dotenv

load_dotenv()

_DATABASE_URL = os.getenv("DATABASE_URL")

if _DATABASE_URL:
    # Railway provides postgres:// — SQLAlchemy requires postgresql://
    if _DATABASE_URL.startswith("postgres://"):
        _DATABASE_URL = _DATABASE_URL.replace("postgres://", "postgresql://", 1)
    engine = create_engine(_DATABASE_URL, pool_pre_ping=True)
else:
    engine = create_engine(
        "sqlite:///database.db",
        connect_args={"check_same_thread": False},
    )

# (table, column, type, default-clause-or-empty). One row per nullable column
# that's been added since the project's original schema. The migration loop
# below adds them with plain ALTER TABLE — `IF NOT EXISTS` is Postgres-only
# and a parse error on SQLite, so we rely on the try/except + a column-existence
# probe so reruns are silent on both dialects.
_COLUMN_MIGRATIONS: list[tuple[str, str, str, str]] = [
    ("incidentrecord", "status", "TEXT", "NOT NULL DEFAULT 'open'"),
    ("venue", "venue_data", "TEXT", ""),
    ("userrecord", "extra_venue_ids", "TEXT", ""),
    # PageIndex citation linkage — added 2026-05-14.
    ("complianceevidence", "cited_source_id", "TEXT", ""),
    ("complianceevidence", "cited_doc_id", "TEXT", ""),
    ("complianceevidence", "cited_node_id", "TEXT", ""),
    ("complianceevidence", "cited_page_start", "INTEGER", ""),
    ("complianceevidence", "cited_page_end", "INTEGER", ""),
    # Defense-package build — added 2026-05-24.
    ("evidencefile", "content_hash", "TEXT", ""),
    ("evidencefile", "captured_at", "TEXT", ""),
    ("underwritingpacket", "corroboration_status", "TEXT", ""),
    ("underwritingpacket", "corroboration_flags", "TEXT", ""),
    ("incidentrecord", "incident_category", "TEXT", ""),
    ("incidentrecord", "parties", "TEXT", ""),
    ("incidentrecord", "witnesses", "TEXT", ""),
    ("incidentrecord", "security_response", "TEXT", ""),
    ("incidentrecord", "weapon_involved", "BOOLEAN", ""),
    ("incidentrecord", "refused_service_or_overserved", "TEXT", ""),
    ("incidentrecord", "injury_detail", "TEXT", ""),
    # Ingestion rejection-reason observability — added 2026-05-27.
    ("ingestionrun", "rejected_reasons", "TEXT", ""),
    # Claim-proposal request-more-info round-trip — added 2026-05-29. Datetime
    # columns use TEXT to match the project's existing migration convention
    # (e.g. evidencefile.captured_at); SQLModel binds/parses ISO strings on read.
    ("claimproposal", "info_requested_by", "TEXT", ""),
    ("claimproposal", "info_requested_at", "TEXT", ""),
    ("claimproposal", "info_request_note", "TEXT", ""),
    ("claimproposal", "operator_response_note", "TEXT", ""),
    ("claimproposal", "operator_responded_at", "TEXT", ""),
    # Broker-triage routing: recommendation snapshot driving auto-route — added
    # 2026-05-31. JSON stored as TEXT per the convention above.
    ("claimproposal", "recommendation_snapshot", "TEXT", ""),
    # PolicyRequest execute-on-approval result deep-link — added 2026-05-29.
    ("policyrequest", "result_entity_type", "TEXT", ""),
    ("policyrequest", "result_entity_id", "TEXT", ""),
    # Onboarding data capture — added 2026-05-29. Dates/JSON as TEXT per convention.
    ("venue", "current_carrier", "TEXT", ""),
    ("venue", "renewal_date", "TEXT", ""),
    ("venue", "coverage_interest", "TEXT", ""),
    # Nullable, NO default: Postgres rejects an integer boolean default (DEFAULT 0)
    # and the swallowed ALTER would leave the column absent → select(Venue) crash-
    # loop → 502. Mirrors the proven incidentrecord.weapon_involved BOOLEAN row.
    # Existing rows read NULL; the hydration overlay coerces via bool(...).
    ("venue", "onboarding_complete", "BOOLEAN", ""),
    # Carrier desk v2 — request-info loop. Added 2026-06-02.
    ("carrierquote", "info_request_note", "TEXT", ""),
    ("carrierquote", "info_response_note", "TEXT", ""),
    ("carrierquote", "info_requested_by", "TEXT", ""),
    ("carrierquote", "info_requested_at", "TEXT", ""),
    # Carrier claims adjudication — coverage decision. Added 2026-06-02.
    ("claim", "coverage_decision", "TEXT", ""),
    ("claim", "coverage_rationale", "TEXT", ""),
    ("claim", "coverage_decided_by", "TEXT", ""),
    ("claim", "coverage_decided_at", "TEXT", ""),
]


def _existing_columns(conn, table: str) -> set[str]:
    """Cross-dialect column probe so we skip ALTER on columns that already exist."""
    from sqlalchemy import inspect
    try:
        return {c["name"] for c in inspect(conn).get_columns(table)}
    except Exception:
        return set()


# Engines whose schema bootstrap has already run. Keyed PER ENGINE (not a single
# bool) because the test suite swaps app.database.engine to fresh in-memory DBs —
# a global flag would mark "ready" for whichever engine ran first and wrongly skip
# every other engine ("no such table"). A WeakSet drops entries when test engines
# are GC'd. Identity-based membership (Engine uses default __hash__/__eq__).
_bootstrapped_engines: "weakref.WeakSet" = weakref.WeakSet()

# Engines whose compliance-signal backfill has run a full pass (venues existed).
# Separate from _bootstrapped_engines because the backfill must RETRY while venues
# are still unseeded (the lifespan creates the schema before seeding venues), then
# settle once. Keyed per engine for the same test-isolation reason.
_backfilled_engines: "weakref.WeakSet" = weakref.WeakSet()


def create_db_and_tables():
    # get_session() calls this on every request. The expensive, one-time part —
    # create_all's per-table catalog check + the ~30-column migration loop — used
    # to re-run every request; invisible when compute was co-located with the DB
    # (~1ms hops) but ~tens of seconds when the DB is a region away (Railway ->
    # Neon us-east-1). So that DDL block is guarded to run once per engine (keyed
    # per engine, not a global flag, because tests swap app.database.engine). On
    # failure the engine isn't recorded, so the next call retries.
    if engine not in _bootstrapped_engines:
        SQLModel.metadata.create_all(engine)
        # Add missing nullable columns to existing tables. create_all only adds
        # missing TABLES, not missing COLUMNS — so without this loop, a stale
        # database.db keeps the pre-migration schema and inserts fail with
        # "table foo has no column named bar".
        from sqlalchemy import text
        with engine.connect() as conn:
            conn.execution_options(isolation_level="AUTOCOMMIT")
            for table, column, coltype, default_clause in _COLUMN_MIGRATIONS:
                if column in _existing_columns(conn, table):
                    continue
                ddl = f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"
                if default_clause:
                    ddl = f"{ddl} {default_clause}"
                try:
                    conn.execute(text(ddl))
                except Exception:
                    pass
        _bootstrapped_engines.add(engine)
    # Backfill compliance signals ONCE per engine — NOT per request. It still
    # self-heals across the seed-ordering gap: while venues are unseeded the pass
    # returns False (not marked) so it retries; once venues exist a full pass runs,
    # returns True, and the engine is marked done. Running it unguarded on every
    # request added 2 cross-region SELECTs over ~291 venues to EVERY endpoint —
    # ~1ms when co-located, but it compounded into the operator dashboard's 20-30s
    # load on a cold/​waking Neon under ~10 concurrent calls.
    if engine not in _backfilled_engines:
        if _backfill_compliance_signals():
            _backfilled_engines.add(engine)


def _backfill_compliance_signals():
    """Idempotent: seed ComplianceSignal rows from each venue's curated
    compliance_items count, so the operator queue + compliance factor are
    populated. Runs on every create_db_and_tables() call so it self-heals: the
    lifespan creates the schema before venues are seeded, then a later call
    seeds them once the Venue rows exist.

    Idempotency is venue-level: a venue that already has ANY signal is left
    untouched (we never clobber live operator state — resolved items, auto-
    generated camera items, etc.).

    Bulk-queried — two SELECTs (existing venue ids; venues that already have a
    signal) instead of a per-venue session.get() over ~291 venues — so the
    per-request cost stays low (~2 round-trips) even when the DB is a region
    away. See memory: SQLAlchemy FK ordering on Postgres."""
    from sqlmodel import Session, select
    from app.models import ComplianceSignal, Venue
    from app.seed_data import VENUES
    with Session(engine) as session:
        existing_venue_ids = set(session.exec(select(Venue.id)).all())
        if not existing_venue_ids:
            return False  # venues not seeded yet — a later call self-heals
        venues_with_signals = set(
            session.exec(select(ComplianceSignal.venue_id).distinct()).all()
        )
        new_signals = []
        for venue_id, data in VENUES.items():
            n = int(data.get("compliance_items", 0) or 0)
            if n == 0:
                continue
            # FK safety: skip venues whose Venue row doesn't exist yet (a dangling
            # FK crashes on Postgres). Skip venues that already have a signal.
            if venue_id not in existing_venue_ids or venue_id in venues_with_signals:
                continue
            for i in range(n):
                new_signals.append(ComplianceSignal(
                    id=f"seed-cmp-{venue_id}-{i}", venue_id=venue_id,
                    title="Outstanding compliance item",
                    description="Curated underwriter compliance item.",
                    provenance="underwriter_verified", severity="medium", status="open",
                ))
        if new_signals:
            session.add_all(new_signals)
            session.commit()
        return True  # venues existed → a full pass ran; engine can be marked done


def get_session():
    create_db_and_tables()
    with Session(engine) as session:
        yield session
