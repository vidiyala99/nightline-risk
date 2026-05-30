import os
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
    # PolicyRequest execute-on-approval result deep-link — added 2026-05-29.
    ("policyrequest", "result_entity_type", "TEXT", ""),
    ("policyrequest", "result_entity_id", "TEXT", ""),
    # Onboarding data capture — added 2026-05-29. Dates/JSON as TEXT per convention.
    ("venue", "current_carrier", "TEXT", ""),
    ("venue", "renewal_date", "TEXT", ""),
    ("venue", "coverage_interest", "TEXT", ""),
    ("venue", "onboarding_complete", "BOOLEAN", "NOT NULL DEFAULT 0"),
]


def _existing_columns(conn, table: str) -> set[str]:
    """Cross-dialect column probe so we skip ALTER on columns that already exist."""
    from sqlalchemy import inspect
    try:
        return {c["name"] for c in inspect(conn).get_columns(table)}
    except Exception:
        return set()


def create_db_and_tables():
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
    _backfill_compliance_signals()


def _backfill_compliance_signals():
    """Idempotent: seed ComplianceSignal rows from each venue's curated
    compliance_items count, so the operator queue + compliance factor are
    populated.

    Idempotency is venue-level: if a venue already has ANY signal, it is left
    untouched (we never clobber live operator state — resolved items, auto-
    generated camera items, etc.). The single commit at the end of the loop
    makes seeding atomic, so a crash can't leave a venue partially seeded; the
    only way to reach a partial set is manual row deletion, which this backfill
    intentionally does not try to repair (re-seeding a venue is a manual op)."""
    from sqlmodel import Session, select
    from app.models import ComplianceSignal, Venue
    from app.seed_data import VENUES
    with Session(engine) as session:
        for venue_id, data in VENUES.items():
            n = int(data.get("compliance_items", 0) or 0)
            if n == 0:
                continue
            # FK safety: skip venues whose Venue row doesn't exist yet. On first
            # boot this backfill runs (via get_session) BEFORE the lifespan seeds
            # venues, so inserting a ComplianceSignal with a dangling venue_id FK
            # would crash on Postgres (SQLite doesn't enforce FKs, which is why
            # the test suite couldn't catch it). A later backfill run — once the
            # venues are seeded — picks these up, so it's idempotent and
            # self-healing. See memory: SQLAlchemy FK ordering on Postgres.
            if session.get(Venue, venue_id) is None:
                continue
            existing = session.exec(
                select(ComplianceSignal).where(ComplianceSignal.venue_id == venue_id)
            ).first()
            if existing is not None:
                continue
            for i in range(n):
                session.add(ComplianceSignal(
                    id=f"seed-cmp-{venue_id}-{i}", venue_id=venue_id,
                    title="Outstanding compliance item",
                    description="Curated underwriter compliance item.",
                    provenance="underwriter_verified", severity="medium", status="open",
                ))
        session.commit()


def get_session():
    create_db_and_tables()
    with Session(engine) as session:
        yield session
