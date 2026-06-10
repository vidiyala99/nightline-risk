"""Tests for the DateTimeUTC SQLAlchemy TypeDecorator.

The decorator's job: every timestamp column reads back timezone-aware (UTC)
regardless of backend. SQLite strips tzinfo on read and Postgres preserves it;
without normalization, comparing a freshly-created ``now_utc()`` (aware) against
a value read from SQLite (naive) raises ``TypeError: can't subtract
offset-naive and offset-aware datetimes`` in dev while working in prod. The
decorator removes that whole class of bug at the column boundary.
"""
from datetime import datetime, timezone, timedelta

from sqlmodel import Field, SQLModel, Session, create_engine, select

from app.time import DateTimeUTC, now_utc


class _Stamped(SQLModel, table=True):
    __tablename__ = "datetime_utc_probe"
    id: int = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=now_utc, sa_type=DateTimeUTC)
    resolved_at: datetime | None = Field(default=None, sa_type=DateTimeUTC)


def _engine():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    return engine


def test_reads_back_timezone_aware_on_sqlite():
    """A row written with an aware default reads back aware (not naive)."""
    engine = _engine()
    with Session(engine) as session:
        row = _Stamped()
        session.add(row)
        session.commit()
        row_id = row.id

    with Session(engine) as session:
        fetched = session.get(_Stamped, row_id)
        assert fetched.created_at.tzinfo is not None
        assert fetched.created_at.utcoffset() == timedelta(0)


def test_naive_bind_value_reads_back_aware():
    """A naive datetime stored to the column reads back labeled as UTC."""
    engine = _engine()
    naive = datetime(2026, 6, 10, 12, 0, 0)  # no tzinfo
    with Session(engine) as session:
        row = _Stamped(created_at=naive)
        session.add(row)
        session.commit()
        row_id = row.id

    with Session(engine) as session:
        fetched = session.get(_Stamped, row_id)
        assert fetched.created_at.tzinfo == timezone.utc
        # Wall-clock fields preserved; only tzinfo re-attached.
        assert fetched.created_at.replace(tzinfo=None) == naive


def test_aware_non_utc_bind_normalized_to_utc():
    """An aware value in another zone is converted to UTC before storage."""
    engine = _engine()
    # 12:00 at UTC-5 == 17:00 UTC
    eastern = timezone(timedelta(hours=-5))
    aware = datetime(2026, 6, 10, 12, 0, 0, tzinfo=eastern)
    with Session(engine) as session:
        row = _Stamped(created_at=aware)
        session.add(row)
        session.commit()
        row_id = row.id

    with Session(engine) as session:
        fetched = session.get(_Stamped, row_id)
        assert fetched.created_at == aware  # equal instant
        assert fetched.created_at.replace(tzinfo=None) == datetime(2026, 6, 10, 17, 0, 0)


def test_none_round_trips():
    """Nullable timestamp columns accept and return None."""
    engine = _engine()
    with Session(engine) as session:
        row = _Stamped()
        session.add(row)
        session.commit()
        row_id = row.id

    with Session(engine) as session:
        fetched = session.get(_Stamped, row_id)
        assert fetched.resolved_at is None


def test_read_value_supports_arithmetic_against_now_utc():
    """The original footgun: read value minus a fresh now_utc() must not raise."""
    engine = _engine()
    with Session(engine) as session:
        row = _Stamped()
        session.add(row)
        session.commit()
        row_id = row.id

    with Session(engine) as session:
        fetched = session.get(_Stamped, row_id)
        delta = now_utc() - fetched.created_at  # would TypeError if naive
        assert delta >= timedelta(0)
