"""Tests for app/time.py — the SQLite tzinfo workaround."""

from datetime import datetime, timezone, timedelta

from app.time import as_utc, now_utc


def test_as_utc_attaches_tzinfo_to_naive_datetime():
    """The SQLite case: column stored as UTC, driver returned naive."""
    naive = datetime(2026, 5, 21, 12, 0, 0)
    assert naive.tzinfo is None
    result = as_utc(naive)
    assert result is not None
    assert result.tzinfo == timezone.utc
    assert result == datetime(2026, 5, 21, 12, 0, 0, tzinfo=timezone.utc)


def test_as_utc_passes_through_aware_datetime():
    """Postgres case or already-converted: don't double-wrap."""
    aware = datetime(2026, 5, 21, 12, 0, 0, tzinfo=timezone.utc)
    result = as_utc(aware)
    assert result is aware  # same instance, not re-wrapped


def test_as_utc_does_not_convert_other_timezones():
    """`as_utc` only ATTACHES tzinfo to naive datetimes; it does NOT shift
    a non-UTC aware datetime to UTC. That would corrupt data — if a
    datetime is already aware but in a different zone, the row was wrong
    upstream and we shouldn't silently 'fix' it."""
    et = timezone(timedelta(hours=-5))
    dt = datetime(2026, 5, 21, 12, 0, 0, tzinfo=et)
    result = as_utc(dt)
    assert result is dt
    assert result.tzinfo == et  # unchanged


def test_as_utc_handles_none():
    """Chainable on Optional[datetime] columns."""
    assert as_utc(None) is None


def test_as_utc_enables_arithmetic_with_aware_now():
    """The motivating test: subtracting now() from a SQLite-read datetime."""
    sqlite_naive = datetime(2026, 5, 21, 12, 0, 0)
    fixed = as_utc(sqlite_naive)
    delta = now_utc() - fixed
    # Just confirm no TypeError raised; the delta sign depends on real time.
    assert isinstance(delta, timedelta)


def test_now_utc_returns_aware():
    """The drop-in replacement for `datetime.now(timezone.utc)` and the
    fix for `datetime.utcnow()` deprecation warnings."""
    n = now_utc()
    assert n.tzinfo == timezone.utc
