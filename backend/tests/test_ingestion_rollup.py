"""Tests for app/ingestion/rollup.py — latest-value rollup into venue_data."""
import json
from datetime import datetime

from sqlmodel import Session, SQLModel, create_engine

from app.ingestion.rollup import rollup_operational_data
from app.models import Venue, VenueOperationalEvent


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _voe(metric, value, hour, source="pos") -> VenueOperationalEvent:
    return VenueOperationalEvent(
        id=f"voe-{metric}-{hour}",
        venue_id="v1",
        source_system=source,
        event_type="x",
        metric_name=metric,
        value=value,
        occurred_at=datetime(2026, 5, 26, hour, 0, 0),
        content_hash=f"{metric}-{hour}",
    )


def test_rollup_picks_latest_value_per_metric_and_updates_db_and_index():
    s = _session()
    s.add(Venue(id="v1", name="Elsewhere", venue_data=json.dumps({"name": "Elsewhere"})))
    s.add(_voe("over_pour_rate", 0.30, hour=1))
    s.add(_voe("over_pour_rate", 0.55, hour=5))  # latest wins
    s.add(_voe("id_rejection_rate", 0.10, hour=3, source="id_scanner"))
    s.commit()

    venues_index: dict = {"v1": {"name": "Elsewhere"}}
    rollup_operational_data(s, ["v1"], venues_index=venues_index)

    # In-memory index updated
    op = venues_index["v1"]["operational_data"]
    assert op["over_pour_rate"] == 0.55
    assert op["id_rejection_rate"] == 0.10
    assert sorted(op["sources"]) == ["id_scanner", "pos"]
    assert op["last_ingest_at"] == datetime(2026, 5, 26, 5, 0, 0).isoformat()

    # DB venue_data persisted too
    row = s.get(Venue, "v1")
    persisted = json.loads(row.venue_data)["operational_data"]
    assert persisted["over_pour_rate"] == 0.55


def test_rollup_no_events_is_noop():
    s = _session()
    s.add(Venue(id="v1", name="Elsewhere", venue_data=json.dumps({"name": "Elsewhere"})))
    s.commit()
    venues_index: dict = {"v1": {"name": "Elsewhere"}}
    rollup_operational_data(s, ["v1"], venues_index=venues_index)
    assert "operational_data" not in venues_index["v1"]
