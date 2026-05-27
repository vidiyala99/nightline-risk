"""Tests for the ingestion spine (app/ingestion/base.py).

The spine wraps every connector run uniformly: extract → transform →
watermark filter → data-quality filter → dedupe-load → rollup → run-log.
These tests use a fake operational connector so the framework is exercised
without any real feed.
"""
from datetime import datetime

from sqlmodel import Session, SQLModel, create_engine, select

from app.ingestion.base import (
    Connector,
    LoadResult,
    NormalizedEvent,
    load_operational_events,
    run_connector,
)
from app.models import IngestionRun, VenueOperationalEvent


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


class _FakeConnector(Connector):
    source_system = "pos"

    def __init__(self, events: list[NormalizedEvent]):
        self._events = events

    def extract(self):
        # one raw "batch" carrying all events
        return [self._events]

    def transform(self, raw):
        return list(raw)

    def load(self, session, events):
        return load_operational_events(session, events)


def _event(metric="over_pour_rate", value=0.4, hour=2, ref="r1") -> NormalizedEvent:
    return NormalizedEvent(
        venue_id="v1",
        source_system="pos",
        event_type="over_pour",
        metric_name=metric,
        value=value,
        occurred_at=datetime(2026, 5, 26, hour, 0, 0),
        external_ref=ref,
    )


def test_content_hash_is_stable_for_same_identity():
    a = _event()
    b = _event()
    assert a.content_hash == b.content_hash
    # a different occurred_at is a different event
    c = _event(hour=3)
    assert a.content_hash != c.content_hash


def test_run_loads_events_and_writes_run_log():
    s = _session()
    run = run_connector(_FakeConnector([_event(ref="r1"), _event(ref="r2", value=0.5)]), s)

    assert run.status == "success"
    assert run.extracted == 2
    assert run.loaded == 2
    assert run.skipped == 0
    assert run.watermark == datetime(2026, 5, 26, 2, 0, 0)

    events = s.exec(select(VenueOperationalEvent)).all()
    assert len(events) == 2
    logged = s.exec(select(IngestionRun)).one()
    assert logged.source_system == "pos"
    assert logged.loaded == 2


def test_rerun_is_idempotent_via_content_hash():
    s = _session()
    batch = [_event(ref="r1"), _event(ref="r2", value=0.5)]
    run_connector(_FakeConnector(batch), s)
    second = run_connector(_FakeConnector(batch), s)

    assert second.loaded == 0
    assert second.skipped == 2
    # still only the two original rows
    assert len(s.exec(select(VenueOperationalEvent)).all()) == 2


def test_watermark_skips_already_seen_events():
    s = _session()
    early = _event(hour=2, ref="early")
    late = _event(hour=5, ref="late")
    run = run_connector(
        _FakeConnector([early, late]),
        s,
        watermark=datetime(2026, 5, 26, 3, 0, 0),
    )
    # only the post-watermark event is loaded
    assert run.loaded == 1
    assert run.watermark == datetime(2026, 5, 26, 5, 0, 0)
    rows = s.exec(select(VenueOperationalEvent)).all()
    assert [r.external_ref for r in rows] == ["late"]


def test_quality_filter_rejects_and_counts():
    s = _session()
    good = _event(value=0.4, ref="good")
    bad = _event(value=-1.0, ref="bad")  # out of range
    run = run_connector(
        _FakeConnector([good, bad]),
        s,
        quality_filter=lambda e: 0.0 <= e.value <= 1.0,
    )
    assert run.loaded == 1
    assert run.rejected == 1
    rows = s.exec(select(VenueOperationalEvent)).all()
    assert [r.external_ref for r in rows] == ["good"]


def test_run_connector_aggregates_rejected_reasons():
    import json

    from app.ingestion.quality import is_valid_event

    s = _session()
    good = _event(value=0.4, ref="good")
    oor = _event(value=1.5, ref="oor")                         # out_of_range
    unknown = _event(metric="made_up_metric", value=0.5, ref="unk")  # unknown_metric
    run = run_connector(_FakeConnector([good, oor, unknown]), s, quality_filter=is_valid_event)
    assert run.loaded == 1
    assert run.rejected == 2
    assert json.loads(run.rejected_reasons) == {"out_of_range": 1, "unknown_metric": 1}


def test_watermark_comparison_tolerates_mixed_tzawareness():
    # Regression: SQLite strips tzinfo on read, so a watermark loaded from the
    # IngestionRun log is naive while fresh events (now_utc) are tz-aware.
    # Comparing them must not raise "can't compare naive and aware datetimes".
    from datetime import timezone

    s = _session()
    aware_early = NormalizedEvent(
        venue_id="v1", source_system="pos", event_type="over_pour",
        metric_name="over_pour_rate", value=0.4,
        occurred_at=datetime(2026, 5, 26, 2, 0, 0, tzinfo=timezone.utc), external_ref="early",
    )
    aware_late = NormalizedEvent(
        venue_id="v1", source_system="pos", event_type="over_pour",
        metric_name="over_pour_rate", value=0.4,
        occurred_at=datetime(2026, 5, 26, 5, 0, 0, tzinfo=timezone.utc), external_ref="late",
    )
    naive_watermark = datetime(2026, 5, 26, 3, 0, 0)  # as read back from SQLite

    run = run_connector(_FakeConnector([aware_early, aware_late]), s, watermark=naive_watermark)
    assert run.status == "success"
    assert run.loaded == 1  # only the post-watermark event


def test_extract_retries_then_succeeds(monkeypatch):
    import app.ingestion.base as base
    monkeypatch.setattr(base.time, "sleep", lambda *_a, **_k: None)  # no real backoff in tests
    s = _session()

    class _Flaky(_FakeConnector):
        def __init__(self, events, fail_times):
            super().__init__(events)
            self._fail_times = fail_times
            self._calls = 0

        def extract(self):
            self._calls += 1
            if self._calls <= self._fail_times:
                raise RuntimeError("transient")
            return [self._events]

    run = run_connector(_Flaky([_event()], fail_times=2), s)
    assert run.status == "success"
    assert run.loaded == 1


def test_extract_exhausts_retries_and_records_error(monkeypatch):
    import app.ingestion.base as base
    monkeypatch.setattr(base.time, "sleep", lambda *_a, **_k: None)
    s = _session()

    class _AlwaysFails(_FakeConnector):
        def extract(self):
            raise RuntimeError("boom")

    run = run_connector(_AlwaysFails([_event()]), s)
    assert run.status == "error"
    assert "after 3 attempts" in (run.error or "")


def test_dry_run_writes_nothing():
    s = _session()
    run = run_connector(_FakeConnector([_event()]), s, dry_run=True)
    assert run.extracted == 1
    assert run.loaded == 0
    assert s.exec(select(VenueOperationalEvent)).all() == []
    assert s.exec(select(IngestionRun)).all() == []
