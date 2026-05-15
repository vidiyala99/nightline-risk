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

def get_session():
    create_db_and_tables()
    with Session(engine) as session:
        yield session
