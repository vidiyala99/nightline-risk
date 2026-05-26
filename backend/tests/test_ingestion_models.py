"""Tests for the ingestion-spine ORM models (app/models.py)."""
from datetime import datetime

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import IngestionRun, VenueOperationalEvent


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_operational_event_roundtrips_with_defaults():
    s = _session()
    ev = VenueOperationalEvent(
        id="voe-abc123abc123",
        venue_id="v1",
        source_system="pos",
        event_type="over_pour",
        metric_name="over_pour_rate",
        value=0.42,
        occurred_at=datetime(2026, 5, 26, 2, 0, 0),
        content_hash="deadbeef",
    )
    s.add(ev)
    s.commit()

    got = s.exec(select(VenueOperationalEvent)).one()
    assert got.venue_id == "v1"
    assert got.metric_name == "over_pour_rate"
    assert got.value == 0.42
    # ingested_at auto-stamped; event_metadata defaults to empty dict
    assert isinstance(got.ingested_at, datetime)
    assert got.event_metadata == {}


def test_ingestion_run_roundtrips_with_count_defaults():
    s = _session()
    run = IngestionRun(
        id="ingest-abc123abc123",
        source_system="pos",
        status="success",
    )
    s.add(run)
    s.commit()

    got = s.exec(select(IngestionRun)).one()
    assert got.source_system == "pos"
    assert got.status == "success"
    # counters default to 0
    assert got.extracted == 0
    assert got.loaded == 0
    assert got.skipped == 0
    assert got.rejected == 0
    assert isinstance(got.started_at, datetime)
