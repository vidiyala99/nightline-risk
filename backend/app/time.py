"""Time helpers.

The codebase stores all timestamps in UTC (`datetime.now(timezone.utc)`).
SQLite's Python driver strips tzinfo on read; Postgres preserves it. Without
a re-attaching helper, datetime arithmetic on values just read from SQLite
raises `TypeError: can't subtract offset-naive and offset-aware datetimes`
in dev, while working fine in prod.

`as_utc()` is the single fix: call it after reading any timestamp column
that you then do arithmetic on. A SQLAlchemy `TypeDecorator` would do this
transparently at the column level — that's the right long-term shape, but
a helper is cheap and unblocks Phase 1.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime
from sqlalchemy.types import TypeDecorator


def as_utc(dt: datetime | None) -> datetime | None:
    """Force tzinfo=UTC on a (possibly naive) datetime.

    Returns None for None inputs so callers can chain on Optional columns.
    Does NOT convert from local time to UTC — assumes the input was stored
    as UTC and only the tzinfo is missing (the SQLite case)."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def now_utc() -> datetime:
    """Convenience: timezone-aware UTC 'now'.

    Use this in `Field(default_factory=now_utc)` instead of the lambda
    `lambda: datetime.now(timezone.utc)` — easier to import once, less
    boilerplate at the model level, easier to monkey-patch in tests."""
    return datetime.now(timezone.utc)


class DateTimeUTC(TypeDecorator):
    """A DateTime column that always reads back timezone-aware (UTC).

    This is the column-level version of `as_utc()`: instead of remembering to
    re-attach tzinfo at every read site, the normalization happens in the type.

    - On **bind** (write): an aware value is converted to UTC and stored as a
      naive-UTC wall-clock. This matches what the legacy `datetime.utcnow()`
      already wrote, so existing rows on both SQLite and Postgres stay
      byte-compatible — no DDL migration or data rewrite is needed.
    - On **result** (read): the (naive on SQLite, possibly naive on a legacy
      Postgres `TIMESTAMP WITHOUT TIME ZONE` column) value is labeled UTC.

    The net effect: every timestamp is tz-aware in Python regardless of
    backend, killing the offset-naive/offset-aware mixing class of bug.
    """

    impl = DateTime  # keep the physical column type unchanged (no timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        return as_utc(value)
